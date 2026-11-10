import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import type { LatLng } from '../../providers/geo.js';
import type { RefreshPanoramaResult, StreetViewProvider } from '../../providers/types.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  fixturePlace,
} from '../testing.js';
import { runRenderJob } from './job.js';
import { panoramaVerdict } from './source.js';
import { readJob } from './transitions.js';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

const PLACE = 'ChIJfxLanternHillColonial01';

const metadata = (status: RefreshPanoramaResult['metadata']['status'], panoId: string | null) => ({
  status,
  panoId,
  location: null,
  date: null,
  copyright: null,
});

/** Deps whose Street View revalidation answers as given, recording the probed location. */
function answering(answer: RefreshPanoramaResult, seen: (LatLng | null)[] = []): PipelineDeps {
  const inner = base.providers.fixtures.streetView;
  const streetView: StreetViewProvider = {
    ...inner,
    async refreshPanorama(_panoId, options) {
      seen.push(options?.location ?? null);
      return answer;
    },
  };
  return {
    ...base,
    providers: { ...base.providers, fixtures: { ...base.providers.fixtures, streetView } },
  };
}

/** A `persist` Street View source with one delivered variant and a stored copy. */
async function renderedSource() {
  const created = await createStreetViewSource(base, { placeId: PLACE, streetViewMode: 'persist' });
  const first = await createRenderJobRecord(base, created);
  expect((await runRenderJob(base, { renderJobId: first.id })).state).toBe('succeeded');
  const source = await base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', created.source.id)
    .executeTakeFirstOrThrow();
  expect(source.objectKey).not.toBeNull();
  return { ...created, source };
}

/** Retains target coordinates on a project's property. */
async function pin(projectId: string, pinned: LatLng) {
  const project = await base.db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  await base.db
    .updateTable('properties')
    .set({
      targetLat: pinned.latitude,
      targetLng: pinned.longitude,
      coordsExpireAt: addMs(new Date(), 86_400_000),
    })
    .where('id', '=', project.propertyId!)
    .execute();
}

async function renderAgain(deps: PipelineDeps, made: Awaited<ReturnType<typeof renderedSource>>) {
  const next = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
  const ended = await runRenderJob(deps, { renderJobId: next.id });
  const source = await base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', made.source.id)
    .executeTakeFirstOrThrow();
  const variants = await base.db
    .selectFrom('renderAssets')
    .select('id')
    .where('sourceAssetId', '=', made.source.id)
    .where('deletedAt', 'is', null)
    .where('withdrawnAt', 'is', null)
    .execute();
  return { state: ended.state, job: await readJob(base.db, next.id), source, variants };
}

describe('render-time panorama revalidation', () => {
  for (const status of ['OVER_QUERY_LIMIT', 'REQUEST_DENIED', 'UNKNOWN_ERROR'] as const) {
    it(`a ${status} answer fails the render and changes nothing, so the next request renders`, async () => {
      const made = await renderedSource();
      const result = await renderAgain(
        answering({ status: 'error', metadata: metadata(status, null) }),
        made,
      );
      expect(result.state).toBe('failed');
      expect(result.job).toMatchObject({ failureKind: 'source_unavailable' });
      expect(result.source.state).toBe('ready');
      expect(result.source.staleAt).toBeNull();
      expect(result.variants).toHaveLength(1);
      expect(result.source.objectKey).toBe(made.source.objectKey);
      expect(await base.storage.head('private', made.source.objectKey!)).not.toBeNull();
      const retried = await renderAgain(base, made);
      expect(retried.state).toBe('succeeded');
      expect(retried.source.state).toBe('ready');
    });
  }

  it('newer imagery at the pinned location keeps the variants and the stored copy', async () => {
    const pinned = { latitude: 41.881, longitude: -87.623 };
    const made = await renderedSource();
    await pin(made.projectId, pinned);
    const seen: (LatLng | null)[] = [];
    const result = await renderAgain(
      answering({ status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery02') }, seen),
      made,
    );
    expect(seen).toEqual([pinned]);
    expect(result.state).toBe('failed');
    expect(result.job).toMatchObject({ failureKind: 'source_unavailable' });
    expect(result.source.state).toBe('stale');
    expect(result.variants).toHaveLength(1);
    expect(result.source.objectKey).toBe(made.source.objectKey);
  });

  it('a retired pano ID at a place with newer imagery reads as replaced through the fixture adapter', async () => {
    const place = fixturePlace(PLACE);
    const made = await createStreetViewSource(base, { placeId: PLACE });
    const first = await createRenderJobRecord(base, made);
    expect((await runRenderJob(base, { renderJobId: first.id })).state).toBe('succeeded');
    const asset = await base.db
      .selectFrom('renderAssets')
      .select('id')
      .where('jobId', '=', first.id)
      .executeTakeFirstOrThrow();
    const grantId = newId();
    await base.db
      .insertInto('shareGrants')
      .values({
        id: grantId,
        ownerId: made.ownerId,
        renderAssetId: asset.id,
        tokenHash: sha256Hex(randomToken(16)),
        expiresAt: addMs(new Date(), 30 * 86_400_000),
      })
      .execute();
    // The pinned pano ID no longer resolves; the property's target point still has imagery.
    await base.db
      .updateTable('sourceAssets')
      .set({ viewpoint: toJson({ ...made.source.viewpoint!, panoId: 'fxSvRetiredPano01' }) })
      .where('id', '=', made.source.id)
      .execute();
    await pin(made.projectId, place.destinations.targetPoint ?? place.location);

    const result = await renderAgain(base, made);
    expect(result.state).toBe('failed');
    expect(result.job).toMatchObject({ failureKind: 'source_unavailable' });
    expect(result.source.state).toBe('stale');
    expect(result.variants).toEqual([{ id: asset.id }]);
    const grant = await base.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow();
    expect(grant.revokedAt).toBeNull();
  });

  it('a removed panorama purges the variants and the stored copy', async () => {
    const made = await renderedSource();
    const seen: (LatLng | null)[] = [];
    const result = await renderAgain(
      answering({ status: 'missing', metadata: metadata('ZERO_RESULTS', null) }, seen),
      made,
    );
    // Without retained coordinates no location is probed.
    expect(seen).toEqual([null]);
    expect(result.state).toBe('failed');
    expect(result.source.state).toBe('stale');
    expect(result.variants).toEqual([]);
    expect(result.source.objectKey).toBeNull();
    expect(await base.storage.head('private', made.source.objectKey!)).toBeNull();
  });

  it('an unchanged panorama renders', async () => {
    const made = await renderedSource();
    const result = await renderAgain(
      answering({
        status: 'unchanged',
        metadata: metadata('OK', made.source.viewpoint!.panoId),
      }),
      made,
    );
    expect(result.state).toBe('succeeded');
    expect(result.source.state).toBe('ready');
  });
});

describe('panorama verdicts', () => {
  it('reads every refresh answer, never treating an uninformative one as a removal', () => {
    const pano = 'fxSvPinned01';
    expect(panoramaVerdict(null, pano)).toBe('unknown');
    expect(panoramaVerdict({ status: 'unchanged', metadata: metadata('OK', pano) }, pano)).toBe(
      'present',
    );
    expect(
      panoramaVerdict({ status: 'replaced', metadata: metadata('OK', 'fxSvNewer') }, pano),
    ).toBe('replaced');
    expect(
      panoramaVerdict({ status: 'error', metadata: metadata('OVER_QUERY_LIMIT', null) }, pano),
    ).toBe('unknown');
    expect(
      panoramaVerdict({ status: 'missing', metadata: metadata('ZERO_RESULTS', null) }, pano),
    ).toBe('removed');
    // A `missing` answer that carries newer imagery is read as a replacement.
    expect(
      panoramaVerdict({ status: 'missing', metadata: metadata('OK', 'fxSvNewer') }, pano),
    ).toBe('replaced');
  });
});
