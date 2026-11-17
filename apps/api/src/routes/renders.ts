import {
  CachedRenderResponseSchema,
  CreateClickRequestSchema,
  CreateClickResponseSchema,
  CreateRenderRequestSchema,
  EmptyObjectSchema,
  IdParamsSchema,
  IdempotencyKeySchema,
  isTerminalRenderJobState,
  NON_TERMINAL_RENDER_JOB_STATES,
  ProductsPanelSchema,
  QueuedRenderResponseSchema,
  RenderStatusSchema,
  STANDARD_RENDER_ATTEMPTS,
  variantKey,
  type CreateRenderRequest,
  type RenderRequestOutcome,
  type VariantKeyInput,
} from '@hailiday/core';
import {
  isUniqueViolation,
  toJson,
  type Project,
  type RenderJob,
  type SourceAsset,
} from '@hailiday/server/db';
import {
  AppError,
  allowanceExhausted,
  atCapacity,
  budgetPaused,
  isAppError,
  notFound,
  providerUnavailable,
  rateLimited,
  validationFailed,
} from '@hailiday/server/errors';
import { newId, sha256Hex } from '@hailiday/server/ids';
import { linesBySku, renderReservationLines, reserve } from '@hailiday/server/ledger';
import {
  attemptQuota,
  backstopLimits,
  checkSpend,
  deviceBackstop,
  lockOwnerAllowance,
  variantAllowance,
  type BackstopState,
  type CounterState,
} from '@hailiday/server/limits';
import {
  compilerVersionFor,
  enhancementReservationExpected,
  streetViewFetchExpected,
  terminateRenderJob,
  visionModeFor,
} from '@hailiday/server/pipeline';
import { isPropertyBlocked } from '@hailiday/server/policy';
import { EnqueueConflictError, notifyRenderJobChanged } from '@hailiday/server/queue';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { ipHashesInWindowOf } from '../auth/ip.js';
import { enforceEndpointLimit } from '../auth/limits.js';
import {
  deviceHashOf,
  hasTurnstileToken,
  ipHashOf,
  requestTokenVerified,
  requireSession,
  sessionHashOf,
  type AuthState,
} from '../auth/session.js';
import { allowanceFor } from '../domain/allowance.js';
import { admitRender } from '../domain/capacity.js';
import { buildProductsPanel, verifyClickToken } from '../domain/commerce.js';
import { emitEvent } from '../domain/events.js';
import { commerceOccurrenceOf, holidayCalendar, packVersionFor } from '../domain/holidays.js';
import {
  activeJobOf,
  latestDiscovery,
  loadOwnedProject,
  loadSource,
  offeredFor,
  projectExpiry,
} from '../domain/projects.js';
import { reconfirmationNeeded } from '../domain/discovery.js';
import { loadOwnedJob, renderStatus, variantDto } from '../domain/renders.js';
import {
  admissionSourceOf,
  capabilityModeFor,
  capabilityState,
  evaluateFor,
  evaluateSourceForSubmission,
} from '../domain/sources.js';
import { registerRenderEvents } from './render-events.js';

/** Canonical JSON with sorted keys (request hashing). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, inner]) => inner !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the method, path and canonical JSON body. */
export function requestHashOf(method: string, path: string, body: unknown): string {
  return sha256Hex(`${method.toUpperCase()} ${path}\n${canonicalJson(body)}`);
}

/** Reads the `Idempotency-Key` header; required for renders, optional elsewhere. */
export function idempotencyKeyOf(request: FastifyRequest, required: boolean): string | null {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    if (required) {
      throw validationFailed({ fields: [{ path: 'headers.idempotency-key', reason: 'required' }] });
    }
    return null;
  }
  const parsed = IdempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw validationFailed({ fields: [{ path: 'headers.idempotency-key', reason: 'invalid' }] });
  }
  return parsed.data;
}

/** The compiler family a job is stamped with: `fixture` when the AI leg runs fixture adapters. */
async function compilerFamilyFor(deps: ApiDeps, source: SourceAsset): Promise<string> {
  if (source.kind === 'fixture') return 'fixture';
  const capability = source.kind === 'street_view' ? 'street_view_ai' : 'image_editing';
  const state = await capabilityState(deps, capability);
  return state === 'fixture' ? 'fixture' : deps.config.providers.imageEditor;
}

async function recordOutcome(
  deps: ApiDeps,
  auth: AuthState,
  input: { body: CreateRenderRequest; project: Project; outcome: RenderRequestOutcome },
) {
  const first = await deps.db
    .selectFrom('renderJobs')
    .select('id')
    .where('projectId', '=', input.project.id)
    .executeTakeFirst();
  await emitEvent(deps, deps.db, {
    name: 'render_requested',
    ownerId: auth.ownerId,
    holidayId: input.body.holidayId,
    sceneType: input.project.sceneType,
    properties: {
      style: input.body.style,
      lightingMode: input.body.lightingMode,
      isFirstRender: first === undefined,
      outcome: input.outcome,
    },
  });
}

async function rememberSelection(deps: ApiDeps, project: Project, body: CreateRenderRequest) {
  const now = deps.clock.now();
  await deps.db
    .updateTable('projects')
    .set({
      holidayId: body.holidayId,
      style: body.style,
      lightingMode: body.lightingMode,
      lastActivityAt: now,
      expiresAt: projectExpiry(project, now),
    })
    .where('id', '=', project.id)
    .execute();
}

async function replayJob(deps: ApiDeps, auth: AuthState, reply: FastifyReply, job: RenderJob) {
  const status = await renderStatus(deps, auth, job);
  const superseded = await deps.db
    .selectFrom('renderJobs')
    .select('id')
    .where('supersededByJobId', '=', job.id)
    .executeTakeFirst();
  reply.code(202).header('Idempotent-Replayed', 'true');
  return { ...status, cached: false as const, supersededRenderJobId: superseded?.id ?? null };
}

/** The partial unique index that keeps one non-terminal render job per project. */
const ONE_ACTIVE_JOB_INDEX = 'render_jobs_one_active_per_project_idx';
/** `Retry-After` when the project's active slot stays contended after a retry. */
const RENDER_CONFLICT_RETRY_S = 5;

/** Whether a job renders the requested variant (equal variant keys). */
function sameVariant(job: RenderJob, requested: VariantKeyInput): boolean {
  return job.variantKey === variantKey(requested);
}

/**
 * Whether the variants allowance refuses a new job. The project's own non-terminal job is about
 * to be superseded, so it does not hold a unit against the request that replaces it.
 */
function allowanceBlocks(state: CounterState, replacesActiveJob: boolean): boolean {
  if (!state.exhausted) return false;
  return !replacesActiveJob || state.used - 1 >= state.limit;
}

type Refusal =
  | { kind: 'allowance'; state: CounterState }
  | { kind: 'attempts'; state: CounterState }
  | { kind: 'device'; state: CounterState }
  | { kind: 'verification' };

/**
 * The backstop's answer for a request. The IP dimension refuses (`RATE_LIMITED`, scope `device`)
 * whatever the request carries. The device dimension alone is a challenge: a request that carries
 * an `X-Turnstile-Token` that verifies is admitted, and any other is answered
 * `VERIFICATION_REQUIRED` (scope `device`), so every render beyond the device limit needs a fresh
 * solve. The token is verified at most once per request, before the render transaction opens; the
 * locked re-check reuses the answer.
 */
async function backstopRefusal(
  deps: ApiDeps,
  request: FastifyRequest,
  state: BackstopState,
): Promise<Refusal | null> {
  if (state.ip?.exhausted) return { kind: 'device', state: state.ip };
  if (!state.device?.exhausted) return null;
  return (await requestTokenVerified(deps, request)) ? null : { kind: 'verification' };
}

type TransactionOutcome =
  | { kind: 'created'; job: RenderJob; supersededId: string | null }
  | { kind: 'in_flight'; job: RenderJob }
  | { kind: 'refused'; refusal: Refusal };

/** Records the blocked outcome of a refused request and throws its error. */
async function refuse(
  deps: ApiDeps,
  auth: AuthState,
  input: { body: CreateRenderRequest; project: Project },
  refusal: Refusal,
  now: Date,
): Promise<never> {
  if (refusal.kind === 'allowance') {
    await recordOutcome(deps, auth, { ...input, outcome: 'blocked_allowance' });
    await emitEvent(deps, deps.db, {
      name: 'allowance_reached',
      ownerId: auth.ownerId,
      holidayId: input.body.holidayId,
      properties: { scope: 'variants', gateVariant: 'sheet_default' },
    });
    throw allowanceExhausted('variants', refusal.state.resetsAt, [
      'view_cached_variants',
      'save_project',
      'wait_for_reset',
    ]);
  }
  await recordOutcome(deps, auth, { ...input, outcome: 'blocked_rate' });
  if (refusal.kind === 'verification') {
    throw new AppError('VERIFICATION_REQUIRED', { scope: 'device' });
  }
  const retry = refusal.state.resetsAt
    ? Math.max(1, Math.ceil((refusal.state.resetsAt.getTime() - now.getTime()) / 1000))
    : 3600;
  throw rateLimited(refusal.kind, retry);
}

/** The 202 for a request whose variant the project's in-flight job already renders. */
async function inFlightResponse(
  deps: ApiDeps,
  auth: AuthState,
  reply: FastifyReply,
  job: RenderJob,
) {
  const status = await renderStatus(deps, auth, job);
  reply.code(202);
  return { ...status, cached: false as const, supersededRenderJobId: null };
}

/**
 * `POST /v1/renders` in the specified check order: schema, project version, idempotency replay,
 * variant-key cache (200), source readiness (with a view to confirm again), content cell, the in-flight job of the same variant
 * (202, no new job), variants allowance, paid-attempt cap, device and IP backstop, budget and
 * pause, provider availability, capacity, then one transaction under the owner's allowance lock
 * that re-checks the version, source and counts, supersedes the active job, inserts the job,
 * reserves the worst case, enqueues with the same ID and notifies.
 */
async function createRender(
  deps: ApiDeps,
  request: FastifyRequest<{ Body: CreateRenderRequest }>,
  reply: FastifyReply,
) {
  const auth = await requireSession(deps, request, reply);
  const body = request.body;
  const key = idempotencyKeyOf(request, true) as string;
  const project = await loadOwnedProject(deps, auth, body.projectId);

  // 2. Project version.
  if (body.projectVersion !== project.projectVersion) {
    throw new AppError('STALE_PROJECT_VERSION', { currentProjectVersion: project.projectVersion });
  }

  // 3. Idempotency replay.
  const requestHash = requestHashOf('POST', '/v1/renders', body);
  const prior = await deps.db
    .selectFrom('renderJobs')
    .selectAll()
    .where('ownerId', '=', auth.ownerId)
    .where('idempotencyKey', '=', key)
    .executeTakeFirst();
  if (prior) {
    if (prior.requestHash !== requestHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', { idempotencyKey: key });
    }
    return replayJob(deps, auth, reply, prior);
  }

  const source = await admissionSourceOf(
    deps,
    await loadSource(deps, project.activeSourceAssetId),
    auth.audience,
  );
  // A place on the opt-out list is never rendered in Street View form, also from a source bound
  // before the block (no cached variant, no job).
  if (
    source?.kind === 'street_view' &&
    (await isPropertyBlocked(deps.db, project.propertyId, deps.clock.now()))
  ) {
    await recordOutcome(deps, auth, { body, project, outcome: 'needs_photo' });
    throw new AppError('NEEDS_PHOTO', { sourceMode: 'unavailable' });
  }
  const holidayPackVersion = await packVersionFor(deps, body.holidayId);
  if (!holidayPackVersion) {
    throw validationFailed({ reason: 'content_cell_not_offered' });
  }

  const now = deps.clock.now();
  const family = source ? await compilerFamilyFor(deps, source) : null;
  const compilerVersion = family ? compilerVersionFor(family) : null;

  // 4. Variant-key cache: the newest accepted variant of the key (an owner keeps every rendering,
  // so a key may have several) of a `ready` source whose evaluated permission still allows
  // display, unexpired while time-based deletion is on (its stored expiry is ignored while it is
  // off). Anything else falls through to the checks below.
  if (source && compilerVersion) {
    const key4 = variantKey({
      sourceAssetId: source.id,
      holidayId: body.holidayId,
      style: body.style,
      lightingMode: body.lightingMode,
      holidayPackVersion,
      compilerVersion,
    });
    const timeBased = await deps.settings.get('retention.time_based_deletion');
    const cached = await deps.db
      .selectFrom('renderAssets')
      .selectAll()
      .where('ownerId', '=', auth.ownerId)
      .where('variantKey', '=', key4)
      .where('deletedAt', 'is', null)
      .where('withdrawnAt', 'is', null)
      .$if(timeBased, (query) =>
        query.where((eb) => eb.or([eb('expiresAt', 'is', null), eb('expiresAt', '>', now)])),
      )
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .executeTakeFirst();
    const displayable =
      cached !== undefined &&
      source.state === 'ready' &&
      (
        await evaluateFor(deps, {
          policyId: source.assetPolicyId,
          kind: source.kind,
          isGoogleImagery: source.isGoogleImagery,
          copyright: source.copyright,
          audience: auth.audience,
        })
      ).permission.display;
    if (cached && displayable) {
      await rememberSelection(deps, project, body);
      await recordOutcome(deps, auth, { body, project, outcome: 'cached' });
      reply.code(200);
      return {
        cached: true as const,
        variant: await variantDto(deps, auth, cached, source),
        allowance: await allowanceFor(deps, auth.ownerId),
      };
    }
  }

  // 5. Source readiness.
  if (!source || !family || !compilerVersion) {
    const discovery = project.kind === 'address' ? await latestDiscovery(deps, project.id) : null;
    const candidateCount = discovery
      ? discovery.candidates.filter((candidate) => !candidate.derivedFromCandidateId).length
      : 0;
    if (discovery && discovery.matchClass !== 'skip_to_upload' && candidateCount > 0) {
      await recordOutcome(deps, auth, { body, project, outcome: 'needs_confirmation' });
      throw new AppError('NEEDS_CONFIRMATION', { candidateCount });
    }
    await recordOutcome(deps, auth, { body, project, outcome: 'needs_photo' });
    throw new AppError('NEEDS_PHOTO', { sourceMode: discovery?.sourceMode ?? null });
  }
  if (source.kind === 'street_view' && source.streetViewMode === 'unavailable') {
    await recordOutcome(deps, auth, { body, project, outcome: 'needs_photo' });
    throw new AppError('NEEDS_PHOTO', { sourceMode: 'unavailable' });
  }
  const notEditable = async (
    reason: 'display_only' | 'permission_denied' | 'permission_unknown' | 'stale' | 'declined',
  ) => {
    await recordOutcome(deps, auth, { body, project, outcome: 'source_not_editable' });
    return new AppError('SOURCE_NOT_EDITABLE', { reason });
  };
  if (source.state === 'stale') throw await notEditable('stale');
  if (source.state === 'declined' || source.state === 'failed') throw await notEditable('declined');
  if (source.state !== 'ready') throw await notEditable('permission_unknown');
  // A view aimed at the resolved point, confirmed from views that did not test for a target on
  // the road, is confirmed again before its first look.
  const reconfirmCount = await reconfirmationNeeded(deps, project, source);
  if (reconfirmCount !== null) {
    await recordOutcome(deps, auth, { body, project, outcome: 'needs_confirmation' });
    throw new AppError('NEEDS_CONFIRMATION', { candidateCount: reconfirmCount });
  }
  const evaluated = await evaluateFor(deps, {
    policyId: source.assetPolicyId,
    kind: source.kind,
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
    audience: auth.audience,
  });
  const { permission } = evaluated;
  if (!permission.aiProcess || !permission.edit) {
    const policy = source.assetPolicyId
      ? await deps.db
          .selectFrom('assetPolicies')
          .select(['aiProcess', 'edit'])
          .where('id', '=', source.assetPolicyId)
          .executeTakeFirst()
      : undefined;
    const unknown = policy && (policy.aiProcess === 'unknown' || policy.edit === 'unknown');
    if (source.kind === 'street_view') throw await notEditable('display_only');
    throw await notEditable(unknown ? 'permission_unknown' : 'permission_denied');
  }

  // 6. Content cell.
  const offered = await offeredFor(deps, project, source, body.holidayId);
  if (
    !offered ||
    !offered.styles.includes(body.style) ||
    !offered.lightingModes.includes(body.lightingMode)
  ) {
    throw validationFailed({ reason: 'content_cell_not_offered' });
  }

  // The in-flight job already renders this exact variant: return it (no new job, no quota).
  const requested: VariantKeyInput = {
    sourceAssetId: source.id,
    holidayId: body.holidayId,
    style: body.style,
    lightingMode: body.lightingMode,
    holidayPackVersion,
    compilerVersion,
  };
  const inFlight = await activeJobOf(deps, project.id);
  if (inFlight && sameVariant(inFlight, requested)) {
    return inFlightResponse(deps, auth, reply, inFlight);
  }

  // 7. Variants allowance.
  const allowance = await variantAllowance(deps.db, deps.settings, { ownerId: auth.ownerId, now });
  if (allowanceBlocks(allowance, inFlight !== null)) {
    return refuse(deps, auth, { body, project }, { kind: 'allowance', state: allowance }, now);
  }

  // 8. Paid-attempt cap. Every job is projected at two attempts: the first attempt and either its
  // repair or, for a relit look, its relight, which must both fit. A third attempt (the repair of
  // a relit look's base or of its relight) is checked by the worker against the cap before it is
  // sent. Whether the worker finds an accepted daylight variant to relight depends on the working
  // image it prepares, so a relit look is reserved below as one that decorates its own base (three
  // edits), which covers both.
  const jobShape = { lightingMode: body.lightingMode, relightBase: false };
  const projectedAttempts = STANDARD_RENDER_ATTEMPTS;
  const attempts = await attemptQuota(deps.db, deps.settings, {
    ownerId: auth.ownerId,
    now,
    projected: projectedAttempts,
  });
  if (attempts.used > attempts.limit) {
    return refuse(deps, auth, { body, project }, { kind: 'attempts', state: attempts }, now);
  }

  // 9. Device and IP backstop. Refused before any job row exists, so a retry with the same
  // Idempotency-Key after the challenge is a new request, not a replay or a conflict.
  const deviceHash = deviceHashOf(deps, request);
  const ipHash = ipHashOf(deps, request);
  const ipHashes = ipHashesInWindowOf(deps, request);
  // Each dimension has its own limit; the locked re-check reuses both.
  const { deviceLimit, ipLimit } = await backstopLimits(deps.settings);
  const backstop = await deviceBackstop(deps.db, deps.settings, {
    deviceHash,
    ipHashes,
    now,
    deviceLimit,
    ipLimit,
  });
  const backstopRefused = await backstopRefusal(deps, request, backstop);
  if (backstopRefused) return refuse(deps, auth, { body, project }, backstopRefused, now);

  // 10. Budget and pause; 11. provider availability. Each leg is priced for the adapter the
  // worker will use: the vision leg follows `vision_analysis` through the worker's resolver.
  const isFixture = family === 'fixture';
  const aiMode = await capabilityModeFor(
    deps,
    source.kind === 'street_view' ? 'street_view_ai' : 'image_editing',
    auth.audience,
  );
  const visionMode = isFixture ? 'fixture' : await visionModeFor(deps, aiMode, auth.roles);
  const visionProvider = visionMode === 'live' ? deps.config.providers.vision : 'fixture';
  const imageEditProvider = isFixture ? 'fixture' : deps.config.providers.imageEditor;
  // A stored Street View frame may have been replaced by a refetch with other bytes, so only an
  // analysis made since that frame was fetched counts as one the worker can reuse.
  const fetchedAtMs =
    source.kind === 'street_view' && source.objectKey && source.viewpoint?.fetchedAt
      ? Date.parse(source.viewpoint.fetchedAt)
      : NaN;
  const frameFetchedAt = Number.isFinite(fetchedAtMs) ? new Date(fetchedAtMs) : null;
  const hasAnalysis = await deps.db
    .selectFrom('sceneAnalyses')
    .select('id')
    .where('sourceAssetId', '=', source.id)
    .$if(frameFetchedAt !== null, (query) => query.where('createdAt', '>=', frameFetchedAt as Date))
    .executeTakeFirst();
  // A stored frame past its maximum age is fetched again in `preparing` (one more Static fetch).
  // A fetched frame may carry other bytes, which are analyzed again (analyses are keyed by the
  // working image), so the analysis is reserved too; the worker releases it when it reuses one.
  const streetViewFetch = streetViewFetchExpected(source, source.streetViewMode, {
    now,
    maxAgeMs: deps.config.streetView.frameMaxAgeDays * 86_400_000,
  });
  // A stored Street View frame is first enhanced once per frame and release: its edit and judge
  // call are reserved until a decided enhancement exists for the stored frame.
  const enhance = await enhancementReservationExpected(deps.db, {
    enabled: deps.config.streetView.enhance,
    source,
    streetViewFetch,
    compilerVersion,
  });
  const lines = renderReservationLines({
    imageEditProvider,
    visionProvider,
    streetViewFetch,
    enhance,
    reuseAnalysis: hasAnalysis !== undefined && !streetViewFetch,
    streetViewProvider: isFixture ? 'fixture' : 'google',
    ...jobShape,
  });
  const block = await checkSpend(deps.db, deps.settings, {
    now,
    additional: linesBySku(lines.filter((line) => !line.isFixture)),
    isFixture,
  });
  if (block) {
    await recordOutcome(deps, auth, { body, project, outcome: 'blocked_budget' });
    throw budgetPaused(block.reason, block.resumesAt, now);
  }
  if (aiMode === 'unavailable' || (await deps.settings.isProviderPaused(imageEditProvider))) {
    throw providerUnavailable(imageEditProvider);
  }
  if (visionMode === 'unavailable') throw providerUnavailable(deps.config.providers.vision);
  if (await deps.settings.isProviderPaused(visionProvider)) {
    throw providerUnavailable(visionProvider);
  }

  // 12. Capacity.
  try {
    await admitRender(deps);
  } catch (error) {
    if (isAppError(error)) {
      await recordOutcome(deps, auth, { body, project, outcome: 'blocked_capacity' });
    }
    throw error;
  }

  // 13. The render transaction.
  const reviewMode = await deps.settings.reviewModeFor(
    project.sceneType ?? source.sceneType ?? 'house_exterior',
  );
  const kit = deps.content.kitFor(
    body.holidayId,
    project.sceneType ?? source.sceneType ?? 'house_exterior',
  );
  const kitRow = kit
    ? await deps.db
        .selectFrom('styleKits')
        .select('id')
        .where('kitKey', '=', `${body.holidayId}.${project.sceneType ?? source.sceneType}`)
        .where('status', '=', 'published')
        .executeTakeFirst()
    : undefined;
  await clearStaleQueueEntries(deps, project.id);
  // A bot-check token is verified before the transaction opens, so the locked backstop re-check
  // only reads the cached answer and never waits on the verifier while the owner and project
  // locks are held. A request without a token needs no verifier call.
  if (hasTurnstileToken(request)) await requestTokenVerified(deps, request);

  /**
   * Under the owner's allowance lock and the project row lock: re-check the project version and
   * active source, return an in-flight job of the same variant, re-run the allowance, attempt and
   * backstop counts on the transaction, then supersede, insert, reserve, enqueue and notify. Only
   * the transaction handle is used inside, so a request queued on the lock never waits on the
   * pool.
   */
  const renderTransaction = () =>
    deps.db.transaction().execute(async (trx): Promise<TransactionOutcome> => {
      await lockOwnerAllowance(trx, auth.ownerId);
      const locked = await trx
        .selectFrom('projects')
        .select(['projectVersion', 'activeSourceAssetId', 'deletedAt'])
        .where('id', '=', project.id)
        .forUpdate()
        .executeTakeFirst();
      if (!locked || locked.deletedAt) throw notFound();
      if (
        locked.projectVersion !== body.projectVersion ||
        locked.activeSourceAssetId !== source.id
      ) {
        throw new AppError('STALE_PROJECT_VERSION', {
          currentProjectVersion: locked.projectVersion,
        });
      }
      const active = await trx
        .selectFrom('renderJobs')
        .selectAll()
        .where('projectId', '=', project.id)
        .where('state', 'in', [...NON_TERMINAL_RENDER_JOB_STATES])
        .executeTakeFirst();
      if (active && sameVariant(active, requested)) return { kind: 'in_flight', job: active };

      // The clock is read again under the lock so rows committed by requests ahead in the queue
      // (a job created or succeeded since the pre-checks) fall inside the windows.
      const lockedNow = deps.clock.now();
      const lockedAllowance = await variantAllowance(trx, deps.settings, {
        ownerId: auth.ownerId,
        now: lockedNow,
        limit: allowance.limit,
      });
      if (allowanceBlocks(lockedAllowance, active !== undefined)) {
        return { kind: 'refused', refusal: { kind: 'allowance', state: lockedAllowance } };
      }
      const lockedAttempts = await attemptQuota(trx, deps.settings, {
        ownerId: auth.ownerId,
        now: lockedNow,
        projected: projectedAttempts,
        limit: attempts.limit,
      });
      if (lockedAttempts.used > lockedAttempts.limit) {
        return { kind: 'refused', refusal: { kind: 'attempts', state: lockedAttempts } };
      }
      const lockedBackstop = await deviceBackstop(trx, deps.settings, {
        deviceHash,
        ipHashes,
        now: lockedNow,
        deviceLimit,
        ipLimit,
      });
      const lockedRefusal = await backstopRefusal(deps, request, lockedBackstop);
      if (lockedRefusal) return { kind: 'refused', refusal: lockedRefusal };

      let supersededId: string | null = null;
      if (active) {
        const ended = await terminateRenderJob(
          { db: trx, clock: deps.clock, config: deps.config, logger: deps.logger, queue: null },
          { jobId: active.id, to: 'superseded' },
        );
        if (ended) {
          supersededId = active.id;
          await deps.queue.cancel('render', active.id, { trx });
        }
      }
      const { evaluationId } = await evaluateSourceForSubmission(
        deps,
        trx,
        source,
        auth.audience,
        evaluated,
      );
      if (!evaluationId) throw notFound();
      const job = await trx
        .insertInto('renderJobs')
        .values({
          id: newId(),
          ownerId: auth.ownerId,
          projectId: project.id,
          projectVersion: locked.projectVersion,
          sourceAssetId: source.id,
          holidayId: body.holidayId,
          style: body.style,
          lightingMode: body.lightingMode,
          holidayPackVersion,
          compilerVersion,
          inputSnapshot: toJson({
            sourceKind: source.kind,
            sceneType: project.sceneType ?? source.sceneType,
            buildingForm: project.buildingForm ?? source.buildingForm,
            roomType: project.roomType ?? source.roomType,
            ...(kitRow ? { styleKitVersionId: kitRow.id } : {}),
          }),
          permissionEvaluationId: evaluationId,
          state: 'queued',
          idempotencyKey: key,
          requestHash,
          reviewMode,
          deviceHash,
          ipHash,
          correlationId: request.id,
          requestedAt: lockedNow,
          sourceReadyAt: source.readyAt,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      if (supersededId) {
        await trx
          .updateTable('renderJobs')
          .set({ supersededByJobId: job.id })
          .where('id', '=', supersededId)
          .execute();
      }
      await reserve(
        trx,
        {
          ownerId: auth.ownerId,
          jobId: job.id,
          projectId: project.id,
          sessionId: auth.session.id,
          isFixture,
        },
        lines,
        deps.clock,
      );
      await deps.queue.enqueueRender(trx, {
        renderJobId: job.id,
        projectId: project.id,
        ownerId: auth.ownerId,
        correlationId: request.id,
      });
      await notifyRenderJobChanged(trx, { jobId: job.id, seq: job.stateSeq });
      await trx
        .updateTable('projects')
        .set({
          holidayId: body.holidayId,
          style: body.style,
          lightingMode: body.lightingMode,
          lastActivityAt: now,
          expiresAt: projectExpiry(project, now),
        })
        .where('id', '=', project.id)
        .execute();
      return { kind: 'created', job, supersededId };
    });

  let outcome: TransactionOutcome | null = null;
  for (let attempt = 1; outcome === null; attempt += 1) {
    try {
      outcome = await renderTransaction();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const raced = await deps.db
          .selectFrom('renderJobs')
          .selectAll()
          .where('ownerId', '=', auth.ownerId)
          .where('idempotencyKey', '=', key)
          .executeTakeFirst();
        if (raced) {
          if (raced.requestHash !== requestHash) {
            throw new AppError('IDEMPOTENCY_CONFLICT', { idempotencyKey: key });
          }
          return replayJob(deps, auth, reply, raced);
        }
      }
      const conflict =
        isUniqueViolation(error, ONE_ACTIVE_JOB_INDEX) || error instanceof EnqueueConflictError;
      if (!conflict) throw error;
      // Another writer holds the project's active slot: retry once, then answer a retryable
      // capacity refusal instead of a server error.
      if (attempt >= 2) throw atCapacity(RENDER_CONFLICT_RETRY_S, null);
      await clearStaleQueueEntries(deps, project.id);
    }
  }

  if (outcome.kind === 'in_flight') return inFlightResponse(deps, auth, reply, outcome.job);
  if (outcome.kind === 'refused') {
    return refuse(deps, auth, { body, project }, outcome.refusal, now);
  }
  const { job: created, supersededId } = outcome;
  if (supersededId) deps.events.publish(supersededId, null);
  await recordOutcome(deps, auth, { body, project, outcome: 'queued' });
  const status = await renderStatus(deps, auth, created);
  reply.code(202);
  return { ...status, cached: false as const, supersededRenderJobId: supersededId };
}

/**
 * Cancels `render` queue entries of the project whose render job already ended in the domain (a
 * worker that stopped after publishing, or an entry no consumer picked up), so the queue's
 * one-active-job-per-project guard never blocks a new request on a finished job.
 */
async function clearStaleQueueEntries(deps: ApiDeps, projectId: string): Promise<void> {
  const entries = await deps.queue.boss.findJobs('render', { key: projectId });
  const live = entries.filter((entry) => ['created', 'retry', 'active'].includes(entry.state));
  if (live.length === 0) return;
  const rows = await deps.db
    .selectFrom('renderJobs')
    .select(['id', 'state'])
    .where(
      'id',
      'in',
      live.map((entry) => entry.id),
    )
    .execute();
  const states = new Map(rows.map((row) => [row.id, row.state]));
  const stale = live
    .filter((entry) => {
      const state = states.get(entry.id);
      return state === undefined || isTerminalRenderJobState(state);
    })
    .map((entry) => entry.id);
  if (stale.length > 0) await deps.queue.cancel('render', stale);
}

/** Renders: create, status, cancel, live events, Shop the look and click recording. */
export function registerRenderRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/renders',
    {
      schema: {
        body: CreateRenderRequestSchema,
        response: { 200: CachedRenderResponseSchema, 202: QueuedRenderResponseSchema },
      },
    },
    async (request, reply) => createRender(deps, request, reply),
  );

  app.get(
    '/v1/renders/:id',
    { schema: { params: IdParamsSchema, response: { 200: RenderStatusSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const job = await loadOwnedJob(deps, auth, request.params.id);
      return renderStatus(deps, auth, job);
    },
  );

  app.post(
    '/v1/renders/:id/cancel',
    {
      schema: {
        params: IdParamsSchema,
        body: EmptyObjectSchema.optional(),
        response: { 200: RenderStatusSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const job = await loadOwnedJob(deps, auth, request.params.id);
      await terminateRenderJob(deps.pipeline, { jobId: job.id, to: 'canceled' });
      const current = await loadOwnedJob(deps, auth, job.id);
      return renderStatus(deps, auth, current);
    },
  );

  registerRenderEvents(app, deps);

  app.get(
    '/v1/renders/:id/products',
    { schema: { params: IdParamsSchema, response: { 200: ProductsPanelSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const job = await loadOwnedJob(deps, auth, request.params.id);
      return buildProductsPanel(deps, auth, job);
    },
  );

  app.post(
    '/v1/clicks',
    { schema: { body: CreateClickRequestSchema, response: { 201: CreateClickResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      enforceEndpointLimit(deps, request, reply, 'clicks', { auth });
      const token = request.body.clickToken;
      const linkId = verifyClickToken(deps.config.sessionSecret, auth.session.id, token);
      if (!linkId) throw notFound();
      const existing = await deps.db
        .selectFrom('affiliateClicks')
        .select('id')
        .where('clickToken', '=', token)
        .executeTakeFirst();
      if (existing) {
        reply.code(201);
        return { clickId: existing.id };
      }
      const link = await deps.db
        .selectFrom('renderProductLinks')
        .innerJoin('renderAssets', 'renderAssets.id', 'renderProductLinks.renderAssetId')
        .innerJoin('sourceAssets', 'sourceAssets.id', 'renderAssets.sourceAssetId')
        .select([
          'renderProductLinks.id',
          'renderProductLinks.chosenOfferId',
          'renderProductLinks.linkMode',
          'renderProductLinks.relationship',
          'renderProductLinks.rankPosition',
          'renderProductLinks.sponsored',
          'renderAssets.holidayId',
          'renderAssets.ownerId',
          'sourceAssets.kind as sourceKind',
          'sourceAssets.sceneType',
        ])
        .where('renderProductLinks.id', '=', linkId)
        .executeTakeFirst();
      if (!link || !link.chosenOfferId || !link.linkMode || link.ownerId !== auth.ownerId) {
        throw notFound();
      }
      const offer = await deps.db
        .selectFrom('offers')
        .innerJoin('merchantPrograms', 'merchantPrograms.id', 'offers.merchantProgramId')
        .select([
          'offers.id',
          'offers.merchantProgramId',
          'offers.sponsored',
          'merchantPrograms.programKey',
          'merchantPrograms.subIdCapability',
          'merchantPrograms.trackingIds',
        ])
        .where('offers.id', '=', link.chosenOfferId)
        .executeTakeFirstOrThrow();
      const calendar = await holidayCalendar(deps);
      const occurrence = commerceOccurrenceOf(calendar.rows, link.holidayId, deps.clock.now());
      const trackingId =
        link.linkMode === 'tracking'
          ? (offer.trackingIds.find(
              (entry) => entry.holidayId === link.holidayId && entry.channel === 'direct',
            )?.trackingId ?? null)
          : null;
      const clickId = newId();
      try {
        await deps.db
          .insertInto('affiliateClicks')
          .values({
            id: clickId,
            clickToken: token,
            renderProductLinkId: link.id,
            offerId: offer.id,
            merchantProgramId: offer.merchantProgramId,
            linkMode: link.linkMode,
            sentSubId: link.linkMode === 'tracking' && offer.subIdCapability ? token : null,
            trackingId,
            relationship: link.relationship,
            rankPosition: link.rankPosition,
            holidayId: link.holidayId,
            occurrenceKey: occurrence?.occurrenceKey ?? `${link.holidayId}.US`,
            sceneType: link.sceneType ?? 'house_exterior',
            sourceKind: link.sourceKind,
            acquisitionChannel: 'direct',
            sessionHash: sessionHashOf(deps, auth.ownerId),
            countryCode: 'US',
          })
          .execute();
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const raced = await deps.db
          .selectFrom('affiliateClicks')
          .select('id')
          .where('clickToken', '=', token)
          .executeTakeFirstOrThrow();
        reply.code(201);
        return { clickId: raced.id };
      }
      await emitEvent(deps, deps.db, {
        name: 'product_clicked',
        ownerId: auth.ownerId,
        holidayId: link.holidayId,
        sceneType: link.sceneType,
        sourceKind: link.sourceKind,
        properties: {
          relationship: link.relationship,
          rankPosition: Math.max(1, link.rankPosition),
          merchantProgramId: offer.programKey.slice(0, 64),
          linkMode: link.linkMode,
          sponsored: offer.sponsored || link.sponsored,
        },
      });
      reply.code(201);
      return { clickId };
    },
  );
}
