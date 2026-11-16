import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createNotificationListener,
  parseRenderJobChanged,
  RENDER_JOB_CHANNEL,
} from '../../queue/notify.js';
import { testDatabaseUrl } from '../../db/testing.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { newId } from '../../ids/index.js';
import type { PipelineDeps } from '../context.js';
import { runReconciliation } from '../jobs/reconciliation.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { IPTC_DIGITAL_SOURCE_TYPE } from '../versions.js';
import { runRenderJob } from './job.js';
import { approveReview, rejectReview } from './review.js';
import { terminateRenderJob } from './terminate.js';
import { readJob } from './transitions.js';

const PLACES = {
  showcase: 'ChIJfxLanternHillColonial01',
  repair: 'ChIJfxGullwingLaneCapeXXX05',
  slow: 'ChIJfxMagnoliaTerraceColo06',
  providerError: 'ChIJfxMesquiteDrawRanchXX07',
  reject: 'ChIJfxFernwoodLoopBungalo08',
  moderation: 'ChIJfxCornflowerRoadFarmh09',
  noAnchors: 'ChIJfxHemlockRidgeRanchXX10',
  blurred: 'ChIJfxSitkaSpruceBungalow12',
  dusk: 'ChIJfxOrchardBluffColonia11',
};

let deps: PipelineDeps & { close(): Promise<void> };
const seqs = new Map<string, number[]>();
const listener = createNotificationListener({
  connectionString: testDatabaseUrl(),
  channels: [RENDER_JOB_CHANNEL],
  onNotification: (_channel, payload) => {
    const change = parseRenderJobChanged(payload);
    if (!change) return;
    seqs.set(change.jobId, [...(seqs.get(change.jobId) ?? []), change.seq]);
  },
});

beforeAll(async () => {
  deps = await createPipelineTestDeps({ fixtureSlowDelayMs: 4000 });
  await listener.start();
});

afterAll(async () => {
  await listener.stop();
  await deps.close();
});

async function ledgerFor(jobId: string) {
  return deps.db.selectFrom('usageLedger').selectAll().where('jobId', '=', jobId).execute();
}

/** Every reservation of a job has a settlement or release (nothing left open). */
async function openReservationIds(jobId: string): Promise<string[]> {
  const rows = await ledgerFor(jobId);
  return rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id))
    .map((row) => row.id);
}

async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('render job, Street View fixture place', () => {
  it('renders an auto_start place to succeeded in source lighting', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'source',
    });
    const result = await runRenderJob(deps, { renderJobId: job.id });
    expect(result).toEqual({ state: 'succeeded', stopped: false });

    const done = await readJob(deps.db, job.id);
    expect(done).toMatchObject({ state: 'succeeded', attemptCount: 1, repairUsed: false });
    for (const field of [
      'startedAt',
      'renderStartedAt',
      'renderCompletedAt',
      'qaPassedAt',
      'succeededAt',
      'terminalAt',
    ] as const) {
      expect(done?.[field]).toBeInstanceOf(Date);
    }
    expect(done?.workingWidth).toBe(1024);
    expect(done?.scaleFactor).toBe(1.6);
    // Transient Street View: no working image is stored.
    expect(done?.workingObjectKey).toBeNull();

    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      providerMode: 'fixture',
      outcome: 'succeeded',
      fidelityMode: 'composite_additive',
      providerOperationId: `fixture:${attempts[0]?.id}`,
    });
    expect(attempts[0]?.compositeMask).toHaveProperty('rle');
    // Band shapes of `along` placements dilate by 1.25% of the long edge, boxes by 4%.
    const plan = await deps.db
      .selectFrom('decorationPlans')
      .select('document')
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const placements = (
      plan.document as { placements: { placementRule: string; maskShapes?: unknown[] }[] }
    ).placements;
    expect(placements.some((p) => p.placementRule === 'along' && p.maskShapes?.length)).toBe(true);
    expect(attempts[0]?.compositeMask).toMatchObject({
      dilationPx: Math.round(0.04 * 1024),
      bandDilationPx: Math.round(0.0125 * 1024),
    });
    // The fixture output keeps the framing: registered as the identity, recorded, not warped.
    expect(attempts[0]?.registrationTransform).toMatchObject({
      accepted: true,
      applied: false,
      dx: 0,
      dy: 0,
      scale: 1,
    });

    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(asset).toMatchObject({
      variantKey: done?.variantKey,
      fidelityMode: 'composite_additive',
      // Fixture activation evaluates the unknown distribution grant as allowed (fixture only).
      downloadable: true,
      distributable: true,
      attributionText: 'Fixture photo: Brett Wharton / Unsplash License',
      contentType: 'image/jpeg',
    });
    // The Street View-origin download carries the attribution band below the image.
    const download = await deps.storage.get('private', asset.downloadObjectKey as string);
    const downloadMeta = await sharp(download?.body as Buffer).metadata();
    expect(downloadMeta.width).toBe(1024);
    expect(downloadMeta.height).toBeGreaterThan(1024);
    expect(done?.renderAssetId).toBe(asset.id);
    expect(asset.provenance).toMatchObject({
      iptcDigitalSourceType: IPTC_DIGITAL_SOURCE_TYPE,
      providerMode: 'fixture',
    });
    const output = await deps.storage.get('private', asset.objectKey);
    expect(output).not.toBeNull();
    const meta = await sharp(output?.body as Buffer).metadata();
    expect(meta).toMatchObject({ width: 1024, height: 1024, format: 'jpeg' });
    expect(meta.xmp?.toString()).toContain(IPTC_DIGITAL_SOURCE_TYPE);
    expect(meta.exif).toBeUndefined();

    // No source pixels were stored for the transient source.
    expect(await deps.storage.list('private', `originals/${ownerId}/`)).toEqual([]);
    expect(await deps.storage.list('private', `working/${job.id}/`)).toEqual([]);
    expect(await deps.storage.list('private', `attempts/${job.id}/`)).toEqual([]);
    expect(attempts[0]?.candidateObjectKey).toBeNull();

    // Ledger: every reservation settled or released; the transient fetch was settled.
    expect(await openReservationIds(job.id)).toEqual([]);
    const ledger = await ledgerFor(job.id);
    expect(
      ledger.some((row) => row.kind === 'settlement' && row.sku === 'street_view_static_fetch'),
    ).toBe(true);
    expect(
      ledger.some((row) => row.kind === 'settlement' && row.sku === 'image_edit_attempt'),
    ).toBe(true);
    expect(ledger.every((row) => row.isFixture)).toBe(true);

    const links = await deps.db
      .selectFrom('renderProductLinks')
      .selectAll()
      .where('renderAssetId', '=', asset.id)
      .execute();
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => link.relationship === 'similar')).toBe(true);

    // NOTIFY carried an increasing sequence on every transition.
    const notified = await waitFor(async () => {
      const values = seqs.get(job.id) ?? [];
      return values.includes(done?.stateSeq ?? -1) ? values : null;
    });
    expect(notified).toEqual([...notified].sort((a, b) => a - b));
    expect(new Set(notified).size).toBe(notified.length);
    expect(notified[0]).toBe(0);
    expect(done?.stateSeq).toBe(6);
  });

  it('renders the evening relight and reuses the scene analysis', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    const first = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const evening = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('succeeded');

    const analyses = await deps.db
      .selectFrom('sceneAnalyses')
      .select('id')
      .where('sourceAssetId', '=', source.id)
      .execute();
    expect(analyses).toHaveLength(1);
    const jobs = await deps.db
      .selectFrom('renderJobs')
      .select(['sceneAnalysisId'])
      .where('sourceAssetId', '=', source.id)
      .execute();
    expect(new Set(jobs.map((row) => row.sceneAnalysisId))).toEqual(new Set([analyses[0]?.id]));
    const ledger = await ledgerFor(evening.id);
    expect(ledger.some((row) => row.kind === 'settlement' && row.stage === 'analyzing')).toBe(
      false,
    );
    expect(await openReservationIds(evening.id)).toEqual([]);

    // No Christmas daylight variant existed: attempt 1 rendered it, attempt 2 relit it.
    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', evening.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', evening.id)
      .executeTakeFirstOrThrow();
    expect(asset).toMatchObject({ lightingMode: 'evening', fidelityMode: 'global_relight' });
    const plans = await deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('jobId', '=', evening.id)
      .orderBy('attemptNo')
      .execute();
    expect(plans[1]?.compiledInstruction).toContain('Relight this exact photograph');
  });

  it('delivers an evening look of a dusk photo as photographed, with one edit and no relight', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.dusk,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
      style: 'abundant',
      lightingMode: 'evening',
    });
    expect(await runRenderJob(deps, { renderJobId: job.id })).toEqual({
      state: 'succeeded',
      stopped: false,
    });
    expect(await readJob(deps.db, job.id)).toMatchObject({ attemptCount: 1, repairUsed: false });

    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
    ]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_skipped',
      reason: 'not_daylight',
      timeOfDay: 'dusk',
    });
    const plans = await deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    expect(plans).toHaveLength(1);
    expect((plans[0]?.document as { lightingMode?: string }).lightingMode).toBe('source');
    expect(plans[0]?.compiledInstruction).not.toContain('Relight');

    // One evening result and no daylight companion job or variant.
    const assets = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('projectId', '=', projectId)
      .execute();
    expect(assets).toHaveLength(1);
    expect(assets[0]).toMatchObject({
      jobId: job.id,
      style: 'abundant',
      lightingMode: 'evening',
      fidelityMode: 'composite_additive',
    });
    const jobs = await deps.db
      .selectFrom('renderJobs')
      .select('id')
      .where('projectId', '=', projectId)
      .execute();
    expect(jobs.map((row) => row.id)).toEqual([job.id]);

    // An evening look is reserved as one that decorates its own base (three edits). One image
    // edit is charged; the other two reserved edits are released.
    const ledger = await ledgerFor(job.id);
    const edits = ledger.filter((row) => row.sku === 'image_edit_attempt');
    expect(edits.filter((row) => row.kind === 'reservation')).toHaveLength(3);
    expect(edits.filter((row) => row.kind === 'settlement')).toHaveLength(1);
    expect(edits.filter((row) => row.kind === 'release')).toHaveLength(2);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('repairs once after a repairable QA failure and then succeeds', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.repair,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const done = await readJob(deps.db, job.id);
    expect(done).toMatchObject({ attemptCount: 2, repairUsed: true });
    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => [a.attemptNo, a.isRepair, a.outcome])).toEqual([
      [1, false, 'qa_rejected'],
      [2, true, 'succeeded'],
    ]);
    const plans = await deps.db
      .selectFrom('decorationPlans')
      .selectAll()
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(plans).toHaveLength(2);
    expect(
      (plans[1]?.document as { planVersion: number; repairConstraints?: { code: string }[] })
        .repairConstraints?.[0]?.code,
    ).toBe('implausible_decor');
    const judges = await deps.db
      .selectFrom('judgeResults')
      .select(['attemptId', 'decision', 'majorCodes'])
      .where(
        'attemptId',
        'in',
        attempts.map((a) => a.id),
      )
      .execute();
    expect(judges.find((j) => j.attemptId === attempts[0]?.id)).toMatchObject({
      decision: 'reject',
      majorCodes: ['implausible_decor'],
    });
    expect(judges.find((j) => j.attemptId === attempts[1]?.id)?.decision).toBe('pass');
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('rejects after the repair also fails QA', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.reject,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const done = await readJob(deps.db, job.id);
    expect(done).toMatchObject({
      state: 'rejected',
      rejectionReason: 'qa_critical',
      attemptCount: 2,
      failureCodes: ['structure_changed'],
    });
    expect(done?.succeededAt).toBeNull();
    expect(done?.terminalAt).toBeInstanceOf(Date);
    expect(
      await deps.db.selectFrom('renderAssets').select('id').where('jobId', '=', job.id).execute(),
    ).toEqual([]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('fails with provider_error after transport retries', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.providerError,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(deps.db, job.id)).toMatchObject({
      failureKind: 'provider_error',
      failureDetail: null,
    });
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({
      outcome: 'provider_error',
      transportRetries: deps.config.queue.renderTransportRetryLimit,
    });
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('fails with source_rejected/no_usable_anchors before any paid attempt', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.noAnchors,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(deps.db, job.id)).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'no_usable_anchors',
      attemptCount: 0,
    });
    expect(
      await deps.db.selectFrom('renderAttempts').select('id').where('jobId', '=', job.id).execute(),
    ).toEqual([]);
    expect(await openReservationIds(job.id)).toEqual([]);
  });

  it('fails with moderation_blocked and declines the source', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.moderation,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(deps.db, job.id)).toMatchObject({ failureKind: 'moderation_blocked' });
    const declined = await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(declined).toMatchObject({ state: 'declined', declinedReason: 'provider_refused' });
    expect(declined.providerRefusedAt).toBeInstanceOf(Date);
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(attempt).toMatchObject({
      outcome: 'moderation_blocked',
      providerCategories: ['fixture'],
      transportRetries: 0,
    });
  });

  it('refuses an owner-blurred facade before any paid edit', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.blurred,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(deps.db, job.id)).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'owner_blurred',
    });
    const declined = await deps.db
      .selectFrom('sourceAssets')
      .select('state')
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(declined.state).toBe('declined');
  });
});

describe('Street View source modes', () => {
  it('renders a transient source on a refetched frame with other bytes than its previous attempt', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    const first = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    // The previous attempt worked on a frame with other bytes than the next fetch returns.
    await deps.db
      .updateTable('renderAttempts')
      .set({ sourceChecksumSha256: 'a'.repeat(64) })
      .where('jobId', '=', first.id)
      .execute();
    const second = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    const row = await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ state: 'ready', staleAt: null });
  });

  it('stores the frame and the working image in persist mode', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const stored = await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(stored.objectKey).toBe(`originals/${ownerId}/${source.id}`);
    expect(stored.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.viewpoint?.sourceCheckedAt).not.toBeNull();
    const head = await deps.storage.head('private', stored.objectKey as string);
    expect(head?.metadata['source-kind']).toBe('street_view');
    expect((await readJob(deps.db, job.id))?.workingObjectKey).toBe(
      `working/${job.id}/working.png`,
    );
  });
});

describe('cancellation, supersede and late results', () => {
  async function startSlow(to: 'superseded' | 'canceled') {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.slow,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    const controller = new AbortController();
    const running = runRenderJob(deps, { renderJobId: job.id, signal: controller.signal });
    await waitFor(async () => {
      const attempt = await deps.db
        .selectFrom('renderAttempts')
        .select('providerOperationId')
        .where('jobId', '=', job.id)
        .executeTakeFirst();
      return attempt?.providerOperationId ?? null;
    });
    const newer = to === 'superseded' ? newId() : null;
    const ended = await terminateRenderJob(deps, { jobId: job.id, to, supersededByJobId: null });
    expect(ended?.state).toBe(to);
    controller.abort();
    const result = await running;
    return { job, result, newer };
  }

  it('supersedes a running job without publishing; the in-flight attempt is reconciled', async () => {
    const { job, result } = await startSlow('superseded');
    expect(result).toEqual({ state: 'superseded', stopped: true });
    expect(
      await deps.db.selectFrom('renderAssets').select('id').where('jobId', '=', job.id).execute(),
    ).toEqual([]);
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(attempt.outcome).toBe('canceled');
    // Only the in-flight attempt's reservation stays open for reconciliation.
    expect(await openReservationIds(job.id)).toEqual([attempt.reservationEntryId]);
    const reconciled = await runReconciliation(deps, { scanObjects: false });
    expect(reconciled.attemptsAssumedCharged + reconciled.attemptsSettled).toBeGreaterThanOrEqual(
      1,
    );
    expect(await openReservationIds(job.id)).toEqual([]);
    const after = await deps.db
      .selectFrom('renderAttempts')
      .select('reconciled')
      .where('id', '=', attempt.id)
      .executeTakeFirstOrThrow();
    expect(after.reconciled).not.toBeNull();
  });

  it('cancels a running job', async () => {
    const { job, result } = await startSlow('canceled');
    expect(result).toEqual({ state: 'canceled', stopped: true });
    const done = await readJob(deps.db, job.id);
    expect(done?.cancelRequestedAt).toBeInstanceOf(Date);
    expect(done?.terminalAt).toBeInstanceOf(Date);
    expect(
      await deps.db.selectFrom('renderAssets').select('id').where('jobId', '=', job.id).execute(),
    ).toEqual([]);
  });
});

describe('pre-delivery review', () => {
  it('holds a passing candidate in needs_review, then publishes on approval', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      reviewMode: 'pre_delivery',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const held = await readJob(deps.db, job.id);
    expect(held?.qaPassedAt).toBeInstanceOf(Date);
    expect(held?.succeededAt).toBeNull();
    expect(
      await deps.db.selectFrom('renderAssets').select('id').where('jobId', '=', job.id).execute(),
    ).toEqual([]);

    const reviewer = await createReviewer();
    const asset = await approveReview(deps, { jobId: job.id, reviewerUserId: reviewer });
    expect(asset.jobId).toBe(job.id);
    expect(await readJob(deps.db, job.id)).toMatchObject({ state: 'succeeded' });
    const done = await readJob(deps.db, job.id);
    expect(done?.reviewCompletedAt).toBeInstanceOf(Date);
    const reviews = await deps.db
      .selectFrom('reviews')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    expect(reviews).toMatchObject([{ decision: 'approve', subjectKind: 'render_job' }]);
  });

  it('holds an evening relight for review without publishing its unreviewed daylight base', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      reviewMode: 'pre_delivery',
      lightingMode: 'evening',
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .selectAll()
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => [a.outcome, a.fidelityMode])).toEqual([
      ['succeeded', 'composite_additive'],
      ['succeeded', 'global_relight'],
    ]);
    expect(attempts[1]?.fallback).toMatchObject({
      kind: 'relight',
      base: 'attempt',
      baseAttemptId: attempts[0]?.id,
      baseRenderAssetId: null,
    });
    // Nothing is published before review, not even the daylight base.
    expect(
      await deps.db
        .selectFrom('renderAssets')
        .select('id')
        .where('projectId', '=', projectId)
        .execute(),
    ).toEqual([]);

    const reviewer = await createReviewer();
    const asset = await approveReview(deps, { jobId: job.id, reviewerUserId: reviewer });
    expect(asset).toMatchObject({
      jobId: job.id,
      lightingMode: 'evening',
      fidelityMode: 'global_relight',
    });
    const [, relight] = await deps.db
      .selectFrom('renderAttempts')
      .select(['attemptNo', 'outcome'])
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(relight?.outcome).toBe('succeeded');
    const links = await deps.db
      .selectFrom('renderProductLinks')
      .select('id')
      .where('renderAssetId', '=', asset.id)
      .execute();
    expect(links.length).toBeGreaterThan(0);
  });

  it('rejects on reviewer rejection without a repair', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: PLACES.showcase,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      reviewMode: 'pre_delivery',
      holidayId: 'thanksgiving_us',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const reviewer = await createReviewer();
    const ended = await rejectReview(deps, {
      jobId: job.id,
      reviewerUserId: reviewer,
      reasonCodes: ['implausible_decor'],
    });
    expect(ended).toMatchObject({
      state: 'rejected',
      rejectionReason: 'reviewer_rejected',
      attemptCount: 1,
    });
  });
});

describe('render job, upload source', () => {
  it('renders an uploaded photo (download file labeled and tagged)', async () => {
    const frame = await renderFixturePanorama({
      panoId: 'fxSvLanternHillC01p1Sv',
      heading: 0,
      fov: 80,
      pitch: 2,
    });
    const image = await sharp(frame?.image ?? Buffer.alloc(0))
      .resize(1200, 900, { fit: 'fill' })
      .jpeg()
      .toBuffer();
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image,
      fileName: 'front-porch.jpg',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    const result = await runRenderJob(deps, { renderJobId: job.id });
    const done = await readJob(deps.db, job.id);
    expect(result.state).toBe('succeeded');
    expect(done?.workingObjectKey).toBe(`working/${job.id}/working.png`);
    expect(done).toMatchObject({ workingWidth: 1536, workingHeight: 1024 });
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(asset).toMatchObject({ downloadable: true, distributable: true });
    const download = await deps.storage.get('private', asset.downloadObjectKey as string);
    const meta = await sharp(download?.body as Buffer).metadata();
    expect(meta.xmp?.toString()).toContain('compositeWithTrainedAlgorithmicMedia');
    expect((asset.provenance as { labelApplied: boolean }).labelApplied).toBe(true);
  });
});

async function createReviewer(): Promise<string> {
  const ownerId = newId();
  await deps.db.insertInto('owners').values({ id: ownerId, kind: 'user' }).execute();
  const userId = newId();
  await deps.db
    .insertInto('users')
    .values({
      id: userId,
      ownerId,
      emailNormalized: `reviewer-${userId}@example.com`,
      roles: ['reviewer'],
    })
    .execute();
  return userId;
}
