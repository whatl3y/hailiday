import {
  IdParamsSchema,
  RENDER_SSE_EVENT,
  RENDER_SSE_RETRY_MS,
  isTerminalRenderJobState,
} from '@holiday/core';
import type { RenderJob } from '@holiday/server/db';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { requireSession } from '../auth/session.js';
import { loadOwnedJob, renderStatus } from '../domain/renders.js';

function lastEventIdOf(header: string | string[] | undefined): number | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * `GET /v1/renders/:id/events`: the current `RenderStatus` at once (unless `Last-Event-ID` is
 * already at the job's sequence), then one event per state transition delivered through the
 * process's `LISTEN` connection, heartbeat comments, and the stream closes after the terminal
 * event. A reconnect whose `Last-Event-ID` is at or beyond the terminal sequence receives 204.
 * The hub bounds open streams (a new stream replaces the owner's oldest beyond the per-job and
 * per-owner bounds; a full process answers `AT_CAPACITY`) and ends every stream at shutdown.
 */
export function registerRenderEvents(app: App, deps: ApiDeps): void {
  app.get(
    '/v1/renders/:id/events',
    { schema: { params: IdParamsSchema } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const job = await loadOwnedJob(deps, auth, request.params.id);
      const lastEventId = lastEventIdOf(request.headers['last-event-id']);
      if (
        isTerminalRenderJobState(job.state) &&
        lastEventId !== null &&
        lastEventId >= job.stateSeq
      ) {
        return reply.code(204).send();
      }

      const heartbeatSeconds = await deps.settings.get('sse.heartbeat_s');
      const raw = reply.raw;
      let lastSent = lastEventId ?? -1;
      let closed = false;
      let unsubscribe: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      let release: (() => void) | null = null;

      const finish = () => {
        if (closed) return;
        closed = true;
        release?.();
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        raw.end();
      };

      // Admission happens before the hijack so a refusal is an ordinary error response.
      release = deps.events.openStream({ ownerId: auth.ownerId, jobId: job.id, close: finish });
      reply.hijack();
      raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Request-Id': request.id,
      });
      raw.write(`retry: ${RENDER_SSE_RETRY_MS}\n\n`);

      const send = async (current: RenderJob) => {
        const status = await renderStatus(deps, auth, current);
        if (closed) return;
        raw.write(
          `id: ${current.stateSeq}\nevent: ${RENDER_SSE_EVENT}\ndata: ${JSON.stringify(status)}\n\n`,
        );
        lastSent = current.stateSeq;
      };

      let busy = false;
      let again = false;
      const check = async (): Promise<void> => {
        if (closed) return;
        if (busy) {
          again = true;
          return;
        }
        busy = true;
        try {
          do {
            again = false;
            const current = await deps.db
              .selectFrom('renderJobs')
              .selectAll()
              .where('id', '=', job.id)
              .executeTakeFirst();
            if (!current) {
              finish();
              return;
            }
            if (current.stateSeq > lastSent) await send(current);
            if (isTerminalRenderJobState(current.state)) {
              finish();
              return;
            }
          } while (again && !closed);
        } catch (error) {
          request.log.warn({ err: error }, 'render event stream failed');
          finish();
        } finally {
          busy = false;
        }
      };

      raw.on('close', finish);
      unsubscribe = deps.events.subscribe(job.id, () => void check());
      heartbeat = setInterval(() => {
        if (closed) return;
        raw.write(': heartbeat\n\n');
        void check();
      }, heartbeatSeconds * 1000);
      heartbeat.unref?.();
      await check();
    },
  );
}
