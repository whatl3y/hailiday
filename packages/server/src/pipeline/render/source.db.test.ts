import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import type { SourceAsset, ViewpointFraming } from '../../db/schema.js';
import { fixturePanoramaGeometry, renderFixturePanorama } from '../../fixtures/street-view.js';
import type { LatLng } from '../../providers/geo.js';
import { frameView, framedViewOf } from '../../providers/street-view/framing.js';
import type {
  RefreshPanoramaResult,
  StreetViewProvider,
  StreetViewView,
} from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { prepareWorkingImage } from '../imaging/working.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  fixturePlace,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { runRenderJob } from './job.js';
import { panoramaVerdict } from './source.js';
import { terminateRenderJob } from './terminate.js';
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

describe('Street View source modes at render time', () => {
  it('decorates and stores a source recorded as display-only once its policy allows it', async () => {
    const created = await createStreetViewSource(base, { placeId: PLACE });
    await base.db
      .updateTable('sourceAssets')
      .set({ streetViewMode: 'display_only' })
      .where('id', '=', created.source.id)
      .execute();
    const source = { ...created.source, streetViewMode: 'display_only' as const };
    const job = await createRenderJobRecord(base, { ...created, source });
    expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('succeeded');
    const stored = await base.db
      .selectFrom('sourceAssets')
      .select('objectKey')
      .where('id', '=', source.id)
      .executeTakeFirstOrThrow();
    expect(stored.objectKey).not.toBeNull();
  });

  it('keeps a persist source in memory when its policy no longer allows storage', async () => {
    const created = await createStreetViewSource(base, {
      placeId: PLACE,
      streetViewMode: 'persist',
    });
    await base.db
      .updateTable('assetPolicies')
      .set({ store: 'denied', distributeDerivative: 'denied', commerceAdjacent: 'denied' })
      .where('id', '=', created.source.assetPolicyId as string)
      .execute();
    const job = await createRenderJobRecord(base, created);
    expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('succeeded');
    const stored = await base.db
      .selectFrom('sourceAssets')
      .select('objectKey')
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(stored.objectKey).toBeNull();
  });
});

/** Deps whose Street View fetches run `during` before they answer. */
function fetching(during: (view: StreetViewView) => Promise<void>): PipelineDeps {
  const inner = base.providers.fixtures.streetView;
  const streetView: StreetViewProvider = {
    ...inner,
    async fetchTransient(view, options) {
      await during(view);
      return inner.fetchTransient(view, options);
    },
  };
  return {
    ...base,
    providers: { ...base.providers, fixtures: { ...base.providers.fixtures, streetView } },
  };
}

/** A framing record another run writes into a viewpoint. */
const otherFraming: ViewpointFraming = {
  status: 'kept',
  reason: 'no_home',
  box: null,
  promptVersion: 'frame-test',
  model: 'other-run',
  framedAt: '2026-11-11T00:00:00.000Z',
};

async function sourceOf(id: string) {
  return base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

describe('what a render writes into a stored Street View frame', () => {
  it('a first store keeps a frame another run stored meanwhile, and its viewpoint', async () => {
    const created = await createStreetViewSource(base, {
      placeId: PLACE,
      streetViewMode: 'persist',
    });
    // While this render fetches its first frame, another run stores a frame (a slightly wider
    // view) and writes its framing into the viewpoint.
    const other = (await renderFixturePanorama({
      ...framedViewOf(created.source.viewpoint!),
      fov: created.source.viewpoint!.fov - 5,
    }))!;
    const key = keys.original(created.ownerId, created.source.id);
    const deps = fetching(async () => {
      await base.storage.put({
        bucket: 'private',
        key,
        body: other.image,
        contentType: 'image/jpeg',
        provenance: {
          sourceKind: 'street_view',
          permission: { store: true, evidenceId: 'test' } as never,
        },
      });
      const row = await sourceOf(created.source.id);
      await base.db
        .updateTable('sourceAssets')
        .set({
          objectKey: key,
          checksumSha256: other.checksum,
          byteLength: other.image.length,
          viewpoint: toJson({ ...row.viewpoint!, framing: otherFraming }),
        })
        .where('id', '=', created.source.id)
        .execute();
    });
    const job = await createRenderJobRecord(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const row = await sourceOf(created.source.id);
    expect(row.checksumSha256).toBe(other.checksum);
    expect(row.viewpoint?.framing).toEqual(otherFraming);
    const stored = await base.storage.get('private', key);
    expect(sha256Hex(stored!.body)).toBe(other.checksum);
  });

  for (const how of ['aged', 'damaged'] as const) {
    it(`a refetch of an ${how} frame writes only its fetch and check times into the viewpoint`, async () => {
      const made = await renderedSource();
      const viewpoint = made.source.viewpoint!;
      if (how === 'aged') {
        await base.db
          .updateTable('sourceAssets')
          .set({ viewpoint: toJson({ ...viewpoint, fetchedAt: '2020-01-01T00:00:00.000Z' }) })
          .where('id', '=', made.source.id)
          .execute();
      } else {
        const other = (await renderFixturePanorama({
          ...framedViewOf(viewpoint),
          fov: viewpoint.fov - 5,
        }))!;
        expect(other.checksum).not.toBe(made.source.checksumSha256);
        await base.storage.put({
          bucket: 'private',
          key: made.source.objectKey!,
          body: other.image,
          contentType: 'image/jpeg',
          provenance: {
            sourceKind: 'street_view',
            permission: { store: true, evidenceId: 'test' } as never,
          },
        });
      }
      // While the frame is fetched again, another run writes its framing into the viewpoint.
      let fetches = 0;
      const deps = fetching(async () => {
        fetches += 1;
        await base.db
          .updateTable('sourceAssets')
          .set({
            viewpoint: sql<string>`jsonb_set(viewpoint, '{framing}', ${JSON.stringify(otherFraming)}::jsonb)`,
          })
          .where('id', '=', made.source.id)
          .execute();
      });
      const started = Date.now();
      const result = await renderAgain(deps, made);
      expect(result.state).toBe('succeeded');
      expect(fetches).toBe(1);
      expect(result.source.viewpoint?.framing).toEqual(otherFraming);
      expect(Date.parse(result.source.viewpoint!.fetchedAt!)).toBeGreaterThanOrEqual(started);
      expect(result.source.viewpoint?.sourceCheckedAt).toBe(result.source.viewpoint?.fetchedAt);
      expect(result.source.viewpoint?.heading).toBe(viewpoint.heading);
    });
  }
});

/** A place whose wide frame shows its home small enough to zoom in on. */
const FRAMED_PLACE = 'ChIJfxOldQuarryRoadColoni19';

/** The pipeline with the framing switched on. */
function framingOn(deps: PipelineDeps): PipelineDeps {
  return {
    ...deps,
    config: { ...deps.config, streetView: { ...deps.config.streetView, framing: true } },
  };
}

/** The framed view the fixture analysis of a viewpoint's wide frame leads to. */
function expectedFramedView(viewpoint: NonNullable<SourceAsset['viewpoint']>): StreetViewView {
  const wide = framedViewOf(viewpoint);
  const facade = fixturePanoramaGeometry(wide)?.targetFacade;
  if (!facade) throw new Error('the fixture frame has no facade');
  const framed = frameView(wide, facade, {
    marginFraction: PIPELINE_DEFAULTS.framing.marginFraction,
    minFovDeg: PIPELINE_DEFAULTS.framing.minFovDeg,
    slackBelowShare: PIPELINE_DEFAULTS.framing.slackBelowShare,
  });
  return { ...wide, heading: framed.heading, pitch: framed.pitch, fov: framed.fov };
}

/** The SHA-256 of the frame stored for a source, if any. */
async function storedChecksumOf(id: string): Promise<string | null> {
  const row = await sourceOf(id);
  const stored = row.objectKey ? await base.storage.get('private', row.objectKey) : null;
  return stored ? sha256Hex(stored.body) : null;
}

/**
 * Deps whose fixture Street View answers `answer(view)` when given (other bytes for a view) and
 * runs `during` once, before the first fetch answers.
 */
function streetViewOf(
  deps: PipelineDeps,
  options: {
    answer?: (view: StreetViewView) => { image: Buffer; checksum: string } | null;
    during?: () => Promise<void>;
  },
): PipelineDeps {
  const inner = deps.providers.fixtures.streetView;
  let ran = false;
  const streetView: StreetViewProvider = {
    ...inner,
    async fetchTransient(view, callOptions) {
      if (options.during && !ran) {
        ran = true;
        await options.during();
      }
      const fetched = await inner.fetchTransient(view, callOptions);
      const other = options.answer?.(view) ?? null;
      return other ? { ...fetched, bytes: other.image, checksum: other.checksum } : fetched;
    },
  };
  return {
    ...deps,
    providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, streetView } },
  };
}

describe('a stored frame fetched again while another run changes it', { timeout: 120_000 }, () => {
  for (const how of ['damaged', 'aged'] as const) {
    it(`${how}: a canceled run's late refetch leaves the framed frame of the next job`, async () => {
      const made = await createStreetViewSource(base, {
        placeId: FRAMED_PLACE,
        streetViewMode: 'persist',
      });
      // A first look with the framing off: the wide frame is stored and has a look.
      const first = await createRenderJobRecord(base, made);
      expect((await runRenderJob(base, { renderJobId: first.id })).state).toBe('succeeded');
      const wideRow = await sourceOf(made.source.id);
      const wideView = framedViewOf(made.source.viewpoint!);
      const wide = (await renderFixturePanorama(wideView))!;
      expect(wideRow.checksumSha256).toBe(wide.checksum);
      const framedFrame = (await renderFixturePanorama(
        expectedFramedView(made.source.viewpoint!),
      ))!;

      // What the provider returns for the wide view from now on.
      let wideNow = wide;
      if (how === 'damaged') {
        // The stored object holds other bytes than its row records.
        const other = (await renderFixturePanorama({ ...wideView, fov: wideView.fov - 5 }))!;
        await base.storage.put({
          bucket: 'private',
          key: wideRow.objectKey!,
          body: other.image,
          contentType: 'image/jpeg',
          provenance: {
            sourceKind: 'street_view',
            permission: { store: true, evidenceId: 'test' } as never,
          },
        });
      } else {
        // The stored frame is past its maximum age and the provider now returns other bytes.
        await base.db
          .updateTable('sourceAssets')
          .set({
            viewpoint: toJson({ ...wideRow.viewpoint!, fetchedAt: '2020-01-01T00:00:00.000Z' }),
          })
          .where('id', '=', wideRow.id)
          .execute();
        wideNow = (await renderFixturePanorama({ ...wideView, fov: wideView.fov - 3 }))!;
        expect(wideNow.checksum).not.toBe(wide.checksum);
      }
      const answer = (view: StreetViewView) => (view.fov === wideView.fov ? wideNow : null);

      // Run A fetches the stored frame again. While its fetch is in flight it is canceled (its
      // run goes on), and job B of the same project frames the source and makes its look.
      let jobAId = '';
      let jobBId = '';
      let bState = '';
      const depsA = streetViewOf(framingOn(base), {
        answer,
        during: async () => {
          await terminateRenderJob(base, { jobId: jobAId, to: 'canceled' });
          const jobB = await createRenderJobRecord(base, {
            ...made,
            source: await sourceOf(made.source.id),
            holidayId: 'halloween',
          });
          jobBId = jobB.id;
          const depsB = streetViewOf(framingOn(base), { answer });
          bState = (await runRenderJob(depsB, { renderJobId: jobB.id })).state;
        },
      });
      const jobA = await createRenderJobRecord(depsA, {
        ...made,
        source: await sourceOf(made.source.id),
        holidayId: 'halloween',
      });
      jobAId = jobA.id;
      await runRenderJob(depsA, { renderJobId: jobA.id }).catch(() => null);

      expect(bState).toBe('succeeded');
      expect((await readJob(base.db, jobAId))?.state).toBe('canceled');
      const framedWorking = await prepareWorkingImage(framedFrame.image, 'street_view');
      expect((await readJob(base.db, jobBId))?.workingChecksumSha256).toBe(framedWorking.checksum);
      // A's late answer writes nothing: the source keeps the framed frame B's look was made from.
      const row = await sourceOf(made.source.id);
      expect(row.viewpoint?.framing?.status).toBe('framed');
      expect(row.checksumSha256).toBe(framedFrame.checksum);
      expect(await storedChecksumOf(made.source.id)).toBe(framedFrame.checksum);
    });
  }

  it('writes nothing once the row records another frame, and renders that frame', async () => {
    const made = await renderedSource();
    const viewpoint = made.source.viewpoint!;
    await base.db
      .updateTable('sourceAssets')
      .set({ viewpoint: toJson({ ...viewpoint, fetchedAt: '2020-01-01T00:00:00.000Z' }) })
      .where('id', '=', made.source.id)
      .execute();
    // While the aged frame is fetched again, another run stores other bytes under the key.
    const other = (await renderFixturePanorama({
      ...framedViewOf(viewpoint),
      fov: viewpoint.fov - 5,
    }))!;
    const deps = streetViewOf(base, {
      during: async () => {
        await base.storage.put({
          bucket: 'private',
          key: made.source.objectKey!,
          body: other.image,
          contentType: 'image/jpeg',
          provenance: {
            sourceKind: 'street_view',
            permission: { store: true, evidenceId: 'test' } as never,
          },
        });
        await base.db
          .updateTable('sourceAssets')
          .set({ checksumSha256: other.checksum, byteLength: other.image.length })
          .where('id', '=', made.source.id)
          .execute();
      },
    });
    const result = await renderAgain(deps, made);
    expect(result.state).toBe('succeeded');
    expect(result.source.checksumSha256).toBe(other.checksum);
    expect(await storedChecksumOf(made.source.id)).toBe(other.checksum);
    // The fetch time is not restarted by the run that wrote nothing.
    expect(result.source.viewpoint?.fetchedAt).toBe('2020-01-01T00:00:00.000Z');
    const working = await prepareWorkingImage(other.image, 'street_view');
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
  });
});
