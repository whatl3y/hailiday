import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeResult, NormalizedBox } from '@hailiday/core';
import type { Clock } from '../../clock/index.js';
import { testConfig } from '../../config/index.js';
import { ProviderError } from '../../providers/errors.js';
import type { CallOptions, JudgeInput, Providers, VisionModel } from '../../providers/types.js';
import { createQueue } from '../../queue/client.js';
import type { PipelineDeps } from '../context.js';
import { createJobHandlers } from '../handlers.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { sleep } from './errors.js';
import { readJob } from './transitions.js';

const SHOWCASE = 'ChIJfxLanternHillColonial01';
/**
 * The render job time limit of these tests (the queue's expiry follows it, as deployed). Long
 * enough that a busy machine still reaches the repair's judge before the limit.
 */
const LIMIT_S = 25;
/**
 * How long the worker takes from the queue handing it the job to the job's own start (database
 * reads on a slow connection): the job's deadline, counted from its start, falls that much after
 * the moment the queue started counting.
 */
const START_DELAY_MS = 1_000;

const plain = testConfig();
const config = { ...plain, queue: { ...plain.queue, renderMaxJobDurationSeconds: LIMIT_S } };
// A schema of its own, so no other suite's render jobs reach this worker.
const queue = createQueue(config, { role: 'worker', max: 4, schema: 'pgboss_render_deadline' });

let base: PipelineDeps & { close(): Promise<void> };
let current: PipelineDeps;
const runs: { jobId: string; retryCount: number; outcome: string }[] = [];

beforeAll(async () => {
  base = await createPipelineTestDeps({ config, pipeline: { repairBudgetMs: 1_000 } });
  current = base;
  await queue.start();
  await queue.ensureQueues();
  await queue.work(
    'render',
    async (job) => {
      await sleep(START_DELAY_MS);
      try {
        await createJobHandlers(current).render(job);
        runs.push({ jobId: job.data.renderJobId, retryCount: job.retryCount, outcome: 'returned' });
      } catch (error) {
        runs.push({
          jobId: job.data.renderJobId,
          retryCount: job.retryCount,
          outcome: `threw ${(error as Error).name}`,
        });
        throw error;
      }
    },
    { pollingIntervalSeconds: 0.5 },
  );
});

afterAll(async () => {
  await queue.stop({ graceful: false });
  await base.close();
});

async function untilEnded(jobId: string, timeoutMs: number) {
  const started = Date.now();
  for (;;) {
    const row = await readJob(base.db, jobId);
    if (row && ['succeeded', 'failed', 'rejected'].includes(row.state)) return row;
    if (Date.now() - started > timeoutMs) return row;
    await sleep(200);
  }
}

describe('the render job time limit under the queue', () => {
  it("the job's own deadline comes first: a kept doubt whose repair is still judged at the limit is delivered", async () => {
    const box: NormalizedBox = [0.45, 0.6, 0.47, 0.62];
    // Once the first attempt is judged the job's clock is set back two minutes, so its repair is
    // planned and sent with time for a whole edit; the job's own deadline still falls at the limit
    // in real time.
    let offset = 0;
    const clock: Clock = { now: () => new Date(Date.now() + offset) };
    const inner = base.providers.fixtures.vision;
    // The first attempt is doubted (a deliverable doubt, kept through its repair); the repair's
    // judge answers only when the run is aborted.
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        if (input.mode !== 'relight' && input.plan.attemptNumber === 2) {
          await new Promise<void>((resolve) => {
            if (options?.signal?.aborted) resolve();
            else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw new ProviderError('fixture', 'provider_error', 'aborted', { retryable: false });
        }
        const result = await inner.judge(input, options);
        if (input.plan.attemptNumber === 1 && !input.escalated) offset = -120_000;
        const doubt = {
          code: 'structure_changed',
          confidence: 0.5,
          evidence: 'Test judge doubt.',
          box,
        } as JudgeResult['critical'][number];
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, doubt] },
        };
      },
    };
    const providers: Providers = {
      ...base.providers,
      fixtures: { ...base.providers.fixtures, vision },
    };
    current = { ...base, providers, clock };
    const { ownerId, projectId, source } = await createStreetViewSource(base, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(base, { ownerId, projectId, source });
    await base.db
      .transaction()
      .execute((trx) => queue.enqueueRender(trx, { renderJobId: job.id, projectId, ownerId }));

    const ended = await untilEnded(job.id, 75_000);
    expect(ended).toMatchObject({ state: 'succeeded' });
    const attempts = await base.db
      .selectFrom('renderAttempts')
      .select(['attemptNo', 'outcome'])
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts).toEqual([
      { attemptNo: 1, outcome: 'succeeded' },
      { attemptNo: 2, outcome: 'qa_rejected' },
    ]);
    const assets = await base.db
      .selectFrom('renderAssets')
      .select(['jobId', 'lightingMode'])
      .where('projectId', '=', projectId)
      .execute();
    expect(assets).toEqual([{ jobId: job.id, lightingMode: 'source' }]);
    // One delivery of the queue job did it all, within the queue's expiry.
    await sleep(500);
    expect(runs.filter((run) => run.jobId === job.id)).toEqual([
      { jobId: job.id, retryCount: 0, outcome: 'returned' },
    ]);
  }, 90_000);
});
