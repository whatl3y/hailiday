import { sql } from '@hailiday/server/db';
import { z } from 'zod';
import {
  CapabilityListResponseSchema,
  CapabilityParamsSchema,
  CapabilityRecordSchema,
  CeilingsSchema,
  CreateBlockedAddressRequestSchema,
  CreatePreservationHoldRequestSchema,
  EmptyObjectSchema,
  IdParamsSchema,
  MERCHANT_PROGRAM_STATUSES,
  OfferStatusRequestSchema,
  PauseStateSchema,
  PutCapabilityRequestSchema,
  ReleasePreservationHoldRequestSchema,
  ReportTriageRequestSchema,
  ReviewDecisionRequestSchema,
  SPEND_CEILING_KEYS,
  SettingRecordSchema,
  SettingWriteSchema,
  UploadHoldDecisionRequestSchema,
  isRuntimeSettingKey,
  normalizeEmail,
  type CapabilityKey,
  type JobEnhancementRecord,
  type PauseState,
  type Ceilings,
} from '@hailiday/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toCapabilityRecord } from '@hailiday/server/capabilities';
import { addMs, DAY_MS } from '@hailiday/server/clock';
import { toJson, type Db, type DbOrTx, type Tx, type User } from '@hailiday/server/db';
import { forbidden, notFound, validationFailed } from '@hailiday/server/errors';
import { newId, safeEqual, sha256Hex } from '@hailiday/server/ids';
import {
  ReviewStateError,
  approveReview,
  copyHeldObjects,
  deleteProject,
  deleteReviewCopy,
  deleteSharePublicObjects,
  heldAttemptOf,
  heldKeys,
  placePreservationHold,
  purgePlace,
  rejectReview,
  releaseHeldObjects,
  reviewObjectKeyOf,
  withoutReviewCopy,
} from '@hailiday/server/pipeline';
import { KNOWN_PROVIDERS } from '@hailiday/server/settings';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import {
  MICROSECOND_TIMESTAMP_FORMAT,
  decodePreciseCursor,
  encodePreciseCursor,
} from '../http/cursor.js';
import { csrfTokenFor, currentAuth, ipHashOf, type AuthState } from '../auth/session.js';
import { writeAudit } from '../domain/events.js';
import { invalidateHolidayCalendar } from '../domain/holidays.js';
import {
  framedDisplayUrlOf,
  lookPredatesFraming,
  wideDisplayUrlForViewpoint,
} from '../domain/sources.js';
import { hasFreshReauth, isOperatorEmail, sendAuthLink } from './auth.js';

type OperatorAuth = AuthState & { user: User };

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(512).optional(),
});

/**
 * The creation time of a listed row at the database's microsecond precision (`cursorAt`), so a
 * keyset over `(created_at, id)` compares the stored values and never repeats or skips a row
 * created in the same millisecond as a page boundary.
 */
const CURSOR_AT =
  sql<string>`to_char(created_at at time zone 'utc', ${MICROSECOND_TIMESTAMP_FORMAT})`.as(
    'cursorAt',
  );

/** The keyset condition after a precise cursor, ascending (`>`) or descending (`<`). */
function afterCursor(cursor: [string, string], direction: 'asc' | 'desc') {
  return direction === 'asc'
    ? sql<boolean>`(created_at, id) > (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`
    : sql<boolean>`(created_at, id) < (${cursor[0]}::timestamptz, ${cursor[1]}::uuid)`;
}

/** One page of rows fetched with `limit + 1` and `CURSOR_AT`, and the cursor of the next page. */
function page<T extends { cursorAt: string; id: string }>(
  rows: T[],
  limit: number,
): { items: Omit<T, 'cursorAt'>[]; nextCursor: string | null } {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    items: kept.map(({ cursorAt: _cursorAt, ...item }) => item),
    nextCursor: rows.length > limit && last ? encodePreciseCursor(last.cursorAt, last.id) : null,
  };
}

/**
 * Operator authentication for `/internal/v1`: a signed-in account holding `operator` (or
 * `reviewer` for review endpoints) whose email is on the operator allowlist; mutating calls also
 * need the per-session `X-CSRF-Token` and an email re-authentication within the configured window.
 */
async function requireOperator(
  deps: ApiDeps,
  request: FastifyRequest,
  options: { reviewer?: boolean; mutating?: boolean; reauth?: boolean } = {},
): Promise<OperatorAuth> {
  const auth = await currentAuth(deps, request);
  if (!auth?.user) throw forbidden('operator_required');
  const roles = auth.user.roles;
  const role =
    roles.includes('operator') || (options.reviewer === true && roles.includes('reviewer'));
  if (!role || !isOperatorEmail(deps, auth.user.emailNormalized)) {
    throw forbidden('operator_required');
  }
  if (options.mutating) {
    const header = request.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (!token || !safeEqual(token, csrfTokenFor(deps, auth.session))) throw forbidden('csrf');
    if (options.reauth !== false && !(await hasFreshReauth(deps, auth))) {
      throw forbidden('reauth_required');
    }
  }
  return auth as OperatorAuth;
}

/**
 * Appends the `audit_log` row of an internal call. Mutations pass their transaction so the change
 * and its audit row commit together (a failed audit write rolls the change back).
 */
async function audit(
  deps: ApiDeps,
  db: DbOrTx,
  request: FastifyRequest,
  auth: OperatorAuth,
  entry: {
    action: string;
    targetKind: string;
    targetId: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await writeAudit(db, {
    actorUserId: auth.user.id,
    actorKind: actorKindOf(auth),
    action: entry.action,
    targetKind: entry.targetKind,
    targetId: entry.targetId,
    before: (entry.before ?? null) as Record<string, unknown> | null,
    after: (entry.after ?? null) as Record<string, unknown> | null,
    requestId: request.id,
    ipHash: ipHashOf(deps, request),
  });
}

function actorKindOf(auth: OperatorAuth) {
  return auth.user.roles.includes('operator') ? ('operator' as const) : ('reviewer' as const);
}

/**
 * Records that the caller was shown customer images through an internal tool: one `audit_log`
 * row per item (the target only; never the URL or image data).
 */
async function auditImageViews(
  deps: ApiDeps,
  request: FastifyRequest,
  auth: OperatorAuth,
  entry: { action: string; targetKind: string; targetIds: string[] },
) {
  if (entry.targetIds.length === 0) return;
  const ipHash = ipHashOf(deps, request);
  await deps.db
    .insertInto('auditLog')
    .values(
      entry.targetIds.map((targetId) => ({
        id: newId(),
        actorUserId: auth.user.id,
        actorKind: actorKindOf(auth),
        action: entry.action,
        targetKind: entry.targetKind,
        targetId,
        before: null,
        after: null,
        requestId: request.id,
        ipHash,
      })),
    )
    .execute();
}

const PAUSE_PROVIDERS = [...KNOWN_PROVIDERS, 'commerce'] as const;

/**
 * The confirmation a homeowner receives when an operator actions their "Don't decorate my home"
 * request: what was done in one sentence, and where to ask Google to blur the source imagery.
 */
const OPT_OUT_CONFIRMATION = {
  subject: 'Your Hailiday request is done',
  text: [
    "We've added the address you sent us to Hailiday's do-not-decorate list and deleted every Hailiday preview made from its street photo.",
    '',
    'Hailiday can\'t change Google\'s own Street View image. To ask Google to blur your home there, use "Report a problem" on Google Maps: https://www.google.com/streetview/privacy/',
    '',
    'This address is now kept only as a place reference, and your email address only as a one-way hash.',
  ].join('\n'),
} as const;

async function pauseState(deps: ApiDeps): Promise<PauseState> {
  const providers: Record<string, boolean> = {};
  for (const provider of PAUSE_PROVIDERS) {
    providers[provider] = await deps.settings.isProviderPaused(provider);
  }
  return {
    global: await deps.settings.get('pause.global'),
    providers,
    version: (await deps.settings.getRecord('pause.global')).version,
  };
}

async function ceilingsState(deps: ApiDeps): Promise<Ceilings> {
  const skuDailyMicros: Ceilings['skuDailyMicros'] = {};
  for (const key of SPEND_CEILING_KEYS) {
    skuDailyMicros[key] = await deps.settings.skuDailyCeilingMicros(key);
  }
  return {
    dailyMicros: await deps.settings.get('spend.daily_micros'),
    monthlyMicros: await deps.settings.get('spend.monthly_micros'),
    skuDailyMicros,
    version: (await deps.settings.getRecord('spend.daily_micros')).version,
  };
}

/** Sets a setting at its current version (secondary keys of a combined write). */
async function setCurrent(deps: ApiDeps, trx: Tx, key: string, value: unknown, userId: string) {
  const current = await deps.settings.getRecord(key);
  if (JSON.stringify(current.value) === JSON.stringify(value)) return;
  await deps.settings.set(key, value, {
    expectedVersion: current.version,
    updatedBy: userId,
    db: trx,
  });
}

/**
 * Withdraws a delivered variant in the caller's transaction: hidden from its owner and every share
 * grant revoked. Returns the grants' card keys, whose public copies the caller deletes after
 * commit with `deleteShareCopies`.
 */
async function withdrawVariant(
  deps: ApiDeps,
  trx: Tx,
  renderAssetId: string,
): Promise<(string | null)[]> {
  const now = deps.clock.now();
  await trx
    .updateTable('renderAssets')
    .set({ withdrawnAt: now })
    .where('id', '=', renderAssetId)
    .where('withdrawnAt', 'is', null)
    .execute();
  const grants = await trx
    .selectFrom('shareGrants')
    .selectAll()
    .where('renderAssetId', '=', renderAssetId)
    .execute();
  await trx
    .updateTable('shareGrants')
    .set({ revokedAt: now })
    .where('renderAssetId', '=', renderAssetId)
    .where('revokedAt', 'is', null)
    .execute();
  return grants.map((grant) => grant.shareCardObjectKey);
}

/** Deletes the public copies of withdrawn share grants (best effort; revocation already holds). */
async function deleteShareCopies(deps: ApiDeps, cardKeys: (string | null)[]) {
  for (const cardKey of cardKeys) {
    await deleteSharePublicObjects(deps.pipeline, cardKey).catch(() => 0);
  }
}

/**
 * A signed URL of the accepted Street View enhancement a job decorated (its enhancement outcome
 * `made` or `reused`), or null when the job used Google's frame or the picture is gone.
 */
async function enhancedSourceUrlOf(
  deps: ApiDeps,
  enhancement: JobEnhancementRecord | null,
): Promise<string | null> {
  if (!enhancement?.enhancementId) return null;
  if (enhancement.outcome !== 'made' && enhancement.outcome !== 'reused') return null;
  const row = await deps.db
    .selectFrom('sourceEnhancements')
    .select(['status', 'objectKey'])
    .where('id', '=', enhancement.enhancementId)
    .executeTakeFirst();
  if (row?.status !== 'accepted' || !row.objectKey) return null;
  return deps.storage.presignGet('private', row.objectKey);
}

/** The internal operations API for operator accounts (reviewers for review endpoints). */
export function registerInternalRoutes(app: App, deps: ApiDeps): void {
  const withCodes = (reply: FastifyReply, code: number) => reply.code(code);

  app.get('/internal/v1/session', async (request) => {
    const auth = await requireOperator(deps, request, { reviewer: true });
    return {
      csrfToken: csrfTokenFor(deps, auth.session),
      user: { id: auth.user.id, email: auth.user.emailNormalized, roles: auth.user.roles },
      reauthFresh: await hasFreshReauth(deps, auth),
    };
  });

  app.post(
    '/internal/v1/reauth',
    { schema: { body: EmptyObjectSchema.optional() } },
    async (request, reply) => {
      const auth = await requireOperator(deps, request, {
        reviewer: true,
        mutating: true,
        reauth: false,
      });
      await deps.db.transaction().execute(async (trx) => {
        await audit(deps, trx, request, auth, {
          action: 'operator.reauth_request',
          targetKind: 'user',
          targetId: auth.user.id,
          after: { sessionId: auth.session.id },
        });
        await sendAuthLink(deps, request, {
          email: auth.user.emailNormalized,
          purpose: 'operator_reauth',
          sessionId: auth.session.id,
          ownerId: auth.ownerId,
          returnTo: null,
          db: trx,
        });
      });
      return withCodes(reply, 202).send({});
    },
  );

  // ---- capabilities --------------------------------------------------------------------------
  app.get(
    '/internal/v1/capabilities',
    { schema: { response: { 200: CapabilityListResponseSchema } } },
    async (request) => {
      await requireOperator(deps, request);
      deps.capabilities.invalidate();
      return { items: (await deps.capabilities.list()).map(toCapabilityRecord) };
    },
  );

  app.put(
    '/internal/v1/capabilities/:countryCode/:capability',
    {
      schema: {
        params: CapabilityParamsSchema,
        body: PutCapabilityRequestSchema,
        response: { 200: CapabilityRecordSchema },
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const body = request.body;
      const after = await deps.db.transaction().execute(async (trx) => {
        const changed = await deps.capabilities.set({
          countryCode: request.params.countryCode,
          capability: request.params.capability as CapabilityKey,
          state: body.state,
          evidenceRef: body.evidenceRef,
          reviewedAt: new Date(body.reviewedAt),
          reviewedBy: auth.user.id,
          expectedVersion: body.version,
          ...(body.confirm !== undefined ? { confirm: body.confirm } : {}),
          db: trx,
        });
        const { before, after: row } = changed;
        await audit(deps, trx, request, auth, {
          action: 'capability.update',
          targetKind: 'country_capability',
          targetId: `${row.countryCode}:${row.capability}`,
          before: before ? { state: before.state, version: before.version } : null,
          after: { state: row.state, version: row.version, evidenceRef: row.evidenceRef },
        });
        return row;
      });
      deps.capabilities.invalidate();
      return toCapabilityRecord(after);
    },
  );

  // ---- pause and ceilings --------------------------------------------------------------------
  app.get(
    '/internal/v1/pause',
    { schema: { response: { 200: PauseStateSchema } } },
    async (request) => {
      await requireOperator(deps, request);
      deps.settings.invalidate();
      return pauseState(deps);
    },
  );

  app.put(
    '/internal/v1/pause',
    { schema: { body: PauseStateSchema, response: { 200: PauseStateSchema } } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      deps.settings.invalidate();
      const before = await pauseState(deps);
      await deps.db.transaction().execute(async (trx) => {
        const global = await deps.settings.set('pause.global', request.body.global, {
          expectedVersion: request.body.version,
          updatedBy: auth.user.id,
          db: trx,
        });
        const providers = { ...before.providers };
        for (const [provider, paused] of Object.entries(request.body.providers)) {
          if (!/^[a-z0-9_-]+$/.test(provider)) continue;
          await setCurrent(deps, trx, `pause.provider.${provider}`, paused, auth.user.id);
          if (provider in providers) providers[provider] = paused;
        }
        await audit(deps, trx, request, auth, {
          action: 'pause.set',
          targetKind: 'runtime_settings',
          targetId: 'pause',
          before,
          after: {
            global: request.body.global,
            providers,
            version: global.version,
            reason: request.body.reason ?? null,
          },
        });
      });
      deps.settings.invalidate();
      return pauseState(deps);
    },
  );

  app.get(
    '/internal/v1/ceilings',
    { schema: { response: { 200: CeilingsSchema } } },
    async (request) => {
      await requireOperator(deps, request);
      deps.settings.invalidate();
      return ceilingsState(deps);
    },
  );

  app.put(
    '/internal/v1/ceilings',
    { schema: { body: CeilingsSchema, response: { 200: CeilingsSchema } } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      deps.settings.invalidate();
      const before = await ceilingsState(deps);
      await deps.db.transaction().execute(async (trx) => {
        const daily = await deps.settings.set('spend.daily_micros', request.body.dailyMicros, {
          expectedVersion: request.body.version,
          updatedBy: auth.user.id,
          db: trx,
        });
        await setCurrent(
          deps,
          trx,
          'spend.monthly_micros',
          request.body.monthlyMicros,
          auth.user.id,
        );
        const skuDailyMicros = { ...before.skuDailyMicros };
        for (const [key, value] of Object.entries(request.body.skuDailyMicros)) {
          if (value !== undefined) {
            await setCurrent(deps, trx, `spend.sku_daily_micros.${key}`, value, auth.user.id);
            (skuDailyMicros as Record<string, number>)[key] = value;
          }
        }
        await audit(deps, trx, request, auth, {
          action: 'ceilings.set',
          targetKind: 'runtime_settings',
          targetId: 'ceilings',
          before,
          after: {
            dailyMicros: request.body.dailyMicros,
            monthlyMicros: request.body.monthlyMicros,
            skuDailyMicros,
            version: daily.version,
          },
        });
      });
      deps.settings.invalidate();
      return ceilingsState(deps);
    },
  );

  app.get(
    '/internal/v1/settings/:key',
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(128) }),
        response: { 200: SettingRecordSchema },
      },
    },
    async (request) => {
      await requireOperator(deps, request);
      if (!isRuntimeSettingKey(request.params.key)) throw notFound();
      deps.settings.invalidate();
      const record = await deps.settings.getRecord(request.params.key);
      return {
        key: record.key,
        value: record.value,
        version: record.version,
        updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
      };
    },
  );

  app.put(
    '/internal/v1/settings/:key',
    {
      schema: {
        params: z.object({ key: z.string().min(1).max(128) }),
        body: SettingWriteSchema,
        response: { 200: SettingRecordSchema },
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      if (!isRuntimeSettingKey(request.params.key)) throw notFound();
      deps.settings.invalidate();
      const before = await deps.settings.getRecord(request.params.key);
      const record = await deps.db.transaction().execute(async (trx) => {
        const written = await deps.settings.set(request.params.key, request.body.value, {
          expectedVersion: request.body.version,
          updatedBy: auth.user.id,
          db: trx,
        });
        await audit(deps, trx, request, auth, {
          action: 'setting.update',
          targetKind: 'runtime_setting',
          targetId: request.params.key,
          before: { value: before.value, version: before.version },
          after: { value: written.value, version: written.version },
        });
        return written;
      });
      deps.settings.invalidate();
      return {
        key: record.key,
        value: record.value,
        version: record.version,
        updatedAt: record.updatedAt ? record.updatedAt.toISOString() : null,
      };
    },
  );

  // ---- review queue --------------------------------------------------------------------------
  app.get(
    '/internal/v1/reviews',
    {
      schema: {
        querystring: ListQuerySchema.extend({ state: z.literal('needs_review').optional() }),
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { reviewer: true });
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db
        .selectFrom('renderJobs')
        .selectAll()
        .select(CURSOR_AT)
        .where('state', '=', 'needs_review');
      if (cursor) query = query.where(afterCursor(cursor, 'asc'));
      const rows = await query
        .orderBy('createdAt')
        .orderBy('id')
        .limit(request.query.limit + 1)
        .execute();
      const { items, nextCursor } = page(rows, request.query.limit);
      const now = deps.clock.now();
      const result = [];
      for (const job of items) {
        const source = await deps.db
          .selectFrom('sourceAssets')
          .selectAll()
          .where('id', '=', job.sourceAssetId)
          .executeTakeFirst();
        // The attempt whose candidate is held, with its own plan and judge decision.
        const attempt = (await heldAttemptOf(deps.db, job)) ?? undefined;
        const plan = attempt
          ? await deps.db
              .selectFrom('decorationPlans')
              .select('document')
              .where('id', '=', attempt.decorationPlanId)
              .executeTakeFirst()
          : undefined;
        const judge = attempt
          ? await deps.db
              .selectFrom('judgeResults')
              .select(['document', 'decision'])
              .where('attemptId', '=', attempt.id)
              .orderBy('escalated', 'desc')
              .executeTakeFirst()
          : undefined;
        // The held look's time is its held attempt's (made after the job prepared its frame).
        // A look made before its Street View source was zoomed in on its home is shown beside
        // the wide view it was made from. A source with no stored frame shows the provider's
        // display URL of its view (a framed view's load is counted and ledgered once per source).
        const lookAt = attempt?.createdAt ?? job.renderStartedAt ?? job.createdAt;
        const sourceUrl =
          source?.kind === 'street_view' && lookPredatesFraming(source.viewpoint, lookAt)
            ? await wideDisplayUrlForViewpoint(deps, auth.audience, source.viewpoint)
            : source?.objectKey
              ? await deps.storage.presignGet('private', source.objectKey)
              : source
                ? await framedDisplayUrlOf(deps, auth, source)
                : null;
        const candidateUrl = attempt
          ? await deps.storage.presignGet('private', heldKeys(job.id, attempt.id).delivered)
          : null;
        // The sharpened Street View picture the attempts decorated, beside Google's frame, so a
        // reviewer can tell a sharper photo from a changed home.
        const enhancement = job.enhancement ?? null;
        const enhancedSourceUrl = await enhancedSourceUrlOf(deps, enhancement);
        const waitFrom = job.qaPassedAt ?? job.renderCompletedAt ?? job.requestedAt;
        result.push({
          renderJobId: job.id,
          subjectKind: 'render_job',
          holidayId: job.holidayId,
          style: job.style,
          lightingMode: job.lightingMode,
          sceneType: source?.sceneType ?? null,
          sourceKind: source?.kind ?? null,
          attempt: job.attemptCount,
          sourceUrl,
          enhancedSourceUrl,
          enhancement,
          candidateUrl,
          plan: plan?.document ?? null,
          judge: judge ? { decision: judge.decision, document: judge.document } : null,
          waitMs: Math.max(0, now.getTime() - waitFrom.getTime()),
        });
      }
      await auditImageViews(deps, request, auth, {
        action: 'review.view',
        targetKind: 'render_job',
        targetIds: result.map((item) => item.renderJobId),
      });
      return { items: result, nextCursor };
    },
  );

  app.post(
    '/internal/v1/reviews/:renderJobId/decision',
    { schema: { params: z.object({ renderJobId: z.uuid() }), body: ReviewDecisionRequestSchema } },
    async (request) => {
      const auth = await requireOperator(deps, request, { reviewer: true, mutating: true });
      const body = request.body;
      const job = await deps.db
        .selectFrom('renderJobs')
        .selectAll()
        .where('id', '=', request.params.renderJobId)
        .executeTakeFirst();
      if (!job) throw notFound();
      let withdrawnCards: (string | null)[] = [];
      try {
        await deps.db.transaction().execute(async (trx) => {
          await audit(deps, trx, request, auth, {
            action: 'review.decide',
            targetKind: 'render_job',
            targetId: job.id,
            before: { state: job.state },
            after: { decision: body.decision, reasonCodes: body.reasonCodes },
          });
          // The pipeline's database writes join this transaction (it nests through
          // `withTransaction`), so the decision and its audit row commit together.
          const pipeline = { ...deps.pipeline, db: trx as unknown as Db };
          if (job.state === 'needs_review') {
            if (body.decision === 'approve') {
              const adherence = body.adherence
                ? Object.fromEntries(
                    body.adherence.map((entry) => [
                      entry.placementId,
                      {
                        category: entry.status !== 'fail',
                        colorFamily: entry.status === 'pass',
                        count: entry.status === 'pass',
                      },
                    ]),
                  )
                : undefined;
              await approveReview(pipeline, {
                jobId: job.id,
                reviewerUserId: auth.user.id,
                notes: body.notes ?? null,
                ...(adherence ? { adherence } : {}),
              });
            } else {
              await rejectReview(pipeline, {
                jobId: job.id,
                reviewerUserId: auth.user.id,
                reasonCodes: body.reasonCodes,
                notes: body.notes ?? null,
              });
            }
          } else if (job.state === 'succeeded' && job.renderAssetId) {
            await trx
              .insertInto('reviews')
              .values({
                id: newId(),
                subjectKind: 'audit_sample',
                jobId: job.id,
                reviewerUserId: auth.user.id,
                decision: body.decision,
                reasonCodes: body.reasonCodes,
                notes: body.notes ?? null,
                requestedAt: job.succeededAt ?? job.updatedAt,
                decidedAt: deps.clock.now(),
              })
              .execute();
            if (body.decision === 'reject') {
              withdrawnCards = await withdrawVariant(deps, trx, job.renderAssetId);
            }
          } else {
            throw validationFailed({
              fields: [{ path: 'renderJobId', reason: 'not_reviewable' }],
            });
          }
        });
      } catch (error) {
        if (error instanceof ReviewStateError) {
          throw validationFailed({ fields: [{ path: 'renderJobId', reason: 'not_reviewable' }] });
        }
        throw error;
      }
      await deleteShareCopies(deps, withdrawnCards);
      deps.events.publish(job.id, null);
      const after = await deps.db
        .selectFrom('renderJobs')
        .select(['id', 'state', 'renderAssetId'])
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow();
      return { renderJobId: after.id, state: after.state, renderAssetId: after.renderAssetId };
    },
  );

  // ---- upload holds --------------------------------------------------------------------------
  app.get(
    '/internal/v1/upload-holds',
    { schema: { querystring: ListQuerySchema } },
    async (request) => {
      const auth = await requireOperator(deps, request, { reviewer: true });
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db
        .selectFrom('sourceAssets')
        .selectAll()
        .select(CURSOR_AT)
        .where('state', '=', 'screening')
        .where('holdForReview', '=', true);
      if (cursor) query = query.where(afterCursor(cursor, 'asc'));
      const rows = await query
        .orderBy('createdAt')
        .orderBy('id')
        .limit(request.query.limit + 1)
        .execute();
      const { items, nextCursor } = page(rows, request.query.limit);
      const result = [];
      for (const asset of items) {
        const screening = (asset.screening ?? {}) as Record<string, unknown>;
        // Reviewers see only the reduced-size copy written at screening, never the original.
        const reviewKey = reviewObjectKeyOf(screening);
        result.push({
          sourceAssetId: asset.id,
          imageUrl: reviewKey ? await deps.storage.presignGet('private', reviewKey) : null,
          flags: screening.checks ?? [],
          heldAt: screening.heldAt ?? null,
          holdUntil: screening.holdUntil ?? null,
        });
      }
      await auditImageViews(deps, request, auth, {
        action: 'upload_hold.view',
        targetKind: 'source_asset',
        targetIds: result.filter((item) => item.imageUrl).map((item) => item.sourceAssetId),
      });
      return { items: result, nextCursor };
    },
  );

  app.post(
    '/internal/v1/upload-holds/:sourceAssetId/decision',
    {
      schema: {
        params: z.object({ sourceAssetId: z.uuid() }),
        body: UploadHoldDecisionRequestSchema,
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { reviewer: true, mutating: true });
      const now = deps.clock.now();
      const asset = await deps.db
        .selectFrom('sourceAssets')
        .selectAll()
        .where('id', '=', request.params.sourceAssetId)
        .where('state', '=', 'screening')
        .where('holdForReview', '=', true)
        .executeTakeFirst();
      if (!asset) throw notFound();
      const approve = request.body.decision === 'approve';
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('sourceAssets')
          .set(
            approve
              ? {
                  state: 'ready',
                  holdForReview: false,
                  readyAt: now,
                  screening: toJson(withoutReviewCopy(asset.screening)),
                }
              : {
                  state: 'declined',
                  holdForReview: false,
                  screening: toJson(withoutReviewCopy(asset.screening)),
                  declinedCode: 'UPLOAD_DECLINED',
                  declinedReasonClass: 'safety',
                  declinedReason: 'review_declined',
                },
          )
          .where('id', '=', asset.id)
          .execute();
        await trx
          .insertInto('reviews')
          .values({
            id: newId(),
            subjectKind: 'upload_hold',
            sourceAssetId: asset.id,
            reviewerUserId: auth.user.id,
            decision: request.body.decision,
            reasonCodes: request.body.reasonCode
              ? [request.body.reasonCode]
              : approve
                ? []
                : ['review_declined'],
            requestedAt: asset.updatedAt,
            decidedAt: now,
          })
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'upload_hold.decide',
          targetKind: 'source_asset',
          targetId: asset.id,
          before: { state: asset.state },
          after: { decision: request.body.decision },
        });
      });
      await deleteReviewCopy(deps, asset.screening);
      return { sourceAssetId: asset.id, state: approve ? 'ready' : 'declined' };
    },
  );

  // ---- reports and holds ---------------------------------------------------------------------
  app.get(
    '/internal/v1/reports',
    {
      schema: {
        querystring: ListQuerySchema.extend({
          status: z.enum(['open', 'triaged', 'actioned', 'dismissed']).optional(),
          priority: z.enum(['normal', 'urgent']).optional(),
        }),
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request);
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db.selectFrom('reports').selectAll().select(CURSOR_AT);
      if (request.query.status) query = query.where('status', '=', request.query.status);
      if (request.query.priority) query = query.where('priority', '=', request.query.priority);
      if (cursor) query = query.where(afterCursor(cursor, 'desc'));
      const rows = await query
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit + 1)
        .execute();
      const { items, nextCursor } = page(rows, request.query.limit);
      // Reporter contact details are personal data: each report shown with them is audited.
      await auditImageViews(deps, request, auth, {
        action: 'report.view',
        targetKind: 'report',
        targetIds: items.filter((report) => report.reporterContactEmail).map((report) => report.id),
      });
      return {
        items: items.map((report) => ({
          id: report.id,
          targetKind: report.targetKind,
          targetId: report.targetId,
          targetPlaceId: report.targetPlaceId,
          reason: report.reason,
          details: report.details,
          contactEmail: report.reporterContactEmail,
          requestOptOut: report.requestOptOut,
          status: report.status,
          priority: report.priority,
          assigneeUserId: report.assigneeUserId,
          resolution: report.resolution,
          createdAt: report.createdAt.toISOString(),
          resolvedAt: report.resolvedAt ? report.resolvedAt.toISOString() : null,
        })),
        nextCursor,
      };
    },
  );

  app.post(
    '/internal/v1/reports/:id/triage',
    { schema: { params: IdParamsSchema, body: ReportTriageRequestSchema } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const report = await deps.db
        .selectFrom('reports')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!report) throw notFound();
      const now = deps.clock.now();
      const body = request.body;
      const action = body.resolution?.action ?? null;
      if (action === 'block_address' && !(body.resolution?.placeId ?? report.targetPlaceId)) {
        throw validationFailed({
          fields: [{ path: 'body.resolution.placeId', reason: 'required' }],
        });
      }
      const takedownProject =
        action === 'takedown' && report.targetId
          ? await deps.db
              .selectFrom('projects')
              .selectAll()
              .where('id', '=', report.targetId)
              .executeTakeFirst()
          : undefined;
      const blockedPlaceId =
        action === 'block_address'
          ? ((body.resolution?.placeId ?? report.targetPlaceId) as string)
          : null;
      // A homeowner opt-out keeps the requester's contact only as a hash once actioned, and the
      // typed address text is dropped (the place ID is what is honored).
      const optOutEmail =
        action === 'block_address' &&
        report.reason === 'this_is_my_home' &&
        report.reporterContactEmail &&
        !/^[0-9a-f]{64}$/.test(report.reporterContactEmail)
          ? report.reporterContactEmail
          : null;
      const contactHash = optOutEmail ? sha256Hex(normalizeEmail(optOutEmail)) : null;
      // Every database change of the triage and its audit row commit together; the public share
      // copies, the takedown's project deletion, the place purge (each keeps its own deletion
      // request and receipt), held copies and the opt-out confirmation run after the commit.
      const committed = await deps.db.transaction().execute(async (trx) => {
        let holdId: string | null = report.preservationHoldId;
        let placedHold: string | null = null;
        let cards: (string | null)[] = [];
        if (action === 'block_address' && blockedPlaceId) {
          const source = report.reason === 'this_is_my_home' ? 'homeowner_request' : 'operator';
          const evidenceRef = body.resolution?.evidenceRef ?? `report:${report.id}`;
          // A place listed before (an expired, removed or other block) is listed again as this
          // report's block: its source, evidence and author are the ones of this triage.
          await trx
            .insertInto('blockedAddresses')
            .values({
              id: newId(),
              placeId: blockedPlaceId,
              source,
              reportId: report.id,
              evidenceRef,
              createdBy: auth.user.id,
              requesterContactHash: contactHash,
            })
            .onConflict((oc) =>
              oc.column('placeId').doUpdateSet({
                removedAt: null,
                expiresAt: null,
                reportId: report.id,
                source,
                evidenceRef,
                createdBy: auth.user.id,
                ...(contactHash ? { requesterContactHash: contactHash } : {}),
              }),
            )
            .execute();
        } else if (action === 'takedown' && report.targetId) {
          const asset = await trx
            .selectFrom('renderAssets')
            .select(['id'])
            .where('id', '=', report.targetId)
            .executeTakeFirst();
          if (asset) cards = await withdrawVariant(deps, trx, asset.id);
        } else if (
          (action === 'preservation_hold' || action === 'escalate_child_safety') &&
          !report.preservationHoldId &&
          (report.targetId || report.targetShareTokenHash)
        ) {
          const placed = await placePreservationHold(trx, {
            targetKind: 'report',
            targetId: report.id,
            reason:
              action === 'escalate_child_safety' ? 'mandatory_report' : 'complaint_investigation',
            authorityRef: `report:${report.id}`,
            releaseCondition:
              action === 'escalate_child_safety'
                ? 'One year after the CyberTipline report, or release after review finds no report is required'
                : 'Investigation closed',
            placedBy: auth.user.id,
          });
          holdId = placed.holdId;
          placedHold = placed.holdId;
        }
        const resolved = body.status === 'actioned' || body.status === 'dismissed';
        await trx
          .updateTable('reports')
          .set({
            status: body.status,
            assigneeUserId: body.assigneeUserId ?? report.assigneeUserId,
            priority: action === 'escalate_child_safety' ? 'urgent' : report.priority,
            resolution: body.resolution
              ? toJson({ ...body.resolution, at: now.toISOString(), by: auth.user.id })
              : report.resolution
                ? toJson(report.resolution)
                : null,
            preservationHoldId: holdId,
            resolvedAt: resolved ? now : report.resolvedAt,
            ...(contactHash ? { reporterContactEmail: contactHash, addressText: null } : {}),
          })
          .where('id', '=', report.id)
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'report.triage',
          targetKind: 'report',
          targetId: report.id,
          before: { status: report.status },
          after: { status: body.status, action, ...(placedHold ? { holdId: placedHold } : {}) },
        });
        return { cards, placedHold };
      });
      await deleteShareCopies(deps, committed.cards);
      if (committed.placedHold) await copyHeldObjects(deps.pipeline, committed.placedHold);
      if (takedownProject) {
        await deleteProject(deps.pipeline, {
          project: takedownProject,
          scope: 'takedown',
          requestedBy: 'operator',
        });
      }
      if (blockedPlaceId) {
        await purgePlace(deps.pipeline, blockedPlaceId, { requestedBy: 'operator' });
      }
      if (optOutEmail) {
        await deps.email
          .send({ to: optOutEmail, ...OPT_OUT_CONFIRMATION, tag: 'optout-confirmation' })
          .catch((error: unknown) => {
            request.log.error({ err: error, reportId: report.id }, 'opt-out confirmation failed');
          });
      }
      return { reportId: report.id, status: body.status };
    },
  );

  app.get(
    '/internal/v1/preservation-holds',
    { schema: { querystring: ListQuerySchema } },
    async (request) => {
      await requireOperator(deps, request);
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db.selectFrom('preservationHolds').selectAll().select(CURSOR_AT);
      if (cursor) query = query.where(afterCursor(cursor, 'desc'));
      const rows = await query
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit + 1)
        .execute();
      return page(rows, request.query.limit);
    },
  );

  app.post(
    '/internal/v1/preservation-holds',
    { schema: { body: CreatePreservationHoldRequestSchema } },
    async (request, reply) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const body = request.body;
      const holdId = await deps.db.transaction().execute(async (trx) => {
        const placed = await placePreservationHold(trx, { ...body, placedBy: auth.user.id });
        await audit(deps, trx, request, auth, {
          action: 'preservation_hold.place',
          targetKind: body.targetKind,
          targetId: body.targetId,
          after: { holdId: placed.holdId, reason: body.reason },
        });
        return placed.holdId;
      });
      await copyHeldObjects(deps.pipeline, holdId);
      return withCodes(reply, 201).send({ id: holdId });
    },
  );

  app.post(
    '/internal/v1/preservation-holds/:id/release',
    { schema: { params: IdParamsSchema, body: ReleasePreservationHoldRequestSchema } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const hold = await deps.db
        .selectFrom('preservationHolds')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!hold) throw notFound();
      const now = deps.clock.now();
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('preservationHolds')
          .set({
            releasedAt: now,
            releasedBy: auth.user.id,
            releaseReason: request.body.releaseReason,
          })
          .where('id', '=', hold.id)
          .execute();
        await trx
          .updateTable('projects')
          .set({ preservationHoldId: null })
          .where('preservationHoldId', '=', hold.id)
          .execute();
        await trx
          .updateTable('sourceAssets')
          .set({ preservationHoldId: null })
          .where('preservationHoldId', '=', hold.id)
          .execute();
        await trx
          .updateTable('renderAssets')
          .set({ preservationHoldId: null })
          .where('preservationHoldId', '=', hold.id)
          .execute();
        await trx
          .updateTable('reports')
          .set({ preservationHoldId: null })
          .where('preservationHoldId', '=', hold.id)
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'preservation_hold.release',
          targetKind: hold.targetKind,
          targetId: hold.targetId,
          before: { holdId: hold.id },
          after: { releasedAt: now.toISOString() },
        });
      });
      await releaseHeldObjects(deps.pipeline, hold.id);
      return { id: hold.id, releasedAt: now.toISOString() };
    },
  );

  // ---- blocked addresses ---------------------------------------------------------------------
  app.get(
    '/internal/v1/blocked-addresses',
    { schema: { querystring: ListQuerySchema } },
    async (request) => {
      await requireOperator(deps, request);
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db
        .selectFrom('blockedAddresses')
        .selectAll()
        .select(CURSOR_AT)
        .where('removedAt', 'is', null);
      if (cursor) query = query.where(afterCursor(cursor, 'desc'));
      const rows = await query
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit + 1)
        .execute();
      const { items, nextCursor } = page(rows, request.query.limit);
      return {
        items: items.map((row) => ({
          id: row.id,
          placeId: row.placeId,
          source: row.source,
          reportId: row.reportId,
          evidenceRef: row.evidenceRef,
          expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor,
      };
    },
  );

  app.post(
    '/internal/v1/blocked-addresses',
    { schema: { body: CreateBlockedAddressRequestSchema } },
    async (request, reply) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const body = request.body;
      const row = await deps.db.transaction().execute(async (trx) => {
        const added = await trx
          .insertInto('blockedAddresses')
          .values({
            id: newId(),
            placeId: body.placeId,
            normalizedAddressHash: body.normalizedAddressHash ?? null,
            source: body.source,
            evidenceRef: body.evidenceRef,
            createdBy: auth.user.id,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          })
          .onConflict((oc) =>
            oc.column('placeId').doUpdateSet({
              removedAt: null,
              expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
              evidenceRef: body.evidenceRef,
              source: body.source,
            }),
          )
          .returning(['id', 'placeId'])
          .executeTakeFirstOrThrow();
        await audit(deps, trx, request, auth, {
          action: 'blocked_address.add',
          targetKind: 'blocked_address',
          targetId: added.id,
          after: { placeId: added.placeId, source: body.source },
        });
        return added;
      });
      return withCodes(reply, 201).send({ id: row.id });
    },
  );

  app.delete(
    '/internal/v1/blocked-addresses/:id',
    { schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      await deps.db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('blockedAddresses')
          .set({ removedAt: deps.clock.now() })
          .where('id', '=', request.params.id)
          .returning(['id', 'placeId'])
          .executeTakeFirst();
        if (!row) throw notFound();
        await audit(deps, trx, request, auth, {
          action: 'blocked_address.remove',
          targetKind: 'blocked_address',
          targetId: row.id,
          before: { placeId: row.placeId },
        });
      });
      return reply.code(204).send();
    },
  );

  // ---- commerce: programs, offers, kits --------------------------------------------------------
  app.get('/internal/v1/merchant-programs', async (request) => {
    await requireOperator(deps, request);
    const rows = await deps.db
      .selectFrom('merchantPrograms')
      .selectAll()
      .orderBy('programKey')
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        programKey: row.programKey,
        displayName: row.displayName,
        network: row.network,
        status: row.status,
        linkMethod: row.linkMethod,
        subIdCapability: row.subIdCapability,
        apiAccess: row.apiAccess,
        capabilityKey: row.capabilityKey,
        statusHistory: row.statusHistory,
      })),
    };
  });

  app.put(
    '/internal/v1/merchant-programs/:id',
    {
      schema: {
        params: IdParamsSchema,
        body: z.strictObject({
          status: z.enum(MERCHANT_PROGRAM_STATUSES),
          evidenceRef: z.string().min(1).max(500),
        }),
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const program = await deps.db
        .selectFrom('merchantPrograms')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!program) throw notFound();
      const now = deps.clock.now();
      const history = [
        ...program.statusHistory,
        {
          status: request.body.status,
          at: now.toISOString(),
          evidenceRef: request.body.evidenceRef,
        },
      ];
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('merchantPrograms')
          .set({
            status: request.body.status,
            statusHistory: toJson(history),
            ...(request.body.status === 'approved' ? { approvedAt: now } : {}),
            ...(request.body.status === 'applied' ? { appliedAt: now } : {}),
            ...(['declined', 'withdrawn'].includes(request.body.status) ? { endedAt: now } : {}),
          })
          .where('id', '=', program.id)
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'merchant_program.update',
          targetKind: 'merchant_program',
          targetId: program.id,
          before: { status: program.status },
          after: { status: request.body.status, evidenceRef: request.body.evidenceRef },
        });
      });
      return { id: program.id, status: request.body.status };
    },
  );

  app.get(
    '/internal/v1/offers',
    {
      schema: {
        querystring: ListQuerySchema.extend({
          status: z.enum(['draft', 'active', 'paused', 'retired']).optional(),
        }),
      },
    },
    async (request) => {
      await requireOperator(deps, request);
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db.selectFrom('offers').selectAll().select(CURSOR_AT);
      if (request.query.status) query = query.where('status', '=', request.query.status);
      if (cursor) query = query.where(afterCursor(cursor, 'asc'));
      const rows = await query
        .orderBy('createdAt')
        .orderBy('id')
        .limit(request.query.limit + 1)
        .execute();
      const { items, nextCursor } = page(rows, request.query.limit);
      return {
        items: items.map((offer) => ({
          id: offer.id,
          offerKey: offer.offerKey,
          productId: offer.productId,
          merchantProgramId: offer.merchantProgramId,
          status: offer.status,
          availability: offer.availability,
          priceSource: offer.priceSource,
          seasonalEligibility: offer.seasonalEligibility,
          lastVerifiedAt: offer.lastVerifiedAt ? offer.lastVerifiedAt.toISOString() : null,
          verificationMethod: offer.verificationMethod,
        })),
        nextCursor,
      };
    },
  );

  app.put(
    '/internal/v1/offers/:id/status',
    { schema: { params: IdParamsSchema, body: OfferStatusRequestSchema } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const offer = await deps.db
        .selectFrom('offers')
        .select(['id', 'status'])
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!offer) throw notFound();
      if (offer.status === 'retired' && request.body.status !== 'retired') {
        throw validationFailed({
          fields: [{ path: 'body.status', reason: 'retired_is_terminal' }],
        });
      }
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('offers')
          .set({ status: request.body.status })
          .where('id', '=', offer.id)
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'offer.update',
          targetKind: 'offer',
          targetId: offer.id,
          before: { status: offer.status },
          after: { status: request.body.status },
        });
      });
      return { id: offer.id, status: request.body.status };
    },
  );

  app.post(
    '/internal/v1/offers/:id/verify',
    {
      schema: {
        params: IdParamsSchema,
        body: z.strictObject({ availability: z.enum(['in_stock', 'unknown', 'out_of_stock']) }),
      },
    },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const now = deps.clock.now();
      const offer = await deps.db.transaction().execute(async (trx) => {
        const verified = await trx
          .updateTable('offers')
          .set({
            lastVerifiedAt: now,
            verificationMethod: 'manual',
            verifiedBy: auth.user.id,
            availability: request.body.availability,
            availabilityCheckedAt: now,
          })
          .where('id', '=', request.params.id)
          .returning(['id'])
          .executeTakeFirst();
        if (!verified) throw notFound();
        await audit(deps, trx, request, auth, {
          action: 'offer.verify',
          targetKind: 'offer',
          targetId: verified.id,
          after: { availability: request.body.availability, method: 'manual' },
        });
        return verified;
      });
      return { id: offer.id, lastVerifiedAt: now.toISOString() };
    },
  );

  app.get('/internal/v1/kits', async (request) => {
    await requireOperator(deps, request);
    const rows = await deps.db
      .selectFrom('styleKits')
      .selectAll()
      .orderBy('kitKey')
      .orderBy('version')
      .execute();
    return {
      items: rows.map((kit) => ({
        id: kit.id,
        kitKey: kit.kitKey,
        holidayId: kit.holidayId,
        sceneType: kit.sceneType,
        version: kit.version,
        status: kit.status,
        publishedAt: kit.publishedAt ? kit.publishedAt.toISOString() : null,
      })),
    };
  });

  app.get(
    '/internal/v1/kits/:id/items',
    { schema: { params: IdParamsSchema } },
    async (request) => {
      await requireOperator(deps, request);
      const items = await deps.db
        .selectFrom('kitItems')
        .selectAll()
        .where('kitId', '=', request.params.id)
        .orderBy('sortOrder')
        .execute();
      return {
        items: items.map((item) => ({
          id: item.id,
          kitItemId: item.kitItemId,
          anchorCategory: item.anchorCategory,
          specText: item.specText,
          specAttributes: item.specAttributes,
          styleQuantities: item.styleQuantities,
          sortOrder: item.sortOrder,
          currentProductId: item.currentProductId,
        })),
      };
    },
  );

  app.post(
    '/internal/v1/kits/:id/publish',
    { schema: { params: IdParamsSchema, body: EmptyObjectSchema.optional() } },
    async (request) => {
      const auth = await requireOperator(deps, request, { mutating: true });
      const kit = await deps.db
        .selectFrom('styleKits')
        .selectAll()
        .where('id', '=', request.params.id)
        .executeTakeFirst();
      if (!kit) throw notFound();
      const now = deps.clock.now();
      await deps.db.transaction().execute(async (trx) => {
        await trx
          .updateTable('styleKits')
          .set({ status: 'retired' })
          .where('kitKey', '=', kit.kitKey)
          .where('status', '=', 'published')
          .where('id', '<>', kit.id)
          .execute();
        await trx
          .updateTable('styleKits')
          .set({ status: 'published', publishedAt: now })
          .where('id', '=', kit.id)
          .execute();
        await audit(deps, trx, request, auth, {
          action: 'kit.publish',
          targetKind: 'style_kit',
          targetId: kit.id,
          before: { status: kit.status },
          after: { status: 'published' },
        });
      });
      invalidateHolidayCalendar();
      return { id: kit.id, status: 'published' };
    },
  );

  // ---- audit and ledger ----------------------------------------------------------------------
  app.get(
    '/internal/v1/audit-log',
    { schema: { querystring: ListQuerySchema.extend({ action: z.string().max(64).optional() }) } },
    async (request) => {
      await requireOperator(deps, request);
      const cursor = decodePreciseCursor(request.query.cursor);
      let query = deps.db.selectFrom('auditLog').selectAll().select(CURSOR_AT);
      if (request.query.action) query = query.where('action', '=', request.query.action);
      if (cursor) query = query.where(afterCursor(cursor, 'desc'));
      const rows = await query
        .orderBy('createdAt', 'desc')
        .orderBy('id', 'desc')
        .limit(request.query.limit + 1)
        .execute();
      const result = page(rows, request.query.limit);
      return {
        items: result.items.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get(
    '/internal/v1/ledger/summary',
    {
      schema: {
        querystring: z.object({
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          groupBy: z.enum(['sku', 'provider', 'day']).default('sku'),
        }),
      },
    },
    async (request) => {
      await requireOperator(deps, request);
      const to = request.query.to ? new Date(request.query.to) : deps.clock.now();
      const from = request.query.from ? new Date(request.query.from) : addMs(to, -DAY_MS * 30);
      const day = sql<string>`to_char(date_trunc('day', created_at at time zone 'UTC'), 'YYYY-MM-DD')`;
      const rows = await deps.db
        .selectFrom('usageLedger')
        .select([
          'sku',
          'provider',
          'isFixture',
          day.as('day'),
          sql<number>`coalesce(sum(amount_micros), 0)`.as('netMicros'),
          sql<number>`coalesce(sum(amount_micros) filter (where kind in ('charge', 'settlement')), 0)`.as(
            'spentMicros',
          ),
          sql<number>`count(*)`.as('rows'),
        ])
        .where('createdAt', '>=', from)
        .where('createdAt', '<', to)
        .groupBy(['sku', 'provider', 'isFixture', day])
        .orderBy(day)
        .execute();
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        groupBy: request.query.groupBy,
        items: rows.map((row) => ({
          sku: row.sku,
          provider: row.provider,
          isFixture: row.isFixture,
          day: row.day,
          netMicros: Number(row.netMicros),
          spentMicros: Number(row.spentMicros),
          rows: Number(row.rows),
        })),
      };
    },
  );
}
