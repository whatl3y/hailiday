import Fastify, { LogController, type FastifyBaseLogger } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { ServerContext } from '@holiday/server';
import { loadContent, type Content } from '@holiday/server/content';
import { createProviders, type Providers } from '@holiday/server/providers';
import { createLimiter, pipelineDepsFrom, type ApiDeps } from './deps.js';
import { registerErrorHandling } from './http/errors.js';
import { registerRequestHooks, requestIdFor } from './http/request.js';
import type { App } from './http/types.js';
import { loadWebShell } from './html/shell.js';
import { RenderEventHub } from './sse/hub.js';
import { registerAddressRoutes } from './routes/addresses.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerPageRoutes, renderNotFoundPage } from './routes/pages.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerRenderRoutes } from './routes/renders.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSharingRoutes } from './routes/sharing.js';
import { registerUploadRoutes } from './routes/uploads.js';

/**
 * Trusts exactly `hops` proxies in front of the API: the immediate peer and the next `hops - 1`
 * `X-Forwarded-For` entries counted from the right, so `request.ip` is the entry the outermost
 * trusted proxy appended and anything a client prepends is ignored. Fastify treats a numeric
 * `trustProxy` as trusting nothing, so the count is expressed as a function; 0 ignores the header.
 */
export function trustProxyHops(hops: number): false | ((address: string, hop: number) => boolean) {
  return hops > 0 ? (_address, hop) => hop < hops : false;
}

/** Maximum JSON body size (analytics batches are the largest bodies). */
const BODY_LIMIT_BYTES = 256 * 1024;

export interface BuildServerOptions {
  /** The infrastructure handles (database, storage, queue as producer, settings, email). */
  context: Pick<
    ServerContext,
    | 'config'
    | 'logger'
    | 'clock'
    | 'db'
    | 'storage'
    | 'queue'
    | 'settings'
    | 'capabilities'
    | 'email'
  >;
  content?: Content;
  providers?: Providers;
  /** Directory of the built web app; undefined uses `apps/web/dist`, null disables static files. */
  webDistDir?: string | null;
  /** Hold the `LISTEN` connection for SSE fan-out (default true). */
  listen?: boolean;
}

export interface ApiServer {
  app: App;
  deps: ApiDeps;
  /** Closes the HTTP server and the `LISTEN` connection (the context is closed by its owner). */
  close(): Promise<void>;
}

/**
 * Builds the Fastify application: zod validation and serialization with the core schemas, the
 * request plumbing (request IDs, no-store, same-origin checks, access logs without query text),
 * cookies, the error envelope, every `/v1` and `/internal/v1` route, the server-rendered landing and
 * share pages, the SPA's static files and the SSE hub.
 */
export async function buildServer(options: BuildServerOptions): Promise<ApiServer> {
  const { context } = options;
  const content = options.content ?? (await loadContent());
  const providers =
    options.providers ?? createProviders(context.config, { logger: context.logger, content });
  const events = new RenderEventHub({
    config: context.config,
    logger: context.logger,
    enabled: options.listen !== false,
  });
  const deps: ApiDeps = {
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    db: context.db,
    storage: context.storage,
    queue: context.queue,
    settings: context.settings,
    capabilities: context.capabilities,
    email: context.email,
    providers,
    content,
    limiter: createLimiter(context.clock),
    events,
    web: loadWebShell(options.webDistDir),
    pipeline: pipelineDepsFrom(context, providers, content),
  };

  const app = Fastify({
    loggerInstance: context.logger as FastifyBaseLogger,
    logController: new LogController({
      disableRequestLogging: true,
      requestIdLogLabel: 'requestId',
    }),
    genReqId: requestIdFor,
    requestIdHeader: false,
    trustProxy: trustProxyHops(context.config.trustProxyHops),
    bodyLimit: BODY_LIMIT_BYTES,
    routerOptions: { ignoreTrailingSlash: true },
  }).withTypeProvider<ZodTypeProvider>() as unknown as App;

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(fastifyCookie);
  registerRequestHooks(app, context.config);
  registerErrorHandling(app, {
    onPageNotFound: (_request, reply) => renderNotFoundPage(deps, reply),
  });

  registerSessionRoutes(app, deps);
  registerAddressRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerUploadRoutes(app, deps);
  registerRenderRoutes(app, deps);
  registerSharingRoutes(app, deps);
  registerAuthRoutes(app, deps);
  registerInternalRoutes(app, deps);
  registerPageRoutes(app, deps);

  // Open SSE streams keep their connections busy, so they end before the server stops accepting
  // and waits for in-flight requests; browsers reconnect to another instance.
  app.addHook('preClose', async () => {
    events.closeAll();
  });
  app.addHook('onClose', async () => {
    await events.stop();
  });

  await events.start();
  await app.ready();
  return {
    app,
    deps,
    async close() {
      await app.close();
    },
  };
}
