import {
  AnalyticsBatchSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  EmptyObjectSchema,
  ExperienceQuerySchema,
  ExperienceSchema,
  MeSchema,
  validateClientAnalyticsEvent,
} from '@hailiday/core';
import { AppError } from '@hailiday/server/errors';
import { toJson } from '@hailiday/server/db';
import { newId } from '@hailiday/server/ids';
import { verifyTurnstile } from '@hailiday/server/turnstile';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { enforceEndpointLimit, enforceSessionCreationLimit } from '../auth/limits.js';
import {
  createAnonymousSession,
  currentAuth,
  requireSession,
  sessionHashOf,
} from '../auth/session.js';
import { allowanceFor } from '../domain/allowance.js';
import { isFixtureEnvironment } from '../domain/events.js';
import { experienceFor } from '../domain/experience.js';

/** Sessions, the experience projection, `GET /v1/me` and client analytics ingestion. */
export function registerSessionRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/sessions',
    {
      schema: {
        body: CreateSessionRequestSchema,
        response: { 201: CreateSessionResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = await currentAuth(deps, request);
      if (existing) {
        // A session without a verified bot check (the one a logout leaves behind) is verified
        // with this call's token; otherwise nothing changes.
        if (!existing.session.turnstileVerifiedAt && !existing.user) {
          const verified = await verifyTurnstile(deps.config, request.body.turnstileToken, {
            remoteIp: request.ip,
            logger: deps.logger,
          });
          if (!verified.success) throw new AppError('VERIFICATION_REQUIRED', {});
          await deps.db
            .updateTable('anonymousSessions')
            .set({ turnstileVerifiedAt: deps.clock.now() })
            .where('id', '=', existing.session.id)
            .execute();
        }
        reply.code(201);
        return { expiresAt: existing.session.expiresAt.toISOString() };
      }
      await enforceSessionCreationLimit(deps, request, reply);
      const verified = await verifyTurnstile(deps.config, request.body.turnstileToken, {
        remoteIp: request.ip,
        logger: deps.logger,
      });
      if (!verified.success) throw new AppError('VERIFICATION_REQUIRED', {});
      const auth = await createAnonymousSession(deps, request, reply, {
        timezone: request.body.timezone ?? null,
        turnstileVerifiedAt: deps.clock.now(),
      });
      reply.code(201);
      return { expiresAt: auth.session.expiresAt.toISOString() };
    },
  );

  app.get(
    '/v1/experience',
    { schema: { querystring: ExperienceQuerySchema, response: { 200: ExperienceSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      return experienceFor(deps, {
        requestedHoliday: request.query.holiday ?? null,
        audience: auth.audience,
        allowance: await allowanceFor(deps, auth.ownerId),
      });
    },
  );

  app.get('/v1/me', { schema: { response: { 200: MeSchema } } }, async (request, reply) => {
    const auth = await requireSession(deps, request, reply);
    const saved = await deps.db
      .selectFrom('projects')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', auth.ownerId)
      .where('deletedAt', 'is', null)
      .where('savedAt', 'is not', null)
      .executeTakeFirstOrThrow();
    return {
      user: auth.user
        ? { id: auth.user.id, email: auth.user.emailNormalized, roles: auth.roles }
        : null,
      allowance: await allowanceFor(deps, auth.ownerId),
      savedProjects: Number(saved.count),
    };
  });

  app.post(
    '/v1/analytics',
    { schema: { body: AnalyticsBatchSchema, response: { 202: EmptyObjectSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      enforceEndpointLimit(deps, request, reply, 'analytics', { auth });
      const now = deps.clock.now();
      const fixture = isFixtureEnvironment(deps);
      const rows = request.body.events
        .map((event) => validateClientAnalyticsEvent(event))
        .filter((event) => event !== null)
        .map((event) => ({
          id: newId(),
          eventName: event.name,
          occurredAt: new Date(event.occurredAt),
          receivedAt: now,
          sessionHash: sessionHashOf(deps, auth.ownerId),
          emitter: 'client' as const,
          properties: toJson({ ...event.properties, ...(fixture ? { fixture: true } : {}) }),
          holidayId: event.holidayId,
          sceneType: event.sceneType,
          sourceKind: event.sourceKind,
          countryCode: 'US',
          appVersion: deps.config.appVersion,
        }));
      if (rows.length > 0) await deps.db.insertInto('analyticsEvents').values(rows).execute();
      reply.code(202);
      return {};
    },
  );
}
