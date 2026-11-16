import { sql } from 'kysely';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addMs, createManualClock } from '../../clock/index.js';
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
import { SERVER_TEST_BUCKETS } from '../../storage/testing.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { queueDefinitions } from '../../queue/definitions.js';
import { createJobHandlers } from '../handlers.js';
import {
  STREET_VIEW_REVALIDATION_RUN_BUDGET_MS,
  runStreetViewRevalidation,
} from './commerce-and-coverage.js';
import { copyHeldObjects, placePreservationHold } from './holds.js';

let base: PipelineDeps & { close(): Promise<void> };
let deps: PipelineDeps;
let photo: Buffer;

/** This file's own buckets, so its purges never touch another file's objects. */
const BUCKETS = SERVER_TEST_BUCKETS.revalidation;
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
  token: string;
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
  return { ...created, source, panoId, storedKey, assetId: asset.id, grantId, token };
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

  it('stamps a source it marks stale with the time of the write, not the time the run started', async () => {
    const made = await persistedSource();
    const clock = createManualClock(Date.now());
    const startedAt = clock.now();
    const revalidation = revalidating(
      new Map<string, Answer>([
        [made.panoId, { status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery04') }],
      ]),
      [],
    );
    const streetView = revalidation.providers.fixtures.streetView;
    // The run spends ten minutes before it reaches this source's metadata answer.
    const slow: PipelineDeps = {
      ...revalidation,
      clock,
      providers: {
        ...revalidation.providers,
        fixtures: {
          ...revalidation.providers.fixtures,
          streetView: {
            ...streetView,
            async refreshPanorama(panoId, options) {
              clock.advance(10 * 60_000);
              return streetView.refreshPanorama(panoId, options);
            },
          },
        },
      },
    };
    const result = await runStreetViewRevalidation(slow, { sourceAssetIds: [made.source.id] });
    expect(result).toMatchObject({ checked: 1, stale: 1 });
    const row = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'staleAt', 'revalidatedAt'])
      .where('id', '=', made.source.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe('stale');
    expect(row.staleAt).toEqual(addMs(startedAt, 10 * 60_000));
    expect(row.revalidatedAt).toEqual(row.staleAt);
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
      [staleHeld.panoId, { status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery02') }],
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
    expect(stale.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    expect(stale.grant.revokedAt).toBeNull();
  });
});

describe('Street View revalidation of stale and declined sources', () => {
  const unchanged = (panoId: string): Answer => ({
    status: 'unchanged',
    metadata: metadata('OK', panoId),
  });

  async function setSource(id: string, values: { state?: 'declined'; copyright?: string }) {
    await deps.db.updateTable('sourceAssets').set(values).where('id', '=', id).execute();
  }

  async function withdrawLooks(sourceId: string) {
    await deps.db
      .updateTable('renderAssets')
      .set({ withdrawnAt: new Date() })
      .where('sourceAssetId', '=', sourceId)
      .execute();
  }

  it('makes a stale source whose own panorama is still served ready again, with its stored copy', async () => {
    const made = await persistedSource({ state: 'stale' });
    const result = await runStreetViewRevalidation(
      revalidating(new Map([[made.panoId, unchanged(made.panoId)]]), []),
      { sourceAssetIds: [made.source.id] },
    );
    expect(result).toMatchObject({ checked: 1, restored: 1, stale: 0, removed: 0 });
    const state = await after(made);
    expect(state.source).toMatchObject({ state: 'ready', objectKey: made.storedKey });
    expect(state.source.revalidatedAt).not.toBeNull();
    expect(await stored(made.storedKey)).toBe(true);
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    const row = await deps.db
      .selectFrom('sourceAssets')
      .select(['staleAt', 'viewpoint'])
      .where('id', '=', made.source.id)
      .executeTakeFirstOrThrow();
    expect(row.staleAt).toBeNull();
    expect(Date.now() - Date.parse(row.viewpoint!.sourceCheckedAt!)).toBeLessThan(60_000);
  });

  it('checks a stale source that keeps a stored frame but no look, and deletes the frame', async () => {
    const made = await persistedSource({ state: 'stale' });
    await withdrawLooks(made.source.id);
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery03') }],
        ]),
        seen,
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(seen.map((call) => call.panoId)).toEqual([made.panoId]);
    expect(result.checked).toBe(1);
    const state = await after(made);
    expect(state.source).toMatchObject({ state: 'stale', objectKey: null });
    expect(state.source.revalidatedAt).not.toBeNull();
    expect(await stored(made.storedKey)).toBe(false);
  });

  it('applies a tightened policy to a declined source: its shared link is revoked and its frame deleted', async () => {
    const made = await persistedSource();
    await setSource(made.source.id, { state: 'declined' });
    await publishShareCopies(made.token);
    const result = await runStreetViewRevalidation(
      underUsePolicy('decorate', new Map([[made.panoId, unchanged(made.panoId)]])),
      { sourceAssetIds: [made.source.id] },
    );
    expect(result).toMatchObject({ checked: 1, sharesRevoked: 1, framesDropped: 1, restored: 0 });
    const state = await after(made);
    expect(state.source).toMatchObject({ state: 'declined', objectKey: null });
    expect(state.source.revalidatedAt).not.toBeNull();
    expect(await stored(made.storedKey)).toBe(false);
    expect(state.grant.revokedAt).not.toBeNull();
    expect(await publicCopies(made.token)).toBe(0);
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
  });

  it('keeps the frame of a declined source whose panorama is still served under an unchanged policy', async () => {
    const made = await persistedSource();
    await setSource(made.source.id, { state: 'declined' });
    await runStreetViewRevalidation(
      revalidating(new Map([[made.panoId, unchanged(made.panoId)]]), []),
      { sourceAssetIds: [made.source.id] },
    );
    const state = await after(made);
    expect(state.source).toMatchObject({ state: 'declined', objectKey: made.storedKey });
    expect(state.source.revalidatedAt).not.toBeNull();
    expect(await stored(made.storedKey)).toBe(true);
    expect(state.grant.revokedAt).toBeNull();
  });

  it('keeps the looks and shared link of a declined source whose panorama was replaced, deleting its frame', async () => {
    const made = await persistedSource();
    await setSource(made.source.id, { state: 'declined' });
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'replaced', metadata: metadata('OK', 'fxSvNewerImagery05') }],
        ]),
        [],
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(result).toMatchObject({ checked: 1, removed: 0, variantsPurged: 0, restored: 0 });
    const state = await after(made);
    expect(state.source).toMatchObject({ state: 'declined', objectKey: null });
    expect(state.source.revalidatedAt).not.toBeNull();
    expect(await stored(made.storedKey)).toBe(false);
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    expect(state.grant.revokedAt).toBeNull();
  });

  it('purges the looks of a declined source whose panorama was removed, keeping a held frame', async () => {
    const free = await persistedSource();
    const held = await persistedSource();
    for (const made of [free, held]) await setSource(made.source.id, { state: 'declined' });
    const placed = await deps.db.transaction().execute((trx) =>
      placePreservationHold(trx, {
        targetKind: 'source_asset',
        targetId: held.source.id,
        reason: 'complaint_investigation',
        authorityRef: `test:${held.source.id}`,
        releaseCondition: 'test',
        placedBy: null,
      }),
    );
    await copyHeldObjects(deps, placed.holdId);
    const removed: Answer = { status: 'missing', metadata: metadata('ZERO_RESULTS') };
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map([
          [free.panoId, removed],
          [held.panoId, removed],
        ]),
        [],
      ),
      { sourceAssetIds: [free.source.id, held.source.id] },
    );
    expect(result.removed).toBe(2);

    const purged = await after(free);
    expect(purged.source).toMatchObject({ state: 'declined', objectKey: null });
    expect(await stored(free.storedKey)).toBe(false);
    expect(purged.variant.withdrawnAt).not.toBeNull();
    expect(purged.grant.revokedAt).not.toBeNull();

    const kept = await after(held);
    expect(kept.source).toMatchObject({ state: 'declined', objectKey: held.storedKey });
    expect(await stored(held.storedKey)).toBe(true);
  });

  it('never purges a declined source the configured provider cannot judge', async () => {
    const made = await persistedSource();
    await setSource(made.source.id, { state: 'declined', copyright: '© 2025 Google' });
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'missing', metadata: metadata('ZERO_RESULTS') }],
        ]),
        seen,
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(seen).toEqual([]);
    expect(result).toMatchObject({ checked: 1, skipped: 1, removed: 0 });
    const state = await after(made);
    expect(state.source).toMatchObject({
      state: 'declined',
      objectKey: made.storedKey,
      revalidatedAt: null,
    });
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
  });
});

/**
 * A `ready` Street View source with a stored frame under a pano ID of its own (no render), last
 * checked at `revalidatedAt`.
 */
async function storedSource(revalidatedAt: Date | null, copyright?: string) {
  const created = await createStreetViewSource(deps, { placeId: PLACE, streetViewMode: 'persist' });
  const storedKey = keys.original(created.ownerId, created.source.id);
  await deps.storage.put({
    bucket: 'private',
    key: storedKey,
    body: photo,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'upload' },
  });
  const panoId = `${FIXTURE_METADATA_ERROR_PANO_PREFIX}Batch${newId().replace(/-/g, '')}`;
  await deps.db
    .updateTable('sourceAssets')
    .set({
      objectKey: storedKey,
      revalidatedAt,
      viewpoint: toJson({ ...created.source.viewpoint!, panoId }),
      ...(copyright ? { copyright } : {}),
    })
    .where('id', '=', created.source.id)
    .execute();
  return { ...created, panoId, storedKey };
}

describe('Street View revalidation at scale', () => {
  it('takes due sources oldest check first in batches, each once, until none is due', async () => {
    const day = 86_400_000;
    const made = [
      await storedSource(new Date(Date.now() - 3 * day)),
      await storedSource(null),
      await storedSource(new Date(Date.now() - 10 * day)),
      await storedSource(new Date(Date.now() - 5 * day)),
      await storedSource(new Date(Date.now() - 2 * day)),
    ];
    const failing = made[3]!;
    const answers = new Map<string, Answer>(
      made.map((entry) => [
        entry.panoId,
        entry === failing
          ? { status: 'error', metadata: metadata('UNKNOWN_ERROR') }
          : { status: 'unchanged', metadata: metadata('OK', entry.panoId) },
      ]),
    );
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(revalidating(answers, seen), {
      limit: 2,
      sourceAssetIds: made.map((entry) => entry.source.id),
    });
    // Never checked first, then the oldest check; the failed call is not taken again.
    expect(seen.map((call) => call.panoId)).toEqual(
      [made[1], made[2], made[3], made[0], made[4]].map((entry) => entry!.panoId),
    );
    expect(result).toMatchObject({ checked: 5, failed: 1, stale: 0 });
    for (const entry of made) {
      const row = await deps.db
        .selectFrom('sourceAssets')
        .select(['state', 'revalidatedAt', 'objectKey'])
        .where('id', '=', entry.source.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('ready');
      expect(row.objectKey).toBe(entry.storedKey);
      if (entry === failing) expect(Date.now() - row.revalidatedAt!.getTime()).toBeGreaterThan(day);
      else expect(Date.now() - row.revalidatedAt!.getTime()).toBeLessThan(60_000);
    }
  });

  it('stops taking batches when the run budget is spent, leaving the rest due', async () => {
    const made = await storedSource(null);
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
        seen,
      ),
      { maxDurationMs: 0, sourceAssetIds: [made.source.id] },
    );
    expect(seen).toEqual([]);
    expect(result.checked).toBe(0);
  });

  it('expires the queued run after its batch budget and before the next hourly run', () => {
    const expiry = queueDefinitions(deps.config).street_view_revalidation.expireInSeconds * 1000;
    expect(expiry).toBeGreaterThan(STREET_VIEW_REVALIDATION_RUN_BUDGET_MS);
    expect(expiry).toBeLessThan(3_600_000);
  });

  it('never asks the fixture adapter about real Google imagery', async () => {
    const made = await storedSource(null, '© 2025 Google');
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'missing', metadata: metadata('ZERO_RESULTS') }],
        ]),
        seen,
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(seen).toEqual([]);
    expect(result).toMatchObject({ checked: 1, skipped: 1, removed: 0 });
    const row = await deps.db
      .selectFrom('sourceAssets')
      .select(['state', 'objectKey', 'revalidatedAt'])
      .where('id', '=', made.source.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ state: 'ready', objectKey: made.storedKey, revalidatedAt: null });
  });
});

describe('Street View revalidation after the use policy changes', () => {
  it('deletes a stored frame whose policy no longer allows storage and keeps the looks', async () => {
    const made = await persistedSource();
    const decorating: PipelineDeps = {
      ...revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
        [],
      ),
      config: { ...deps.config, streetView: { ...deps.config.streetView, usePolicy: 'decorate' } },
    };
    const result = await runStreetViewRevalidation(decorating, {
      sourceAssetIds: [made.source.id],
    });
    expect(result.framesDropped).toBe(1);
    const state = await after(made);
    expect(state.source.state).toBe('ready');
    expect(state.source.objectKey).toBeNull();
    expect(await stored(made.storedKey)).toBe(false);
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });
    const policy = await deps.db
      .selectFrom('assetPolicies')
      .select('store')
      .where('id', '=', made.source.assetPolicyId as string)
      .executeTakeFirstOrThrow();
    expect(policy.store).toBe('denied');
  });

  it('keeps what another writer recorded on the viewpoint while the panorama was checked', async () => {
    for (const state of ['ready', 'stale'] as const) {
      const made = await persistedSource({ state });
      const framing = {
        status: 'kept',
        reason: 'small_gain',
        box: null,
        promptVersion: 'frame-test',
        model: 'test',
        framedAt: new Date().toISOString(),
      };
      const scripted = revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
        [],
      );
      const inner = scripted.providers.fixtures.streetView;
      const streetView: StreetViewProvider = {
        ...inner,
        async refreshPanorama(panoId, options) {
          // Revalidation has read the row; a first look records its framing before the write.
          await deps.db
            .updateTable('sourceAssets')
            .set({ viewpoint: sql<string>`viewpoint || ${JSON.stringify({ framing })}::jsonb` })
            .where('id', '=', made.source.id)
            .execute();
          return inner.refreshPanorama(panoId, options);
        },
      };
      await runStreetViewRevalidation(
        {
          ...scripted,
          providers: {
            ...scripted.providers,
            fixtures: { ...scripted.providers.fixtures, streetView },
          },
        },
        { sourceAssetIds: [made.source.id] },
      );
      const row = await deps.db
        .selectFrom('sourceAssets')
        .select(['state', 'viewpoint'])
        .where('id', '=', made.source.id)
        .executeTakeFirstOrThrow();
      expect(row.state, state).toBe('ready');
      expect(row.viewpoint, state).toMatchObject({ framing, panoId: made.panoId });
      expect(Date.now() - Date.parse(row.viewpoint!.sourceCheckedAt!)).toBeLessThan(60_000);
    }
  });

  it('keeps the stored frame while the policy still allows storage', async () => {
    const made = await persistedSource();
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
        [],
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(result.framesDropped).toBe(0);
    expect((await after(made)).source.objectKey).toBe(made.storedKey);
    expect(await stored(made.storedKey)).toBe(true);
  });

  it('checks a transient source that still has looks and purges them when its panorama is gone', async () => {
    const created = await createStreetViewSource(deps, { placeId: PLACE });
    const job = await createRenderJobRecord(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const panoId = `${FIXTURE_METADATA_ERROR_PANO_PREFIX}Transient${newId().replace(/-/g, '')}`;
    await deps.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: null, viewpoint: toJson({ ...created.source.viewpoint!, panoId }) })
      .where('id', '=', created.source.id)
      .execute();
    const source = await deps.db
      .selectFrom('sourceAssets')
      .select(['streetViewMode', 'objectKey'])
      .where('id', '=', created.source.id)
      .executeTakeFirstOrThrow();
    expect(source).toEqual({ streetViewMode: 'transient', objectKey: null });
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(
      revalidating(
        new Map<string, Answer>([
          [panoId, { status: 'missing', metadata: metadata('ZERO_RESULTS') }],
        ]),
        seen,
      ),
      { sourceAssetIds: [created.source.id] },
    );
    expect(seen.map((call) => call.panoId)).toEqual([panoId]);
    expect(result).toMatchObject({ removed: 1 });
    expect(result.variantsPurged).toBeGreaterThanOrEqual(1);
    const variants = await deps.db
      .selectFrom('renderAssets')
      .select('withdrawnAt')
      .where('jobId', '=', job.id)
      .execute();
    expect(variants.every((row) => row.withdrawnAt !== null)).toBe(true);
  });
});

/** Puts a share link's public copies (the shared after image and the card) on the public bucket. */
async function publishShareCopies(token: string) {
  for (const key of [keys.shared(token, 'after'), keys.card(token)]) {
    await deps.storage.put({
      bucket: 'public',
      key,
      body: Buffer.from(`public copy ${key}`),
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
  }
}

const publicCopies = async (token: string) =>
  (
    await Promise.all(
      [keys.shared(token, 'after'), keys.card(token)].map((key) =>
        deps.storage.head('public', key),
      ),
    )
  ).filter((head) => head !== null).length;

const underUsePolicy = (
  usePolicy: 'full' | 'decorate' | 'display_only',
  answers: Map<string, Answer>,
): PipelineDeps => ({
  ...revalidating(answers, []),
  config: { ...deps.config, streetView: { ...deps.config.streetView, usePolicy } },
});

describe('Street View revalidation revokes the shares a tightened policy no longer allows', () => {
  it('revokes an unopened link and deletes its public copies when the policy denies distribution', async () => {
    const made = await persistedSource();
    await publishShareCopies(made.token);
    expect(await publicCopies(made.token)).toBe(2);
    const result = await runStreetViewRevalidation(
      underUsePolicy(
        'decorate',
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
      ),
      { sourceAssetIds: [made.source.id] },
    );
    expect(result.sharesRevoked).toBe(1);
    const state = await after(made);
    expect(state.grant.revokedAt).not.toBeNull();
    expect(await publicCopies(made.token)).toBe(0);
    // The look itself stays.
    expect(state.variant).toEqual({ withdrawnAt: null, deletedAt: null });

    // Widening the policy again does not bring the link back.
    const widened = await runStreetViewRevalidation(underUsePolicy('full', new Map()), {
      sourceAssetIds: [made.source.id],
    });
    expect(widened.sharesRevoked).toBe(0);
    expect((await after(made)).grant.revokedAt).not.toBeNull();
  });

  it('reaches a source with no stored frame, and one whose metadata call fails', async () => {
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
    const panoId = `${FIXTURE_METADATA_ERROR_PANO_PREFIX}Shares${newId().replace(/-/g, '')}`;
    await deps.db
      .updateTable('sourceAssets')
      .set({ revalidatedAt: null, viewpoint: toJson({ ...created.source.viewpoint!, panoId }) })
      .where('id', '=', created.source.id)
      .execute();
    await publishShareCopies(token);
    const result = await runStreetViewRevalidation(
      underUsePolicy(
        'decorate',
        new Map<string, Answer>([
          [panoId, { status: 'error', metadata: metadata('OVER_QUERY_LIMIT') }],
        ]),
      ),
      { sourceAssetIds: [created.source.id] },
    );
    expect(result).toMatchObject({ sharesRevoked: 1, failed: 1 });
    const grant = await deps.db
      .selectFrom('shareGrants')
      .select('revokedAt')
      .where('id', '=', grantId)
      .executeTakeFirstOrThrow();
    expect(grant.revokedAt).not.toBeNull();
    expect(await publicCopies(token)).toBe(0);
  });

  it('revokes nothing when only the capability is missing', async () => {
    const made = await persistedSource();
    await publishShareCopies(made.token);
    const unseeded: PipelineDeps = {
      ...revalidating(
        new Map<string, Answer>([
          [made.panoId, { status: 'unchanged', metadata: metadata('OK', made.panoId) }],
        ]),
        [],
      ),
      config: { ...deps.config, isLocal: false },
      capabilities: {
        ...deps.capabilities,
        state: async (country, capability) =>
          capability === 'street_view_ai' ? null : deps.capabilities.state(country, capability),
      },
    };
    const result = await runStreetViewRevalidation(unseeded, { sourceAssetIds: [made.source.id] });
    expect(result).toMatchObject({ sharesRevoked: 0, framesDropped: 0 });
    expect((await after(made)).grant.revokedAt).toBeNull();
    expect(await publicCopies(made.token)).toBe(2);
  });
});

describe('Street View revalidation stays within its run', () => {
  const day = 86_400_000;

  /** A stale source with live variants, last checked `daysAgo` days ago (null: never). */
  async function staleSource(daysAgo: number | null) {
    const made = await persistedSource({ state: 'stale' });
    await deps.db
      .updateTable('sourceAssets')
      .set({
        revalidatedAt: daysAgo === null ? null : new Date(Date.now() - daysAgo * day),
        staleAt: new Date(),
      })
      .where('id', '=', made.source.id)
      .execute();
    return made;
  }

  it('takes due stale sources oldest check first in pages, each once', async () => {
    const made = [await staleSource(3), await staleSource(null), await staleSource(10)];
    const failing = made[2]!;
    const answers = new Map<string, Answer>(
      made.map((entry) => [
        entry.panoId,
        entry === failing
          ? { status: 'error', metadata: metadata('UNKNOWN_ERROR') }
          : { status: 'unchanged', metadata: metadata('OK', entry.panoId) },
      ]),
    );
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const result = await runStreetViewRevalidation(revalidating(answers, seen), {
      limit: 2,
      sourceAssetIds: made.map((entry) => entry.source.id),
    });
    expect(seen.map((call) => call.panoId)).toEqual(
      [made[1], made[2], made[0]].map((entry) => entry!.panoId),
    );
    expect(result).toMatchObject({ checked: 3, failed: 1 });
  });

  it('checks the deadline before each source, not only between pages', async () => {
    const made = [await storedSource(null), await storedSource(null), await storedSource(null)];
    const realNow = Date.now.bind(Date);
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const seen: { panoId: string; location: LatLng | null }[] = [];
    try {
      const answers = new Map<string, Answer>(
        made.map((entry) => [
          entry.panoId,
          { status: 'unchanged', metadata: metadata('OK', entry.panoId) },
        ]),
      );
      const timed = revalidating(answers, seen);
      const refresh = timed.providers.fixtures.streetView.refreshPanorama.bind(
        timed.providers.fixtures.streetView,
      );
      timed.providers.fixtures.streetView.refreshPanorama = async (panoId, options) => {
        // The first check takes longer than the whole run budget.
        offset = 10 * 60_000;
        return refresh(panoId, options);
      };
      const result = await runStreetViewRevalidation(timed, {
        maxDurationMs: 60_000,
        sourceAssetIds: made.map((entry) => entry.source.id),
      });
      expect(result.checked).toBe(1);
    } finally {
      clock.mockRestore();
    }
    expect(seen).toHaveLength(1);
  });

  it('hands the queue job its abort signal', async () => {
    await storedSource(null);
    let calls = 0;
    const counting: PipelineDeps = {
      ...deps,
      providers: {
        ...deps.providers,
        fixtures: {
          ...deps.providers.fixtures,
          streetView: {
            ...base.providers.fixtures.streetView,
            async refreshPanorama() {
              calls += 1;
              return { status: 'error', metadata: metadata('UNKNOWN_ERROR') };
            },
          },
        },
      },
    };
    const controller = new AbortController();
    controller.abort();
    await createJobHandlers(counting).street_view_revalidation({
      id: newId(),
      name: 'street_view_revalidation',
      data: {},
      retryCount: 0,
      signal: controller.signal,
    });
    expect(calls).toBe(0);
  });

  it('stops when its job is aborted', async () => {
    const made = [await storedSource(null), await storedSource(null), await storedSource(null)];
    const controller = new AbortController();
    const answers = new Map<string, Answer>(
      made.map((entry) => [
        entry.panoId,
        { status: 'unchanged', metadata: metadata('OK', entry.panoId) },
      ]),
    );
    const seen: { panoId: string; location: LatLng | null }[] = [];
    const aborting = revalidating(answers, seen);
    const refresh = aborting.providers.fixtures.streetView.refreshPanorama.bind(
      aborting.providers.fixtures.streetView,
    );
    aborting.providers.fixtures.streetView.refreshPanorama = async (panoId, options) => {
      controller.abort();
      return refresh(panoId, options);
    };
    const result = await runStreetViewRevalidation(aborting, {
      signal: controller.signal,
      sourceAssetIds: made.map((entry) => entry.source.id),
    });
    expect(seen).toHaveLength(1);
    expect(result.checked).toBe(1);
  });
});
