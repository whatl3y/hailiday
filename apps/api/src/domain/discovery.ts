import {
  CaptureDateSchema,
  projectSkipReason,
  type Candidate,
  type CandidateFlag,
  type CaptureGranularity,
  type Discovery,
  type HeadingMode,
} from '@holiday/core';
import { addMs } from '@holiday/server/clock';
import {
  toJson,
  type Project,
  type Property,
  type Row,
  type SourceAsset,
  type Tx,
} from '@holiday/server/db';
import { AppError } from '@holiday/server/errors';
import { newId } from '@holiday/server/ids';
import { createAssetPolicy, defaultPolicyTemplate } from '@holiday/server/policy';
import type { StreetViewProvider, ViewCandidate } from '@holiday/server/providers';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { discoveredCandidates, projectExpiry } from './projects.js';
import { streetViewProviderFor, viewOf } from './sources.js';

/** One candidate as stored on `source_discoveries.candidates` (never sent as is). */
export interface StoredCandidate {
  candidateId: string;
  derivedFromCandidateId: string | null;
  isPrimary: boolean;
  rank: number;
  panoId: string;
  heading: number;
  headingMode: HeadingMode;
  pitch: number;
  fov: number;
  width: number;
  height: number;
  distanceMeters: number;
  captureDate: string | null;
  captureGranularity: CaptureGranularity;
  copyright: string | null;
  isGoogleImagery: boolean;
  estimatedFacadePx: number | null;
  flags: CandidateFlag[];
  displayUrlIssuedAt: string | null;
}

/** Signals stored with a discovery: Tier A colors and property signals, never address text. */
export interface StoredSignals extends Record<string, unknown> {
  boundSourceAssetId?: string | null;
}

export function storedCandidateOf(candidate: ViewCandidate): StoredCandidate {
  return {
    candidateId: newId(),
    derivedFromCandidateId: null,
    isPrimary: candidate.isPrimary,
    rank: candidate.rank,
    panoId: candidate.panoId,
    heading: candidate.heading,
    headingMode: candidate.headingMode,
    pitch: candidate.pitch,
    fov: candidate.fov,
    width: candidate.width,
    height: candidate.height,
    distanceMeters: candidate.distanceM,
    captureDate: candidate.captureDate,
    captureGranularity: candidate.captureGranularity,
    copyright: candidate.copyright,
    isGoogleImagery: candidate.isGoogleImagery,
    estimatedFacadePx: candidate.estimatedFacadePx,
    flags: candidate.flags,
    displayUrlIssuedAt: null,
  };
}

export function asStoredCandidates(value: readonly Record<string, unknown>[]): StoredCandidate[] {
  return value as unknown as StoredCandidate[];
}

function normalizeHeading(value: number): number {
  const wrapped = ((value % 360) + 360) % 360;
  return Math.round(wrapped * 10) / 10 === 360 ? 0 : Math.round(wrapped * 10) / 10;
}

/** The client `Candidate` of a stored candidate. */
export function candidateDto(stored: StoredCandidate, displayUrl: string | null): Candidate {
  return {
    candidateId: stored.candidateId,
    derivedFromCandidateId: stored.derivedFromCandidateId,
    isPrimary: stored.isPrimary,
    rank: stored.rank,
    displayUrl,
    heading: normalizeHeading(stored.heading),
    headingMode: stored.headingMode,
    pitch: stored.pitch,
    fov: stored.fov,
    captureDate:
      stored.captureDate && CaptureDateSchema.safeParse(stored.captureDate).success
        ? stored.captureDate
        : null,
    captureGranularity: stored.captureGranularity,
    copyright: stored.copyright,
    isGoogleImagery: stored.isGoogleImagery,
    distanceMeters: Math.max(0, stored.distanceMeters),
    estimatedFacadePx: stored.estimatedFacadePx,
    flags: stored.flags,
    width: stored.width,
    height: stored.height,
  };
}

/** The display URL of a stored candidate when one was issued. */
export function issuedDisplayUrl(
  provider: StreetViewProvider | null,
  stored: StoredCandidate,
): string | null {
  if (!provider || !stored.displayUrlIssuedAt) return null;
  return provider.buildDisplayUrl(viewOf(stored));
}

/** The client `Discovery` of a stored discovery row (blocked addresses projected to `unavailable`). */
export async function discoveryDto(
  deps: ApiDeps,
  auth: AuthState,
  row: Row<'sourceDiscoveries'>,
  property: Pick<Property, 'displayLoadsIssued'> | null,
): Promise<Discovery> {
  const provider = await streetViewProviderFor(deps, auth.audience);
  const limit = await deps.settings.get('rate.static_display_loads_per_address');
  const stored = asStoredCandidates(discoveredCandidates(row.candidates))
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3);
  const candidates =
    row.matchClass === 'skip_to_upload'
      ? []
      : stored.map((candidate) => candidateDto(candidate, issuedDisplayUrl(provider, candidate)));
  const signals = (row.signals ?? {}) as StoredSignals;
  const boundSourceAssetId =
    typeof signals.boundSourceAssetId === 'string' ? signals.boundSourceAssetId : null;
  const nextAction: Discovery['nextAction'] =
    row.matchClass === 'skip_to_upload'
      ? 'upload_photo'
      : row.matchClass === 'auto_start' && boundSourceAssetId
        ? 'render'
        : 'confirm_place';
  return {
    discoveryId: row.id,
    projectVersion: row.projectVersion,
    entryMethod: row.entryMethod,
    matchClass: row.matchClass,
    reason: projectSkipReason(row.reason),
    retryable: row.retryable,
    sourceMode: row.sourceMode,
    thresholdsVersion: row.thresholdsVersion,
    sourceAssetId: boundSourceAssetId,
    remainingDisplayLoads: Math.max(0, limit - (property?.displayLoadsIssued ?? 0)),
    candidates,
    attribution: candidates.length > 0 ? { logo: 'google_maps', required: true } : null,
    nextAction,
  };
}

function viewpointMatches(source: SourceAsset, candidate: StoredCandidate): boolean {
  const viewpoint = source.viewpoint;
  if (!viewpoint) return false;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.05;
  return (
    viewpoint.panoId === candidate.panoId &&
    near(viewpoint.heading, candidate.heading) &&
    near(viewpoint.pitch, candidate.pitch) &&
    near(viewpoint.fov, candidate.fov) &&
    viewpoint.width === candidate.width &&
    viewpoint.height === candidate.height
  );
}

/**
 * Binds a Street View candidate as the project's active source inside a transaction: an existing
 * source asset with the same frozen view is reused; otherwise a `ready` `street_view` asset is
 * created with its own asset policy. The project version is incremented by compare-and-set
 * (`STALE_PROJECT_VERSION` when it moved). Returns the source and the updated project.
 */
export async function bindCandidate(
  deps: Pick<ApiDeps, 'clock'>,
  trx: Tx,
  input: {
    project: Project;
    expectedVersion: number;
    candidate: StoredCandidate;
    streetViewMode: SourceAsset['streetViewMode'];
    attachedFacade: boolean;
  },
): Promise<{ source: SourceAsset; project: Project; created: boolean }> {
  const now = deps.clock.now();
  const { candidate, project } = input;
  const existing = (
    await trx
      .selectFrom('sourceAssets')
      .selectAll()
      .where('projectId', '=', project.id)
      .where('kind', '=', 'street_view')
      .execute()
  ).find((source) => viewpointMatches(source, candidate));
  if (existing && existing.state !== 'ready') throw new AppError('NO_STREET_VIEW', {});
  const buildingForm = input.attachedFacade ? 'attached' : 'detached';
  let source = existing;
  if (!source) {
    const sourceId = newId();
    const policy = await createAssetPolicy(trx, {
      subjectKind: 'source_asset',
      subjectId: sourceId,
      template: defaultPolicyTemplate('street_view', { attributionText: 'Google Maps' }),
    });
    source = await trx
      .insertInto('sourceAssets')
      .values({
        id: sourceId,
        ownerId: project.ownerId,
        projectId: project.id,
        kind: 'street_view',
        state: 'ready',
        captureDate:
          candidate.captureDate && CaptureDateSchema.safeParse(candidate.captureDate).success
            ? candidate.captureDate
            : null,
        copyright: candidate.copyright,
        isGoogleImagery: candidate.isGoogleImagery,
        streetViewMode: input.streetViewMode,
        viewpoint: toJson({
          panoId: candidate.panoId,
          heading: candidate.heading,
          headingMode: candidate.headingMode,
          pitch: candidate.pitch,
          fov: candidate.fov,
          width: candidate.width,
          height: candidate.height,
          source: 'outdoor',
          captureGranularity: candidate.captureGranularity,
          fetchedAt: null,
          sourceCheckedAt: now.toISOString(),
        }),
        sceneType: 'house_exterior',
        buildingForm,
        assetPolicyId: policy.id,
        readyAt: now,
        expiresAt: project.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } else if (source.streetViewMode !== input.streetViewMode) {
    source = await trx
      .updateTable('sourceAssets')
      .set({ streetViewMode: input.streetViewMode })
      .where('id', '=', source.id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  if (project.activeSourceAssetId === source.id) {
    return { source, project, created: false };
  }
  const updated = await trx
    .updateTable('projects')
    .set((eb) => ({
      activeSourceAssetId: source.id,
      projectVersion: eb('projectVersion', '+', 1),
      sceneType: 'house_exterior',
      buildingForm,
      roomType: null,
      lastActivityAt: now,
      expiresAt: projectExpiry(project, now),
    }))
    .where('id', '=', project.id)
    .where('projectVersion', '=', input.expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    const current = await trx
      .selectFrom('projects')
      .select('projectVersion')
      .where('id', '=', project.id)
      .executeTakeFirst();
    throw new AppError('STALE_PROJECT_VERSION', {
      currentProjectVersion: current?.projectVersion ?? project.projectVersion,
    });
  }
  return { source, project: updated, created: !existing };
}

/** Coordinates expire 30 days after retrieval. */
export function coordinateExpiry(now: Date): Date {
  return addMs(now, 30 * 24 * 3_600_000);
}
