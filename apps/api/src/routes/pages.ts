import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ShareTokenSchema, isHolidayId, type Experience } from '@holiday/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { ANONYMOUS_AUDIENCE } from '@holiday/server/capabilities';
import { renderFixturePanorama } from '@holiday/server/fixtures';
import { sha256Hex } from '@holiday/server/ids';
import { verifyFixtureDisplayQuery } from '@holiday/server/providers';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { currentAuth, ipHashOf, sessionHashOf } from '../auth/session.js';
import { allowanceFor } from '../domain/allowance.js';
import { emitEvent } from '../domain/events.js';
import {
  fixtureCapabilitiesFor,
  publicExperience,
  type PublicExperience,
} from '../domain/experience.js';
import {
  renderClientRoute,
  renderLanding,
  renderShareGone,
  renderSharePage,
  siteImageUrl,
} from '../html/pages.js';
import { setHtmlSecurityHeaders } from '../html/shell.js';
import { enforceShareViewLimit, lookupShare, recordShareView, referrerClassOf } from './sharing.js';

/** Client routes the SPA owns (experience spec, client routes). */
export const CLIENT_ROUTES = [
  '/upload',
  '/p/:projectId',
  '/places',
  '/account',
  '/auth/verify',
  '/dont-decorate-my-home',
  '/terms',
  '/privacy',
  '/content-policy',
  '/ai-disclosure',
  '/affiliate-disclosure',
  '/accessibility',
  '/dmca',
] as const;

const LANDING_TTL_MS = 60_000;

interface CachedLanding {
  html: string;
  etag: string;
  expiresAt: number;
  experience: Experience;
}

const landingCaches = new WeakMap<ApiDeps, Map<string, CachedLanding>>();

function landingCache(deps: ApiDeps): Map<string, CachedLanding> {
  let cache = landingCaches.get(deps);
  if (!cache) {
    cache = new Map();
    landingCaches.set(deps, cache);
  }
  return cache;
}

/** The experience as inlined in a shell: public parts with the anonymous audience and allowance. */
async function shellExperience(
  deps: ApiDeps,
  requested: string | null,
): Promise<{ experience: Experience; publicPart: PublicExperience }> {
  const publicPart = await publicExperience(deps, requested);
  const { heroAsset: _heroAsset, windowId: _windowId, ...rest } = publicPart;
  const fixtureCapabilities = await fixtureCapabilitiesFor(deps, ANONYMOUS_AUDIENCE);
  return {
    publicPart,
    experience: {
      ...rest,
      capabilities: await deps.capabilities.publicProjection('US', ANONYMOUS_AUDIENCE),
      ...(fixtureCapabilities ? { fixtureCapabilities } : {}),
      allowance: await allowanceFor(deps, null),
    },
  };
}

async function siteImage(deps: ApiDeps): Promise<string | null> {
  const heroes = await deps.db
    .selectFrom('heroAssets')
    .selectAll()
    .where('active', '=', true)
    .execute();
  return siteImageUrl(deps, heroes);
}

function sendHtml(
  deps: ApiDeps,
  reply: FastifyReply,
  html: string,
  options: { status?: number; cacheControl: string; etag?: string },
) {
  setHtmlSecurityHeaders(reply, deps.config);
  reply.header('Cache-Control', options.cacheControl);
  if (options.etag) reply.header('ETag', options.etag);
  return reply
    .code(options.status ?? 200)
    .type('text/html; charset=utf-8')
    .send(html);
}

async function landingViewed(deps: ApiDeps, request: FastifyRequest, experience: Experience) {
  const auth = await currentAuth(deps, request);
  await emitEvent(deps, deps.db, {
    name: 'landing_viewed',
    ...(auth
      ? { sessionHash: sessionHashOf(deps, auth.ownerId) }
      : { sessionHash: sha256Hex(`landing:${ipHashOf(deps, request)}`) }),
    holidayId: experience.defaultHolidayId,
    properties: {
      defaultHolidayId: experience.defaultHolidayId,
      inWindow: experience.defaultHolidayId !== null,
      offSeason: experience.offSeason,
      referrerClass: referrerClassOf(request, deps.config.publicBaseUrl),
    },
  });
}

/**
 * The server-rendered documents and static delivery: the landing shell at `/` (memoized per
 * window, hero and deep link for a minute), the share page, the SPA shell for client routes, the
 * built assets with long caching for hashed files, fixture Street View frames and the health check.
 */
export function registerPageRoutes(app: App, deps: ApiDeps): void {
  app.get(
    '/',
    { schema: { querystring: z.object({ holiday: z.string().max(64).optional() }).passthrough() } },
    async (request, reply) => {
      const raw = request.query.holiday ?? null;
      const requested = raw && isHolidayId(raw) ? raw : null;
      const cache = landingCache(deps);
      const now = Date.now();
      const key = requested ?? '';
      let cached = cache.get(key);
      if (!cached || cached.expiresAt <= now) {
        const { experience, publicPart } = await shellExperience(deps, requested);
        const html = renderLanding(deps, {
          experience,
          publicPart,
          siteImage: await siteImage(deps),
        });
        const digest = createHash('sha1').update(html).digest('hex').slice(0, 16);
        cached = {
          html,
          etag: `W/"${publicPart.windowId}-${digest}"`,
          expiresAt: now + LANDING_TTL_MS,
          experience,
        };
        cache.set(key, cached);
      }
      const experience = cached.experience;
      await landingViewed(deps, request, experience);
      if (request.headers['if-none-match'] === cached.etag) {
        setHtmlSecurityHeaders(reply, deps.config);
        return reply
          .code(304)
          .header('ETag', cached.etag)
          .header('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
          .send();
      }
      return sendHtml(deps, reply, cached.html, {
        cacheControl: 'public, max-age=60, stale-while-revalidate=300',
        etag: cached.etag,
      });
    },
  );

  app.get(
    '/s/:token',
    { schema: { params: z.object({ token: z.string().max(256) }) } },
    async (request, reply) => {
      enforceShareViewLimit(deps, request, reply);
      const image = await siteImage(deps);
      const token = ShareTokenSchema.safeParse(request.params.token);
      if (!token.success) {
        return sendHtml(
          deps,
          reply,
          renderShareGone(deps, { reason: 'not_found', siteImage: image }),
          {
            status: 404,
            cacheControl: 'no-store',
          },
        );
      }
      const lookup = await lookupShare(deps, token.data);
      if (lookup.status !== 'active') {
        const reason = lookup.status === 'gone' ? lookup.reason : 'not_found';
        return sendHtml(deps, reply, renderShareGone(deps, { reason, siteImage: image }), {
          status: lookup.status === 'gone' ? 410 : 404,
          cacheControl: 'no-store',
        });
      }
      await recordShareView(deps, request, lookup.grant);
      const html = renderSharePage(deps, {
        token: token.data,
        view: lookup.view,
        cardUrl: lookup.cardUrl,
        siteImage: image,
      });
      return sendHtml(deps, reply, html, { cacheControl: 'no-store' });
    },
  );

  const clientRoute = async (_request: FastifyRequest, reply: FastifyReply) => {
    const { experience } = await shellExperience(deps, null);
    return sendHtml(deps, reply, renderClientRoute(deps, experience), { cacheControl: 'no-cache' });
  };
  for (const route of CLIENT_ROUTES) app.get(route, clientRoute);

  app.get('/healthz', async () => ({ status: 'ok' }));

  if (!deps.config.isProduction) {
    app.get(
      '/fixture/streetview',
      { schema: { querystring: z.record(z.string(), z.string()) } },
      async (request, reply) => {
        const view = verifyFixtureDisplayQuery(deps.config.sessionSecret, request.query);
        if (!view) return reply.code(403).type('text/plain; charset=utf-8').send('Forbidden');
        const rendered = await renderFixturePanorama(view);
        if (!rendered) return reply.code(404).type('text/plain; charset=utf-8').send('Not found');
        return reply
          .header('Cache-Control', 'public, max-age=86400, immutable')
          .header('X-Provider-Mode', 'fixture')
          .type('image/jpeg')
          .send(rendered.image);
      },
    );
  }

  if (deps.web.distDir) {
    void app.register(fastifyStatic, {
      root: deps.web.distDir,
      prefix: '/',
      wildcard: true,
      index: false,
      cacheControl: false,
      allowedPath: (pathName) => pathName !== '/index.html',
      setHeaders: (reply, filePath) => {
        const hashed = /[\\/]assets[\\/]/.test(filePath);
        reply.header(
          'Cache-Control',
          hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
        );
      },
    });
  }
}

/** The SPA shell for a 404 on a page route (the client shows its not-found screen). */
export async function renderNotFoundPage(deps: ApiDeps, reply: FastifyReply) {
  const { experience } = await shellExperience(deps, null);
  return sendHtml(deps, reply, renderClientRoute(deps, experience), {
    status: 404,
    cacheControl: 'no-store',
  });
}
