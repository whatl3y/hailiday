import { sql } from 'kysely';
import type { StreetViewSourceMode } from '@hailiday/core';
import type { RenderJob, SourceAsset, ViewpointJson } from '../../db/schema.js';
import { renderGenericScene } from '../../fixtures/art.js';
import { isFixturePhotoCopyright } from '../../fixtures/copyright.js';
import { rasterize } from '../../fixtures/svg.js';
import { sha256Hex } from '../../ids/index.js';
import { decodeRaster } from '../imaging/raster.js';
import { streetViewSourceMode, type AssetPermission } from '../../policy/index.js';
import { isProviderError } from '../../providers/errors.js';
import type { LatLng } from '../../providers/geo.js';
import { framedViewOf } from '../../providers/street-view/framing.js';
import { REFRESH_TARGET_POINT_RADIUS_M } from '../../providers/street-view/refresh.js';
import type {
  RefreshPanoramaResult,
  StreetViewProvider,
  StreetViewView,
} from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import { pipelineOptions, type PipelineDeps, type ProviderLegs } from '../context.js';
import { dropSourceEnhancements } from '../enhance/store.js';
import { loadHeldSet, type HeldSet } from '../jobs/holds.js';
import { purgeSourceDerivatives } from '../jobs/takedown.js';
import { JobFailure, sleep } from './errors.js';
import { sourceFixtureMeta } from './fixture-hints.js';
import { findOpenReservation, settleCall } from './ledger.js';

export interface LoadedSource {
  bytes: Buffer;
  /** SHA-256 of the bytes as loaded (the lineage checksum recorded on attempts). */
  checksum: string;
  /** Street View source mode, or null for other kinds. */
  streetViewMode: StreetViewSourceMode | null;
  /** Whether a billable Street View Static fetch happened. */
  fetched: boolean;
}

/** Marks a Street View source stale (a label: its variants stay, marked by the stale source). */
async function markStale(deps: PipelineDeps, source: SourceAsset): Promise<void> {
  await deps.db
    .updateTable('sourceAssets')
    .set({ state: 'stale', staleAt: deps.clock.now() })
    .where('id', '=', source.id)
    .where('state', '=', 'ready')
    .execute();
}

/**
 * A panorama removed or blurred upstream (its metadata no longer returns imagery for it), found
 * at render time in either source mode (privacy spec, Street View privacy rule 5): the source is
 * marked stale, every variant made from it is purged with its share grants and public copies,
 * and a `persist` copy of the panorama and its enhancements are deleted unless a preservation hold
 * covers the source.
 */
export async function purgeRemovedPanorama(deps: PipelineDeps, source: SourceAsset): Promise<void> {
  await markStale(deps, source);
  await purgeSourceDerivatives(deps, source.id, { requestedBy: 'system' });
  if (!source.objectKey) return;
  const held = await loadHeldSet(deps);
  if (held.sources.has(source.id)) return;
  await deps.storage.delete('private', source.objectKey);
  await deps.db
    .updateTable('sourceAssets')
    .set({ objectKey: null })
    .where('id', '=', source.id)
    .execute();
  await dropSourceEnhancements(deps, source, { held });
}

/**
 * What a panorama revalidation means for a pinned panorama: `present` (still served), `replaced`
 * (newer imagery at the spot; variants stay, labeled by the stale source), `removed` (no imagery
 * for it any more: removed or blurred, so its derivatives are purged) or `unknown` (the call
 * failed or said nothing about the imagery; never treated as a removal). A `missing` answer that
 * carries newer imagery under another pano ID is read as `replaced`.
 */
export function panoramaVerdict(
  refreshed: RefreshPanoramaResult | null,
  panoId: string,
): 'present' | 'replaced' | 'removed' | 'unknown' {
  if (!refreshed) return 'unknown';
  switch (refreshed.status) {
    case 'unchanged':
      return 'present';
    case 'replaced':
      return 'replaced';
    case 'error':
      return 'unknown';
    case 'missing': {
      const newer =
        refreshed.metadata.status === 'OK' &&
        refreshed.metadata.panoId !== null &&
        refreshed.metadata.panoId !== panoId;
      return newer ? 'replaced' : 'removed';
    }
    default:
      return 'unknown';
  }
}

/**
 * The location a Street View source's viewpoint was pinned for: the property's target point while
 * its coordinates are retained (they expire and are redacted at deletion), else null.
 */
export async function pinnedLocationOf(
  deps: Pick<PipelineDeps, 'db' | 'clock'>,
  source: Pick<SourceAsset, 'projectId'>,
): Promise<LatLng | null> {
  const row = await deps.db
    .selectFrom('projects')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select(['properties.targetLat', 'properties.targetLng', 'properties.coordsExpireAt'])
    .where('projects.id', '=', source.projectId)
    .executeTakeFirst();
  if (!row || row.targetLat === null || row.targetLng === null) return null;
  if (row.coordsExpireAt && row.coordsExpireAt.getTime() <= deps.clock.now().getTime()) {
    return null;
  }
  const latitude = Number(row.targetLat);
  const longitude = Number(row.targetLng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/**
 * The stored viewpoint with a new fetch and check time. Only those two keys are written, in SQL,
 * so what another run wrote into the viewpoint meanwhile (its framing) stays.
 */
function restartedViewpoint(at: Date) {
  const iso = at.toISOString();
  return sql<string>`viewpoint || jsonb_build_object('fetchedAt', ${iso}::text, 'sourceCheckedAt', ${iso}::text)`;
}

/**
 * The view a source's frame is fetched at: the framed view once the source was zoomed in on its
 * home, else the viewpoint's own.
 */
function viewOf(viewpoint: ViewpointJson): StreetViewView {
  return framedViewOf(viewpoint);
}

/**
 * The mode a Street View render runs in, from the source's stored mode and the permission
 * evaluated before the fetch: `unavailable` or `display_only` when the permission does not allow
 * decoration; otherwise `transient` when either says so (a source recorded as transient is never
 * stored), else `persist`.
 */
export function effectiveStreetViewMode(
  stored: StreetViewSourceMode | null,
  permission: Pick<AssetPermission, 'display' | 'aiProcess' | 'edit' | 'store'>,
): StreetViewSourceMode {
  const derived = streetViewSourceMode(permission);
  if (derived !== 'persist' && derived !== 'transient') return derived;
  return stored === 'transient' ? 'transient' : derived;
}

/**
 * Whether a Street View provider can judge a source's panorama: the fixture adapter knows only
 * fixture stand-in photographs and the live provider only real imagery. A provider that cannot
 * know a panorama would answer that it is missing, which reads as a removal and purges every look
 * made from it, so its answer is never asked for.
 */
export function streetViewProviderJudges(
  provider: Pick<StreetViewProvider, 'mode'>,
  source: Pick<SourceAsset, 'copyright'>,
): boolean {
  return (provider.mode === 'fixture') === isFixturePhotoCopyright(source.copyright);
}

/**
 * Whether the stored frame of a Street View source is due to be fetched again: a stored copy
 * fetched more than `maxAgeMs` ago (or at an unrecorded time).
 */
export function streetViewFrameRefetchDue(
  source: Pick<SourceAsset, 'kind' | 'objectKey' | 'viewpoint'>,
  now: Date,
  maxAgeMs: number,
): boolean {
  if (source.kind !== 'street_view' || !source.objectKey) return false;
  const fetchedAt = source.viewpoint?.fetchedAt ? Date.parse(source.viewpoint.fetchedAt) : NaN;
  return !Number.isFinite(fetchedAt) || now.getTime() - fetchedAt > maxAgeMs;
}

/**
 * Whether a render of a Street View source in `mode` fetches its pixels from the provider (one
 * billable Static fetch, reserved at admission and settled in `preparing`): always in `transient`
 * mode, and in `persist` mode until a fetched frame is stored or, given `frameAge`, when the
 * stored frame is due to be fetched again.
 */
export function streetViewFetchExpected(
  source: Pick<SourceAsset, 'kind' | 'objectKey'> & Partial<Pick<SourceAsset, 'viewpoint'>>,
  mode: StreetViewSourceMode | null,
  frameAge?: { now: Date; maxAgeMs: number },
): boolean {
  if (source.kind !== 'street_view') return false;
  if (mode === 'transient') return true;
  if (mode !== 'persist') return false;
  if (!source.objectKey) return true;
  return frameAge
    ? streetViewFrameRefetchDue(
        { ...source, viewpoint: source.viewpoint ?? null },
        frameAge.now,
        frameAge.maxAgeMs,
      )
    : false;
}

/**
 * Deletes the stored frame of a Street View source and its enhancements and clears its object
 * key, unless a preservation hold covers the source. Returns the source as it stands afterwards.
 */
export async function dropStoredStreetViewFrame(
  deps: Pick<PipelineDeps, 'db' | 'storage'>,
  source: SourceAsset,
  held?: Pick<HeldSet, 'sources'>,
): Promise<SourceAsset> {
  if (!source.objectKey) return source;
  const holds = held ?? (await loadHeldSet(deps));
  if (holds.sources.has(source.id) || source.preservationHoldId) return source;
  await deps.storage.delete('private', source.objectKey);
  await dropSourceEnhancements(deps, source, { held: holds });
  return (
    (await deps.db
      .updateTable('sourceAssets')
      .set({ objectKey: null })
      .where('id', '=', source.id)
      .returningAll()
      .executeTakeFirst()) ?? { ...source, objectKey: null }
  );
}

/**
 * The stored frame of a `persist` Street View source, read against its row: `intact` when the
 * object exists and its checksum is the one the row records (or the row records none). A missing
 * object or other bytes are checked once more against a fresh read of the row, because another
 * job may have just replaced the frame (the object is written before the row). Returns the row
 * the frame was read against (the fresh one after a second read).
 */
async function readStoredFrame(
  deps: PipelineDeps,
  source: SourceAsset & { objectKey: string },
): Promise<{
  row: SourceAsset;
  frame: { bytes: Buffer; checksum: string } | null;
  intact: boolean;
}> {
  const object = await deps.storage.get('private', source.objectKey);
  const frame = object ? { bytes: object.body, checksum: sha256Hex(object.body) } : null;
  const matches = (row: SourceAsset) =>
    frame !== null &&
    row.objectKey === source.objectKey &&
    (!row.checksumSha256 || row.checksumSha256 === frame.checksum);
  if (matches(source)) return { row: source, frame, intact: true };
  const fresh = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', source.id)
    .executeTakeFirst();
  if (!fresh || fresh.deletedAt || fresh.state !== 'ready') {
    throw new JobFailure('source_unavailable');
  }
  return { row: fresh, frame, intact: matches(fresh) };
}

/**
 * The frame a `persist` render goes on with when another run changed the stored frame while this
 * one fetched it again: the stored frame the row now records (another run's framed frame, for
 * example), read from storage. When the row keeps no intact frame, the frame just fetched serves
 * while it shows the view the row now records; otherwise the job fails `source_unavailable`. A
 * row deleted or no longer ready fails it too.
 */
async function frameOfRow(
  deps: PipelineDeps,
  row: SourceAsset | null,
  fetched: LoadedSource,
  view: StreetViewView,
): Promise<LoadedSource> {
  if (!row || row.deletedAt || row.state !== 'ready' || !row.viewpoint) {
    throw new JobFailure('source_unavailable');
  }
  const object = row.objectKey ? await deps.storage.get('private', row.objectKey) : null;
  if (object) {
    const checksum = sha256Hex(object.body);
    if (!row.checksumSha256 || row.checksumSha256 === checksum) {
      return { ...fetched, bytes: object.body, checksum };
    }
  }
  const now = framedViewOf(row.viewpoint);
  const sameView =
    now.panoId === view.panoId &&
    now.heading === view.heading &&
    now.pitch === view.pitch &&
    now.fov === view.fov;
  if (sameView) return fetched;
  throw new JobFailure(
    'source_unavailable',
    null,
    'Street View frame changed while it was fetched',
  );
}

/**
 * Fetches a Street View frame by panorama with transport retries. A failure fails the job
 * `source_unavailable`.
 */
export async function fetchFrame(
  deps: PipelineDeps,
  legs: ProviderLegs,
  view: StreetViewView,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; checksum: string }> {
  const options = pipelineOptions(deps);
  for (let retry = 0; ; retry += 1) {
    try {
      const fetched = await legs.streetView.fetchTransient(view, { signal });
      return { bytes: fetched.bytes, checksum: fetched.checksum };
    } catch (error) {
      const retryable = isProviderError(error) ? error.retryable : true;
      if (!retryable || retry >= options.transportRetryLimit || signal.aborted) {
        throw new JobFailure('source_unavailable', null, 'Street View fetch failed');
      }
      await sleep(options.retryDelayMs(retry + 1), signal);
    }
  }
}

/**
 * Loads the source pixels for `preparing` (render spec, preparing): uploads and stored fixture or
 * `persist` sources from storage; `transient` Street View by panorama into memory only, after a
 * free metadata revalidation, always using the frame just fetched; procedurally drawn fixtures are
 * rendered on demand. A stored `persist` frame is fetched again when it is older than
 * `streetViewFrameMaxAgeMs` (or its fetch time is unrecorded), or when the stored object is
 * missing or holds other bytes than its row records (after one fresh read of the row): the same
 * bytes restart the frame's age, other bytes replace the stored copy and its checksum and drop its
 * enhancements (never under a preservation hold), and the render goes on with the fetched frame
 * either way; both writes happen under a lock on the row and only while it still records the
 * frame that was read, else nothing is written and the render goes on with the frame the row now
 * records. The first fetch of a `persist` source is stored unless another run stored a frame
 * meanwhile. Writes to the viewpoint touch only its fetch and check times. Street View legs
 * that cannot know the panorama (fixture adapter and real imagery, or the reverse) fail the job
 * `policy_denied` before any metadata call.
 */
export async function loadSourcePixels(
  deps: PipelineDeps,
  input: {
    job: RenderJob;
    source: SourceAsset;
    permission: AssetPermission;
    legs: ProviderLegs;
    signal: AbortSignal;
  },
): Promise<LoadedSource> {
  const { source, job } = input;
  if (source.kind === 'upload' || (source.kind === 'fixture' && source.objectKey)) {
    if (!source.objectKey) throw new JobFailure('source_unavailable');
    const object = await deps.storage.get('private', source.objectKey);
    if (!object) throw new JobFailure('source_unavailable');
    return {
      bytes: object.body,
      checksum: sha256Hex(object.body),
      streetViewMode: null,
      fetched: false,
    };
  }

  if (source.kind === 'fixture') {
    const meta = sourceFixtureMeta(source);
    if (source.viewpoint) {
      const fetched = await input.legs.streetView.fetchTransient(viewOf(source.viewpoint), {
        signal: input.signal,
      });
      return {
        bytes: fetched.bytes,
        checksum: fetched.checksum,
        streetViewMode: null,
        fetched: false,
      };
    }
    const params = meta.sceneId ? deps.content.genericScenes[meta.sceneId] : undefined;
    if (!params || !meta.sceneId) throw new JobFailure('source_unavailable');
    const scene = renderGenericScene(params, 1024, 1024, meta.sceneId);
    const bytes = await rasterize(scene.svg, { quality: 90 });
    return { bytes, checksum: sha256Hex(bytes), streetViewMode: null, fetched: false };
  }

  // Street View.
  const viewpoint = source.viewpoint;
  if (!viewpoint) throw new JobFailure('source_unavailable');
  const mode = effectiveStreetViewMode(source.streetViewMode, input.permission);
  if (mode !== 'transient' && mode !== 'persist') throw new JobFailure('policy_denied');
  const view = viewOf(viewpoint);
  // A leg that cannot know this panorama (the fixture adapter and real imagery, or the live
  // provider and a fixture stand-in) never fetches or revalidates it: its "missing" answer would
  // purge every look made from the source.
  if (!streetViewProviderJudges(input.legs.streetView, source)) {
    throw new JobFailure('policy_denied', null, 'Street View leg cannot serve this panorama');
  }

  // Free metadata revalidation of the pinned panorama before any fetch, probing the property's
  // target point when the pano ID no longer resolves. Only a removed or blurred panorama purges
  // what was made from it; a panorama replaced by newer imagery labels the source stale; a call
  // that says nothing about the imagery (quota, denied, network) fails this render and changes
  // nothing, so the source stays ready and the next request checks again.
  const location = await pinnedLocationOf(deps, source);
  const refreshed = await input.legs.streetView
    .refreshPanorama(viewpoint.panoId, {
      signal: input.signal,
      location,
      locationRadiusM: REFRESH_TARGET_POINT_RADIUS_M,
    })
    .catch(() => null);
  switch (panoramaVerdict(refreshed, viewpoint.panoId)) {
    case 'present':
      break;
    case 'unknown':
      throw new JobFailure('source_unavailable', null, 'Panorama metadata unavailable');
    case 'replaced':
      await markStale(deps, source);
      throw new JobFailure('source_unavailable', null, 'Panorama changed');
    case 'removed':
      await purgeRemovedPanorama(deps, source);
      throw new JobFailure('source_unavailable', null, 'Panorama removed');
  }

  // Persist with a stored frame: read it from storage while it is intact and younger than the
  // maximum age; otherwise the frame is fetched again below and replaces the stored copy.
  let stored: Awaited<ReturnType<typeof readStoredFrame>> | null = null;
  if (mode === 'persist' && source.objectKey) {
    stored = await readStoredFrame(deps, { ...source, objectKey: source.objectKey });
    const due = streetViewFrameRefetchDue(
      stored.row,
      deps.clock.now(),
      pipelineOptions(deps).streetViewFrameMaxAgeMs,
    );
    if (stored.intact && stored.frame && !due) {
      return {
        bytes: stored.frame.bytes,
        checksum: stored.frame.checksum,
        streetViewMode: mode,
        fetched: false,
      };
    }
  }

  // Settled against the job's open fetch reservation, or recorded as a direct charge when
  // admission reserved none (a stored frame found missing or damaged only now).
  const frame = await fetchFrame(deps, input.legs, view, input.signal);
  const reservation = await findOpenReservation(deps.db, job.id, {
    sku: 'street_view_static_fetch',
  });
  await settleCall(deps.db, {
    reservation,
    jobId: job.id,
    ownerId: job.ownerId,
    projectId: job.projectId,
    provider: input.legs.mode === 'live' ? 'google' : 'fixture',
    sku: 'street_view_static_fetch',
    stage: 'preparing',
    units: 1,
    isFixture: input.legs.mode !== 'live',
    clock: deps.clock,
  });

  const fetched: LoadedSource = {
    bytes: frame.bytes,
    checksum: frame.checksum,
    streetViewMode: mode,
    fetched: true,
  };
  // A transient render always works on the frame it just fetched.
  if (mode === 'transient') return fetched;

  // A fetched frame that is not a readable image never replaces or restarts the stored copy: the
  // job fails and the stored object and its row stay as they were.
  try {
    await decodeRaster(frame.bytes);
  } catch {
    throw new JobFailure('source_unavailable', null, 'Street View frame could not be decoded');
  }

  if (stored) {
    // A stored frame fetched again (aged, missing or damaged). Byte identity of two fetches is
    // not evidence of anything (the burned-in credit carries the current year), so other bytes
    // never end the render: the fetched frame replaces the stored copy under the same key, unless
    // a preservation hold covers the source (the held copy and its row stay as they are). The
    // same bytes keep the stored copy and restart its age. Either write happens under a lock on
    // the row and only while the row still records the frame this job read (its key and
    // checksum); a frame another run wrote meanwhile (a framed frame, say) stays, and the render
    // goes on with that frame (`frameOfRow`). Otherwise the render goes on with the fetched frame;
    // a removed or blurred panorama is found by the metadata check above. A stored frame deleted
    // while this job ran (its policy no longer allows storage, for example) is not written again.
    const { row } = stored;
    const objectKey = row.objectKey;
    if (!objectKey) return fetched;
    const same = stored.intact && stored.frame?.checksum === frame.checksum;
    const held = same ? null : await loadHeldSet(deps);
    if (held && (held.sources.has(row.id) || row.preservationHoldId)) return fetched;
    const checkedAt = deps.clock.now();
    const moved = await deps.db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('sourceAssets')
        .selectAll()
        .where('id', '=', row.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !current ||
        current.objectKey !== objectKey ||
        current.checksumSha256 !== row.checksumSha256
      ) {
        return { row: current ?? null };
      }
      const restarted = restartedViewpoint(checkedAt);
      if (same) {
        await trx
          .updateTable('sourceAssets')
          .set({ revalidatedAt: checkedAt, viewpoint: restarted })
          .where('id', '=', row.id)
          .execute();
        return null;
      }
      if (current.preservationHoldId) return null;
      // The enhancements of the replaced frame go with it.
      await dropSourceEnhancements({ db: trx, storage: deps.storage }, current, {
        ...(held ? { held } : {}),
      });
      await deps.storage.put({
        bucket: 'private',
        key: objectKey,
        body: frame.bytes,
        contentType: 'image/jpeg',
        provenance: { sourceKind: 'street_view', permission: input.permission },
      });
      await trx
        .updateTable('sourceAssets')
        .set({
          checksumSha256: frame.checksum,
          byteLength: frame.bytes.length,
          revalidatedAt: checkedAt,
          viewpoint: restarted,
        })
        .where('id', '=', row.id)
        .execute();
      return null;
    });
    return moved ? frameOfRow(deps, moved.row, fetched, view) : fetched;
  }

  // Persist: write the fetched frame once under the source's opaque key, under a lock on the
  // row. A frame another run stored meanwhile stays as it is (object and row), and this render
  // goes on with the frame it fetched.
  const key = keys.original(source.ownerId, source.id);
  await deps.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom('sourceAssets')
      .select('objectKey')
      .where('id', '=', source.id)
      .forUpdate()
      .executeTakeFirst();
    if (!current || current.objectKey !== null) return;
    await deps.storage.put({
      bucket: 'private',
      key,
      body: frame.bytes,
      contentType: 'image/jpeg',
      provenance: { sourceKind: 'street_view', permission: input.permission },
    });
    const now = deps.clock.now();
    await trx
      .updateTable('sourceAssets')
      .set({
        objectKey: key,
        checksumSha256: frame.checksum,
        contentType: 'image/jpeg',
        byteLength: frame.bytes.length,
        revalidatedAt: now,
        viewpoint: restartedViewpoint(now),
      })
      .where('id', '=', source.id)
      .where('objectKey', 'is', null)
      .execute();
  });
  return { bytes: frame.bytes, checksum: frame.checksum, streetViewMode: mode, fetched: true };
}
