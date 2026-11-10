import { sql } from '@holiday/server/db';
import {
  CreateProjectRequestSchema,
  DEFAULT_SCENE_TYPE_AUTO_ACCEPT,
  DeleteProjectResponseSchema,
  IdParamsSchema,
  ProjectListQuerySchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  PutSourceRequestSchema,
  SourceDiscoveryRequestSchema,
  SourceDiscoveryResponseSchema,
  VariantListResponseSchema,
  ViewpointRequestSchema,
  ViewpointResponseSchema,
  distanceBucket,
  isCandidateSourceRequest,
  isNudgeWithinBounds,
  type NormalizedBox,
} from '@holiday/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { isUniqueViolation, toJson, type Project, type Property } from '@holiday/server/db';
import { AppError, notFound, validationFailed } from '@holiday/server/errors';
import { isUuidV7, newId, uuidV7Timestamp } from '@holiday/server/ids';
import { consumeDisplayLoads } from '@holiday/server/limits';
import {
  createAssetPolicy,
  defaultPolicyTemplate,
  recordPermissionEvaluation,
  streetViewSourceMode,
} from '@holiday/server/policy';
import {
  completeProjectDeletion,
  createCroppedChild,
  deleteProject,
  deleteSharePublicObjects,
} from '@holiday/server/pipeline';
import {
  DEFAULT_MATCH_THRESHOLDS,
  DISCOVERY_ALGORITHM_VERSION,
  captureGranularityOf,
  copyrightClassOf,
  decideMatch,
  type DiscoveryResult,
} from '@holiday/server/providers';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { decodeCursor } from '../http/cursor.js';
import { enforceEndpointLimit } from '../auth/limits.js';
import { requireSession, type AuthState } from '../auth/session.js';
import {
  asStoredCandidates,
  bindCandidate,
  candidateDto,
  coordinateExpiry,
  discoveryDto,
  issuedDisplayUrl,
  storedCandidateOf,
  type StoredCandidate,
  type StoredSignals,
} from '../domain/discovery.js';
import { emitEvent, onceEventId } from '../domain/events.js';
import { holidayForNewProject } from '../domain/holidays.js';
import {
  activeJobOf,
  latestDiscovery,
  loadOwnedProject,
  loadSource,
  offeredFor,
  projectDto,
  projectExpiry,
  supersedeActiveJob,
} from '../domain/projects.js';
import { renderStatus, variantDto } from '../domain/renders.js';
import {
  addressProviderFor,
  evaluateFor,
  streetViewCandidatePolicy,
  streetViewProviderFor,
} from '../domain/sources.js';
import { assertSpendAllowed, chargeCall } from '../domain/spend.js';

const NUDGE_FOV_RANGE = { min: 60, max: 90 } as const;

function stale(current: number): AppError<'STALE_PROJECT_VERSION'> {
  return new AppError('STALE_PROJECT_VERSION', { currentProjectVersion: current });
}

function encodeCursor(project: Project): string {
  return Buffer.from(JSON.stringify([project.lastActivityAt.toISOString(), project.id])).toString(
    'base64url',
  );
}

async function loadProperty(deps: ApiDeps, project: Project): Promise<Property> {
  if (!project.propertyId) {
    throw validationFailed({ fields: [{ path: 'project', reason: 'not_an_address_project' }] });
  }
  return deps.db
    .selectFrom('properties')
    .selectAll()
    .where('id', '=', project.propertyId)
    .executeTakeFirstOrThrow();
}

/**
 * Reports a user's project deletion as `project_deleted`, once per deletion request: the event ID
 * derives from the request, so every call that reports the same deletion (concurrent requests
 * that find it held, a repeated request that completes it) records one event.
 */
async function emitProjectDeleted(
  deps: ApiDeps,
  input: { ownerId: string; project: Project; deletionRequestId: string; variantCount: number },
): Promise<void> {
  const at = isUuidV7(input.deletionRequestId)
    ? uuidV7Timestamp(input.deletionRequestId)
    : new Date(0);
  await emitEvent(deps, deps.db, {
    name: 'project_deleted',
    id: onceEventId('project_deleted', input.deletionRequestId, at),
    ownerId: input.ownerId,
    holidayId: input.project.holidayId,
    properties: { scope: 'project', variantCount: input.variantCount },
  });
}

/**
 * The variants a project has as its deletion starts: those not deleted, and those a deletion
 * request still in progress marked deleted when it revoked access (a concurrent or interrupted
 * deletion of the same project has already marked them, and its completion removes the rows).
 */
async function variantsAtDeletion(deps: ApiDeps, projectId: string): Promise<number> {
  const row = await deps.db
    .selectFrom('renderAssets')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('projectId', '=', projectId)
    .where((eb) =>
      eb.or([
        eb('deletedAt', 'is', null),
        eb(
          'deletedAt',
          'in',
          eb
            .selectFrom('deletionRequests')
            .select('accessRevokedAt')
            .where('targetId', '=', projectId)
            .where('status', '!=', 'completed'),
        ),
      ]),
    )
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Issues one display URL against the property's display budget and ledgers it. */
async function issueDisplayLoad(
  deps: ApiDeps,
  auth: AuthState,
  input: { property: Property; projectId: string; isFixture: boolean },
): Promise<number> {
  const limit = await deps.settings.get('rate.static_display_loads_per_address');
  const remaining = await consumeDisplayLoads(deps.db, {
    propertyId: input.property.id,
    limit,
  });
  await chargeCall(deps, deps.db, {
    sku: 'street_view_static_display',
    provider: input.isFixture ? 'fixture-street-view' : 'google',
    isFixture: input.isFixture,
    ownerId: auth.ownerId,
    sessionId: auth.session.id,
    projectId: input.projectId,
    stage: 'display',
  });
  return remaining;
}

/** Projects, discovery, source binding, viewpoint adjustment and the variant list. */
export function registerProjectRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/projects',
    { schema: { body: CreateProjectRequestSchema, response: { 201: ProjectResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      enforceEndpointLimit(deps, request, reply, 'projects', { auth });
      const now = deps.clock.now();
      const holidayId = await holidayForNewProject(deps, request.body.holidayId ?? null);
      const shell = { createdAt: now, savedAt: auth.user ? now : null };
      const project = await deps.db
        .insertInto('projects')
        .values({
          id: newId(),
          ownerId: auth.ownerId,
          kind: 'upload',
          holidayId,
          sceneType: request.body.sceneType ?? null,
          savedAt: shell.savedAt,
          lastActivityAt: now,
          expiresAt: projectExpiry(shell, now),
          createdAt: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      reply.code(201);
      return { project: await projectDto(deps, auth, project) };
    },
  );

  app.get(
    '/v1/projects',
    {
      schema: { querystring: ProjectListQuerySchema, response: { 200: ProjectListResponseSchema } },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const cursor = decodeCursor(request.query.cursor);
      let query = deps.db
        .selectFrom('projects')
        .selectAll()
        .where('ownerId', '=', auth.ownerId)
        .where('deletedAt', 'is', null);
      if (cursor) {
        query = query.where(
          sql<boolean>`(last_activity_at, id) < (${cursor[0]}, ${cursor[1]}::uuid)`,
        );
      }
      const rows = await query
        .orderBy('lastActivityAt', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit + 1)
        .execute();
      const page = rows.slice(0, request.query.limit);
      const items = [];
      for (const project of page) items.push(await projectDto(deps, auth, project));
      const last = page[page.length - 1];
      return {
        items,
        nextCursor: rows.length > request.query.limit && last ? encodeCursor(last) : null,
      };
    },
  );

  app.get(
    '/v1/projects/:id',
    { schema: { params: IdParamsSchema, response: { 200: ProjectResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const project = await loadOwnedProject(deps, auth, request.params.id);
      return { project: await projectDto(deps, auth, project) };
    },
  );

  app.delete(
    '/v1/projects/:id',
    { schema: { params: IdParamsSchema, response: { 202: DeleteProjectResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const project = await deps.db
        .selectFrom('projects')
        .selectAll()
        .where('id', '=', request.params.id)
        .where('ownerId', '=', auth.ownerId)
        .executeTakeFirst();
      if (!project || project.deletedAt) {
        const previous = await deps.db
          .selectFrom('deletionRequests')
          .select(['id', 'status', 'scope'])
          .where('targetId', '=', request.params.id)
          .where('ownerId', '=', auth.ownerId)
          .orderBy('createdAt', 'desc')
          .executeTakeFirst();
        if (!previous) throw notFound();
        reply.code(202);
        // A deletion that did not finish is completed by repeating the request.
        if (project && previous.status !== 'completed' && previous.status !== 'held') {
          const variantCount = await variantsAtDeletion(deps, project.id);
          const resumed = await completeProjectDeletion(deps.pipeline, {
            project,
            requestId: previous.id,
            scope: previous.scope,
          });
          if (previous.scope === 'project' && (resumed.removedRows || resumed.status === 'held')) {
            await emitProjectDeleted(deps, {
              ownerId: auth.ownerId,
              project,
              deletionRequestId: previous.id,
              variantCount,
            });
          }
          return {
            deletionRequestId: previous.id,
            status: resumed.status === 'held' ? ('held' as const) : ('completed' as const),
          };
        }
        return { deletionRequestId: previous.id, status: previous.status };
      }
      const variantCount = await variantsAtDeletion(deps, project.id);
      const result = await deleteProject(deps.pipeline, {
        project,
        scope: 'project',
        requestedBy: 'user',
      });
      // A concurrent request that joined the same deletion and found the rows gone or the request
      // completed reports nothing; one that found it held reports the same event ID.
      if (result.removedRows || result.status === 'held') {
        await emitProjectDeleted(deps, {
          ownerId: auth.ownerId,
          project,
          deletionRequestId: result.deletionRequestId,
          variantCount,
        });
      }
      reply.code(202);
      return {
        deletionRequestId: result.deletionRequestId,
        status: result.status === 'held' ? ('held' as const) : ('completed' as const),
      };
    },
  );

  app.post(
    '/v1/projects/:id/source-discovery',
    {
      schema: {
        params: IdParamsSchema,
        body: SourceDiscoveryRequestSchema,
        response: { 200: SourceDiscoveryResponseSchema },
      },
    },
    async (request, reply) => runDiscovery(deps, request, reply),
  );

  app.put(
    '/v1/projects/:id/source',
    {
      schema: {
        params: IdParamsSchema,
        body: PutSourceRequestSchema,
        response: { 200: ProjectResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const project = await loadOwnedProject(deps, auth, request.params.id);
      const body = request.body;
      if (body.projectVersion !== project.projectVersion) throw stale(project.projectVersion);
      const updated = isCandidateSourceRequest(body)
        ? await bindStreetView(deps, auth, project, body)
        : await bindUpload(deps, auth, project, body);
      return { project: await projectDto(deps, auth, updated) };
    },
  );

  app.put(
    '/v1/projects/:id/viewpoint',
    {
      schema: {
        params: IdParamsSchema,
        body: ViewpointRequestSchema,
        response: { 200: ViewpointResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const project = await loadOwnedProject(deps, auth, request.params.id);
      const body = request.body;
      if (body.projectVersion !== project.projectVersion) throw stale(project.projectVersion);
      const discovery = await latestDiscovery(deps, project.id);
      const candidates = discovery ? asStoredCandidates(discovery.candidates) : [];
      if (!discovery || candidates.length === 0 || discovery.matchClass === 'skip_to_upload') {
        throw new AppError('NO_STREET_VIEW', {});
      }
      const base = candidates.find((candidate) => candidate.candidateId === body.candidateId);
      if (!base) {
        throw validationFailed({ fields: [{ path: 'body.candidateId', reason: 'unknown' }] });
      }
      const provider = await streetViewProviderFor(deps, auth.audience);
      if (!provider) throw new AppError('NO_STREET_VIEW', {});
      const property = await loadProperty(deps, project);
      const isFixture = provider.mode === 'fixture';
      const limit = await deps.settings.get('rate.static_display_loads_per_address');

      let target: StoredCandidate;
      let changed = false;
      if (!body.nudge) {
        target = base;
        if (!base.displayUrlIssuedAt) {
          await assertSpendAllowed(deps, ['street_view_static_display'], isFixture);
          await issueDisplayLoad(deps, auth, { property, projectId: project.id, isFixture });
          target = { ...base, displayUrlIssuedAt: deps.clock.now().toISOString() };
          changed = true;
        }
      } else {
        const root = base.derivedFromCandidateId
          ? (candidates.find(
              (candidate) => candidate.candidateId === base.derivedFromCandidateId,
            ) ?? base)
          : base;
        const nudge = body.nudge;
        const fovOk = nudge.fov >= NUDGE_FOV_RANGE.min && nudge.fov <= NUDGE_FOV_RANGE.max;
        if (!isNudgeWithinBounds(nudge) || !fovOk) {
          throw validationFailed({ fields: [{ path: 'body.nudge', reason: 'out_of_bounds' }] });
        }
        const heading = (((root.heading + nudge.headingDelta) % 360) + 360) % 360;
        const existing = candidates.find(
          (candidate) =>
            candidate.derivedFromCandidateId === root.candidateId &&
            Math.abs(candidate.heading - heading) < 0.05 &&
            candidate.fov === nudge.fov,
        );
        if (existing?.displayUrlIssuedAt) {
          target = existing;
        } else {
          await assertSpendAllowed(deps, ['street_view_static_display'], isFixture);
          await issueDisplayLoad(deps, auth, { property, projectId: project.id, isFixture });
          target = {
            ...root,
            candidateId: existing?.candidateId ?? newId(),
            derivedFromCandidateId: root.candidateId,
            isPrimary: false,
            heading,
            fov: nudge.fov,
            displayUrlIssuedAt: deps.clock.now().toISOString(),
          };
          changed = true;
        }
      }
      if (changed) {
        const next = candidates.some((candidate) => candidate.candidateId === target.candidateId)
          ? candidates.map((candidate) =>
              candidate.candidateId === target.candidateId ? target : candidate,
            )
          : [...candidates, target];
        await deps.db
          .updateTable('sourceDiscoveries')
          .set({ candidates: toJson(next) })
          .where('id', '=', discovery.id)
          .execute();
      }
      const fresh = await deps.db
        .selectFrom('properties')
        .select('displayLoadsIssued')
        .where('id', '=', property.id)
        .executeTakeFirstOrThrow();
      return {
        candidate: candidateDto(target, issuedDisplayUrl(provider, target)),
        remainingDisplayLoads: Math.max(0, limit - fresh.displayLoadsIssued),
      };
    },
  );

  app.get(
    '/v1/projects/:id/variants',
    { schema: { params: IdParamsSchema, response: { 200: VariantListResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const project = await loadOwnedProject(deps, auth, request.params.id);
      const assets = await deps.db
        .selectFrom('renderAssets')
        .selectAll()
        .where('projectId', '=', project.id)
        .where('deletedAt', 'is', null)
        .where('withdrawnAt', 'is', null)
        .orderBy('createdAt', 'desc')
        .execute();
      const items = [];
      for (const asset of assets) {
        items.push(
          await variantDto(deps, auth, asset, await loadSource(deps, asset.sourceAssetId)),
        );
      }
      const active = await activeJobOf(deps, project.id);
      const source = await loadSource(deps, project.activeSourceAssetId);
      return {
        items,
        activeRender: active ? await renderStatus(deps, auth, active) : null,
        offered: await offeredFor(deps, project, source, project.holidayId),
      };
    },
  );
}

/**
 * `POST /v1/projects/:id/source-discovery`: one completed discovery per project version (a repeat
 * replays the stored result with no provider call), free metadata probes only, Tier A signals and
 * the match decision; the primary candidate's display URL is issued against the display budget;
 * an `auto_start` in `persist` or `transient` mode binds the primary as the active source.
 */
async function runDiscovery(
  deps: ApiDeps,
  request: FastifyRequest<{ Params: { id: string }; Body: { projectVersion: number } }>,
  reply: FastifyReply,
) {
  const auth = await requireSession(deps, request, reply);
  let project = await loadOwnedProject(deps, auth, request.params.id);
  const version = request.body.projectVersion;
  const property = await loadProperty(deps, project);

  const replay = async () => {
    const row = await deps.db
      .selectFrom('sourceDiscoveries')
      .selectAll()
      .where('projectId', '=', project.id)
      .where('projectVersion', '=', version)
      .executeTakeFirst();
    if (!row) return null;
    const newer = await deps.db
      .selectFrom('sourceDiscoveries')
      .select('id')
      .where('projectId', '=', project.id)
      .where('projectVersion', '>', version)
      .executeTakeFirst();
    const bound = (row.signals as StoredSignals).boundSourceAssetId ?? null;
    const current =
      project.projectVersion === version ||
      (bound !== null && bound === project.activeSourceAssetId);
    if (newer || !current) return null;
    const fresh = await loadOwnedProject(deps, auth, project.id);
    const freshProperty = await loadProperty(deps, fresh);
    return {
      discovery: await discoveryDto(deps, auth, row, freshProperty),
      project: await projectDto(deps, auth, fresh),
    };
  };

  const replayed = await replay();
  if (replayed) return replayed;
  if (version !== project.projectVersion) throw stale(project.projectVersion);

  const now = deps.clock.now();
  const started = Date.now();
  const streetView = await streetViewProviderFor(deps, auth.audience);
  const isFixture = streetView ? streetView.mode === 'fixture' : true;
  await assertSpendAllowed(deps, ['street_view_static_display'], isFixture);

  const blocked = await deps.db
    .selectFrom('blockedAddresses')
    .select('id')
    .where('placeId', '=', property.placeId)
    .where('removedAt', 'is', null)
    .where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)]))
    .executeTakeFirst();

  let target =
    property.targetLat !== null && property.targetLng !== null
      ? { latitude: property.targetLat, longitude: property.targetLng }
      : null;
  const redProperty =
    blocked !== undefined ||
    property.multiUnit ||
    property.precision === 'low' ||
    property.countryCode.trim() !== 'US';
  if (!target && !redProperty && streetView) {
    const address = await addressProviderFor(deps, auth.audience);
    const signal = await address.geocodeByPlaceId(property.placeId).catch(() => null);
    await chargeCall(deps, deps.db, {
      sku: 'geocoding',
      provider: address.providerId,
      isFixture: address.mode === 'fixture',
      ownerId: auth.ownerId,
      sessionId: auth.session.id,
      projectId: project.id,
      stage: 'discovery',
    });
    if (signal) {
      target = signal.location;
      await deps.db
        .updateTable('properties')
        .set({
          targetLat: Math.round(signal.location.latitude * 1e6) / 1e6,
          targetLng: Math.round(signal.location.longitude * 1e6) / 1e6,
          coordsSource: 'geocoding',
          coordsExpireAt: coordinateExpiry(now),
        })
        .where('id', '=', property.id)
        .execute();
    }
  }

  let result: DiscoveryResult = {
    status: 'no_imagery',
    candidates: [],
    probeRadiusM: null,
    deepSetback: false,
    metadataCalls: 0,
    durationMs: 0,
    timedOut: false,
  };
  if (!redProperty && streetView && target) {
    try {
      result = await streetView.discoverCandidates(
        {
          target,
          geometryAvailable: property.geometryAvailable,
          facadeWidthM: property.facadeWidthM,
          roadBearingDeg: property.roadBearingDeg,
          facadeNormalDeg: property.facadeNormalDeg,
          attachedFacade: property.attachedFacade,
        },
        { budgetMs: DEFAULT_MATCH_THRESHOLDS.discoveryBudgetMs },
      );
    } catch (error) {
      deps.logger.warn({ err: error }, 'street view discovery failed');
      result = { ...result, status: 'error' };
    }
  } else if (!redProperty && !target) {
    result = { ...result, status: 'error' };
  }

  const discoveryId = newId();
  const ranked = [...result.candidates].sort((a, b) => a.rank - b.rank).slice(0, 3);
  const primary = ranked.find((candidate) => candidate.isPrimary) ?? ranked[0] ?? null;

  let sourceMode: 'persist' | 'transient' | 'display_only' | 'unavailable' = 'unavailable';
  if (primary && streetView) {
    const policy = await createAssetPolicy(deps.db, {
      subjectKind: 'source_asset',
      subjectId: discoveryId,
      template: defaultPolicyTemplate('street_view', { attributionText: 'Google Maps' }),
    });
    const evaluated = await evaluateFor(deps, {
      policyId: policy.id,
      kind: 'street_view',
      isGoogleImagery: primary.isGoogleImagery,
      audience: auth.audience,
    });
    await recordPermissionEvaluation(
      deps.db,
      {
        assetPolicyId: policy.id,
        sourceAssetId: null,
        context: 'discovery',
        result: evaluated.permission,
        capabilityState: evaluated.capabilityState,
        evaluatedAt: now,
      },
      deps.clock,
    );
    sourceMode = streetViewSourceMode(evaluated.permission);
  }

  const decision = decideMatch({
    countryCode: property.countryCode.trim(),
    blockedAddress: blocked !== undefined,
    multiUnit: property.multiUnit,
    precision: property.precision,
    partialMatch: property.partialMatch,
    structureType: property.structureType,
    discoveryStatus: result.status,
    probeRadiusM: result.probeRadiusM,
    primaryDistanceM: primary?.distanceM ?? null,
    headingMode: primary?.headingMode ?? null,
    facadeWidthM: property.facadeWidthM,
    attachedFacade: property.attachedFacade,
    captureDate: primary?.captureDate ?? null,
    captureGranularity: primary ? captureGranularityOf(primary.captureDate) : null,
    copyrightClass: primary ? copyrightClassOf(primary.copyright) : null,
    entryMethod: property.entryMethod,
    sourceMode,
    autostartPaused: await deps.settings.get('discovery.autostart_paused'),
    now,
  });

  const stored = decision.matchClass === 'skip_to_upload' ? [] : ranked.map(storedCandidateOf);
  const primaryStored = stored.find((candidate) => candidate.isPrimary) ?? stored[0] ?? null;
  if (primaryStored && sourceMode !== 'unavailable') {
    try {
      await issueDisplayLoad(deps, auth, { property, projectId: project.id, isFixture });
      primaryStored.displayUrlIssuedAt = now.toISOString();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'RATE_LIMITED') throw error;
    }
  }
  const bind =
    decision.matchClass === 'auto_start' &&
    (sourceMode === 'persist' || sourceMode === 'transient') &&
    primaryStored !== null;

  const signals: StoredSignals = {
    tierA: decision.signals,
    amber: decision.amber,
    red: decision.red,
    autostartPaused: decision.autostartPaused,
    precisionClass: property.precision,
    precisionSource: property.precisionSource,
    partialMatch: property.partialMatch,
    multiUnit: property.multiUnit,
    geometryAvailable: property.geometryAvailable,
    blockedAddress: blocked !== undefined,
    probeRadiusM: result.probeRadiusM,
    candidateCount: stored.length,
    primaryDistanceM: primary?.distanceM ?? null,
    primaryCaptureDate: primary?.captureDate ?? null,
    primaryCaptureGranularity: primary ? captureGranularityOf(primary.captureDate) : null,
    primaryCopyrightClass: primary ? copyrightClassOf(primary.copyright) : null,
    deepSetback: result.deepSetback,
    attachedFacade: property.attachedFacade,
    headingMode: primary?.headingMode ?? null,
    estimatedFacadePx: primary?.estimatedFacadePx ?? null,
    timedOut: result.timedOut,
    metadataCalls: result.metadataCalls,
    boundSourceAssetId: null,
  };
  const durationMs = Date.now() - started;

  let boundSourceId: string | null = null;
  try {
    await deps.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('sourceDiscoveries')
        .values({
          id: discoveryId,
          projectId: project.id,
          projectVersion: version,
          entryMethod: property.entryMethod,
          matchClass: decision.matchClass,
          reason: decision.reason,
          retryable: decision.retryable,
          sourceMode,
          thresholdsVersion: decision.thresholdsVersion,
          algorithmVersion: DISCOVERY_ALGORITHM_VERSION,
          candidates: toJson(stored),
          signals: toJson(signals),
          providerCalls: toJson({ street_view_metadata: result.metadataCalls }),
          durationMs,
        })
        .returning('id')
        .executeTakeFirst();
      if (!inserted) throw new Error('discovery not written');
      if (bind && primaryStored) {
        const bound = await bindCandidate(deps, trx, {
          project,
          expectedVersion: version,
          candidate: primaryStored,
          streetViewMode: sourceMode,
          attachedFacade: property.attachedFacade,
        });
        boundSourceId = bound.source.id;
        await trx
          .updateTable('sourceDiscoveries')
          .set({ signals: toJson({ ...signals, boundSourceAssetId: bound.source.id }) })
          .where('id', '=', discoveryId)
          .execute();
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw error;
  }

  if (result.metadataCalls > 0) {
    await chargeCall(deps, deps.db, {
      sku: 'street_view_metadata',
      provider: streetView?.providerId ?? 'google',
      isFixture,
      ownerId: auth.ownerId,
      sessionId: auth.session.id,
      projectId: project.id,
      units: result.metadataCalls,
      stage: 'discovery',
    });
  }
  if (boundSourceId) await supersedeActiveJob(deps, project.id).catch(() => null);

  await emitEvent(deps, deps.db, {
    name: 'source_discovery_completed',
    ownerId: auth.ownerId,
    holidayId: project.holidayId,
    sourceKind: 'street_view',
    properties: {
      matchClass: decision.matchClass,
      reason: decision.reason,
      sourceMode,
      candidateCount: stored.length,
      durationMs,
      isGoogleImagery: primary?.isGoogleImagery ?? null,
      distanceBucket: distanceBucket(primary?.distanceM ?? null),
    },
    fixture: isFixture,
  });
  if (decision.matchClass === 'skip_to_upload' && decision.reason) {
    if (decision.reason === 'no_imagery') {
      await emitEvent(deps, deps.db, {
        name: 'source_unavailable',
        ownerId: auth.ownerId,
        properties: { reason: decision.reason },
        fixture: isFixture,
      });
    }
    await emitEvent(deps, deps.db, {
      name: 'photo_prompt_shown',
      ownerId: auth.ownerId,
      properties: { context: decision.reason === 'no_imagery' ? 'no_imagery' : 'skip_to_upload' },
      fixture: isFixture,
    });
  }
  if (boundSourceId) {
    await emitEvent(deps, deps.db, {
      name: 'source_confirmed',
      ownerId: auth.ownerId,
      holidayId: project.holidayId,
      sourceKind: 'street_view',
      properties: {
        sourceKind: 'street_view',
        candidateRank: 1,
        nudged: false,
        cropApplied: false,
        privateOnly: false,
      },
      fixture: isFixture,
    });
  }

  project = await loadOwnedProject(deps, auth, project.id);
  const row = await deps.db
    .selectFrom('sourceDiscoveries')
    .selectAll()
    .where('id', '=', discoveryId)
    .executeTakeFirstOrThrow();
  return {
    discovery: await discoveryDto(deps, auth, row, await loadProperty(deps, project)),
    project: await projectDto(deps, auth, project),
  };
}

/** Binds a discovered, alternate or nudged Street View candidate after a metadata recheck. */
async function bindStreetView(
  deps: ApiDeps,
  auth: AuthState,
  project: Project,
  body: { projectVersion: number; candidateId: string },
): Promise<Project> {
  const discovery = await latestDiscovery(deps, project.id);
  const candidates = discovery ? asStoredCandidates(discovery.candidates) : [];
  const candidate = candidates.find((entry) => entry.candidateId === body.candidateId);
  if (!discovery || discovery.matchClass === 'skip_to_upload' || !candidate) {
    throw validationFailed({ fields: [{ path: 'body.candidateId', reason: 'unknown' }] });
  }
  const provider = await streetViewProviderFor(deps, auth.audience);
  if (!provider) throw new AppError('NO_STREET_VIEW', {});
  const property = await loadProperty(deps, project);
  const metadata = await provider.metadataByPano(candidate.panoId).catch(() => null);
  await chargeCall(deps, deps.db, {
    sku: 'street_view_metadata',
    provider: provider.providerId,
    isFixture: provider.mode === 'fixture',
    ownerId: auth.ownerId,
    sessionId: auth.session.id,
    projectId: project.id,
    stage: 'confirm',
  });
  if (!metadata || metadata.status !== 'OK') throw new AppError('NO_STREET_VIEW', {});

  const evaluated = await evaluateFor(deps, {
    policyId: null,
    policy: streetViewCandidatePolicy(),
    kind: 'street_view',
    isGoogleImagery: candidate.isGoogleImagery,
    audience: auth.audience,
  });
  const sourceMode = streetViewSourceMode(evaluated.permission);
  if (sourceMode === 'unavailable') throw new AppError('NO_STREET_VIEW', {});

  const active = await activeJobOf(deps, project.id);
  const result = await deps.db.transaction().execute((trx) =>
    bindCandidate(deps, trx, {
      project,
      expectedVersion: body.projectVersion,
      candidate,
      streetViewMode: sourceMode,
      attachedFacade: property.attachedFacade,
    }),
  );
  if (active && result.project.projectVersion !== project.projectVersion) {
    await supersedeActiveJob(deps, project.id);
  }
  const fixture = provider.mode === 'fixture';
  await emitEvent(deps, deps.db, {
    name: 'source_confirmed',
    ownerId: auth.ownerId,
    holidayId: project.holidayId,
    sourceKind: 'street_view',
    properties: {
      sourceKind: 'street_view',
      candidateRank: candidate.rank,
      nudged: candidate.derivedFromCandidateId !== null,
      cropApplied: false,
      privateOnly: false,
    },
    fixture,
  });
  if (sourceMode === 'display_only') {
    await emitEvent(deps, deps.db, {
      name: 'photo_prompt_shown',
      ownerId: auth.ownerId,
      properties: { context: 'display_only' },
      fixture,
    });
  }
  return result.project;
}

/**
 * Binds a screened upload: it must be `ready` (declined answers `UPLOAD_DECLINED`); a scene type is
 * required below the auto-accept confidence; detected people need a resolution (`crop` makes a
 * child asset and re-checks people, `keep` makes the asset and its variants private-only); a
 * classification change after a render job exists creates a child asset with the same bytes.
 */
async function bindUpload(
  deps: ApiDeps,
  auth: AuthState,
  project: Project,
  body: {
    projectVersion: number;
    sourceAssetId: string;
    sceneType?: Project['sceneType'] | undefined;
    roomType?: Project['roomType'] | undefined;
    buildingForm?: Project['buildingForm'] | undefined;
    peopleResolution?:
      | { action: 'crop'; box: NormalizedBox; rotation?: number | undefined }
      | { action: 'keep' }
      | undefined;
  },
): Promise<Project> {
  let source = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', body.sourceAssetId)
    .where('projectId', '=', project.id)
    .where('ownerId', '=', auth.ownerId)
    .where('kind', '=', 'upload')
    .executeTakeFirst();
  if (!source) throw notFound();
  if (source.state === 'declined') {
    throw new AppError('UPLOAD_DECLINED', {
      reasonClass: source.declinedReasonClass ?? 'safety',
      ...(source.declinedReasonClass === 'guidance' && source.declinedReason
        ? { reason: source.declinedReason as never }
        : {}),
    });
  }
  if (source.state !== 'ready') {
    throw validationFailed({
      reason: source.state === 'failed' ? 'unreadable' : 'not_ready',
    });
  }
  const confidence = source.sceneTypeConfidence ?? 0;
  if (!body.sceneType && (!source.sceneType || confidence < DEFAULT_SCENE_TYPE_AUTO_ACCEPT)) {
    throw validationFailed({ reason: 'scene_type_required' });
  }

  let cropApplied = false;
  if (body.peopleResolution?.action === 'crop') {
    const { box, rotation } = body.peopleResolution;
    const outcome = await createCroppedChild(deps.pipeline, {
      parent: source,
      box,
      ...(rotation !== undefined ? { rotation } : {}),
    });
    if (outcome.outcome === 'too_small') throw validationFailed({ reason: 'image_too_small' });
    if (outcome.outcome === 'missing_original') throw validationFailed({ reason: 'unreadable' });
    if (outcome.remainingPeople.length > 0) {
      throw new AppError('PEOPLE_DETECTED', {
        boxes: outcome.remainingPeople,
        suggestedCropBox: null,
        permittedActions: ['crop', 'keep', 'replace'],
      });
    }
    source = outcome.child;
    cropApplied = true;
  } else if (body.peopleResolution?.action === 'keep') {
    source = await keepPrivate(deps, source.id);
  } else if (source.peopleDetected && source.peopleResolution === 'none') {
    throw new AppError('PEOPLE_DETECTED', {
      boxes: (source.peopleBoxes ?? []) as NormalizedBox[],
      suggestedCropBox: (source.suggestedCropBox as NormalizedBox | null) ?? null,
      permittedActions: ['crop', 'keep', 'replace'],
    });
  }

  const sceneType = body.sceneType ?? source.sceneType;
  const roomType =
    sceneType === 'interior'
      ? body.roomType !== undefined
        ? body.roomType
        : source.roomType
      : null;
  const buildingForm =
    sceneType === 'house_exterior'
      ? body.buildingForm !== undefined
        ? body.buildingForm
        : source.buildingForm
      : null;
  const reclassified =
    sceneType !== source.sceneType ||
    roomType !== source.roomType ||
    buildingForm !== source.buildingForm;
  if (reclassified) {
    const hasJobs = await deps.db
      .selectFrom('renderJobs')
      .select('id')
      .where('sourceAssetId', '=', source.id)
      .executeTakeFirst();
    if (hasJobs) {
      source = await childWithClassification(deps, source, { sceneType, roomType, buildingForm });
    } else {
      source = await deps.db
        .updateTable('sourceAssets')
        .set({
          sceneType,
          roomType,
          buildingForm,
          sceneTypeCorrected: body.sceneType !== undefined,
        })
        .where('id', '=', source.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
  }

  const now = deps.clock.now();
  const active = await activeJobOf(deps, project.id);
  const updated =
    project.activeSourceAssetId === source.id &&
    project.sceneType === sceneType &&
    project.roomType === roomType &&
    project.buildingForm === buildingForm
      ? project
      : await deps.db
          .updateTable('projects')
          .set((eb) => ({
            activeSourceAssetId: source.id,
            projectVersion: eb('projectVersion', '+', 1),
            sceneType,
            roomType,
            buildingForm,
            lastActivityAt: now,
            expiresAt: projectExpiry(project, now),
          }))
          .where('id', '=', project.id)
          .where('projectVersion', '=', body.projectVersion)
          .returningAll()
          .executeTakeFirst();
  if (!updated) {
    const current = await loadOwnedProject(deps, auth, project.id);
    throw stale(current.projectVersion);
  }
  if (active && updated !== project) await supersedeActiveJob(deps, project.id);
  await emitEvent(deps, deps.db, {
    name: 'source_confirmed',
    ownerId: auth.ownerId,
    holidayId: project.holidayId,
    sceneType,
    sourceKind: 'upload',
    properties: {
      sourceKind: 'upload',
      candidateRank: null,
      nudged: false,
      cropApplied,
      privateOnly: source.privateOnly,
    },
  });
  return updated;
}

/**
 * `keep`: the asset and every variant of its lineage become private-only: no download (the
 * download files are deleted and the download references cleared), not distributable, and every
 * share grant of those variants revoked with its public copies.
 */
async function keepPrivate(deps: ApiDeps, sourceId: string) {
  const now = deps.clock.now();
  const { source, downloads, cards } = await deps.db.transaction().execute(async (trx) => {
    const source = await trx
      .updateTable('sourceAssets')
      .set({ privateOnly: true, peopleResolution: 'kept' })
      .where('id', '=', sourceId)
      .returningAll()
      .executeTakeFirstOrThrow();
    if (source.assetPolicyId) {
      await trx
        .updateTable('assetPolicies')
        .set({ distributeDerivative: 'denied' })
        .where('id', '=', source.assetPolicyId)
        .execute();
    }
    const assets = await trx
      .selectFrom('renderAssets')
      .select(['id', 'downloadObjectKey'])
      .where('sourceAssetId', '=', sourceId)
      .execute();
    await trx
      .updateTable('renderAssets')
      .set({ distributable: false, downloadable: false, downloadObjectKey: null })
      .where('sourceAssetId', '=', sourceId)
      .execute();
    const grants =
      assets.length > 0
        ? await trx
            .updateTable('shareGrants')
            .set({ revokedAt: now })
            .where(
              'renderAssetId',
              'in',
              assets.map((asset) => asset.id),
            )
            .where('revokedAt', 'is', null)
            .returning('shareCardObjectKey')
            .execute()
        : [];
    return {
      source,
      downloads: assets.flatMap((asset) =>
        asset.downloadObjectKey ? [asset.downloadObjectKey] : [],
      ),
      cards: grants.map((grant) => grant.shareCardObjectKey),
    };
  });
  for (const key of downloads) await deps.storage.delete('private', key).catch(() => undefined);
  for (const card of cards) await deleteSharePublicObjects(deps.pipeline, card).catch(() => 0);
  return source;
}

/** A child source asset with the same normalized original and a corrected classification. */
async function childWithClassification(
  deps: ApiDeps,
  parent: Awaited<ReturnType<typeof loadSource>> & {},
  classification: {
    sceneType: Project['sceneType'];
    roomType: Project['roomType'];
    buildingForm: Project['buildingForm'];
  },
) {
  const childId = newId();
  return deps.db.transaction().execute(async (trx) => {
    const policy = await createAssetPolicy(trx, {
      subjectKind: 'source_asset',
      subjectId: childId,
      template: defaultPolicyTemplate('upload', {
        attestationVersion: parent.attestationVersion,
        privateOnly: parent.privateOnly,
      }),
    });
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      viewpointKey: _key,
      ...rest
    } = parent;
    return trx
      .insertInto('sourceAssets')
      .values({
        ...rest,
        id: childId,
        derivedFromSourceAssetId: parent.id,
        sceneType: classification.sceneType,
        roomType: classification.roomType,
        buildingForm: classification.buildingForm,
        sceneTypeCorrected: true,
        assetPolicyId: policy.id,
        viewpoint: null,
        peopleBoxes: rest.peopleBoxes ? toJson(rest.peopleBoxes) : null,
        suggestedCropBox: rest.suggestedCropBox ? toJson(rest.suggestedCropBox) : null,
        cropBox: rest.cropBox ? toJson(rest.cropBox) : null,
        existingDecorations:
          rest.existingDecorations !== null ? toJson(rest.existingDecorations) : null,
        seasonCues: rest.seasonCues !== null ? toJson(rest.seasonCues) : null,
        screening: rest.screening ? toJson(rest.screening) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}
