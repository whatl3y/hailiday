import type { ServerContext } from '@hailiday/server';
import type { Content } from '@hailiday/server/content';
import { SlidingWindowLimiter } from '@hailiday/server/limits';
import type { PipelineDeps } from '@hailiday/server/pipeline';
import type { Providers } from '@hailiday/server/providers';
import type { RenderEventHub } from './sse/hub.js';
import type { WebShell } from './html/shell.js';

/** Everything route handlers use: the server context plus providers, content and API state. */
export interface ApiDeps {
  config: ServerContext['config'];
  logger: ServerContext['logger'];
  clock: ServerContext['clock'];
  db: ServerContext['db'];
  storage: ServerContext['storage'];
  queue: ServerContext['queue'];
  settings: ServerContext['settings'];
  capabilities: ServerContext['capabilities'];
  email: ServerContext['email'];
  providers: Providers;
  content: Content;
  /** In-memory sliding windows for request rate limits and abuse quotas. */
  limiter: SlidingWindowLimiter;
  /** Fan-out of `render_job_changed` notifications to SSE streams. */
  events: RenderEventHub;
  /** The web app's HTML template and static directory. */
  web: WebShell;
  /** The same handles shaped for pipeline functions (deletion, cancel, review decisions). */
  pipeline: PipelineDeps;
}

export function pipelineDepsFrom(
  context: Pick<
    ServerContext,
    'config' | 'logger' | 'clock' | 'db' | 'storage' | 'queue' | 'settings' | 'capabilities'
  >,
  providers: Providers,
  content: Content,
): PipelineDeps {
  return {
    db: context.db,
    storage: context.storage,
    queue: context.queue,
    settings: context.settings,
    capabilities: context.capabilities,
    config: context.config,
    logger: context.logger,
    clock: context.clock,
    providers,
    content,
  };
}

export function createLimiter(clock: ServerContext['clock']): SlidingWindowLimiter {
  return new SlidingWindowLimiter({ clock });
}
