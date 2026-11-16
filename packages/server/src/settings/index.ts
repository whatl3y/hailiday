import { sql } from 'kysely';
import {
  type RUNTIME_SETTING_SCHEMAS,
  SCENE_TYPES,
  SPEND_CEILING_KEYS,
  runtimeSettingSchemaFor,
} from '@hailiday/core';
import type { ReviewMode, RuntimeSettingKey, SceneType, SpendCeilingKey } from '@hailiday/core';
import type { z } from 'zod';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import type { AppConfig } from '../config/index.js';
import { toJson } from '../db/client.js';
import type { Db, DbOrTx } from '../db/client.js';
import { validationFailed } from '../errors/index.js';
import { PRICE_LIST, dollarsToMicros } from '../ledger/index.js';

export type RuntimeSettingValue<K extends RuntimeSettingKey> = z.infer<
  (typeof RUNTIME_SETTING_SCHEMAS)[K]
>;

/** Providers that get per-provider pause and concurrency settings by default. */
export const KNOWN_PROVIDERS = ['fixture', 'google', 'openai', 'gemini', 'anthropic'] as const;

/**
 * Per-SKU daily ceilings (capped public rollout, in-window column of the economics spec),
 * converted from units to USD micros at list prices. A vision call counts toward its ceiling at
 * its settled cost, so its ceiling is 7,000 calls at the vision list price (`PRICE_LIST`).
 */
export const DEFAULT_SKU_DAILY_CEILINGS_MICROS: Readonly<Record<SpendCeilingKey, number>> = {
  street_view_static: 9_500 * 7_000,
  places_autocomplete_requests: 20_000 * 2_830,
  places_details_essentials: 3_000 * 5_000,
  geocoding: 6_000 * 5_000,
  image_edit_attempt: 3_700 * 130_000,
  vision_call: 7_000 * PRICE_LIST.vision_call.unitPriceMicros,
  screened_upload: 1_500 * 10_000,
  email: 3_000 * 1_000,
};

/** Default image-edit and vision provider concurrency (capped public rollout). */
const DEFAULT_PROVIDER_CONCURRENCY: Readonly<Record<string, number>> = {
  fixture: 6,
  google: 30,
  openai: 6,
  gemini: 6,
  anthropic: 12,
};

/** Converts a setting key to its environment override name (`allowance.x_y` → `ALLOWANCE_X_Y`). */
export function settingEnvName(key: string): string {
  return key.replace(/[.-]/g, '_').toUpperCase();
}

/**
 * Owner and per-IP limits one person needs to test locally: under `APP_ENV=development` these
 * replace the specified values as defaults. Staging, production and test keep the specified
 * values, and an explicit environment value (`ALLOWANCE_VARIANTS_PER_24H=3`) always wins.
 */
export const LOCAL_DEVELOPMENT_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  'allowance.variants_per_24h': 30,
  'allowance.addresses_per_24h': 30,
  'quota.attempts_per_owner_24h': 60,
  'quota.render_requests_per_device_24h': 300,
  'quota.render_requests_per_ip_24h': 300,
  'rate.sessions_per_ip_10m': 200,
});

function reviewModeDefault(config: AppConfig): Partial<Record<SceneType, ReviewMode>> {
  const mode: ReviewMode = config.isLocal ? 'sampled_audit' : 'pre_delivery';
  return Object.fromEntries(SCENE_TYPES.map((sceneType) => [sceneType, mode]));
}

/**
 * Default value of every runtime setting key, before environment overrides. Values come from the
 * owning specs: allowance and quotas (economics D-12), address-path limits (address spec), spend
 * ceilings and admission control (economics), API behavior (data-and-api). Review mode defaults to
 * `pre_delivery` outside development and test, where it is `sampled_audit` so local renders
 * deliver without a reviewer. Under `APP_ENV=development` the owner and per-IP limits take
 * `LOCAL_DEVELOPMENT_LIMITS`. Time-based deletion of projects, sources and renderings
 * (`retention.time_based_deletion`) is off: everything an owner creates is kept until it is
 * deleted for another reason; `RETENTION_TIME_BASED_DELETION=true` restores the age and
 * inactivity schedule.
 */
export function baseSettingDefaults(config: AppConfig): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    'allowance.variants_per_24h': 3,
    'allowance.addresses_per_24h': 3,
    'allowance.new_owner_variants_per_24h': null,
    'quota.attempts_per_owner_24h': 8,
    'quota.render_requests_per_device_24h': 6,
    'quota.render_requests_per_ip_24h': 6,
    'rate.suggestions_per_token': 25,
    'rate.suggestions_per_session_10m': 60,
    'rate.session_tokens_per_10m': 5,
    'rate.sessions_per_ip_10m': 20,
    'rate.resolve_per_token': 1,
    'rate.geocode_per_session_10m': 10,
    'rate.static_display_loads_per_address': 6,
    'spend.daily_micros': dollarsToMicros(700),
    'spend.monthly_micros': dollarsToMicros(15_000),
    'admission.max_queue_depth': config.admission.maxQueueDepth,
    'admission.max_wait_s': config.admission.maxWaitSeconds,
    'pause.global': false,
    'discovery.autostart_paused': false,
    'review.mode': reviewModeDefault(config),
    'review.audit_sample_rate': 0.05,
    'idempotency.retention_h': 24,
    'sse.heartbeat_s': 15,
    'poll.render_ms': 3000,
    'poll.upload_ms': 2000,
    'retention.time_based_deletion': false,
  };
  if (config.appEnv === 'development') Object.assign(defaults, LOCAL_DEVELOPMENT_LIMITS);
  for (const key of SPEND_CEILING_KEYS) {
    defaults[`spend.sku_daily_micros.${key}`] = DEFAULT_SKU_DAILY_CEILINGS_MICROS[key];
  }
  const providers = new Set<string>([
    ...KNOWN_PROVIDERS,
    ...Object.keys(config.admission.providerConcurrency),
  ]);
  for (const provider of providers) {
    defaults[`admission.provider_concurrency.${provider}`] =
      config.admission.providerConcurrency[provider] ?? DEFAULT_PROVIDER_CONCURRENCY[provider] ?? 6;
    defaults[`pause.provider.${provider}`] = false;
  }
  return defaults;
}

/** Defaults with environment overrides applied and every value validated. */
export function settingDefaults(config: AppConfig): Record<string, unknown> {
  const defaults = baseSettingDefaults(config);
  for (const key of Object.keys(defaults)) {
    const raw = config.settingOverrides[settingEnvName(key)];
    if (raw === undefined) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
    defaults[key] = value;
  }
  for (const [key, value] of Object.entries(defaults)) {
    const schema = runtimeSettingSchemaFor(key);
    if (!schema) throw new Error(`No schema for runtime setting ${key}`);
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`Invalid default for runtime setting ${key}: ${parsed.error.message}`);
    }
    defaults[key] = parsed.data;
  }
  return defaults;
}

export interface SettingRecordValue {
  key: string;
  value: unknown;
  version: number;
  updatedAt: Date | null;
  updatedBy: string | null;
  /** True when no row exists and the value is the configured default. */
  isDefault: boolean;
}

export interface RuntimeSettings {
  get<K extends RuntimeSettingKey>(key: K): Promise<RuntimeSettingValue<K>>;
  /** Any key, including patterned ones (`spend.sku_daily_micros.<sku>`, `pause.provider.<p>`). */
  getRaw(key: string): Promise<unknown>;
  getRecord(key: string): Promise<SettingRecordValue>;
  all(): Promise<SettingRecordValue[]>;
  skuDailyCeilingMicros(sku: SpendCeilingKey): Promise<number>;
  providerConcurrency(provider: string): Promise<number>;
  isProviderPaused(provider: string): Promise<boolean>;
  reviewModeFor(sceneType: SceneType): Promise<ReviewMode>;
  /**
   * Writes a value with optimistic concurrency: `expectedVersion` must equal the stored version
   * (0 when no row exists). A mismatch raises `VALIDATION_FAILED` with `reason: version_conflict`
   * and `currentVersion`. Returns the new record.
   */
  set(
    key: string,
    value: unknown,
    options: { expectedVersion: number; updatedBy?: string | null; db?: DbOrTx },
  ): Promise<SettingRecordValue>;
  /** Drops the in-process cache so the next read hits the database. */
  invalidate(): void;
  defaults(): Record<string, unknown>;
}

function validateValue(key: string, value: unknown): unknown {
  const schema = runtimeSettingSchemaFor(key);
  if (!schema) {
    throw validationFailed({ fields: [{ path: 'key', reason: 'unknown_setting' }] });
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed({
      fields: parsed.error.issues.map((issue) => ({
        path: ['value', ...issue.path].join('.'),
        reason: issue.message,
      })),
    });
  }
  return parsed.data;
}

/**
 * Typed accessors for `runtime_settings` with an in-process cache (`SETTINGS_CACHE_S`, default 30
 * seconds). A key without an operator-written row (no row, or a version-0 seed row) reads its
 * configured default, including environment overrides.
 */
export function createSettings(
  db: Db,
  options: { config: AppConfig; clock?: Clock; cacheTtlMs?: number },
): RuntimeSettings {
  const clock = options.clock ?? systemClock;
  const ttl = options.cacheTtlMs ?? options.config.settingsCacheSeconds * 1000;
  const defaults = settingDefaults(options.config);
  let cache: { loadedAt: number; rows: Map<string, SettingRecordValue> } | null = null;

  const load = async (): Promise<Map<string, SettingRecordValue>> => {
    const now = clock.now().getTime();
    if (cache && ttl > 0 && now - cache.loadedAt < ttl) return cache.rows;
    const rows = await db.selectFrom('runtimeSettings').selectAll().execute();
    const map = new Map<string, SettingRecordValue>();
    for (const row of rows) {
      map.set(row.key, {
        key: row.key,
        value: row.value,
        version: row.version,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        isDefault: false,
      });
    }
    cache = { loadedAt: now, rows: map };
    return map;
  };

  const record = async (key: string): Promise<SettingRecordValue> => {
    const rows = await load();
    const row = rows.get(key);
    if (row && row.version > 0) {
      const schema = runtimeSettingSchemaFor(key);
      const parsed = schema?.safeParse(row.value);
      if (parsed?.success) return { ...row, value: parsed.data };
    }
    if (!(key in defaults) && !runtimeSettingSchemaFor(key)) {
      throw new RangeError(`Unknown runtime setting: ${key}`);
    }
    return {
      key,
      value: defaults[key] ?? null,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      isDefault: !row || row.version === 0,
    };
  };

  const settings: RuntimeSettings = {
    async get(key) {
      return (await record(key)).value as RuntimeSettingValue<typeof key>;
    },
    async getRaw(key) {
      return (await record(key)).value;
    },
    getRecord: record,
    async all() {
      const rows = await load();
      const keys = new Set([...Object.keys(defaults), ...rows.keys()]);
      return Promise.all([...keys].sort().map((key) => record(key)));
    },
    async skuDailyCeilingMicros(sku) {
      return Number(await settings.getRaw(`spend.sku_daily_micros.${sku}`));
    },
    async providerConcurrency(provider) {
      const key = `admission.provider_concurrency.${provider.toLowerCase()}`;
      const value = (await record(key)).value;
      return typeof value === 'number' ? value : 6;
    },
    async isProviderPaused(provider) {
      const value = (await record(`pause.provider.${provider.toLowerCase()}`)).value;
      return value === true;
    },
    async reviewModeFor(sceneType) {
      const value = await settings.get('review.mode');
      return value[sceneType] ?? 'pre_delivery';
    },
    async set(key, value, setOptions) {
      const validated = validateValue(key, value);
      const target = setOptions.db ?? db;
      const now = clock.now();
      let row;
      if (setOptions.expectedVersion === 0) {
        row = await target
          .insertInto('runtimeSettings')
          .values({
            key,
            value: toJson(validated),
            version: 1,
            updatedBy: setOptions.updatedBy ?? null,
            createdAt: now,
            updatedAt: now,
          })
          .onConflict((oc) =>
            oc
              .column('key')
              .doUpdateSet({
                value: toJson(validated),
                version: sql<number>`runtime_settings.version + 1`,
                updatedBy: setOptions.updatedBy ?? null,
              })
              .where('runtimeSettings.version', '=', 0),
          )
          .returningAll()
          .executeTakeFirst();
      } else {
        row = await target
          .updateTable('runtimeSettings')
          .set({
            value: toJson(validated),
            version: sql<number>`version + 1`,
            updatedBy: setOptions.updatedBy ?? null,
          })
          .where('key', '=', key)
          .where('version', '=', setOptions.expectedVersion)
          .returningAll()
          .executeTakeFirst();
      }
      if (!row) {
        const current = await target
          .selectFrom('runtimeSettings')
          .select('version')
          .where('key', '=', key)
          .executeTakeFirst();
        throw validationFailed({
          reason: 'version_conflict',
          currentVersion: current?.version ?? 0,
        });
      }
      cache = null;
      return {
        key: row.key,
        value: row.value,
        version: row.version,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
        isDefault: false,
      };
    },
    invalidate() {
      cache = null;
    },
    defaults() {
      return { ...defaults };
    },
  };
  return settings;
}

/**
 * Writes every default key as a version-0 row so operators see the full key set. Version 0 means
 * "the configured default": readers keep using the environment value for such rows, and each seed
 * run refreshes their stored value. Rows an operator has written (version 1 and above) are never
 * touched. Returns the number of rows inserted or refreshed.
 */
export async function seedSettingDefaults(db: DbOrTx, config: AppConfig): Promise<number> {
  const defaults = settingDefaults(config);
  const entries = Object.entries(defaults);
  if (entries.length === 0) return 0;
  const result = await db
    .insertInto('runtimeSettings')
    .values(entries.map(([key, value]) => ({ key, value: toJson(value), version: 0 })))
    .onConflict((oc) =>
      oc
        .column('key')
        .doUpdateSet({ value: (eb) => eb.ref('excluded.value') })
        .where('runtimeSettings.version', '=', 0)
        .where(sql<boolean>`runtime_settings.value is distinct from excluded.value`),
    )
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}
