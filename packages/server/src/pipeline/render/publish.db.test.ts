import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { createSettings } from '../../settings/index.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { runRenderJob } from './job.js';
import { newestPerVariantKey } from './publish.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/** The same dependencies with time-based deletion on. */
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

const PROJECT_EXPIRY = new Date('2099-01-01T00:00:00Z');

async function assetExpiries(projectId: string) {
  const rows = await deps.db
    .selectFrom('renderAssets')
    .select(['lightingMode', 'expiresAt'])
    .where('projectId', '=', projectId)
    .orderBy('lightingMode')
    .execute();
  return rows;
}

async function setProjectExpiry(projectId: string) {
  await deps.db
    .updateTable('projects')
    .set({ expiresAt: PROJECT_EXPIRY })
    .where('id', '=', projectId)
    .execute();
}

describe('render asset expiry', () => {
  it('stores no expiry on a rendering while time-based deletion is off', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    await setProjectExpiry(projectId);
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(await assetExpiries(projectId)).toEqual([{ lightingMode: 'source', expiresAt: null }]);
  });

  it('stores no expiry on an evening rendering or its daylight base while it is off', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    await setProjectExpiry(projectId);
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(await assetExpiries(projectId)).toEqual([
      { lightingMode: 'evening', expiresAt: null },
      { lightingMode: 'source', expiresAt: null },
    ]);
  });

  it("copies the project's expiry onto the rendering while time-based deletion is on", async () => {
    const timed = withTimeBasedDeletion(deps);
    const { ownerId, projectId, source } = await createUploadSource(timed, {
      image: await uploadImage(),
    });
    await setProjectExpiry(projectId);
    const job = await createRenderJobRecord(timed, { ownerId, projectId, source });
    expect((await runRenderJob(timed, { renderJobId: job.id })).state).toBe('succeeded');
    expect(await assetExpiries(projectId)).toEqual([
      { lightingMode: 'source', expiresAt: PROJECT_EXPIRY },
    ]);
  });
});

/** The live renderings of a project: key, lighting and job, oldest first. */
async function liveAssets(projectId: string) {
  return deps.db
    .selectFrom('renderAssets')
    .select(['id', 'variantKey', 'lightingMode', 'jobId', 'createdAt'])
    .where('projectId', '=', projectId)
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .orderBy('id')
    .execute();
}

describe('every rendering is kept', () => {
  it('leaves both renderings live when one key is published twice', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await uploadImage(),
    });
    const first = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const second = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect(second.variantKey).toBe(first.variantKey);
    expect((await runRenderJob(deps, { renderJobId: second.id })).state).toBe('succeeded');
    const assets = await liveAssets(projectId);
    expect(assets.map((asset) => [asset.variantKey, asset.jobId])).toEqual([
      [first.variantKey, first.id],
      [first.variantKey, second.id],
    ]);
    expect(newestPerVariantKey(assets).map((asset) => asset.jobId)).toEqual([second.id]);
  });

  it("keeps an earlier daylight rendering when an evening job publishes its own base's key", async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const daylight = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: daylight.id })).state).toBe('succeeded');
    // The earlier daylight look was made from another working image, so the evening job does not
    // relight it: it decorates its own base and publishes that base under the same key.
    await deps.db
      .updateTable('renderJobs')
      .set({ workingChecksumSha256: 'another-working-image' })
      .where('id', '=', daylight.id)
      .execute();
    const evening = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('succeeded');
    const assets = await liveAssets(projectId);
    const daylightRows = assets.filter((asset) => asset.lightingMode === 'source');
    expect(daylightRows).toHaveLength(2);
    expect(new Set(daylightRows.map((asset) => asset.variantKey)).size).toBe(1);
    expect(daylightRows[0]?.jobId).toBe(daylight.id);
    expect(assets.filter((asset) => asset.lightingMode === 'evening')).toHaveLength(1);
  });
});
