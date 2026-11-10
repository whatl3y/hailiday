import { sql } from '@holiday/server/db';
import { HOUR_MS, addMs } from '@holiday/server/clock';
import type { RenderJob } from '@holiday/server/db';
import { atCapacity } from '@holiday/server/errors';
import type { ApiDeps } from '../deps.js';

/** Fallback job duration for wait estimates before any job has finished (seconds). */
const DEFAULT_P50_SECONDS = 30;

/** Render jobs waiting in `queued`. */
export async function queuedRenderCount(deps: Pick<ApiDeps, 'db'>): Promise<number> {
  const row = await deps.db
    .selectFrom('renderJobs')
    .select(sql<number>`count(*)`.as('count'))
    .where('state', '=', 'queued')
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Median duration of recently succeeded jobs, in seconds (last hour). */
export async function observedP50Seconds(deps: Pick<ApiDeps, 'db' | 'clock'>): Promise<number> {
  const since = addMs(deps.clock.now(), -HOUR_MS);
  const row = await deps.db
    .selectFrom('renderJobs')
    .select(
      sql<
        number | null
      >`percentile_cont(0.5) within group (order by extract(epoch from (succeeded_at - started_at)))`.as(
        'p50',
      ),
    )
    .where('state', '=', 'succeeded')
    .where('succeededAt', '>', since)
    .where('startedAt', 'is not', null)
    .executeTakeFirst();
  const p50 = row?.p50 === null || row?.p50 === undefined ? null : Number(row.p50);
  return p50 && Number.isFinite(p50) && p50 > 0 ? p50 : DEFAULT_P50_SECONDS;
}

/**
 * Render lanes: jobs the workers run at once, the smaller of the worker setting and the routed
 * image-edit provider's concurrency (the same bound the render consumer applies).
 */
export async function renderLanes(deps: Pick<ApiDeps, 'config' | 'settings'>): Promise<number> {
  const provider = await deps.settings.providerConcurrency(deps.config.providers.imageEditor);
  return Math.max(1, Math.min(deps.config.queue.renderWorkerConcurrency, provider));
}

/** `Retry-After` for a refusal: the predicted wait rounded up to 30 s, between 30 s and 300 s. */
export function retryAfterFor(estimatedWaitSeconds: number): number {
  return Math.min(300, Math.max(30, Math.ceil(estimatedWaitSeconds / 30) * 30));
}

/**
 * The admission decision (economics, admission-control values): refused above the queue depth
 * cap, or when the predicted wait (queue position × p50 job duration ÷ render lanes) exceeds the
 * maximum wait. Returns the predicted wait and, for a refusal, its `Retry-After`.
 */
export function admissionDecision(input: {
  queued: number;
  p50Seconds: number;
  lanes: number;
  maxQueueDepth: number;
  maxWaitSeconds: number;
}): { estimatedWait: number; retryAfter: number | null } {
  const estimatedWait = Math.ceil(
    ((input.queued + 1) * input.p50Seconds) / Math.max(1, input.lanes),
  );
  const refused = input.queued >= input.maxQueueDepth || estimatedWait > input.maxWaitSeconds;
  return { estimatedWait, retryAfter: refused ? retryAfterFor(estimatedWait) : null };
}

/**
 * Admission control at `POST /v1/renders`: a refused request gets `AT_CAPACITY` with
 * `Retry-After` (`admissionDecision`); no reservation is made.
 */
export async function admitRender(deps: Pick<ApiDeps, 'db' | 'clock' | 'settings' | 'config'>) {
  const queued = await queuedRenderCount(deps);
  const decision = admissionDecision({
    queued,
    p50Seconds: await observedP50Seconds(deps),
    lanes: await renderLanes(deps),
    maxQueueDepth: await deps.settings.get('admission.max_queue_depth'),
    maxWaitSeconds: await deps.settings.get('admission.max_wait_s'),
  });
  if (decision.retryAfter !== null) throw atCapacity(decision.retryAfter, queued);
}

/**
 * The queue position of a queued job (1-based), reported only while admission control is engaged:
 * when more jobs wait than the workers run at once.
 */
export async function queuePositionOf(
  deps: Pick<ApiDeps, 'db' | 'config' | 'settings'>,
  job: Pick<RenderJob, 'id' | 'state' | 'requestedAt'>,
): Promise<number | null> {
  if (job.state !== 'queued') return null;
  const total = await queuedRenderCount(deps);
  if (total <= (await renderLanes(deps))) return null;
  const ahead = await deps.db
    .selectFrom('renderJobs')
    .select(sql<number>`count(*)`.as('count'))
    .where('state', '=', 'queued')
    .where('requestedAt', '<', job.requestedAt)
    .executeTakeFirstOrThrow();
  return Number(ahead.count) + 1;
}
