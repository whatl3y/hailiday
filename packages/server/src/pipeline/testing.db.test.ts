import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PipelineDeps } from './context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from './testing.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/** How many reservation lines the job holds per SKU and stage. */
async function reservedOf(jobId: string): Promise<Record<string, number>> {
  const rows = await deps.db
    .selectFrom('usageLedger')
    .select(['sku', 'stage'])
    .where('jobId', '=', jobId)
    .where('kind', '=', 'reservation')
    .execute();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = `${row.sku}:${row.stage ?? ''}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

async function photo(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: '#887766' } })
    .jpeg()
    .toBuffer();
}

describe('createRenderJobRecord reserves what the API reserves', () => {
  it('reserves a relit look as one that decorates its own base', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await photo(),
      sceneType: 'interior',
      roomType: 'living_room',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      style: 'abundant',
      lightingMode: 'bright',
    });
    expect(await reservedOf(job.id)).toEqual({
      'vision_call:analyzing': 1,
      'image_edit_attempt:rendering': 3,
      'vision_call:checking': 6,
      'vision_call:localizing': 2,
    });
  });

  it('reserves the daylight shape for an as-photographed look', async () => {
    const { ownerId, projectId, source } = await createUploadSource(deps, { image: await photo() });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect(await reservedOf(job.id)).toEqual({
      'vision_call:analyzing': 1,
      'image_edit_attempt:rendering': 2,
      'vision_call:checking': 4,
      'vision_call:localizing': 2,
    });
  });

  it('reserves the Street View fetch for a persist source that has no stored frame yet', async () => {
    for (const streetViewMode of ['persist', 'transient'] as const) {
      const { ownerId, projectId, source } = await createStreetViewSource(deps, {
        placeId: 'ChIJfxLanternHillColonial01',
        streetViewMode,
      });
      expect(source.objectKey).toBeNull();
      const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
      expect((await reservedOf(job.id))['street_view_static_fetch:preparing'], streetViewMode).toBe(
        1,
      );
    }
  });
});
