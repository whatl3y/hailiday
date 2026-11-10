import {
  AddressSuggestionsQuerySchema,
  AddressSuggestionsResponseSchema,
  GeocodeRequestSchema,
  GeocodeResponseSchema,
  ResolveAddressRequestSchema,
  ResolveAddressResponseSchema,
  isManualResolveRequest,
} from '@holiday/core';
import { addMs, DAY_MS } from '@holiday/server/clock';
import { toJson } from '@holiday/server/db';
import {
  AppError,
  allowanceExhausted,
  isAppError,
  providerUnavailable,
  rateLimited,
  validationFailed,
} from '@holiday/server/errors';
import { newId } from '@holiday/server/ids';
import {
  addressAllowance,
  addressPathRules,
  lockOwnerAllowance,
  type CounterState,
} from '@holiday/server/limits';
import {
  derivePropertySignals,
  type AddressProvider,
  type DestinationGeometry,
  type GeocodeSignal,
  type ResolvedPlace,
} from '@holiday/server/providers';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { enforceLimits } from '../auth/limits.js';
import { mintPlacesSessionToken, verifyPlacesSessionToken } from '../auth/places-token.js';
import { requireSession, type AuthState } from '../auth/session.js';
import { emitEvent } from '../domain/events.js';
import { holidayForNewProject } from '../domain/holidays.js';
import { projectDto, projectExpiry } from '../domain/projects.js';
import { addressProviderFor } from '../domain/sources.js';
import { assertSpendAllowed, chargeCall } from '../domain/spend.js';

/** Places coordinates may be cached for at most 30 days. */
const COORDINATE_TTL_MS = 30 * DAY_MS;
const MAX_TOKENS = 50_000;

interface TokenState {
  requests: number;
  resolves: number;
}

/**
 * Per-token request and resolve counters. Tokens themselves are verified statelessly (see
 * `verifyPlacesSessionToken`); like the other rate-limit counters these live in process memory.
 */
const registries = new WeakMap<ApiDeps, Map<string, TokenState>>();

function tokenRegistry(deps: ApiDeps): Map<string, TokenState> {
  let registry = registries.get(deps);
  if (!registry) {
    registry = new Map();
    registries.set(deps, registry);
  }
  return registry;
}

function remember(registry: Map<string, TokenState>, token: string, state: TokenState) {
  if (!registry.has(token) && registry.size >= MAX_TOKENS) {
    const oldest = registry.keys().next().value;
    if (oldest !== undefined) registry.delete(oldest);
  }
  registry.set(token, state);
}

/**
 * The counters of a session token the server minted for this session. A token it did not mint,
 * or minted for another session, answers `VALIDATION_FAILED` with reason `unknown`.
 */
function trackedToken(deps: ApiDeps, auth: AuthState, token: string, path: string): TokenState {
  if (!verifyPlacesSessionToken(deps.config.sessionSecret, auth.session.id, token)) {
    throw validationFailed({ fields: [{ path, reason: 'unknown' }] });
  }
  const registry = tokenRegistry(deps);
  let state = registry.get(token);
  if (!state) {
    state = { requests: 0, resolves: 0 };
    remember(registry, token, state);
  }
  return state;
}

/** Runs a provider call; vendor failures become `PROVIDER_UNAVAILABLE`. */
async function call<T>(provider: AddressProvider, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isAppError(error)) throw error;
    throw providerUnavailable(provider.mode === 'live' ? 'google' : 'address', error);
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Records `allowance_reached` for the addresses allowance and returns its error. */
async function addressesExhausted(deps: ApiDeps, auth: AuthState, state: CounterState) {
  await emitEvent(deps, deps.db, {
    name: 'allowance_reached',
    ownerId: auth.ownerId,
    properties: { scope: 'addresses', gateVariant: 'sheet_default' },
  });
  return allowanceExhausted('addresses', state.resetsAt, [
    'view_cached_variants',
    'save_project',
    'wait_for_reset',
  ]);
}

/** Address entry: autocomplete suggestions, resolve to a project, and manual-entry geocoding. */
export function registerAddressRoutes(app: App, deps: ApiDeps): void {
  app.get(
    '/v1/addresses/suggestions',
    {
      schema: {
        querystring: AddressSuggestionsQuerySchema,
        response: { 200: AddressSuggestionsResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const query = request.query.q.trim();
      if (query.length < 3) {
        throw validationFailed({ fields: [{ path: 'querystring.q', reason: 'too_short' }] });
      }
      const rules = await addressPathRules(deps.settings);
      let token: string;
      let state: TokenState;
      if (request.query.sessionToken) {
        token = request.query.sessionToken.toLowerCase();
        state = trackedToken(deps, auth, token, 'querystring.sessionToken');
      } else {
        enforceLimits(deps, reply, 'session_tokens', [
          { rule: rules.sessionTokens, key: `session:${auth.session.id}` },
        ]);
        token = mintPlacesSessionToken(deps.config.sessionSecret, auth.session.id);
        state = trackedToken(deps, auth, token, 'querystring.sessionToken');
      }
      if (state.resolves > 0) {
        throw validationFailed({
          fields: [{ path: 'querystring.sessionToken', reason: 'retired' }],
        });
      }
      if (state.requests >= rules.suggestionsPerToken) throw rateLimited('suggestions', null);
      enforceLimits(deps, reply, 'suggestions', [
        { rule: rules.suggestionsPerSession, key: `session:${auth.session.id}` },
      ]);
      state.requests += 1;

      const provider = await addressProviderFor(deps, auth.audience);
      const isFixture = provider.mode === 'fixture';
      await assertSpendAllowed(deps, ['places_autocomplete_requests'], isFixture);
      const result = await call(provider, () => provider.suggest({ query, sessionToken: token }));
      if (result.called) {
        await chargeCall(deps, deps.db, {
          sku: 'places_autocomplete_requests',
          provider: provider.providerId,
          isFixture,
          ownerId: auth.ownerId,
          sessionId: auth.session.id,
          stage: 'suggestions',
        });
      }
      return { sessionToken: token, suggestions: result.suggestions };
    },
  );

  app.post(
    '/v1/addresses/resolve',
    {
      schema: {
        body: ResolveAddressRequestSchema,
        response: { 201: ResolveAddressResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const body = request.body;
      const now = deps.clock.now();
      const rules = await addressPathRules(deps.settings);
      const manual = isManualResolveRequest(body);

      let tokenState: TokenState | undefined;
      if (!manual) {
        tokenState = trackedToken(deps, auth, body.sessionToken.toLowerCase(), 'body.sessionToken');
        if (tokenState.resolves >= rules.resolvePerToken) throw rateLimited('resolve', null);
      }

      const allowance = await addressAllowance(deps.db, deps.settings, {
        ownerId: auth.ownerId,
        now,
      });
      if (allowance.exhausted) throw await addressesExhausted(deps, auth, allowance);

      const provider = await addressProviderFor(deps, auth.audience);
      const isFixture = provider.mode === 'fixture';
      const ledger = (sku: Parameters<typeof chargeCall>[2]['sku'], projectId: string | null) =>
        chargeCall(deps, deps.db, {
          sku,
          provider: provider.providerId,
          isFixture,
          ownerId: auth.ownerId,
          sessionId: auth.session.id,
          projectId,
          stage: 'resolve',
        });

      let resolved: ResolvedPlace | null = null;
      let geocode: GeocodeSignal | null;
      let destinations: DestinationGeometry | null;
      let placeId: string;
      let unit: string | null = null;
      if (manual) {
        const payload = provider.verifyCandidate(body.candidateId, {
          sessionId: auth.session.id,
          now,
        });
        if (!payload) {
          throw validationFailed({
            reason: 'expired',
            fields: [{ path: 'body.candidateId', reason: 'invalid_or_expired' }],
          });
        }
        await assertSpendAllowed(deps, ['geocoding_search_destinations'], isFixture);
        placeId = payload.placeId;
        unit = payload.unit;
        geocode = {
          placeId: payload.placeId,
          formattedAddress: payload.formattedAddress,
          addressComponents: [],
          countryCode: payload.countryCode,
          location: payload.location,
          locationType: payload.locationType,
          partialMatch: payload.partialMatch,
          types: payload.types,
        };
        if (payload.countryCode !== 'US') {
          throw new AppError('ADDRESS_OUT_OF_SCOPE', { countryCode: payload.countryCode });
        }
        destinations = await call(provider, () => provider.searchDestinations(payload.placeId));
        await ledger('geocoding_search_destinations', null);
      } else {
        await assertSpendAllowed(
          deps,
          ['places_details_essentials', 'geocoding', 'geocoding_search_destinations'],
          isFixture,
        );
        if (tokenState) tokenState.resolves += 1;
        placeId = body.placeId;
        resolved = await call(provider, () =>
          provider.resolve({ placeId: body.placeId, sessionToken: body.sessionToken }),
        );
        await ledger('places_details_essentials', null);
        if (!resolved) throw new AppError('ADDRESS_NOT_FOUND', {});
        if (resolved.countryCode !== 'US') {
          throw new AppError('ADDRESS_OUT_OF_SCOPE', { countryCode: resolved.countryCode });
        }
        geocode = await call(provider, () => provider.geocodeByPlaceId(body.placeId));
        await ledger('geocoding', null);
        destinations = await call(provider, () => provider.searchDestinations(body.placeId));
        await ledger('geocoding_search_destinations', null);
      }

      const signals = derivePropertySignals({
        resolved,
        geocode,
        destinations,
        entryMethod: manual ? 'manual' : 'autocomplete',
        unit,
      });
      if (!signals.inScope) {
        throw new AppError('ADDRESS_OUT_OF_SCOPE', { countryCode: signals.countryCode });
      }
      const formattedAddress = resolved?.formattedAddress ?? geocode?.formattedAddress ?? null;
      const holidayId = await holidayForNewProject(deps, body.holidayId ?? null);
      const signedIn = auth.user !== null;

      // Under the owner's allowance lock, re-count on the transaction so parallel resolves never
      // create more address projects than the allowance admits. The clock is read again once the
      // lock is held, so projects committed by requests that were ahead in the queue fall inside
      // the window, and the new project is stamped with that reading. Only `trx` is used inside.
      const project = await deps.db.transaction().execute(async (trx) => {
        await lockOwnerAllowance(trx, auth.ownerId);
        const lockedNow = deps.clock.now();
        const locked = await addressAllowance(trx, deps.settings, {
          ownerId: auth.ownerId,
          now: lockedNow,
          limit: allowance.limit,
        });
        if (locked.exhausted) return { refused: locked } as const;
        const propertyId = newId();
        await trx
          .insertInto('properties')
          .values({
            id: propertyId,
            ownerId: auth.ownerId,
            placeId,
            placeIdRefreshedAt: now,
            countryCode: 'US',
            entryMethod: manual ? 'manual' : 'autocomplete',
            precision: signals.precision,
            precisionSource: signals.precisionSource,
            partialMatch: signals.partialMatch,
            placeTypes: signals.placeTypes,
            multiUnit: signals.multiUnit,
            unitDesignation: unit,
            geometryAvailable: signals.geometryAvailable,
            facadeWidthM: signals.facadeWidthM,
            entranceOffsetM: signals.entranceOffsetM,
            roadBearingDeg: signals.roadBearingDeg,
            facadeNormalDeg: signals.facadeNormalDeg,
            attachedFacade: signals.attachedFacade,
            structureType: signals.structureType,
            targetLat: round6(signals.targetPoint.latitude),
            targetLng: round6(signals.targetPoint.longitude),
            coordsSource: manual ? 'geocoding' : 'places',
            coordsExpireAt: addMs(now, COORDINATE_TTL_MS),
            displayAddress: manual ? formattedAddress : null,
            displayAddressBasis: manual ? 'manual_entry' : 'autocomplete_transient',
            displayAddressStoredAt: manual ? now : null,
            manualEntry: manual ? toJson({ formattedAddress, unit }) : null,
          })
          .execute();
        const projectId = newId();
        const shell = { createdAt: lockedNow, savedAt: signedIn ? lockedNow : null };
        return trx
          .insertInto('projects')
          .values({
            id: projectId,
            ownerId: auth.ownerId,
            kind: 'address',
            propertyId,
            projectVersion: 0,
            holidayId,
            sceneType: signals.multiUnit ? null : 'house_exterior',
            buildingForm: signals.multiUnit
              ? null
              : signals.attachedFacade
                ? 'attached'
                : 'detached',
            savedAt: shell.savedAt,
            lastActivityAt: lockedNow,
            expiresAt: projectExpiry(shell, lockedNow),
            createdAt: lockedNow,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      });
      if ('refused' in project) throw await addressesExhausted(deps, auth, project.refused);
      await deps.db
        .updateTable('usageLedger')
        .set({ projectId: project.id })
        .where('sessionId', '=', auth.session.id)
        .where('projectId', 'is', null)
        .where('stage', '=', 'resolve')
        .where('createdAt', '>=', now)
        .execute();

      if (!manual) {
        await emitEvent(deps, deps.db, {
          name: 'address_selected',
          ownerId: auth.ownerId,
          holidayId,
          properties: {
            entryMethod: 'autocomplete',
            suggestionRank: null,
            precision: signals.precision,
            multiUnit: signals.multiUnit,
          },
          fixture: isFixture,
        });
      }
      reply.code(201);
      return { project: await projectDto(deps, auth, project, { formattedAddress }) };
    },
  );

  app.post(
    '/v1/addresses/geocode',
    { schema: { body: GeocodeRequestSchema, response: { 200: GeocodeResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const rules = await addressPathRules(deps.settings);
      enforceLimits(deps, reply, 'geocode', [
        { rule: rules.geocodePerSession, key: `session:${auth.session.id}` },
      ]);
      const provider = await addressProviderFor(deps, auth.audience);
      const isFixture = provider.mode === 'fixture';
      await assertSpendAllowed(deps, ['geocoding'], isFixture);
      const results = await call(provider, () =>
        provider.geocode(request.body, { sessionId: auth.session.id, now: deps.clock.now() }),
      );
      await chargeCall(deps, deps.db, {
        sku: 'geocoding',
        provider: provider.providerId,
        isFixture,
        ownerId: auth.ownerId,
        sessionId: auth.session.id,
        stage: 'geocode',
      });
      const inScope = results.filter((result) => result.payload.countryCode === 'US');
      await emitManual(deps, auth, inScope, isFixture);
      if (results.length === 0) throw new AppError('ADDRESS_NOT_FOUND', {});
      if (inScope.length === 0) {
        throw new AppError('ADDRESS_OUT_OF_SCOPE', {
          countryCode: results[0]?.payload.countryCode ?? null,
        });
      }
      return { candidates: inScope.map((result) => result.candidate) };
    },
  );
}

async function emitManual(
  deps: ApiDeps,
  auth: AuthState,
  results: { payload: { precision: string; partialMatch: boolean } }[],
  fixture: boolean,
): Promise<void> {
  const first = results[0]?.payload;
  await emitEvent(deps, deps.db, {
    name: 'address_manual_submitted',
    ownerId: auth.ownerId,
    properties: {
      candidateCount: results.length,
      precision: first?.precision ?? null,
      partialMatch: first?.partialMatch ?? null,
    },
    fixture,
  });
}
