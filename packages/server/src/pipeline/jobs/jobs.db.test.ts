import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import { toJson } from '../../db/client.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { settleDeadRender } from '../render/dead-letter.js';
import { runRenderJob } from '../render/job.js';
import { readJob } from '../render/transitions.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { createSettings } from '../../settings/index.js';
import { addressAllowance, attemptQuota, variantAllowance } from '../../limits/index.js';
import { runCoverageProbe, runOfferVerification } from './commerce-and-coverage.js';
import { copyHeldObjects, placePreservationHold, releaseHeldObjects } from './holds.js';
import { generateShareCard } from './share-card.js';
import { deleteProject, resumeDeletionRequests } from './deletion.js';
import { runAttemptSweep, runCoordinateExpiry, runRetentionSweep } from './sweeps.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/** The same dependencies with time-based deletion on (the specified retention schedule). */
function withTimeBasedDeletion(base: PipelineDeps): PipelineDeps {
  const config = {
    ...base.config,
    settingOverrides: { ...base.config.settingOverrides, RETENTION_TIME_BASED_DELETION: 'true' },
  };
  return {
    ...base,
    config,
    settings: createSettings(base.db, { config, clock: base.clock, cacheTtlMs: 0 }),
  };
}

async function uploadImage(): Promise<Buffer> {
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
  });
  return sharp(frame?.image ?? Buffer.alloc(0))
    .resize(1200, 800, { fit: 'fill' })
    .jpeg()
    .toBuffer();
}

async function grantFor(ownerId: string, renderAssetId: string, includeBefore = false) {
  const token = randomToken(16);
  const id = newId();
  await deps.db
    .insertInto('shareGrants')
    .values({
      id,
      ownerId,
      renderAssetId,
      tokenHash: sha256Hex(token),
      includeBefore,
      expiresAt: addMs(new Date(), 30 * 86_400_000),
    })
    .execute();
  return { id, token };
}

describe('share_card', () => {
  it('composes the 1200×630 card and copies the shared images of an upload-origin variant', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const grant = await grantFor(ownerId, asset.id, true);

    const outcome = await generateShareCard(deps, {
      shareGrantId: grant.id,
      shareToken: grant.token,
    });
    expect(outcome).toMatchObject({ outcome: 'written', cardKey: keys.card(grant.token) });
    const card = await deps.storage.get('public', keys.card(grant.token));
    expect(await sharp(card?.body as Buffer).metadata()).toMatchObject({
      width: 1200,
      height: 630,
      format: 'jpeg',
    });
    expect(card?.body.length).toBeLessThan(5 * 1024 * 1024);
    expect(await deps.storage.head('public', keys.shared(grant.token, 'after'))).not.toBeNull();
    expect(await deps.storage.head('public', keys.shared(grant.token, 'before'))).not.toBeNull();
    const stored = await deps.db
      .selectFrom('shareGrants')
      .selectAll()
      .where('id', '=', grant.id)
      .executeTakeFirstOrThrow();
    expect(stored.shareCardObjectKey).toBe(keys.card(grant.token));

    // A wrong token or a revoked grant writes nothing.
    expect(
      await generateShareCard(deps, { shareGrantId: grant.id, shareToken: randomToken(16) }),
    ).toMatchObject({
      outcome: 'skipped',
      reason: 'token_mismatch',
    });
  });

  it('never shares the before image of a Street View-origin variant', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const grant = await grantFor(ownerId, asset.id, true);
    expect(
      await generateShareCard(deps, { shareGrantId: grant.id, shareToken: grant.token }),
    ).toMatchObject({
      outcome: 'written',
      beforeKey: null,
    });
  });

  it('marks a Street View card at the upper left and leaves both attribution boxes untouched', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const grant = await grantFor(ownerId, asset.id);
    expect(
      await generateShareCard(deps, { shareGrantId: grant.id, shareToken: grant.token }),
    ).toMatchObject({ outcome: 'written' });
    const card = (await deps.storage.get('public', keys.card(grant.token)))?.body as Buffer;
    const after = (await deps.storage.get('public', keys.shared(grant.token, 'after')))
      ?.body as Buffer;

    // The card without any mark: the shared image fitted into the 1200 × 586 image area.
    const area = { width: 1200, height: 586 };
    const unmarked = await sharp(after)
      .resize(area.width, area.height, { fit: 'contain', background: { r: 18, g: 22, b: 28 } })
      .greyscale()
      .raw()
      .toBuffer();
    const marked = await sharp(card)
      .extract({ left: 0, top: 0, ...area })
      .greyscale()
      .raw()
      .toBuffer();
    const meta = await sharp(after).metadata();
    const scale = Math.min(area.width / meta.width!, area.height / meta.height!);
    const shown = {
      width: Math.round(meta.width! * scale),
      height: Math.round(meta.height! * scale),
    };
    const origin = {
      left: Math.floor((area.width - shown.width) / 2),
      top: Math.floor((area.height - shown.height) / 2),
    };
    /** Mean gray difference between the card and the unmarked fit inside a box of the image. */
    const difference = (box: readonly number[]) => {
      const x0 = origin.left + Math.floor(box[0]! * shown.width);
      const y0 = origin.top + Math.floor(box[1]! * shown.height);
      const x1 = origin.left + Math.ceil(box[2]! * shown.width);
      const y1 = origin.top + Math.ceil(box[3]! * shown.height);
      let sum = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const i = y * area.width + x;
          sum += Math.abs(marked[i]! - unmarked[i]!);
        }
      }
      return sum / ((x1 - x0) * (y1 - y0));
    };
    expect(difference([0.02, 0.02, 0.16, 0.06])).toBeGreaterThan(30);
    for (const box of DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640']!) {
      expect(difference(box)).toBeLessThan(6);
    }
  });
});

describe('sweeps', () => {
  // A clock in the past keeps the sweeps away from rows other test files are using.
  const past = new Date('2001-01-10T12:00:00Z');
  const pastDeps = () => withTimeBasedDeletion({ ...deps, clock: { now: () => past } });

  it('expires an anonymous project through the deletion order', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    await deps.db
      .updateTable('projects')
      .set({ lastActivityAt: new Date('2001-01-01T00:00:00Z'), createdAt: undefined })
      .where('id', '=', projectId)
      .execute();
    const result = await runRetentionSweep(pastDeps());
    expect(result.projectsExpired).toBeGreaterThanOrEqual(1);
    expect(
      await deps.db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await deps.storage.head('private', source.objectKey as string)).toBeNull();
    const request = await deps.db
      .selectFrom('deletionRequests')
      .selectAll()
      .where('targetId', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(request).toMatchObject({
      scope: 'expiry_sweep',
      requestedBy: 'system',
      status: 'completed',
    });
    expect(
      request.receipt.find((entry) => entry.store === 'object_storage')?.objectsDeleted,
    ).toBeGreaterThanOrEqual(1);
    const tombstone = await deps.db
      .selectFrom('tombstones')
      .select('kind')
      .where('hashSha256', '=', sha256Hex(projectId))
      .executeTakeFirst();
    expect(tombstone?.kind).toBe('project');
    expect(ownerId).toBeTruthy();
  });

  it('keeps idle projects and their renderings while time-based deletion is off', async () => {
    const keptDeps = () => ({ ...deps, clock: { now: () => past } });
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    // Anonymous, idle for 30 days, past the 7-day cap and past its stored expiry.
    await deps.db
      .updateTable('projects')
      .set({
        lastActivityAt: new Date('2000-12-11T12:00:00Z'),
        createdAt: new Date('2000-12-01T00:00:00Z'),
        expiresAt: new Date('2000-12-12T12:00:00Z'),
      } as never)
      .where('id', '=', projectId)
      .execute();
    // An upload that never completed still expires after an hour.
    const pending = await createUploadSource(deps, { image: await uploadImage() });
    await deps.db
      .updateTable('sourceAssets')
      .set({ state: 'pending_upload', createdAt: new Date('2001-01-10T10:00:00Z') } as never)
      .where('id', '=', pending.source.id)
      .execute();

    const kept = await runRetentionSweep(keptDeps());
    expect(kept.projectsExpired).toBe(0);
    expect(kept.uploadsExpired).toBeGreaterThanOrEqual(1);
    const project = await deps.db
      .selectFrom('projects')
      .select('deletedAt')
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(project.deletedAt).toBeNull();
    const keptAsset = await deps.db
      .selectFrom('renderAssets')
      .select(['deletedAt', 'withdrawnAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(keptAsset).toEqual({ deletedAt: null, withdrawnAt: null });
    expect(await deps.storage.head('private', asset.objectKey)).not.toBeNull();
    expect(await deps.storage.head('private', source.objectKey as string)).not.toBeNull();
    const expiredUpload = await deps.db
      .selectFrom('sourceAssets')
      .select('state')
      .where('id', '=', pending.source.id)
      .executeTakeFirstOrThrow();
    expect(expiredUpload.state).toBe('expired');

    // The same project expires on the specified schedule once time-based deletion is on.
    const swept = await runRetentionSweep(pastDeps());
    expect(swept.projectsExpired).toBeGreaterThanOrEqual(1);
    expect(
      await deps.db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await deps.storage.head('private', asset.objectKey)).toBeNull();
  });

  it('sweeps attempt and working objects of long-terminal jobs', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect((await deps.storage.list('private', `attempts/${job.id}/`)).length).toBeGreaterThan(0);
    expect((await deps.storage.list('private', `working/${job.id}/`)).length).toBeGreaterThan(0);
    await deps.db
      .updateTable('renderJobs')
      .set({ terminalAt: new Date('2000-12-01T00:00:00Z') })
      .where('id', '=', job.id)
      .execute();
    const result = await runAttemptSweep(pastDeps());
    expect(result.attemptPrefixesSwept).toBeGreaterThanOrEqual(1);
    expect(await deps.storage.list('private', `attempts/${job.id}/`)).toEqual([]);
    expect(await deps.storage.list('private', `working/${job.id}/`)).toEqual([]);
    expect((await readJob(deps.db, job.id))?.workingObjectKey).toBeNull();
  });

  it('clears expired coordinates and keeps coordinates that have not expired', async () => {
    const propertyOf = async (placeId: string, coordsExpireAt: Date) => {
      const { projectId } = await createStreetViewSource(deps, { placeId });
      const project = await deps.db
        .selectFrom('projects')
        .select('propertyId')
        .where('id', '=', projectId)
        .executeTakeFirstOrThrow();
      await deps.db
        .updateTable('properties')
        .set({ targetLat: 40.1, targetLng: -75.2, coordsSource: 'places', coordsExpireAt })
        .where('id', '=', project.propertyId as string)
        .execute();
      return project.propertyId as string;
    };
    const expiredId = await propertyOf(
      'ChIJfxLanternHillColonial01',
      new Date('2001-01-01T00:00:00Z'),
    );
    const futureExpiry = new Date('2001-02-01T00:00:00Z');
    const retainedId = await propertyOf('ChIJfxLanternHillColonial01', futureExpiry);
    expect((await runCoordinateExpiry(pastDeps())).propertiesCleared).toBe(1);
    const read = (id: string) =>
      deps.db.selectFrom('properties').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    expect(await read(expiredId)).toMatchObject({
      targetLat: null,
      targetLng: null,
      coordsSource: null,
      coordsExpireAt: null,
    });
    expect(await read(retainedId)).toMatchObject({
      targetLat: 40.1,
      targetLng: -75.2,
      coordsSource: 'places',
      coordsExpireAt: futureExpiry,
    });
  });
});

describe('preservation holds in the retention sweep', () => {
  const past = new Date('2001-01-10T12:00:00Z');
  const pastDeps = () => withTimeBasedDeletion({ ...deps, clock: { now: () => past } });
  const exists = async (key: string | null) =>
    key !== null && (await deps.storage.head('private', key)) !== null;

  it('keeps held objects through the sweep, deletes the rest, and completes after release', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const kept = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    const { holdId } = await deps.db.transaction().execute((trx) =>
      placePreservationHold(trx, {
        targetKind: 'render_asset',
        targetId: kept.id,
        reason: 'legal_process',
        authorityRef: 'test:subpoena',
        releaseCondition: 'test',
        placedBy: null,
      }),
    );
    await copyHeldObjects(deps, holdId);
    await deps.db
      .updateTable('projects')
      .set({ expiresAt: new Date('2001-01-01T00:00:00Z') })
      .where('id', '=', projectId)
      .execute();

    const swept = await runRetentionSweep(pastDeps());
    expect(swept.projectsHeld).toBeGreaterThanOrEqual(1);
    expect(await exists(kept.objectKey)).toBe(true);
    expect(await exists(keys.held(holdId, kept.objectKey))).toBe(true);
    expect(await exists(source.objectKey)).toBe(false);
    const project = await deps.db
      .selectFrom('projects')
      .select('deletedAt')
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(project.deletedAt).not.toBeNull();
    const request = await deps.db
      .selectFrom('deletionRequests')
      .select('status')
      .where('targetId', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe('held');

    // Release: the held copies go, and the deletion resumes to completion.
    await deps.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('preservationHolds')
        .set({ releasedAt: new Date(), releaseReason: 'test' })
        .where('id', '=', holdId)
        .execute();
      await trx
        .updateTable('renderAssets')
        .set({ preservationHoldId: null })
        .where('preservationHoldId', '=', holdId)
        .execute();
    });
    expect(await releaseHeldObjects(deps, holdId)).toBeGreaterThanOrEqual(1);
    expect(await exists(keys.held(holdId, kept.objectKey))).toBe(false);
    await resumeDeletionRequests(deps, { olderThanMs: 0, limit: 500 });
    expect(
      await deps.db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(await exists(kept.objectKey)).toBe(false);
  });

  it('purges existing Street View variants of a place once it is on the opt-out list', async () => {
    // A place no other test renders: a block here never reaches another test's variants.
    const placeId = 'ChIJfxBellflowerRowFarmho14';
    const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    await deps.db
      .insertInto('blockedAddresses')
      .values({
        id: newId(),
        placeId,
        source: 'google_blur_detected',
        evidenceRef: `render_job:${job.id}`,
      })
      .onConflict((oc) => oc.column('placeId').doUpdateSet({ removedAt: null }))
      .execute();

    const swept = await runRetentionSweep(pastDeps());
    expect(swept.blockedPlaceVariantsPurged).toBeGreaterThanOrEqual(1);
    const row = await deps.db
      .selectFrom('renderAssets')
      .select(['withdrawnAt', 'deletedAt'])
      .where('id', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row.withdrawnAt).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
    expect(await deps.storage.list('private', keys.outputPrefix(ownerId, asset.id))).toEqual([]);
  });

  it('resumes a deletion interrupted after step 1', async () => {
    const { projectId, source } = await createUploadSource(deps, { image: await uploadImage() });
    let failures = 0;
    const flaky: PipelineDeps = {
      ...deps,
      storage: {
        ...deps.storage,
        delete: async (bucket, key) => {
          if (failures === 0) {
            failures += 1;
            throw new Error('SlowDown: 503');
          }
          return deps.storage.delete(bucket, key);
        },
      },
    };
    const project = await deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    await expect(
      deleteProject(flaky, { project, scope: 'project', requestedBy: 'user' }),
    ).rejects.toThrow('503');
    const request = await deps.db
      .selectFrom('deletionRequests')
      .selectAll()
      .where('targetId', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(request.status).toBe('in_progress');
    expect(await exists(source.objectKey)).toBe(true);

    await deps.db
      .updateTable('deletionRequests')
      .set({ createdAt: new Date('2001-01-01T00:00:00Z') } as never)
      .where('id', '=', request.id)
      .execute();
    const swept = await runRetentionSweep(pastDeps());
    expect(swept.deletionsResumed).toBeGreaterThanOrEqual(1);
    expect(await exists(source.objectKey)).toBe(false);
    expect(
      await deps.db
        .selectFrom('projects')
        .select('id')
        .where('id', '=', projectId)
        .executeTakeFirst(),
    ).toBeUndefined();
    const after = await deps.db
      .selectFrom('deletionRequests')
      .select(['status', 'receipt'])
      .where('id', '=', request.id)
      .executeTakeFirstOrThrow();
    expect(after.status).toBe('completed');
    expect(after.receipt).toHaveLength(2);
  });

  it('clears hashed signals after 7 days, purges expired auth tokens and ages out resolved reports', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const old = await createRenderJobRecord(deps, { ownerId, projectId, source });
    await deps.db
      .updateTable('renderJobs')
      .set({ state: 'canceled', terminalAt: new Date() })
      .where('id', '=', old.id)
      .execute();
    const recent = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      holidayId: 'halloween',
    });
    const signals = { deviceHash: 'd'.repeat(64), ipHash: 'e'.repeat(64) };
    await deps.db
      .updateTable('renderJobs')
      .set({ ...signals, requestedAt: addMs(past, -8 * 86_400_000) })
      .where('id', '=', old.id)
      .execute();
    await deps.db
      .updateTable('renderJobs')
      .set({ ...signals, requestedAt: addMs(past, -3_600_000) })
      .where('id', '=', recent.id)
      .execute();
    const token = (expiresAt: Date) => ({
      id: newId(),
      tokenHash: sha256Hex(randomToken(16)),
      emailNormalized: 'someone@example.com',
      purpose: 'magic_link' as const,
      expiresAt,
      ipHash: 'e'.repeat(64),
    });
    const expired = token(addMs(past, -2 * 86_400_000));
    const fresh = token(addMs(past, -10 * 60_000));
    await deps.db.insertInto('authTokens').values([expired, fresh]).execute();
    const report = (resolvedAt: Date) => ({
      id: newId(),
      targetKind: 'project' as const,
      targetId: projectId,
      reason: 'other' as const,
      status: 'dismissed' as const,
      resolvedAt,
      ipHash: 'e'.repeat(64),
      createdAt: addMs(resolvedAt, -86_400_000),
    });
    const agedReport = report(new Date('1999-12-01T00:00:00Z'));
    const keptReport = report(new Date('2000-12-15T00:00:00Z'));
    await deps.db
      .insertInto('reports')
      .values([agedReport, keptReport] as never)
      .execute();

    const swept = await runRetentionSweep(pastDeps());
    const jobs = await deps.db
      .selectFrom('renderJobs')
      .select(['id', 'deviceHash', 'ipHash'])
      .where('id', 'in', [old.id, recent.id])
      .execute();
    expect(jobs.find((row) => row.id === old.id)).toMatchObject({ deviceHash: null, ipHash: null });
    expect(jobs.find((row) => row.id === recent.id)).toMatchObject(signals);
    expect(swept.signalsCleared).toBeGreaterThanOrEqual(1);
    const tokens = await deps.db
      .selectFrom('authTokens')
      .select('id')
      .where('id', 'in', [expired.id, fresh.id])
      .execute();
    expect(tokens.map((row) => row.id)).toEqual([fresh.id]);
    expect(swept.authTokensPurged).toBeGreaterThanOrEqual(1);
    const reports = await deps.db
      .selectFrom('reports')
      .select(['id', 'ipHash'])
      .where('id', 'in', [agedReport.id, keptReport.id])
      .execute();
    expect(reports).toEqual([{ id: keptReport.id, ipHash: null }]);
    expect(swept.reportsAged).toBeGreaterThanOrEqual(1);
  });
});

describe('deletion and the allowance', () => {
  it('keeps deleted units counted through residue until they leave the window', async () => {
    const settings = createSettings(deps.db, { config: deps.config, cacheTtlMs: 0 });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const counts = async () => {
      const now = new Date();
      return {
        addresses: (await addressAllowance(deps.db, settings, { ownerId, now })).used,
        variants: (await variantAllowance(deps.db, settings, { ownerId, now })).used,
        attempts: (await attemptQuota(deps.db, settings, { ownerId, now })).used,
      };
    };
    const before = await counts();
    expect(before.addresses).toBe(1);
    expect(before.variants).toBe(1);
    expect(before.attempts).toBeGreaterThanOrEqual(1);

    const project = await deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    const outcome = await deleteProject(deps, { project, scope: 'project', requestedBy: 'user' });
    expect(outcome.status).toBe('completed');
    expect(
      await deps.db.selectFrom('renderJobs').select('id').where('id', '=', job.id).execute(),
    ).toEqual([]);
    expect(await counts()).toEqual(before);
    const residue = await deps.db
      .selectFrom('allowanceResidue')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .execute();
    expect(Object.keys(residue[0] ?? {}).sort()).toEqual(
      ['countedAt', 'createdAt', 'expiresAt', 'id', 'kind', 'ownerId'].sort(),
    );
    expect(residue.filter((row) => row.kind === 'address')).toHaveLength(1);
    expect(residue.filter((row) => row.kind === 'variant')).toHaveLength(1);
    expect(residue.filter((row) => row.kind === 'attempt')).toHaveLength(before.attempts);

    // The retention sweep removes residue past its window.
    await deps.db
      .updateTable('allowanceResidue')
      .set({ expiresAt: new Date('2001-01-01T00:00:00Z') })
      .where('ownerId', '=', ownerId)
      .execute();
    const swept = await runRetentionSweep({
      ...deps,
      clock: { now: () => new Date('2001-01-10T12:00:00Z') },
    });
    expect(swept.allowanceResidueAged).toBeGreaterThanOrEqual(residue.length);
    expect(
      await deps.db
        .selectFrom('allowanceResidue')
        .select('id')
        .where('ownerId', '=', ownerId)
        .execute(),
    ).toEqual([]);
  });

  it('counts an evening request that renders its daylight base as one variant, before and after deletion', async () => {
    const settings = createSettings(deps.db, { config: deps.config, cacheTtlMs: 0 });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const used = async () =>
      (await variantAllowance(deps.db, settings, { ownerId, now: new Date() })).used;
    expect(await used()).toBe(0);
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect(await used()).toBe(1);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const jobs = await deps.db
      .selectFrom('renderJobs')
      .select(['id', 'state', 'lightingMode'])
      .where('projectId', '=', projectId)
      .execute();
    // Two succeeded jobs deliver the two variants: the evening job and the daylight companion.
    expect(
      jobs
        .filter((row) => row.state === 'succeeded')
        .map((row) => row.lightingMode)
        .sort(),
    ).toEqual(['evening', 'source']);
    expect(await used()).toBe(1);

    const project = await deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    const outcome = await deleteProject(deps, { project, scope: 'project', requestedBy: 'user' });
    expect(outcome.status).toBe('completed');
    const residue = await deps.db
      .selectFrom('allowanceResidue')
      .select('kind')
      .where('ownerId', '=', ownerId)
      .where('kind', '=', 'variant')
      .execute();
    expect(residue).toHaveLength(1);
    expect(await used()).toBe(1);
  });

  it('leaves no residue for units already outside the window', async () => {
    const { ownerId, projectId } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    await deps.db
      .updateTable('projects')
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) } as never)
      .where('id', '=', projectId)
      .execute();
    const project = await deps.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', projectId)
      .executeTakeFirstOrThrow();
    await deleteProject(deps, { project, scope: 'project', requestedBy: 'user' });
    expect(
      await deps.db
        .selectFrom('allowanceResidue')
        .select('id')
        .where('ownerId', '=', ownerId)
        .execute(),
    ).toEqual([]);
  });
});

describe('dead letters and scheduled jobs', () => {
  it('settles a dead-lettered render as unknown_outcome when the sent attempt cannot be recovered', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    // Simulate a worker that died while the provider call was in flight.
    await deps.db
      .updateTable('renderJobs')
      .set({ state: 'rendering', startedAt: new Date() })
      .where('id', '=', job.id)
      .execute();
    const plan = newId();
    const analysis = newId();
    await deps.db
      .insertInto('sceneAnalyses')
      .values({
        id: analysis,
        sourceAssetId: source.id,
        analysisModel: 'dead-letter-test',
        analysisPromptVersion: 'x',
        schemaVersion: '1.0',
        workingWidth: 1024,
        workingHeight: 1024,
        workingChecksumSha256: newId(),
        document: toJson({}),
      })
      .execute();
    const kit = await deps.db.selectFrom('styleKits').select('id').executeTakeFirstOrThrow();
    await deps.db
      .insertInto('decorationPlans')
      .values({
        id: plan,
        jobId: job.id,
        attemptNo: 1,
        sceneAnalysisId: analysis,
        packVersion: '1.0.0',
        styleKitId: kit.id,
        compilerVersion: 'x',
        document: toJson({}),
        validatorResult: toJson({}),
      })
      .execute();
    const reservation = await deps.db
      .selectFrom('usageLedger')
      .select('id')
      .where('jobId', '=', job.id)
      .where('sku', '=', 'image_edit_attempt')
      .executeTakeFirstOrThrow();
    await deps.db
      .insertInto('renderAttempts')
      .values({
        id: newId(),
        jobId: job.id,
        attemptNo: 1,
        isRepair: false,
        decorationPlanId: plan,
        sceneAnalysisId: analysis,
        permissionEvaluationId: job.permissionEvaluationId,
        provider: 'fixture-editor',
        modelSnapshot: 'x',
        promptVersion: 'x',
        compilerVersion: 'x',
        settingsHash: 'x',
        providerMode: 'fixture',
        providerOperationId: 'fixture:lost',
        sourceChecksumSha256: 'x',
        workingChecksumSha256: 'x',
        outcome: 'pending',
        reservationEntryId: reservation.id,
      })
      .execute();
    expect(await settleDeadRender(deps, { renderJobId: job.id })).toEqual({
      failureKind: 'unknown_outcome',
    });
    expect(await readJob(deps.db, job.id)).toMatchObject({
      state: 'failed',
      failureKind: 'unknown_outcome',
    });
    const ledger = await deps.db
      .selectFrom('usageLedger')
      .selectAll()
      .where('jobId', '=', job.id)
      .execute();
    // The in-flight attempt keeps its reservation open for reconciliation; the rest is released.
    const open = ledger.filter(
      (row) => row.kind === 'reservation' && !ledger.some((o) => o.reservationId === row.id),
    );
    expect(open.map((row) => row.id)).toEqual([reservation.id]);
  });

  it('verifies offers with automated access and auto-pauses stale ones', async () => {
    const offers = await deps.db
      .selectFrom('offers')
      .innerJoin('merchantPrograms', 'merchantPrograms.id', 'offers.merchantProgramId')
      .select([
        'offers.id',
        'offers.priceSource',
        'merchantPrograms.apiAccess',
        'offers.lastVerifiedAt',
      ])
      .where('offers.status', '=', 'active')
      .where('offers.offerKey', '<>', 'offer_foam_jack_o_lanterns_lit__home_garden')
      .execute();
    const automated = offers.find((o) => o.apiAccess === 'granted' || o.priceSource === 'api');
    const manual = offers.find(
      (o) => o.apiAccess !== 'granted' && o.priceSource !== 'api' && o.priceSource !== 'feed',
    );
    if (!automated || !manual) throw new Error('fixture offers missing');
    await deps.db
      .updateTable('offers')
      .set({ lastVerifiedAt: new Date(Date.now() - 30 * 86_400_000) })
      .where('id', '=', manual.id)
      .execute();
    const result = await runOfferVerification(deps, { offerIds: [automated.id, manual.id] });
    expect(result).toMatchObject({ verified: 1, paused: 1 });
    const after = await deps.db
      .selectFrom('offers')
      .select(['id', 'status', 'lastVerifiedAt'])
      .where('id', 'in', [automated.id, manual.id])
      .execute();
    expect(after.find((o) => o.id === manual.id)?.status).toBe('paused');
    expect(after.find((o) => o.id === automated.id)?.status).toBe('active');
  });

  it('runs the coverage probe over the fixture sample', async () => {
    const summary = await runCoverageProbe(deps, { probeRunId: newId(), sampleSize: 25 });
    expect(summary?.sampleSize).toBeGreaterThan(0);
    expect(summary?.availability.within200m).toBeGreaterThan(0);
    expect(Object.keys(summary?.matchClasses ?? {})).toContain('auto_start');
  });
});
