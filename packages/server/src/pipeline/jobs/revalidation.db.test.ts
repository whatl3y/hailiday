import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMs } from '../../clock/index.js';
import { toJson } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { loadFixtureData } from '../../fixtures/data.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import { FIXTURE_METADATA_ERROR_PANO_PREFIX } from '../../providers/street-view/fixture.js';
import type { LatLng } from '../../providers/geo.js';
import type {
  RefreshPanoramaResult,
  StreetViewMetadata,
  StreetViewProvider,
} from '../../providers/types.js';
import { createStorage } from '../../storage/client.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { runStreetViewRevalidation } from './commerce-and-coverage.js';
import { copyHeldObjects, placePreservationHold } from './holds.js';

let base: PipelineDeps & { close(): Promise<void> };
let deps: PipelineDeps;
let photo: Buffer;

/** This file's own buckets, so its purges never touch another file's objects. */
const BUCKETS = {
  private: 'test-revalidation-private',
  public: 'test-revalidation-public',
} as const;
const PLACE = 'ChIJfxLanternHillColonial01';

beforeAll(async () => {
  base = await createPipelineTestDeps();
  const storage = createStorage(base.config, { buckets: { ...BUCKETS } });
  for (const bucket of Object.values(BUCKETS)) await storage.ensureBucket(bucket);
  deps = { ...base, storage };
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
  });
  photo = await sharp(frame?.image ?? Buffer.alloc(0))
    .resize(1200, 800, { fit: 'fill' })
    .jpeg()
    .toBuffer();
});

afterAll(async () => {
  deps.storage.destroy();
  await base.close();
});

const metadata = (status: StreetViewMetadata['status'], panoId: string | null = null) => ({
  status,
  panoId,
  location: null,
  date: null,
  copyright: null,
});

/** A scripted answer, a thrown error, or `fixture`: the fixture adapter itself answers. */
type Answer = RefreshPanoramaResult | 'throw' | 'fixture';

/**
 * Revalidation deps whose Street View metadata answers this file's pano IDs as scripted (recording
 * the location each call probed). Every other pano ID answers `error`, which changes nothing, so
 * these runs never touch the sources of other test files.
 */
function revalidating(
  answers: Map<string, Answer>,
  seen: { panoId: string; location: LatLng | null }[],
) {
  const streetView: StreetViewProvider = {
    ...base.providers.fixtures.streetView,
    async refreshPanorama(panoId, options) {
      const answer = answers.get(panoId);
      if (!answer) return { status: 'error', metadata: metadata('UNKNOWN_ERROR') };
      seen.push({ panoId, location: options?.location ?? null });
      if (answer === 'throw') throw new Error('metadata request failed');
      if (answer === 'fixture') {
        return base.providers.fixtures.streetView.refreshPanorama(panoId, options);
      }
      return answer;
    },
  };
  return {
    ...deps,
    providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, streetView } },
  } satisfies PipelineDeps;
}

/**
 * A rendered Street View source made `persist` with a stored copy under a pano ID of its own,
 * `ready` and due, or `stale` with live variants. `pinned` sets the property's target point. The
 * fixture adapter answers the pano ID with a failed metadata call, so revalidation runs of other
 * test files leave the source as it is.
 */
async function persistedSource(
  options: { state?: 'ready' | 'stale'; pinned?: LatLng; panoId?: string } = {},
): Promise<{
  source: SourceAsset;
  ownerId: string;
  projectId: string;
  panoId: string;
  storedKey: string;
  assetId: string;
  grantId: string;
}> {
  const created = await createStreetViewSource(deps, { placeId: PLACE });
  const job = await createRenderJobRecord(deps, created);
  expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
  const asset = await deps.db
    .selectFrom('renderAssets')
    .select('id')
    .where('jobId', '=', job.id)
    .executeTakeFirstOrThrow();
  const token = randomToken(16);
  const grantId = newId();
  await deps.db
    .insertInto('shareGrants')
    .values({
      id: grantId,
      ownerId: created.ownerId,
      renderAssetId: asset.id,
      tokenHash: sha256Hex(token),
      expiresAt: addMs(new Date(), 30 * 86_400_000),
      shareCardObjectKey: keys.card(token),
    })
    .execute();
  const storedKey = keys.original(created.ownerId, created.source.id);
  await deps.storage.put({
    bucket: 'private',
    key: storedKey,
    body: photo,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  const panoId =
    options.panoId ??
    `${FIXTURE_METADATA_ERROR_PANO_PREFIX}Revalidation${newId().replace(/-/g, '')}`;
  await deps.db
    .updateTable('sourceAssets')
    .set({
      streetViewMode: 'persist',
      objectKey: storedKey,
      revalidatedAt: null,
      viewpoint: toJson({ ...created.source.viewpoint!, panoId }),
      ...(options.state === 'stale' ? { state: 'stale' as const, staleAt: new Date() } : {}),
    })
    .where('id', '=', created.source.id)
    .execute();
  if (options.pinned) {
    const project = await deps.db
      .selectFrom('projects')
      .select('propertyId')
      .where('id', '=', created.projectId)
      .executeTakeFirstOrThrow();
    await deps.db
      .updateTable('properties')
      .set({
        targetLat: options.pinned.latitude,
        targetLng: options.pinned.longitude,
        coordsExpireAt: addMs(new Date(), 86_400_000),
      })
      .where('id', '=', project.propertyId!)
      .execute();
  }
  const source = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', created.source.id)
    .executeTakeFirstOrThrow();
  return { ...created, source, panoId, storedKey, assetId: asset.id, grantId };
}

async function after(made: { source: SourceAsset; assetId: string; grantId: string }) {
  const source = await deps.db
    .selectFrom('sourceAssets')
    .select(['state', 'objectKey', 'revalidatedAt'])
    .where('id', '=', made.source.id)
    .executeTakeFirstOrThrow();
  const variant = await deps.db
    .selectFrom('renderAssets')
    .select(['withdrawnAt', 'deletedAt'])
    .where('id', '=', made.assetId)
    .executeTakeFirstOrThrow();
  const grant = await deps.db
    .selectFrom('shareGrants')
    .select('revokedAt')
    .where('id', '=', made.grantId)
    .executeTakeFirstOrThrow();
  return { source, variant, grant };
}

const stored = async (key: string) => (await deps.storage.head('private', key)) !== null;

describe('Street View revalidation outcomes', () => {
  it('changes nothing when the metadata call fails or says nothing about the imagery', async () => {
    const quota = await persistedSource();
    const denied = await persistedSource();
    const network = await persistedSource();
    const staleQuota = await persistedSource({ state: 'stale' });
    const answers = new Map<string, Answer>([
      [quota.panoId, { status: 'error', metadata: metadata('OVER_QUERY_LIMIT') }],
      [denied.panoId, { status: 'error', metadata: metadata('REQUEST_DENIED') }],
      [network.panoId, 'throw'],
      [staleQuota.panoId, { status: 'error', metadata: metadata('UNKNOWN_ERROR') }],
    ]);
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(revalidating(answers, seen));
    expect(seen.map((call) => call.panoId).sort()).toEqual([...answers.keys()].sort());
    expect(result.failed).toBeGreaterThanOrEqual(4);

    for (const made of [quota, denied, network]) {
      const state = await after(made);
      expect(state.source).toEqual({
        state: 'ready',
        objectKey: made.storedKey,
        revalidatedAt: null,
      });
      expect(await stored(made.storedKey)).toBe(true);
      expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
      expect(state.grant.revokedAt).toBeNull();
    }
    const stale = await after(staleQuota);
    expect(stale.source).toEqual({
      state: 'stale',
      objectKey: staleQuota.storedKey,
      revalidatedAt: null,
    });
    expect(await stored(staleQuota.storedKey)).toBe(true);
    expect(stale.variant).toEqual({ withdrawnAt: null, deletedAt: null });
  });

  it('probes the pinned location and keeps the variants of a panorama replaced by newer imagery', async () => {
    const pinned = { latitude: 40.7128, longitude: -74.006 };
    const replaced = await persistedSource({ pinned });
    const removed = await persistedSource();
    const answers = new Map<string, Answer>([
      [replaced.panoId, { status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery01') }],
      [removed.panoId, { status: 'missing', metadata: metadata('ZERO_RESULTS') }],
    ]);
    const seen: { panoId: string; location: LatLng | null }[] = [];
    await runStreetViewRevalidation(revalidating(answers, seen));
    expect(seen.find((call) => call.panoId === replaced.panoId)?.location).toEqual(pinned);
    expect(seen.find((call) => call.panoId === removed.panoId)?.location).toBeNull();

    const kept = await after(replaced);
    expect(kept.source.state).toBe('stale');
    expect(kept.source.objectKey).toBeNull();
    expect(kept.source.revalidatedAt).not.toBeNull();
    expect(await stored(replaced.storedKey)).toBe(false);
    expect(kept.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    expect(kept.grant.revokedAt).toBeNull();

    const purged = await after(removed);
    expect(purged.source).toMatchObject({ state: 'stale', objectKey: null });
    expect(await stored(removed.storedKey)).toBe(false);
    expect(purged.variant.withdrawnAt).not.toBeNull();
    expect(purged.grant.revokedAt).not.toBeNull();
  });

  it('reads a retired pano ID at a place with newer imagery as replaced through the fixture adapter', async () => {
    const place = loadFixtureData().placeById(PLACE)!;
    const made = await persistedSource({
      pinned: place.destinations.targetPoint ?? place.location,
      panoId: `fxSvRetired${newId().replace(/-/g, '')}`,
    });
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(new Map<string, Answer>([[made.panoId, 'fixture']]), seen),
    );
    expect(seen).toHaveLength(1);
    expect(result.stale).toBeGreaterThanOrEqual(1);

    const kept = await after(made);
    expect(kept.source.state).toBe('stale');
    expect(kept.source.objectKey).toBeNull();
    expect(kept.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    expect(kept.grant.revokedAt).toBeNull();
  });

  it('never deletes the stored copy of a held source', async () => {
    const removedHeld = await persistedSource();
    const staleHeld = await persistedSource({ state: 'stale' });
    for (const made of [removedHeld, staleHeld]) {
      const placed = await deps.db.transaction().execute((trx) =>
        placePreservationHold(trx, {
          targetKind: 'source_asset',
          targetId: made.source.id,
          reason: 'complaint_investigation',
          authorityRef: `test:${made.source.id}`,
          releaseCondition: 'test',
          placedBy: null,
        }),
      );
      await copyHeldObjects(deps, placed.holdId);
    }
    const answers = new Map<string, Answer>([
      [removedHeld.panoId, { status: 'missing', metadata: metadata('ZERO_RESULTS') }],
      [staleHeld.panoId, { status: 'unchanged', metadata: metadata('OK', staleHeld.panoId) }],
    ]);
    await runStreetViewRevalidation(revalidating(answers, []));

    const removed = await after(removedHeld);
    expect(removed.source.state).toBe('stale');
    expect(removed.source.revalidatedAt).not.toBeNull();
    expect(removed.source.objectKey).toBe(removedHeld.storedKey);
    expect(await stored(removedHeld.storedKey)).toBe(true);

    const stale = await after(staleHeld);
    expect(stale.source.state).toBe('stale');
    expect(stale.source.revalidatedAt).not.toBeNull();
    expect(stale.source.objectKey).toBe(staleHeld.storedKey);
    expect(await stored(staleHeld.storedKey)).toBe(true);
  });
});
