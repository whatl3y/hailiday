import {
  DEFAULT_LIGHTING_MODE,
  DEFAULT_STYLE,
  NON_TERMINAL_RENDER_JOB_STATES,
  packOfferFor,
  projectSkipReason,
  type HolidayId,
  type LightingMode,
  type OfferedSet,
  type Project as ProjectDto,
  type Style,
} from '@hailiday/core';
import type { Audience } from '@hailiday/server/capabilities';
import { addMs } from '@hailiday/server/clock';
import type { DbOrTx, Project, SourceAsset } from '@hailiday/server/db';
import { notFound } from '@hailiday/server/errors';
import { displayLoadsRemaining } from '@hailiday/server/limits';
import { RETENTION, terminateRenderJob } from '@hailiday/server/pipeline';
import { framingOf } from '@hailiday/server/providers';
import type { ApiDeps } from '../deps.js';
import type { AuthState } from '../auth/session.js';
import { allowanceFor } from './allowance.js';
import {
  displayUrlForViewpoint,
  framedDisplayUrlOf,
  streetViewSourcePermissions,
} from './sources.js';

/** Expiry of a project from its activity and save state (privacy retention schedule). */
export function projectExpiry(
  project: Pick<Project, 'createdAt' | 'savedAt'>,
  lastActivityAt: Date,
): Date {
  if (project.savedAt) return addMs(lastActivityAt, RETENTION.savedInactivityMs);
  const idle = addMs(lastActivityAt, RETENTION.anonymousInactivityMs);
  const cap = addMs(project.createdAt, RETENTION.anonymousHardCapMs);
  return idle < cap ? idle : cap;
}

/** Records activity on a project (restarts its inactivity clock). */
export async function touchProject(
  deps: Pick<ApiDeps, 'clock'>,
  db: DbOrTx,
  project: Project,
): Promise<void> {
  const now = deps.clock.now();
  await db
    .updateTable('projects')
    .set({ lastActivityAt: now, expiresAt: projectExpiry(project, now) })
    .where('id', '=', project.id)
    .execute();
}

/** Loads a project the caller owns; anything else is `NOT_FOUND` (existence is not disclosed). */
export async function loadOwnedProject(
  deps: Pick<ApiDeps, 'db'>,
  auth: AuthState,
  projectId: string,
): Promise<Project> {
  const project = await deps.db
    .selectFrom('projects')
    .selectAll()
    .where('id', '=', projectId)
    .where('ownerId', '=', auth.ownerId)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!project) throw notFound();
  return project;
}

export async function loadSource(
  deps: Pick<ApiDeps, 'db'>,
  sourceAssetId: string | null,
): Promise<SourceAsset | null> {
  if (!sourceAssetId) return null;
  return (
    (await deps.db
      .selectFrom('sourceAssets')
      .selectAll()
      .where('id', '=', sourceAssetId)
      .executeTakeFirst()) ?? null
  );
}

/** Whether the latest scene analysis of a source reports daylight (null before any analysis). */
async function sourceIsDaylight(deps: Pick<ApiDeps, 'db'>, sourceAssetId: string) {
  const row = await deps.db
    .selectFrom('sceneAnalyses')
    .select('document')
    .where('sourceAssetId', '=', sourceAssetId)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .executeTakeFirst();
  const lighting = (row?.document as { lighting?: { isDaylight?: unknown } } | undefined)?.lighting;
  return typeof lighting?.isDaylight === 'boolean' ? lighting.isDaylight : null;
}

/**
 * The project's `offered` set for a holiday: the pack's offer for the scene type, intersected
 * with the source-kind configuration (`evening` on Street View needs an AI-capable source mode)
 * and with `evening` only when the source's analysis reports daylight. The defaults are the
 * pack's, after those filters: a default lighting mode they removed becomes `source`. Null
 * without a scene type.
 */
export async function offeredFor(
  deps: Pick<ApiDeps, 'db' | 'content'>,
  project: Pick<Project, 'sceneType'>,
  source: SourceAsset | null,
  holidayId: HolidayId,
): Promise<OfferedSet | null> {
  const sceneType = project.sceneType ?? source?.sceneType ?? null;
  if (!sceneType) return null;
  const pack = deps.content.packFor(holidayId);
  const offer = pack ? packOfferFor(pack.pack, sceneType) : null;
  if (!offer) {
    return {
      styles: [],
      defaultStyle: DEFAULT_STYLE,
      lightingModes: [],
      defaultLightingMode: DEFAULT_LIGHTING_MODE,
    };
  }
  let lightingModes: LightingMode[] = [...offer.lightingModes];
  if (source?.kind === 'street_view') {
    const editable = source.streetViewMode === 'persist' || source.streetViewMode === 'transient';
    if (!editable) lightingModes = lightingModes.filter((mode) => mode !== 'evening');
  }
  if (source && lightingModes.includes('evening')) {
    const daylight = await sourceIsDaylight(deps, source.id);
    if (daylight === false) lightingModes = lightingModes.filter((mode) => mode !== 'evening');
  }
  return {
    styles: [...offer.styles],
    defaultStyle: offer.styles.includes(offer.defaultStyle) ? offer.defaultStyle : DEFAULT_STYLE,
    lightingModes,
    defaultLightingMode: lightingModes.includes(offer.defaultLightingMode)
      ? offer.defaultLightingMode
      : DEFAULT_LIGHTING_MODE,
  };
}

/**
 * The look a project starts from for its scene type and holiday: the defaults of its `offered`
 * set (the pack's defaults after the source filters). Without a scene type it is the default
 * style in as-photographed lighting. Set whenever the scene type is set or changes.
 */
export async function startingLookFor(
  deps: Pick<ApiDeps, 'db' | 'content'>,
  project: Pick<Project, 'sceneType'>,
  source: SourceAsset | null,
  holidayId: HolidayId,
): Promise<{ style: Style; lightingMode: LightingMode }> {
  const offered = await offeredFor(deps, project, source, holidayId);
  return {
    style: offered?.defaultStyle ?? DEFAULT_STYLE,
    lightingMode: offered?.defaultLightingMode ?? DEFAULT_LIGHTING_MODE,
  };
}

/** The project's non-terminal render job, if any. */
export async function activeJobOf(deps: Pick<ApiDeps, 'db'>, projectId: string) {
  return (
    (await deps.db
      .selectFrom('renderJobs')
      .selectAll()
      .where('projectId', '=', projectId)
      .where('state', 'in', [...NON_TERMINAL_RENDER_JOB_STATES])
      .executeTakeFirst()) ?? null
  );
}

/** Supersedes any non-terminal render job of a project (a source change). */
export async function supersedeActiveJob(deps: ApiDeps, projectId: string): Promise<string | null> {
  const active = await activeJobOf(deps, projectId);
  if (!active) return null;
  await terminateRenderJob(deps.pipeline, { jobId: active.id, to: 'superseded' });
  return active.id;
}

/** The latest discovery row of a project. */
export async function latestDiscovery(deps: Pick<ApiDeps, 'db'>, projectId: string) {
  return (
    (await deps.db
      .selectFrom('sourceDiscoveries')
      .selectAll()
      .where('projectId', '=', projectId)
      .orderBy('projectVersion', 'desc')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .executeTakeFirst()) ?? null
  );
}

/** Whether a project has a look: a variant neither deleted nor withdrawn. */
export async function projectHasLook(deps: Pick<ApiDeps, 'db'>, projectId: string) {
  const look = await deps.db
    .selectFrom('renderAssets')
    .select('id')
    .where('projectId', '=', projectId)
    .where('deletedAt', 'is', null)
    .where('withdrawnAt', 'is', null)
    .limit(1)
    .executeTakeFirst();
  return look !== undefined;
}

/** Discovered (not derived) candidates stored on a discovery row. */
export function discoveredCandidates(candidates: readonly Record<string, unknown>[]) {
  return candidates.filter((candidate) => !candidate.derivedFromCandidateId);
}

/**
 * The picture of a Street View source zoomed in on its home, from its stored frame: a signed URL
 * of that frame while one is kept and the source's policy still allows storing it (as a variant's
 * "Before" shows it). Null for a source that is not framed or keeps no frame it may show, which
 * shows the provider's display URL instead (for a framed view, counted and ledgered once per
 * source: `framedDisplayUrlOf`).
 */
async function storedFramedPicture(
  deps: ApiDeps,
  audience: Audience,
  source: SourceAsset,
): Promise<string | null> {
  if (source.kind !== 'street_view' || framingOf(source.viewpoint)?.status !== 'framed') {
    return null;
  }
  if (!source.objectKey || source.state === 'deleted') return null;
  const { store } = await streetViewSourcePermissions(deps, audience, {
    policyId: source.assetPolicyId,
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
  });
  return store ? deps.storage.presignGet('private', source.objectKey) : null;
}

/**
 * The shared `Project` object. `formattedAddress` is passed only by the resolve response (the
 * transient Place Details text); later reads show a stored display address only for a stored basis.
 */
export async function projectDto(
  deps: ApiDeps,
  auth: AuthState,
  project: Project,
  options: { formattedAddress?: string | null } = {},
): Promise<ProjectDto> {
  const property = project.propertyId
    ? ((await deps.db
        .selectFrom('properties')
        .selectAll()
        .where('id', '=', project.propertyId)
        .executeTakeFirst()) ?? null)
    : null;
  const source = await loadSource(deps, project.activeSourceAssetId);
  const discovery = project.kind === 'address' ? await latestDiscovery(deps, project.id) : null;
  const displayLimit = await deps.settings.get('rate.static_display_loads_per_address');
  const active = await activeJobOf(deps, project.id);
  const variantCount = await deps.db
    .selectFrom('renderAssets')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('projectId', '=', project.id)
    .where('deletedAt', 'is', null)
    .where('withdrawnAt', 'is', null)
    .executeTakeFirstOrThrow();

  let displayUrl: string | null = null;
  if (source?.kind === 'street_view' && framingOf(source.viewpoint)?.status === 'framed') {
    displayUrl =
      (await storedFramedPicture(deps, auth.audience, source)) ??
      (await framedDisplayUrlOf(deps, auth, source));
  } else if (source?.kind === 'street_view' || (source?.kind === 'fixture' && source.viewpoint)) {
    displayUrl = await displayUrlForViewpoint(deps, auth.audience, source.viewpoint);
  } else if (source?.objectKey && source.state === 'ready') {
    displayUrl = await deps.storage.presignGet('private', source.objectKey);
  }

  const storedAddress =
    property &&
    (property.displayAddressBasis === 'manual_entry' ||
      property.displayAddressBasis === 'geocoding_place_id')
      ? property.displayAddress
      : null;

  return {
    id: project.id,
    kind: project.kind,
    projectVersion: project.projectVersion,
    holidayId: project.holidayId,
    style: project.style,
    lightingMode: project.lightingMode,
    sceneType: project.sceneType,
    buildingForm: project.buildingForm,
    roomType: project.roomType,
    property: property
      ? {
          id: property.id,
          formattedAddress: options.formattedAddress ?? storedAddress,
          precision: property.precision,
          multiUnit: property.multiUnit,
          countryCode: property.countryCode.trim(),
        }
      : null,
    activeSource: source
      ? {
          sourceAssetId: source.id,
          kind: source.kind,
          state: source.state,
          sourceMode: source.streetViewMode,
          displayUrl,
          captureDate: source.captureDate,
          copyright: source.copyright,
          isGoogleImagery: source.isGoogleImagery,
          width: source.viewpoint?.width ?? source.width ?? null,
          height: source.viewpoint?.height ?? source.height ?? null,
          peopleDetected: source.peopleDetected,
          privateOnly: source.privateOnly,
        }
      : null,
    discovery: discovery
      ? {
          matchClass: discovery.matchClass,
          reason: projectSkipReason(discovery.reason),
          sourceMode: discovery.sourceMode,
          candidateCount: discoveredCandidates(discovery.candidates).length,
          remainingDisplayLoads: displayLoadsRemaining(property, displayLimit, deps.clock.now()),
        }
      : null,
    offered: await offeredFor(deps, project, source, project.holidayId),
    activeRenderJobId: active?.id ?? null,
    variantCount: Number(variantCount.count),
    saved: project.savedAt !== null,
    expiresAt:
      project.expiresAt && (await deps.settings.get('retention.time_based_deletion'))
        ? project.expiresAt.toISOString()
        : null,
    lastActivityAt: project.lastActivityAt.toISOString(),
    allowance: await allowanceFor(deps, auth.ownerId),
  };
}
