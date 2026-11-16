import { sql } from 'kysely';
import {
  BASE_CAPABILITY_KEYS,
  PRIVATE_AUDIENCE_ROLES,
  commerceCapabilityKey,
  isCapabilityKey,
  isCommerceCapabilityKey,
} from '@hailiday/core';
import type {
  ActivationState,
  AppEnv,
  BaseCapabilityKey,
  CapabilityKey,
  CapabilityRecord,
  PublicCapabilities,
  UserRole,
} from '@hailiday/core';
import type { Clock } from '../clock/index.js';
import type { AppConfig } from '../config/index.js';
import { DEFAULT_STREET_VIEW_USE_POLICY } from '../config/index.js';
import { systemClock } from '../clock/index.js';
import type { Db, DbOrTx } from '../db/client.js';
import type { CountryCapability } from '../db/schema.js';
import { validationFailed } from '../errors/index.js';
import { newId } from '../ids/index.js';

/** Who is asking: the roles of the signed-in account (empty for anonymous sessions). */
export interface Audience {
  roles: readonly UserRole[];
}

export const ANONYMOUS_AUDIENCE: Audience = { roles: [] };

/** How a leg is served for an audience. */
export type CapabilityMode = 'fixture' | 'live' | 'unavailable';

/**
 * Audience projection: `live_public` is live for everyone; `live_private` is live only for
 * accounts holding `pilot`, `reviewer` or `operator` and unavailable to everyone else; `fixture`
 * serves fixture adapters outside production and is unavailable in production.
 */
export function capabilityMode(
  state: ActivationState | null,
  audience: Audience,
  appEnv: AppEnv,
): CapabilityMode {
  switch (state) {
    case 'live_public':
      return 'live';
    case 'live_private':
      return audience.roles.some((role) => PRIVATE_AUDIENCE_ROLES.includes(role))
        ? 'live'
        : 'unavailable';
    case 'fixture':
      return appEnv === 'production' ? 'unavailable' : 'fixture';
    default:
      return 'unavailable';
  }
}

export function isCapabilityAvailable(
  state: ActivationState | null,
  audience: Audience,
  appEnv: AppEnv,
): boolean {
  return capabilityMode(state, audience, appEnv) !== 'unavailable';
}

export function toCapabilityRecord(row: CountryCapability): CapabilityRecord {
  return {
    countryCode: row.countryCode,
    capability: row.capability as CapabilityKey,
    state: row.state,
    evidenceRef: row.evidenceRef,
    reviewedAt: row.reviewedAt.toISOString(),
    reviewedBy: row.reviewedBy,
    version: row.version,
  };
}

/** The capability flags the experience payload exposes for an audience. */
export function projectPublicCapabilities(
  rows: readonly Pick<CountryCapability, 'capability' | 'state'>[],
  audience: Audience,
  appEnv: AppEnv,
): PublicCapabilities {
  const states = new Map(rows.map((row) => [row.capability, row.state]));
  const available = (key: string) =>
    isCapabilityAvailable(states.get(key) ?? null, audience, appEnv);
  return {
    addressLookup: available('address_lookup'),
    streetViewAi: available('street_view_ai'),
    uploads: available('uploads'),
    sharing: available('sharing'),
    commerce: rows.some(
      (row) => isCommerceCapabilityKey(row.capability) && available(row.capability),
    ),
  };
}

export interface Capabilities {
  /** The row for a country and capability, or null when none exists (unavailable). */
  get(countryCode: string, capability: CapabilityKey): Promise<CountryCapability | null>;
  state(countryCode: string, capability: CapabilityKey): Promise<ActivationState | null>;
  mode(countryCode: string, capability: CapabilityKey, audience: Audience): Promise<CapabilityMode>;
  list(countryCode?: string): Promise<CountryCapability[]>;
  publicProjection(countryCode: string, audience: Audience): Promise<PublicCapabilities>;
  /**
   * Changes a state with optimistic concurrency on `version`. `live_public` requires `confirm`.
   * Returns the updated row and the previous one (for the audit log).
   */
  set(input: {
    countryCode: string;
    capability: CapabilityKey;
    state: ActivationState;
    evidenceRef: string;
    reviewedAt: Date;
    reviewedBy: string | null;
    expectedVersion: number;
    confirm?: boolean;
    db?: DbOrTx;
  }): Promise<{ before: CountryCapability | null; after: CountryCapability }>;
  invalidate(): void;
}

/**
 * Accessors for `country_capabilities` with a short in-process cache (same interval as runtime
 * settings) so a state change takes effect without a deploy.
 */
export function createCapabilities(
  db: Db,
  options: { appEnv: AppEnv; clock?: Clock; cacheTtlMs?: number },
): Capabilities {
  const clock = options.clock ?? systemClock;
  const ttl = options.cacheTtlMs ?? 30_000;
  let cache: { loadedAt: number; rows: CountryCapability[] } | null = null;

  const load = async (): Promise<CountryCapability[]> => {
    const now = clock.now().getTime();
    if (cache && ttl > 0 && now - cache.loadedAt < ttl) return cache.rows;
    const rows = await db
      .selectFrom('countryCapabilities')
      .selectAll()
      .orderBy('countryCode')
      .orderBy('capability')
      .execute();
    cache = { loadedAt: now, rows };
    return rows;
  };

  const capabilities: Capabilities = {
    async get(countryCode, capability) {
      const rows = await load();
      return (
        rows.find((row) => row.countryCode === countryCode && row.capability === capability) ?? null
      );
    },
    async state(countryCode, capability) {
      return (await capabilities.get(countryCode, capability))?.state ?? null;
    },
    async mode(countryCode, capability, audience) {
      return capabilityMode(
        await capabilities.state(countryCode, capability),
        audience,
        options.appEnv,
      );
    },
    async list(countryCode) {
      const rows = await load();
      return countryCode ? rows.filter((row) => row.countryCode === countryCode) : rows;
    },
    async publicProjection(countryCode, audience) {
      return projectPublicCapabilities(
        await capabilities.list(countryCode),
        audience,
        options.appEnv,
      );
    },
    async set(input) {
      if (!isCapabilityKey(input.capability)) {
        throw validationFailed({ fields: [{ path: 'capability', reason: 'unknown_capability' }] });
      }
      if (input.state === 'live_public' && input.confirm !== true) {
        throw validationFailed({
          fields: [{ path: 'confirm', reason: 'required_for_live_public' }],
        });
      }
      const target = input.db ?? db;
      const before =
        (await target
          .selectFrom('countryCapabilities')
          .selectAll()
          .where('countryCode', '=', input.countryCode)
          .where('capability', '=', input.capability)
          .executeTakeFirst()) ?? null;
      let after: CountryCapability | undefined;
      if (!before) {
        if (input.expectedVersion !== 0) {
          throw validationFailed({ reason: 'version_conflict', currentVersion: 0 });
        }
        after = await target
          .insertInto('countryCapabilities')
          .values({
            id: newId(),
            countryCode: input.countryCode,
            capability: input.capability,
            state: input.state,
            evidenceRef: input.evidenceRef,
            reviewedAt: input.reviewedAt,
            reviewedBy: input.reviewedBy,
            version: 1,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        after = await target
          .updateTable('countryCapabilities')
          .set({
            state: input.state,
            evidenceRef: input.evidenceRef,
            reviewedAt: input.reviewedAt,
            reviewedBy: input.reviewedBy,
            version: sql<number>`version + 1`,
          })
          .where('id', '=', before.id)
          .where('version', '=', input.expectedVersion)
          .returningAll()
          .executeTakeFirst();
        if (!after) {
          throw validationFailed({ reason: 'version_conflict', currentVersion: before.version });
        }
      }
      cache = null;
      return { before, after };
    },
    invalidate() {
      cache = null;
    },
  };
  return capabilities;
}

/** Every capability key for a country: the base keys plus one per merchant program. */
export function capabilityKeysFor(merchantProgramKeys: readonly string[]): CapabilityKey[] {
  return [...BASE_CAPABILITY_KEYS, ...merchantProgramKeys.map((key) => commerceCapabilityKey(key))];
}

/**
 * The default activation state of a capability for an environment (the seed profile, and the
 * state assumed for a missing row locally). Everything starts in `fixture`. In development a leg
 * whose provider resolves to a live adapter defaults to `live_public`, so a local visitor reaches
 * the live model: `image_editing`, `vision_analysis`, `address_lookup` and `street_view_display`,
 * and `street_view_ai` when both the Street View provider and the image editor are live and the
 * Street View use policy (default `full`) is not `display_only`. Staging and production defaults
 * never go live.
 */
export function defaultCapabilityState(
  config: Pick<AppConfig, 'appEnv' | 'providers'> & {
    streetView?: Pick<AppConfig['streetView'], 'usePolicy'>;
  },
  capability: CapabilityKey,
): ActivationState {
  if (config.appEnv !== 'development') return 'fixture';
  const usePolicy = config.streetView?.usePolicy ?? DEFAULT_STREET_VIEW_USE_POLICY;
  const live: Partial<Record<BaseCapabilityKey, boolean>> = {
    image_editing: config.providers.imageEditor !== 'fixture',
    vision_analysis: config.providers.vision !== 'fixture',
    address_lookup: config.providers.address !== 'fixture',
    street_view_display: config.providers.streetView !== 'fixture',
    street_view_ai:
      config.providers.streetView !== 'fixture' &&
      config.providers.imageEditor !== 'fixture' &&
      usePolicy !== 'display_only',
  };
  return live[capability as BaseCapabilityKey] ? 'live_public' : 'fixture';
}

/**
 * Inserts missing capability rows in their default state (the per-environment profile). Rows an
 * operator changed (version 1 and above) are never overwritten; with `refreshSeeded`, rows still
 * at their seeded version 0 follow the current default, so adding or removing a provider key in
 * development switches the local capabilities on the next seed.
 */
export async function seedCapabilities(
  db: DbOrTx,
  input: {
    countryCode: string;
    keys: readonly CapabilityKey[];
    /** The state for each key. */
    state: ActivationState | ((key: CapabilityKey) => ActivationState);
    evidenceRef: string;
    now: Date;
    refreshSeeded?: boolean;
  },
): Promise<number> {
  if (input.keys.length === 0) return 0;
  const stateOf = (key: CapabilityKey) =>
    typeof input.state === 'function' ? input.state(key) : input.state;
  const result = await db
    .insertInto('countryCapabilities')
    .values(
      input.keys.map((capability) => ({
        id: newId(),
        countryCode: input.countryCode,
        capability,
        state: stateOf(capability),
        evidenceRef: input.evidenceRef,
        reviewedAt: input.now,
        reviewedBy: null,
        version: 0,
      })),
    )
    .onConflict((oc) => oc.columns(['countryCode', 'capability']).doNothing())
    .executeTakeFirst();
  let changed = Number(result.numInsertedOrUpdatedRows ?? 0);
  if (input.refreshSeeded) {
    for (const capability of input.keys) {
      const state = stateOf(capability);
      const updated = await db
        .updateTable('countryCapabilities')
        .set({ state, evidenceRef: input.evidenceRef, reviewedAt: input.now })
        .where('countryCode', '=', input.countryCode)
        .where('capability', '=', capability)
        .where('version', '=', 0)
        .where('state', '!=', state)
        .executeTakeFirst();
      changed += Number(updated.numUpdatedRows ?? 0);
    }
  }
  return changed;
}
