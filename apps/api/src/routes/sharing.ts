import {
  AI_PREVIEW_LABEL_KEY,
  CreateFeedbackRequestSchema,
  CreateFeedbackResponseSchema,
  CreateReportRequestSchema,
  CreateReportResponseSchema,
  CreateShareRequestSchema,
  CreateShareResponseSchema,
  ShareTokenParamsSchema,
  ShareViewSchema,
  type ReferrerClass,
  type ShareRevokedReason,
  type ShareView,
} from '@holiday/core';
import type { FastifyRequest } from 'fastify';
import { DAY_MS, MINUTE_MS, addMs } from '@holiday/server/clock';
import { isUniqueViolation, type ShareGrant } from '@holiday/server/db';
import { AppError, forbidden, notFound, validationFailed } from '@holiday/server/errors';
import { newId, randomToken, sha256Hex } from '@holiday/server/ids';
import { deleteSharePublicObjects } from '@holiday/server/pipeline';
import { EnqueueConflictError } from '@holiday/server/queue';
import { keys } from '@holiday/server/storage';
import { verifyTurnstile } from '@holiday/server/turnstile';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { enforceEndpointLimit, enforceLimits } from '../auth/limits.js';
import { currentAuth, ipHashOf, requireSession } from '../auth/session.js';
import { emitEvent } from '../domain/events.js';
import { loadSource } from '../domain/projects.js';
import { capabilityModeFor, evaluateFor } from '../domain/sources.js';
import { idempotencyKeyOf } from './renders.js';

/** Default share lifetime (privacy retention schedule; configuration). */
export const SHARE_LIFETIME_MS = 30 * DAY_MS;
/** Share views per IP hash (`GET /v1/shares/:token` and the share page). */
const SHARE_VIEW_RULE = { limit: 120, windowMs: 10 * MINUTE_MS };

/** Classifies a referrer for analytics (never stores the URL). */
export function referrerClassOf(request: FastifyRequest, publicBaseUrl: string): ReferrerClass {
  const referrer = request.headers.referer;
  if (!referrer) return 'direct';
  try {
    const url = new URL(referrer);
    if (url.origin === new URL(publicBaseUrl).origin) {
      return url.pathname.startsWith('/s/') ? 'share' : 'direct';
    }
    if (/google\.|bing\.|duckduckgo\.|yahoo\./i.test(url.hostname)) return 'search';
    if (
      /facebook\.|instagram\.|t\.co$|twitter\.|x\.com|pinterest\.|reddit\.|tiktok\.|linkedin\./i.test(
        url.hostname,
      )
    ) {
      return 'social';
    }
    return 'other';
  } catch {
    return 'other';
  }
}

export type ShareLookup =
  | { status: 'active'; grant: ShareGrant; view: ShareView; cardUrl: string | null }
  | { status: 'gone'; reason: ShareRevokedReason }
  | { status: 'not_found' };

/**
 * Resolves a share token to its public view: the shared after image (the public copy once the
 * share-card job has made it, a short-lived signed URL until then), the before image only for an
 * upload-origin grant that includes it, attribution for Street View-origin images. No address,
 * owner or products. A variant that is no longer distributable (or whose source became
 * private-only) answers `gone`.
 */
export async function lookupShare(deps: ApiDeps, token: string): Promise<ShareLookup> {
  const hash = sha256Hex(token);
  const grant = await deps.db
    .selectFrom('shareGrants')
    .selectAll()
    .where('tokenHash', '=', hash)
    .executeTakeFirst();
  if (!grant) {
    const tombstone = await deps.db
      .selectFrom('tombstones')
      .select('id')
      .where('kind', '=', 'share_token')
      .where('hashSha256', '=', hash)
      .executeTakeFirst();
    return tombstone ? { status: 'gone', reason: 'deleted' } : { status: 'not_found' };
  }
  if (grant.revokedAt) return { status: 'gone', reason: 'revoked' };
  if (grant.expiresAt.getTime() <= deps.clock.now().getTime()) {
    return { status: 'gone', reason: 'expired' };
  }
  const asset = await deps.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('id', '=', grant.renderAssetId)
    .executeTakeFirst();
  if (!asset || asset.deletedAt || asset.withdrawnAt) return { status: 'gone', reason: 'deleted' };
  const source = await loadSource(deps, asset.sourceAssetId);
  // A lineage made private after the grant (people kept in the photo) is never shown.
  if (!asset.distributable || source?.privateOnly) return { status: 'gone', reason: 'revoked' };
  const afterKey = keys.shared(token, 'after');
  const afterCopy = await deps.storage.head('public', afterKey);
  const imageUrl = afterCopy
    ? deps.storage.publicUrl(afterKey)
    : await deps.storage.presignGet('private', asset.objectKey);
  let beforeImageUrl: string | null = null;
  if (grant.includeBefore && source && source.kind !== 'street_view') {
    const beforeKey = keys.shared(token, 'before');
    if (await deps.storage.head('public', beforeKey)) {
      beforeImageUrl = deps.storage.publicUrl(beforeKey);
    } else if (source.objectKey) {
      beforeImageUrl = await deps.storage.presignGet('private', source.objectKey);
    }
  }
  const cardKey = keys.card(token);
  const card = await deps.storage.head('public', cardKey);
  return {
    status: 'active',
    grant,
    cardUrl: card ? deps.storage.publicUrl(cardKey) : null,
    view: {
      holidayId: asset.holidayId,
      style: asset.style,
      imageUrl,
      beforeImageUrl,
      width: asset.width,
      height: asset.height,
      labelKey: AI_PREVIEW_LABEL_KEY,
      attribution:
        source?.kind === 'street_view'
          ? { required: true, text: asset.attributionText ?? 'Google Maps', logo: 'google_maps' }
          : null,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      report: { targetKind: 'share' },
    },
  };
}

/** Counts a share view and emits `share_viewed` (without viewer identity). */
export async function recordShareView(
  deps: ApiDeps,
  request: FastifyRequest,
  grant: ShareGrant,
): Promise<void> {
  await deps.db
    .updateTable('shareGrants')
    .set((eb) => ({ viewCount: eb('viewCount', '+', 1), lastViewedAt: deps.clock.now() }))
    .where('id', '=', grant.id)
    .execute();
  const viewer = await currentAuth(deps, request);
  await emitEvent(deps, deps.db, {
    name: 'share_viewed',
    sessionHash: sha256Hex(`share-view:${ipHashOf(deps, request)}`),
    properties: {
      referrerClass: referrerClassOf(request, deps.config.publicBaseUrl),
      viewerHasSession: viewer !== null,
    },
  });
}

export function enforceShareViewLimit(
  deps: ApiDeps,
  request: FastifyRequest,
  reply: Parameters<typeof enforceLimits>[1],
) {
  enforceLimits(deps, reply, 'shares', [
    { rule: SHARE_VIEW_RULE, key: `view:${ipHashOf(deps, request)}` },
  ]);
}

/** Shares, feedback and reports (including the homeowner opt-out). */
export function registerSharingRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/shares',
    { schema: { body: CreateShareRequestSchema, response: { 201: CreateShareResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const idempotencyKey = idempotencyKeyOf(request, false);
      const body = request.body;
      const respond = (grant: ShareGrant, token: string) => {
        reply.code(201);
        return {
          token,
          url: `${deps.config.publicBaseUrl}/s/${token}`,
          expiresAt: grant.expiresAt.toISOString(),
          cardUrl: deps.storage.publicUrl(keys.card(token)),
        };
      };
      if (idempotencyKey) {
        const prior = await deps.db
          .selectFrom('shareGrants')
          .selectAll()
          .where('ownerId', '=', auth.ownerId)
          .where('idempotencyKey', '=', idempotencyKey)
          .executeTakeFirst();
        const priorToken = prior?.shareCardObjectKey?.replace(/^cards\//, '').replace(/\.jpg$/, '');
        if (prior && priorToken) {
          if (
            prior.renderAssetId !== body.renderAssetId ||
            prior.includeBefore !== body.includeBefore
          ) {
            throw new AppError('IDEMPOTENCY_CONFLICT', { idempotencyKey });
          }
          reply.header('Idempotent-Replayed', 'true');
          return respond(prior, priorToken);
        }
      }
      enforceEndpointLimit(deps, request, reply, 'shares', { auth });
      const asset = await deps.db
        .selectFrom('renderAssets')
        .selectAll()
        .where('id', '=', body.renderAssetId)
        .where('ownerId', '=', auth.ownerId)
        .where('deletedAt', 'is', null)
        .executeTakeFirst();
      if (!asset) throw notFound();
      if (asset.withdrawnAt) {
        throw new AppError('RENDER_REJECTED', {
          rejectionReason: 'reviewer_rejected',
          failureCodes: [],
        });
      }
      const source = await loadSource(deps, asset.sourceAssetId);
      if (source?.privateOnly) throw forbidden('private_only');
      if ((await capabilityModeFor(deps, 'sharing', auth.audience)) === 'unavailable') {
        throw forbidden('distribution_not_permitted');
      }
      if (source) {
        const { permission } = await evaluateFor(deps, {
          policyId: source.assetPolicyId,
          kind: source.kind,
          isGoogleImagery: source.isGoogleImagery,
          audience: auth.audience,
        });
        if (!asset.distributable || !permission.distributeDerivative) {
          throw forbidden('distribution_not_permitted');
        }
      } else if (!asset.distributable) {
        throw forbidden('distribution_not_permitted');
      }
      if (body.includeBefore && source?.kind === 'street_view') {
        throw validationFailed({ reason: 'source_not_exportable' });
      }

      const token = randomToken(16);
      const now = deps.clock.now();
      let grant: ShareGrant;
      try {
        grant = await deps.db.transaction().execute(async (trx) => {
          const row = await trx
            .insertInto('shareGrants')
            .values({
              id: newId(),
              ownerId: auth.ownerId,
              renderAssetId: asset.id,
              tokenHash: sha256Hex(token),
              includeBefore: body.includeBefore && source?.kind !== 'street_view',
              idempotencyKey,
              expiresAt: addMs(now, SHARE_LIFETIME_MS),
              shareCardObjectKey: keys.card(token),
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          await trx
            .updateTable('renderAssets')
            .set({ pinnedUntil: row.expiresAt })
            .where('id', '=', asset.id)
            .where((eb) =>
              eb.or([eb('pinnedUntil', 'is', null), eb('pinnedUntil', '<', row.expiresAt)]),
            )
            .execute();
          try {
            await deps.queue.enqueue(trx, 'share_card', {
              shareGrantId: row.id,
              shareToken: token,
            });
          } catch (error) {
            if (!(error instanceof EnqueueConflictError)) throw error;
          }
          return row;
        });
      } catch (error) {
        if (idempotencyKey && isUniqueViolation(error)) {
          throw new AppError('IDEMPOTENCY_CONFLICT', { idempotencyKey });
        }
        throw error;
      }
      await emitEvent(deps, deps.db, {
        name: 'share_created',
        ownerId: auth.ownerId,
        holidayId: asset.holidayId,
        sourceKind: source?.kind ?? null,
        properties: { includeBefore: grant.includeBefore },
      });
      return respond(grant, token);
    },
  );

  app.get(
    '/v1/shares/:token',
    { schema: { params: ShareTokenParamsSchema, response: { 200: ShareViewSchema } } },
    async (request, reply) => {
      enforceShareViewLimit(deps, request, reply);
      const lookup = await lookupShare(deps, request.params.token);
      if (lookup.status === 'not_found') throw notFound();
      if (lookup.status === 'gone') throw new AppError('SHARE_REVOKED', { reason: lookup.reason });
      await recordShareView(deps, request, lookup.grant);
      return lookup.view;
    },
  );

  app.delete(
    '/v1/shares/:token',
    { schema: { params: ShareTokenParamsSchema } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const grant = await deps.db
        .selectFrom('shareGrants')
        .selectAll()
        .where('tokenHash', '=', sha256Hex(request.params.token))
        .where('ownerId', '=', auth.ownerId)
        .executeTakeFirst();
      if (!grant) throw notFound();
      if (!grant.revokedAt) {
        await deps.db
          .updateTable('shareGrants')
          .set({ revokedAt: deps.clock.now() })
          .where('id', '=', grant.id)
          .execute();
      }
      await deleteSharePublicObjects(deps.pipeline, keys.card(request.params.token)).catch(
        (error: unknown) => request.log.warn({ err: error }, 'share object purge failed'),
      );
      return reply.code(204).send();
    },
  );

  app.post(
    '/v1/feedback',
    {
      schema: {
        body: CreateFeedbackRequestSchema,
        response: { 201: CreateFeedbackResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const idempotencyKey = idempotencyKeyOf(request, false);
      const body = request.body;
      if (idempotencyKey) {
        const prior = await deps.db
          .selectFrom('feedback')
          .select(['id', 'renderAssetId', 'verdict'])
          .where('ownerId', '=', auth.ownerId)
          .where('idempotencyKey', '=', idempotencyKey)
          .executeTakeFirst();
        if (prior) {
          if (prior.renderAssetId !== body.renderAssetId || prior.verdict !== body.verdict) {
            throw new AppError('IDEMPOTENCY_CONFLICT', { idempotencyKey });
          }
          reply.code(201).header('Idempotent-Replayed', 'true');
          return { feedbackId: prior.id };
        }
      }
      enforceEndpointLimit(deps, request, reply, 'feedback', { auth });
      const asset = await deps.db
        .selectFrom('renderAssets')
        .selectAll()
        .where('id', '=', body.renderAssetId)
        .where('ownerId', '=', auth.ownerId)
        .executeTakeFirst();
      if (!asset) throw notFound();
      const source = await loadSource(deps, asset.sourceAssetId);
      const project = await deps.db
        .selectFrom('projects')
        .select('sceneType')
        .where('id', '=', asset.projectId)
        .executeTakeFirst();
      const feedbackId = newId();
      await deps.db
        .insertInto('feedback')
        .values({
          id: feedbackId,
          ownerId: auth.ownerId,
          renderAssetId: asset.id,
          jobId: asset.jobId,
          verdict: body.verdict,
          reasons: body.reasons,
          note: body.note ?? null,
          holidayId: asset.holidayId,
          sceneType: project?.sceneType ?? source?.sceneType ?? 'house_exterior',
          sourceKind: source?.kind ?? 'upload',
          idempotencyKey,
        })
        .execute();
      await emitEvent(deps, deps.db, {
        name: 'feedback_submitted',
        ownerId: auth.ownerId,
        holidayId: asset.holidayId,
        properties: { verdict: body.verdict, reasons: body.reasons },
      });
      reply.code(201);
      return { feedbackId };
    },
  );

  app.post(
    '/v1/reports',
    { schema: { body: CreateReportRequestSchema, response: { 201: CreateReportResponseSchema } } },
    async (request, reply) => {
      const body = request.body;
      const auth = await currentAuth(deps, request);
      if (!auth) {
        const verified = await verifyTurnstile(deps.config, body.turnstileToken, {
          remoteIp: request.ip,
          logger: deps.logger,
        });
        if (!verified.success) throw new AppError('VERIFICATION_REQUIRED', {});
      }
      enforceEndpointLimit(deps, request, reply, 'reports', { auth });
      const target = body.target;
      let targetId: string | null = null;
      let tokenHash: string | null = null;
      let placeId: string | null = null;
      let addressText: string | null = null;
      if (target.kind === 'share') {
        tokenHash = sha256Hex(target.token);
        const grant = await deps.db
          .selectFrom('shareGrants')
          .select('renderAssetId')
          .where('tokenHash', '=', tokenHash)
          .executeTakeFirst();
        targetId = grant?.renderAssetId ?? null;
      } else if (target.kind === 'address') {
        placeId = target.placeId;
        addressText = target.addressText ?? null;
      } else {
        targetId = target.id;
      }
      const reportId = newId();
      const now = deps.clock.now();
      await deps.db
        .insertInto('reports')
        .values({
          id: reportId,
          reporterOwnerId: auth?.ownerId ?? null,
          reporterContactEmail: body.contactEmail ?? null,
          targetKind: target.kind,
          targetId,
          targetShareTokenHash: tokenHash,
          targetPlaceId: placeId,
          addressText,
          reason: body.reason,
          details: body.details ?? null,
          requestOptOut: target.kind === 'address' ? true : body.requestOptOut,
          status: 'open',
          priority: body.reason === 'child_pictured' ? 'urgent' : 'normal',
          acknowledgedAt: now,
          ipHash: ipHashOf(deps, request),
        })
        .execute();
      if (body.reason === 'child_pictured') {
        request.log.error({ reportId }, 'urgent child-safety report received');
      }
      await emitEvent(deps, deps.db, {
        name: 'report_submitted',
        ...(auth
          ? { ownerId: auth.ownerId }
          : { sessionHash: sha256Hex(`report:${ipHashOf(deps, request)}`) }),
        properties: {
          reason: body.reason,
          targetKind: target.kind,
          requestOptOut: target.kind === 'address' ? true : body.requestOptOut,
        },
      });
      reply.code(201);
      return {
        reportId,
        acknowledgementKey:
          target.kind === 'address' ? ('optout.thanks' as const) : ('report.thanks' as const),
      };
    },
  );
}
