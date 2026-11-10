import type { StreetViewSourceMode } from '@holiday/core';
import { toJson } from '../../db/client.js';
import type { RenderJob, SourceAsset, ViewpointJson } from '../../db/schema.js';
import { renderGenericScene } from '../../fixtures/art.js';
import { rasterize } from '../../fixtures/svg.js';
import { sha256Hex } from '../../ids/index.js';
import { streetViewSourceMode, type AssetPermission } from '../../policy/index.js';
import { isProviderError } from '../../providers/errors.js';
import type { LatLng } from '../../providers/geo.js';
import { REFRESH_TARGET_POINT_RADIUS_M } from '../../providers/street-view/refresh.js';
import type { RefreshPanoramaResult, StreetViewView } from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import { pipelineOptions, type PipelineDeps, type ProviderLegs } from '../context.js';
import { loadHeldSet } from '../jobs/holds.js';
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
 * and a `persist` copy of the panorama is deleted unless a preservation hold covers the source.
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

function viewOf(viewpoint: ViewpointJson): StreetViewView {
  return {
    panoId: viewpoint.panoId,
    heading: viewpoint.heading,
    pitch: viewpoint.pitch,
    fov: viewpoint.fov,
    width: viewpoint.width,
    height: viewpoint.height,
  };
}

/** The checksum of the source bytes of the most recent attempt on the same source asset. */
async function previousSourceChecksum(
  deps: PipelineDeps,
  sourceAssetId: string,
  excludeJobId: string,
): Promise<string | null> {
  const row = await deps.db
    .selectFrom('renderAttempts')
    .innerJoin('renderJobs', 'renderJobs.id', 'renderAttempts.jobId')
    .select('renderAttempts.sourceChecksumSha256')
    .where('renderJobs.sourceAssetId', '=', sourceAssetId)
    .where('renderJobs.id', '<>', excludeJobId)
    .orderBy('renderAttempts.createdAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row?.sourceChecksumSha256 ?? null;
}

/** Fetches a Street View frame by panorama with transport retries. */
async function fetchFrame(
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
 * free metadata revalidation, comparing the checksum with the previous attempt on the same asset
 * (a mismatch makes the asset `stale`); procedurally drawn fixtures are rendered on demand.
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
  const mode = source.streetViewMode ?? streetViewSourceMode(input.permission);
  if (mode !== 'transient' && mode !== 'persist') throw new JobFailure('policy_denied');
  const view = viewOf(viewpoint);

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

  if (mode === 'persist' && source.objectKey) {
    const object = await deps.storage.get('private', source.objectKey);
    if (!object) throw new JobFailure('source_unavailable');
    const checksum = sha256Hex(object.body);
    if (source.checksumSha256 && source.checksumSha256 !== checksum) {
      await markStale(deps, source);
      throw new JobFailure('source_unavailable', null, 'Stored panorama changed');
    }
    return { bytes: object.body, checksum, streetViewMode: mode, fetched: false };
  }

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

  if (mode === 'transient') {
    const previous = await previousSourceChecksum(deps, source.id, job.id);
    if (previous && previous !== frame.checksum) {
      await markStale(deps, source);
      throw new JobFailure('source_unavailable', null, 'Panorama imagery changed');
    }
    return { bytes: frame.bytes, checksum: frame.checksum, streetViewMode: mode, fetched: true };
  }

  // Persist: write the fetched frame once under the source's opaque key.
  const key = keys.original(source.ownerId, source.id);
  await deps.storage.put({
    bucket: 'private',
    key,
    body: frame.bytes,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'street_view', permission: input.permission },
  });
  const now = deps.clock.now().toISOString();
  await deps.db
    .updateTable('sourceAssets')
    .set({
      objectKey: key,
      checksumSha256: frame.checksum,
      contentType: 'image/jpeg',
      byteLength: frame.bytes.length,
      revalidatedAt: deps.clock.now(),
      viewpoint: toJson({ ...viewpoint, fetchedAt: now, sourceCheckedAt: now }),
    })
    .where('id', '=', source.id)
    .execute();
  return { bytes: frame.bytes, checksum: frame.checksum, streetViewMode: mode, fetched: true };
}
