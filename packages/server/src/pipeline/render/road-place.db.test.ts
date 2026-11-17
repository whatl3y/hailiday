import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../config/index.js';
import { loadFixtureData } from '../../fixtures/data.js';
import { fixturePanoramaFrame, renderFixturePanorama } from '../../fixtures/street-view.js';
import { sha256Hex } from '../../ids/index.js';
import { framedViewOf } from '../../providers/street-view/framing.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { runRenderJob } from './job.js';
import { readJob } from './transitions.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps({ config: testConfig({ STREET_VIEW_FRAMING: 'on' }) });
});

afterAll(async () => {
  await deps.close();
});

/** The fixture place whose target point lies on the road, and its first panorama. */
const ROAD_PLACE = 'ChIJfxMillpondRoadCapeXXX26';
const ROAD_P1 = 'fxSvMillpondRoad26p1Sv';

describe('a view of the fixture place on the road', { timeout: 120_000 }, () => {
  it('is framed and decorated although the framed crop leaves the photograph', async () => {
    const made = await createStreetViewSource(deps, {
      placeId: ROAD_PLACE,
      streetViewMode: 'persist',
      view: { panoId: ROAD_P1, heading: 152, pitch: 3.8, fov: 90, headingMode: 'point' },
    });
    expect(made.source.viewpoint).toMatchObject({
      panoId: ROAD_P1,
      heading: 152,
      pitch: 3.8,
      fov: 90,
      headingMode: 'point',
      width: 640,
      height: 640,
    });
    const job = await createRenderJobRecord(deps, made);
    const ended = await runRenderJob(deps, { renderJobId: job.id });
    expect(ended.state).toBe('succeeded');
    expect((await readJob(deps.db, job.id))?.state).toBe('succeeded');

    const row = await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', made.source.id)
      .executeTakeFirstOrThrow();
    const framing = row.viewpoint?.framing;
    expect(framing).toMatchObject({ status: 'framed', heading: 152, fov: 33.4 });

    // The framed view's crop reaches past the photograph, and that frame is the stored one.
    const framed = framedViewOf(row.viewpoint!);
    const crop = fixturePanoramaFrame(framed)?.crop;
    const photo = loadFixtureData().panorama(ROAD_P1)?.panorama.photo;
    expect(photo?.photoId).toBe('house-06-dutchcolonial-summer');
    expect(crop!.left < 0 || crop!.top < 0).toBe(true);
    expect(row.checksumSha256).toBe((await renderFixturePanorama(framed))!.checksum);
    const stored = await deps.storage.get('private', row.objectKey!);
    expect(sha256Hex(stored!.body)).toBe(row.checksumSha256);

    const looks = await deps.db
      .selectFrom('renderAssets')
      .select(['id', 'jobId'])
      .where('sourceAssetId', '=', made.source.id)
      .where('deletedAt', 'is', null)
      .execute();
    expect(looks.map((look) => look.jobId)).toContain(job.id);
  });
});
