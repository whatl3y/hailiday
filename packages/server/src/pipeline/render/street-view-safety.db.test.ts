import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { toJson } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import { evaluatePermission } from '../../policy/index.js';
import type { StreetViewProvider } from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps, ProviderLegs } from '../context.js';
import { copyHeldObjects, placePreservationHold } from '../jobs/holds.js';
import { generateShareCard } from '../jobs/share-card.js';
import { purgeBlockedPlaces, purgePlace } from '../jobs/takedown.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { JobFailure } from './errors.js';
import { runRenderJob } from './job.js';
import { loadSourcePixels } from './source.js';
import { readJob } from './transitions.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

const PLACE = 'ChIJfxLanternHillColonial01';
const LIVE_COPYRIGHT = '© 2025 Google';

const sourceOf = (id: string) =>
  deps.db.selectFrom('sourceAssets').selectAll().where('id', '=', id).executeTakeFirstOrThrow();

const liveVariants = (sourceAssetId: string) =>
  deps.db
    .selectFrom('renderAssets')
    .select('id')
    .where('sourceAssetId', '=', sourceAssetId)
    .where('deletedAt', 'is', null)
    .where('withdrawnAt', 'is', null)
    .execute();

/**
 * A Street View source at a place of its own: the property's place ID is unique to this call, so
 * blocking it never reaches another test's sources. `rendered` delivers one look first (in
 * `persist` mode, so the frame is stored).
 */
async function ownPlaceSource(options: { rendered?: boolean } = {}) {
  const created = await createStreetViewSource(deps, {
    placeId: PLACE,
    streetViewMode: options.rendered ? 'persist' : 'transient',
  });
  const placeId = `ChIJsvSafety${newId().replace(/-/g, '')}`;
  const project = await deps.db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', created.projectId)
    .executeTakeFirstOrThrow();
  await deps.db
    .updateTable('properties')
    .set({ placeId })
    .where('id', '=', project.propertyId!)
    .execute();
  if (options.rendered) {
    const job = await createRenderJobRecord(deps, created);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
  }
  return { ...created, placeId, source: await sourceOf(created.source.id) };
}

async function block(placeId: string, expiresAt: Date | null = null) {
  await deps.db
    .insertInto('blockedAddresses')
    .values({
      id: newId(),
      placeId,
      source: 'homeowner_request',
      evidenceRef: `test:${placeId}`,
      expiresAt,
    })
    .execute();
}

const stored = async (key: string | null) =>
  key !== null && (await deps.storage.head('private', key)) !== null;

describe('the homeowner opt-out reaches what already exists', () => {
  it('fails a job queued before the block, before any provider call', async () => {
    const made = await ownPlaceSource();
    const job = await createRenderJobRecord(deps, made);
    await block(made.placeId);
    const refresh = vi.spyOn(deps.providers.fixtures.streetView, 'refreshPanorama');
    try {
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
    expect(await readJob(deps.db, job.id)).toMatchObject({ failureKind: 'source_rejected' });
  });

  it('declines the sources of a blocked place and deletes their stored frames', async () => {
    const made = await ownPlaceSource({ rendered: true });
    expect(await stored(made.source.objectKey)).toBe(true);
    await block(made.placeId);

    const result = await purgeBlockedPlaces(deps, { limit: 1000 });
    expect(result.sourcesDeclined).toBeGreaterThanOrEqual(1);
    expect(result.framesDeleted).toBeGreaterThanOrEqual(1);
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({ state: 'declined', objectKey: null });
    expect(await stored(made.source.objectKey)).toBe(false);
    expect(await liveVariants(made.source.id)).toEqual([]);

    // A declined source is never rendered again.
    const next = await createRenderJobRecord(deps, { ...made, source: after });
    expect((await runRenderJob(deps, { renderJobId: next.id })).state).not.toBe('succeeded');
  });

  it('purgePlace declines the sources and keeps the stored frame of a held source', async () => {
    const free = await ownPlaceSource({ rendered: true });
    const held = await ownPlaceSource({ rendered: true });
    // Both at one place: the held one keeps its copy, the other loses it.
    const heldProject = await deps.db
      .selectFrom('projects')
      .select('propertyId')
      .where('id', '=', held.projectId)
      .executeTakeFirstOrThrow();
    await deps.db
      .updateTable('properties')
      .set({ placeId: free.placeId })
      .where('id', '=', heldProject.propertyId!)
      .execute();
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

    const result = await purgePlace(deps, free.placeId, { requestedBy: 'system' });
    expect(result).toMatchObject({ sourcesDeclined: 2, framesDeleted: 1 });
    expect(await sourceOf(free.source.id)).toMatchObject({ state: 'declined', objectKey: null });
    expect(await stored(free.source.objectKey)).toBe(false);
    const keptSource = await sourceOf(held.source.id);
    expect(keptSource).toMatchObject({ state: 'declined', objectKey: held.source.objectKey });
    expect(await stored(held.source.objectKey)).toBe(true);
  });

  it('ignores an expired block', async () => {
    const made = await ownPlaceSource({ rendered: true });
    await block(made.placeId, new Date(Date.now() - 60_000));
    await purgeBlockedPlaces(deps, { limit: 1000 });
    expect(await sourceOf(made.source.id)).toMatchObject({
      state: 'ready',
      objectKey: made.source.objectKey,
    });
    expect(await liveVariants(made.source.id)).toHaveLength(1);
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
  });
});

describe('fixture legs never judge real Street View imagery', () => {
  /** Makes a source's imagery a real Google frame (as a live discovery would have recorded it). */
  const markLive = async (source: SourceAsset) => {
    await deps.db
      .updateTable('sourceAssets')
      .set({ copyright: LIVE_COPYRIGHT, isGoogleImagery: true })
      .where('id', '=', source.id)
      .execute();
    return sourceOf(source.id);
  };

  it('ends a fixture-leg job on a real frame policy_denied, keeping the source and its looks', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const live = await markLive(made.source);
    const refresh = vi.spyOn(deps.providers.fixtures.streetView, 'refreshPanorama');
    try {
      const job = await createRenderJobRecord(deps, {
        ...made,
        source: live,
        holidayId: 'halloween',
      });
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
      expect(await readJob(deps.db, job.id)).toMatchObject({ failureKind: 'policy_denied' });
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      refresh.mockRestore();
    }
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({
      state: 'ready',
      objectKey: made.source.objectKey,
      staleAt: null,
    });
    expect(await stored(made.source.objectKey)).toBe(true);
    expect(await liveVariants(made.source.id)).toHaveLength(1);
  });

  it('never asks a provider that cannot know the panorama, even with an editable permission', async () => {
    const made = await ownPlaceSource();
    const live = await markLive(made.source);
    const fixtureStreetView = deps.providers.fixtures.streetView;
    const refresh = vi.fn(fixtureStreetView.refreshPanorama.bind(fixtureStreetView));
    const legs: ProviderLegs = {
      mode: 'fixture',
      visionMode: 'fixture',
      vision: deps.providers.fixtures.vision,
      imageEditor: deps.providers.fixtures.imageEditor,
      streetView: { ...fixtureStreetView, refreshPanorama: refresh } as StreetViewProvider,
    };
    const permission = evaluatePermission({
      policy: {
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: 'allowed',
        commerceAdjacent: 'allowed',
        evidenceRef: 'grant:test',
        attributionText: 'Google Maps',
        expiresAt: null,
        revokedAt: null,
        territory: 'US',
      },
      capabilityState: 'live_public',
      appEnv: 'test',
      contributorImagery: 'decorate',
      now: new Date(),
      sourceKind: 'street_view',
      isGoogleImagery: true,
      copyright: LIVE_COPYRIGHT,
    });
    const job = await createRenderJobRecord(deps, { ...made, source: live });
    const failure = await loadSourcePixels(deps, {
      job,
      source: live,
      permission,
      legs,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobFailure);
    expect((failure as JobFailure).kind).toBe('policy_denied');
    expect(refresh).not.toHaveBeenCalled();
    expect(await sourceOf(made.source.id)).toMatchObject({ state: 'ready' });
  });
});

describe('aged stored Street View frames', () => {
  const DAY = 86_400_000;

  async function age(source: SourceAsset, days: number) {
    const fetchedAt = new Date(Date.now() - days * DAY).toISOString();
    await deps.db
      .updateTable('sourceAssets')
      .set({ viewpoint: toJson({ ...source.viewpoint!, fetchedAt }) })
      .where('id', '=', source.id)
      .execute();
    return sourceOf(source.id);
  }

  const fetches = vi.fn();
  const counting = (): PipelineDeps => {
    const inner = deps.providers.fixtures.streetView;
    const streetView: StreetViewProvider = {
      ...inner,
      async fetchTransient(view, options) {
        fetches(view.panoId);
        return inner.fetchTransient(view, options);
      },
    };
    return {
      ...deps,
      providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, streetView } },
    };
  };

  it('reads a frame younger than the maximum age from storage', async () => {
    const made = await ownPlaceSource({ rendered: true });
    await age(made.source, 29);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    expect((await runRenderJob(counting(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(fetches).not.toHaveBeenCalled();
  });

  it('fetches an older frame again and restarts its age when the bytes are unchanged', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const aged = await age(made.source, 31);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, {
      ...made,
      source: aged,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(counting(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(fetches).toHaveBeenCalledTimes(1);
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({ state: 'ready', objectKey: made.source.objectKey });
    expect(Date.now() - Date.parse(after.viewpoint!.fetchedAt!)).toBeLessThan(DAY);
    expect(await liveVariants(made.source.id)).toHaveLength(2);
  });

  /**
   * Deps whose Street View fixture serves a re-encoded copy of each fixture frame: a decodable
   * image with other bytes than the frame stored at the first render (as a refetch a year later
   * carries another year in its burned-in credit).
   */
  const reencoding = (): PipelineDeps => {
    const inner = deps.providers.fixtures.streetView;
    const streetView: StreetViewProvider = {
      ...inner,
      async fetchTransient(view, options) {
        fetches(view.panoId);
        const original = await inner.fetchTransient(view, options);
        const bytes = await sharp(original.bytes)
          .modulate({ brightness: 1.04 })
          .jpeg({ quality: 83 })
          .toBuffer();
        return { ...original, bytes, checksum: sha256Hex(bytes) };
      },
    };
    return {
      ...deps,
      providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, streetView } },
    };
  };

  /** Replaces the stored copy with other bytes than the provider serves, recorded on the row. */
  async function storeEarlierCopy(source: SourceAsset) {
    const earlier = Buffer.from(`earlier frame ${randomToken(8)}`);
    await deps.storage.put({
      bucket: 'private',
      key: source.objectKey!,
      body: earlier,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    await deps.db
      .updateTable('sourceAssets')
      .set({ checksumSha256: sha256Hex(earlier), byteLength: earlier.length })
      .where('id', '=', source.id)
      .execute();
    return earlier;
  }

  const storedBytes = async (key: string) => (await deps.storage.get('private', key))?.body;

  const ledgerOf = (jobId: string, sku: string, stage?: string) =>
    deps.db
      .selectFrom('usageLedger')
      .select('kind')
      .where('jobId', '=', jobId)
      .where('sku', '=', sku as never)
      .$if(stage !== undefined, (query) => query.where('stage', '=', stage as string))
      .orderBy('createdAt')
      .execute()
      .then((rows) => rows.map((row) => row.kind));

  it('replaces an aged stored frame whose refetch has other bytes and renders on it', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const aged = await age(made.source, 45);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, {
      ...made,
      source: aged,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(reencoding(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(fetches).toHaveBeenCalledTimes(1);

    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({
      state: 'ready',
      objectKey: made.source.objectKey,
      staleAt: null,
    });
    const frame = await storedBytes(made.source.objectKey!);
    expect(frame).toBeDefined();
    expect(sha256Hex(frame!)).not.toBe(made.source.checksumSha256);
    expect(after.checksumSha256).toBe(sha256Hex(frame!));
    expect(after.byteLength).toBe(frame!.length);
    expect(Date.now() - Date.parse(after.viewpoint!.fetchedAt!)).toBeLessThan(DAY);
    // The attempt worked on the new frame, analyzed again (the analysis reserved and settled).
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .select('sourceChecksumSha256')
      .where('jobId', '=', job.id)
      .executeTakeFirstOrThrow();
    expect(attempt.sourceChecksumSha256).toBe(after.checksumSha256);
    expect(await ledgerOf(job.id, 'vision_call', 'analyzing')).toEqual([
      'reservation',
      'settlement',
    ]);
    // The earlier look is kept beside the new one.
    expect(await liveVariants(made.source.id)).toHaveLength(2);
  });

  it('keeps the stored copy of a held source and still renders on the fetched frame', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const earlier = await storeEarlierCopy(made.source);
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
    const before = await age(made.source, 45);
    const job = await createRenderJobRecord(deps, {
      ...made,
      source: before,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({
      state: 'ready',
      objectKey: made.source.objectKey,
      checksumSha256: sha256Hex(earlier),
      viewpoint: before.viewpoint,
    });
    expect(await storedBytes(made.source.objectKey!)).toEqual(earlier);
    expect(await liveVariants(made.source.id)).toHaveLength(2);
  });

  it('fetches and stores again a frame whose stored object is missing', async () => {
    const made = await ownPlaceSource({ rendered: true });
    await deps.storage.delete('private', made.source.objectKey!);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    expect((await runRenderJob(counting(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(fetches).toHaveBeenCalledTimes(1);
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({ state: 'ready', objectKey: made.source.objectKey });
    const frame = await storedBytes(made.source.objectKey!);
    expect(frame).toBeDefined();
    expect(after.checksumSha256).toBe(sha256Hex(frame!));
    // Admission reserved no fetch for a stored frame, so the fetch is a direct charge.
    expect(await ledgerOf(job.id, 'street_view_static_fetch')).toEqual(['charge']);
  });

  it('fetches again a stored frame whose bytes differ from its row and replaces it', async () => {
    const made = await ownPlaceSource({ rendered: true });
    await deps.storage.put({
      bucket: 'private',
      key: made.source.objectKey!,
      body: Buffer.from(`damaged ${randomToken(8)}`),
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'upload' },
    });
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    expect((await runRenderJob(counting(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(fetches).toHaveBeenCalledTimes(1);
    const after = await sourceOf(made.source.id);
    expect(after.state).toBe('ready');
    expect(sha256Hex((await storedBytes(made.source.objectKey!))!)).toBe(after.checksumSha256);
  });

  it('reads a frame another job has just replaced from storage, without a fetch', async () => {
    const made = await ownPlaceSource({ rendered: true });
    // This job loaded the row before another job replaced the frame (object, then row).
    const loadedRow = await sourceOf(made.source.id);
    const replacement = await storeEarlierCopy(made.source);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    const permission = evaluatePermission({
      policy: {
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: 'allowed',
        commerceAdjacent: 'allowed',
        evidenceRef: 'grant:test',
        attributionText: 'Google Maps',
        expiresAt: null,
        revokedAt: null,
        territory: 'US',
      },
      capabilityState: 'fixture',
      appEnv: 'test',
      contributorImagery: 'decorate',
      now: new Date(),
      sourceKind: 'street_view',
      isGoogleImagery: true,
      copyright: loadedRow.copyright,
    });
    const legs: ProviderLegs = {
      mode: 'fixture',
      visionMode: 'fixture',
      vision: deps.providers.fixtures.vision,
      imageEditor: deps.providers.fixtures.imageEditor,
      streetView: counting().providers.fixtures.streetView,
    };
    const loaded = await loadSourcePixels(deps, {
      job,
      source: loadedRow,
      permission,
      legs,
      signal: new AbortController().signal,
    });
    expect(fetches).not.toHaveBeenCalled();
    expect(loaded).toMatchObject({ fetched: false, checksum: sha256Hex(replacement) });
    expect(loaded.bytes).toEqual(replacement);
  });

  /** Deps whose Street View fixture answers a fetch with bytes that are not an image. */
  const unreadable = (): PipelineDeps => {
    const inner = deps.providers.fixtures.streetView;
    const streetView: StreetViewProvider = {
      ...inner,
      async fetchTransient(view, options) {
        fetches(view.panoId);
        const original = await inner.fetchTransient(view, options);
        const bytes = Buffer.from(`<html>not an image ${randomToken(8)}</html>`);
        return { ...original, bytes, checksum: sha256Hex(bytes) };
      },
    };
    return {
      ...deps,
      providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, streetView } },
    };
  };

  it('keeps the stored frame when the refetch of an aged frame is not an image', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const aged = await age(made.source, 45);
    const frameBefore = await storedBytes(made.source.objectKey!);
    fetches.mockClear();
    const job = await createRenderJobRecord(deps, {
      ...made,
      source: aged,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(unreadable(), { renderJobId: job.id })).state).toBe('failed');
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(await readJob(deps.db, job.id)).toMatchObject({ failureKind: 'source_unavailable' });
    const after = await sourceOf(made.source.id);
    expect(after).toMatchObject({
      state: 'ready',
      objectKey: made.source.objectKey,
      checksumSha256: aged.checksumSha256,
      byteLength: aged.byteLength,
      viewpoint: aged.viewpoint,
    });
    expect(await storedBytes(made.source.objectKey!)).toEqual(frameBefore);

    // The frame stays due, so the next render with a healthy provider fetches it and succeeds.
    fetches.mockClear();
    const next = await createRenderJobRecord(deps, {
      ...made,
      source: after,
      holidayId: 'halloween',
    });
    expect((await runRenderJob(counting(), { renderJobId: next.id })).state).toBe('succeeded');
    expect(fetches).toHaveBeenCalledTimes(1);
    expect(
      Date.now() - Date.parse((await sourceOf(made.source.id)).viewpoint!.fetchedAt!),
    ).toBeLessThan(DAY);
  });

  it('stores nothing when the first fetch of a persist frame is not an image', async () => {
    const made = await ownPlaceSource();
    await deps.db
      .updateTable('sourceAssets')
      .set({ streetViewMode: 'persist' })
      .where('id', '=', made.source.id)
      .execute();
    const source = await sourceOf(made.source.id);
    const job = await createRenderJobRecord(deps, { ...made, source });
    expect((await runRenderJob(unreadable(), { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(deps.db, job.id)).toMatchObject({ failureKind: 'source_unavailable' });
    expect(await sourceOf(made.source.id)).toMatchObject({
      state: 'ready',
      objectKey: null,
      checksumSha256: source.checksumSha256,
    });
    expect(await stored(keys.original(source.ownerId, source.id))).toBe(false);
  });

  it('renders a transient source on a frame with other bytes than its previous attempt', async () => {
    const made = await ownPlaceSource();
    const first = await createRenderJobRecord(deps, made);
    expect((await runRenderJob(deps, { renderJobId: first.id })).state).toBe('succeeded');
    const job = await createRenderJobRecord(deps, { ...made, holidayId: 'halloween' });
    expect((await runRenderJob(reencoding(), { renderJobId: job.id })).state).toBe('succeeded');
    expect(await sourceOf(made.source.id)).toMatchObject({
      state: 'ready',
      staleAt: null,
      objectKey: null,
    });
    const checksums = await deps.db
      .selectFrom('renderAttempts')
      .select('sourceChecksumSha256')
      .where('jobId', 'in', [first.id, job.id])
      .execute();
    expect(new Set(checksums.map((row) => row.sourceChecksumSha256)).size).toBe(2);
    expect(await liveVariants(made.source.id)).toHaveLength(2);
  });
});

describe('a Street View AI capability with no row outside local environments', () => {
  it('makes no share card for a Street View look', async () => {
    const made = await ownPlaceSource({ rendered: true });
    const asset = await deps.db
      .selectFrom('renderAssets')
      .select(['id', 'distributable'])
      .where('sourceAssetId', '=', made.source.id)
      .executeTakeFirstOrThrow();
    expect(asset.distributable).toBe(true);
    const token = randomToken(16);
    const grantId = newId();
    await deps.db
      .insertInto('shareGrants')
      .values({
        id: grantId,
        ownerId: made.ownerId,
        renderAssetId: asset.id,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + 86_400_000),
        shareCardObjectKey: keys.card(token),
      })
      .execute();
    const unseeded: PipelineDeps = {
      ...deps,
      config: { ...deps.config, isLocal: false },
      capabilities: {
        ...deps.capabilities,
        state: async (country, capability) =>
          capability === 'street_view_ai' ? null : deps.capabilities.state(country, capability),
      },
    };
    expect(await generateShareCard(unseeded, { shareGrantId: grantId, shareToken: token })).toEqual(
      { outcome: 'skipped', reason: 'not_distributable' },
    );
    expect(await deps.storage.head('public', keys.card(token))).toBeNull();
  });
});
