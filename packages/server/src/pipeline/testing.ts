import { sql } from 'kysely';
import type { LightingMode, ReviewMode, Style, HolidayId } from '@holiday/core';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import { createCapabilities } from '../capabilities/index.js';
import { testConfig, type AppConfig } from '../config/index.js';
import { loadContent, type Content } from '../content/load.js';
import { toJson, type Db } from '../db/client.js';
import type { RenderJob, SourceAsset, ViewpointJson } from '../db/schema.js';
import { CORE_SEED_STEPS, runSeed } from '../db/seed.js';
import { createTestDb } from '../db/testing.js';
import { loadFixtureData, type FixturePlace } from '../fixtures/data.js';
import { newId, randomToken, sha256Hex } from '../ids/index.js';
import { renderReservationLines, reserve } from '../ledger/index.js';
import { createSilentLogger } from '../logger/index.js';
import {
  createAssetPolicy,
  defaultPolicyTemplate,
  evaluatePermission,
  recordPermissionEvaluation,
} from '../policy/index.js';
import { createProviders } from '../providers/create.js';
import { notifyRenderJobChanged } from '../queue/notify.js';
import type { JobQueue } from '../queue/client.js';
import { createSettings } from '../settings/index.js';
import { createStorage } from '../storage/client.js';
import type { PipelineDeps, PipelineOptions } from './context.js';
import { compilerVersionFor } from './versions.js';

/** Bucket names used by pipeline integration tests (never the development buckets). */
export const PIPELINE_TEST_BUCKETS = {
  private: 'test-pipeline-private',
  public: 'test-pipeline-public',
} as const;

const SEED_LOCK = 734_201;
let contentPromise: Promise<Content> | null = null;

/**
 * Seeds capabilities, settings, packs, kits and commerce into the test database once, under an
 * advisory lock so concurrent test files do not race.
 */
export async function seedPipelineTestContent(db: Db, config: AppConfig): Promise<Content> {
  contentPromise ??= loadContent();
  const content = await contentPromise;
  await sql`select pg_advisory_lock(${SEED_LOCK})`.execute(db);
  try {
    const seeded = await db
      .selectFrom('holidayPackVersions')
      .select('id')
      .where('status', '=', 'published')
      .executeTakeFirst();
    const capabilities = await db.selectFrom('countryCapabilities').select('id').executeTakeFirst();
    if (!seeded || !capabilities) {
      await runSeed({ db, config, logger: createSilentLogger(), content, steps: CORE_SEED_STEPS });
    }
  } finally {
    await sql`select pg_advisory_unlock(${SEED_LOCK})`.execute(db);
  }
  return content;
}

/** Builds pipeline dependencies against the test database and the test buckets. */
export async function createPipelineTestDeps(
  options: {
    config?: AppConfig;
    clock?: Clock;
    queue?: JobQueue | null;
    fixtureSlowDelayMs?: number;
    pipeline?: Partial<PipelineOptions>;
  } = {},
): Promise<PipelineDeps & { close(): Promise<void> }> {
  const config = options.config ?? testConfig();
  const db = createTestDb({ max: 6 });
  const clock = options.clock ?? systemClock;
  const content = await seedPipelineTestContent(db, config);
  const storage = createStorage(config, { buckets: { ...PIPELINE_TEST_BUCKETS } });
  for (const bucket of Object.values(PIPELINE_TEST_BUCKETS)) await storage.ensureBucket(bucket);
  const logger = createSilentLogger();
  const providers = createProviders(config, {
    content,
    logger,
    fixtureSlowDelayMs: options.fixtureSlowDelayMs ?? 1500,
  });
  return {
    db,
    storage,
    queue: options.queue ?? null,
    settings: createSettings(db, { config, clock, cacheTtlMs: 0 }),
    capabilities: createCapabilities(db, { appEnv: config.appEnv, clock, cacheTtlMs: 0 }),
    config,
    logger,
    clock,
    providers,
    content,
    options: {
      retryDelayMs: () => 20,
      statusPollMs: 20,
      ...(options.pipeline ?? {}),
    },
    async close() {
      storage.destroy();
      await db.destroy();
    },
  };
}

/** A fixture place by ID. */
export function fixturePlace(placeId: string): FixturePlace {
  const place = loadFixtureData().placeById(placeId);
  if (!place) throw new Error(`Unknown fixture place ${placeId}`);
  return place;
}

/** The confirmed primary viewpoint of a fixture place, as discovery would bind it. */
export async function primaryViewpoint(
  deps: Pick<PipelineDeps, 'providers'>,
  place: FixturePlace,
): Promise<{
  viewpoint: ViewpointJson;
  copyright: string | null;
  captureDate: string | null;
  isGoogleImagery: boolean;
}> {
  const target = place.destinations.targetPoint ?? place.location;
  const discovery = await deps.providers.fixtures.streetView.discoverCandidates({
    target,
    geometryAvailable: place.destinations.hasOutline,
    facadeWidthM: place.destinations.facadeWidthM,
    roadBearingDeg: place.destinations.roadBearingDeg,
    facadeNormalDeg: place.destinations.facadeNormalDeg,
    attachedFacade: place.destinations.attachedFacade,
  });
  const primary = discovery.candidates.find((candidate) => candidate.isPrimary);
  if (!primary) throw new Error(`Fixture place ${place.placeId} has no primary candidate`);
  return {
    viewpoint: {
      panoId: primary.panoId,
      heading: primary.heading,
      headingMode: primary.headingMode,
      pitch: primary.pitch,
      fov: primary.fov,
      width: primary.width,
      height: primary.height,
      source: 'outdoor',
      captureGranularity: primary.captureGranularity,
      fetchedAt: null,
      sourceCheckedAt: null,
    },
    copyright: primary.copyright,
    captureDate: primary.captureDate,
    isGoogleImagery: primary.isGoogleImagery,
  };
}

/** Creates an owner, an address project, its property and a `ready` Street View source. */
export async function createStreetViewSource(
  deps: Pick<PipelineDeps, 'db' | 'providers' | 'clock'>,
  input: { placeId: string; streetViewMode?: 'transient' | 'persist'; holidayId?: HolidayId },
): Promise<{ ownerId: string; projectId: string; source: SourceAsset }> {
  const place = fixturePlace(input.placeId);
  const { viewpoint, copyright, captureDate, isGoogleImagery } = await primaryViewpoint(
    deps,
    place,
  );
  const now = deps.clock.now();
  const ownerId = newId();
  await deps.db.insertInto('owners').values({ id: ownerId, kind: 'anonymous' }).execute();
  const propertyId = newId();
  await deps.db
    .insertInto('properties')
    .values({
      id: propertyId,
      ownerId,
      placeId: place.placeId,
      placeIdRefreshedAt: now,
      countryCode: 'US',
      entryMethod: 'autocomplete',
      precision: 'rooftop_equivalent',
      precisionSource: 'geocoding',
      partialMatch: false,
      placeTypes: place.types,
      multiUnit: false,
      geometryAvailable: place.destinations.hasOutline,
    })
    .execute();
  const projectId = newId();
  await deps.db
    .insertInto('projects')
    .values({
      id: projectId,
      ownerId,
      kind: 'address',
      propertyId,
      projectVersion: 1,
      holidayId: input.holidayId ?? 'christmas',
      lastActivityAt: now,
      sceneType: 'house_exterior',
    })
    .execute();
  const sourceId = newId();
  const policy = await createAssetPolicy(deps.db, {
    subjectKind: 'source_asset',
    subjectId: sourceId,
    template: defaultPolicyTemplate('street_view', { attributionText: 'Google Maps' }),
  });
  const source = await deps.db
    .insertInto('sourceAssets')
    .values({
      id: sourceId,
      ownerId,
      projectId,
      kind: 'street_view',
      state: 'ready',
      captureDate: captureDate && /^\d{4}(-\d{2})?$/.test(captureDate) ? captureDate : null,
      copyright,
      isGoogleImagery,
      streetViewMode: input.streetViewMode ?? 'transient',
      viewpoint: toJson(viewpoint),
      sceneType: 'house_exterior',
      buildingForm: place.destinations.attachedFacade ? 'attached' : 'detached',
      assetPolicyId: policy.id,
      readyAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await deps.db
    .updateTable('projects')
    .set({ activeSourceAssetId: sourceId })
    .where('id', '=', projectId)
    .execute();
  return { ownerId, projectId, source };
}

/** Creates an owner, an upload project and a `ready` upload source with a stored original. */
export async function createUploadSource(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'clock'>,
  input: {
    image: Buffer;
    fileName?: string;
    sceneType?: SourceAsset['sceneType'];
    roomType?: SourceAsset['roomType'];
  },
): Promise<{ ownerId: string; projectId: string; source: SourceAsset }> {
  const now = deps.clock.now();
  const ownerId = newId();
  await deps.db.insertInto('owners').values({ id: ownerId, kind: 'anonymous' }).execute();
  const projectId = newId();
  await deps.db
    .insertInto('projects')
    .values({ id: projectId, ownerId, kind: 'upload', holidayId: 'christmas', lastActivityAt: now })
    .execute();
  const sourceId = newId();
  const policy = await createAssetPolicy(deps.db, {
    subjectKind: 'source_asset',
    subjectId: sourceId,
    template: defaultPolicyTemplate('upload', { attestationVersion: 'test-1' }),
  });
  const key = `originals/${ownerId}/${sourceId}`;
  await deps.storage.put({
    bucket: 'private',
    key,
    body: input.image,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  const source = await deps.db
    .insertInto('sourceAssets')
    .values({
      id: sourceId,
      ownerId,
      projectId,
      kind: 'upload',
      state: 'ready',
      objectKey: key,
      checksumSha256: sha256Hex(input.image),
      contentType: 'image/jpeg',
      byteLength: input.image.length,
      peopleResolution: 'none',
      sceneType: input.sceneType ?? 'house_exterior',
      roomType: input.roomType ?? null,
      buildingForm: (input.sceneType ?? 'house_exterior') === 'house_exterior' ? 'detached' : null,
      attestationVersion: 'test-1',
      attestedAt: now,
      assetPolicyId: policy.id,
      readyAt: now,
      screening: input.fileName ? toJson({ fixture: { fileName: input.fileName } }) : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await deps.db
    .updateTable('projects')
    .set({ activeSourceAssetId: sourceId, sceneType: source.sceneType })
    .where('id', '=', projectId)
    .execute();
  return { ownerId, projectId, source };
}

/**
 * Inserts a `queued` render job the way the API's render transaction does: the submission
 * permission evaluation, the job row with its input snapshot, the worst-case reservation lines and
 * the first `NOTIFY`. The queue job is not enqueued (tests run the handler directly).
 */
export async function createRenderJobRecord(
  deps: Pick<PipelineDeps, 'db' | 'clock' | 'config'>,
  input: {
    ownerId: string;
    projectId: string;
    source: SourceAsset;
    holidayId?: HolidayId;
    style?: Style;
    lightingMode?: LightingMode;
    reviewMode?: ReviewMode;
  },
): Promise<RenderJob> {
  const holidayId = input.holidayId ?? 'christmas';
  const now = deps.clock.now();
  const pack = await deps.db
    .selectFrom('holidayPackVersions')
    .select(['version'])
    .where('holidayId', '=', holidayId)
    .where('status', '=', 'published')
    .executeTakeFirstOrThrow();
  const policy = await deps.db
    .selectFrom('assetPolicies')
    .selectAll()
    .where('id', '=', input.source.assetPolicyId as string)
    .executeTakeFirstOrThrow();
  const project = await deps.db
    .selectFrom('projects')
    .select('projectVersion')
    .where('id', '=', input.projectId)
    .executeTakeFirstOrThrow();
  return deps.db.transaction().execute(async (trx) => {
    const evaluationId = await recordPermissionEvaluation(trx, {
      assetPolicyId: policy.id,
      sourceAssetId: input.source.id,
      context: 'submission',
      result: evaluatePermission({
        policy,
        capabilityState: 'fixture',
        appEnv: deps.config.appEnv,
        now,
        sourceKind: input.source.kind,
        isGoogleImagery: input.source.isGoogleImagery,
      }),
      capabilityState: 'fixture',
      evaluatedAt: now,
    });
    const job = await trx
      .insertInto('renderJobs')
      .values({
        id: newId(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        projectVersion: project.projectVersion,
        sourceAssetId: input.source.id,
        holidayId,
        style: input.style ?? 'classic',
        lightingMode: input.lightingMode ?? 'source',
        holidayPackVersion: pack.version,
        compilerVersion: compilerVersionFor('fixture'),
        inputSnapshot: toJson({
          sourceKind: input.source.kind,
          sceneType: input.source.sceneType,
          buildingForm: input.source.buildingForm,
          roomType: input.source.roomType,
        }),
        permissionEvaluationId: evaluationId,
        state: 'queued',
        idempotencyKey: randomToken(12),
        requestHash: sha256Hex(newId()),
        reviewMode: input.reviewMode ?? 'sampled_audit',
        requestedAt: now,
        sourceReadyAt: input.source.readyAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const reuseAnalysis = false;
    await reserve(
      trx,
      { ownerId: input.ownerId, jobId: job.id, projectId: input.projectId, isFixture: true },
      renderReservationLines({
        imageEditProvider: 'fixture',
        visionProvider: 'fixture',
        streetViewFetch:
          input.source.kind === 'street_view' && input.source.streetViewMode === 'transient',
        reuseAnalysis,
      }),
      deps.clock,
    );
    await notifyRenderJobChanged(trx, { jobId: job.id, seq: job.stateSeq });
    return job;
  });
}
