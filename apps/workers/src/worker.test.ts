import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '@hailiday/server/config';
import { createLogger } from '@hailiday/server/logger';
import { createStorage } from '@hailiday/server/storage';
import {
  createRenderJobRecord,
  createStreetViewSource,
  seedPipelineTestContent,
} from '@hailiday/server/pipeline';
import { QUEUE_NAMES } from '@hailiday/server/queue';
import { createSilentLogger } from '@hailiday/server/logger';
import {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  startWorker,
  stopWorkerContext,
  type WorkerHandle,
} from './worker.js';
import { TEST_BUCKETS } from './test-buckets.js';

const config = testConfig({ ...TEST_BUCKETS });

let worker: WorkerHandle;
const logLines: string[] = [];

beforeAll(async () => {
  const storage = createStorage(config);
  for (const bucket of [config.storage.privateBucket, config.storage.publicBucket]) {
    await storage.ensureBucket(bucket);
  }
  storage.destroy();
  worker = await startWorker({
    config,
    logger: createLogger({
      level: 'info',
      destination: new Writable({
        write(chunk, _encoding, callback) {
          logLines.push(String(chunk));
          callback();
        },
      }),
    }),
    pipeline: { retryDelayMs: () => 20, statusPollMs: 20 },
    pollingIntervalSeconds: 0.5,
    shutdownTimeoutMs: 5000,
  });
  await seedPipelineTestContent(worker.deps.db, config);
});

afterAll(async () => {
  await worker?.stop('test');
});

describe('worker process', () => {
  it("logs every provider's resolved mode, the image editor and the models when ready", () => {
    const ready = logLines
      .map(
        (line) =>
          JSON.parse(line) as {
            msg?: string;
            providerModes?: unknown;
            imageEditor?: unknown;
            vision?: unknown;
          },
      )
      .find((entry) => entry.msg === 'workers ready');
    expect(ready?.providerModes).toEqual({
      addressProvider: 'fixture',
      streetViewProvider: 'fixture',
      imageEditorProvider: 'fixture',
      visionProvider: 'fixture',
      safetyProvider: 'fixture',
      emailProvider: 'fixture',
      commercePrograms: 'fixture',
    });
    expect(ready?.imageEditor).toMatchObject({ provider: 'fixture', model: null });
    expect(ready?.vision).toEqual({ provider: 'fixture', model: null });
  });

  it('registers a consumer for every queue with its concurrency', () => {
    expect(Object.keys(worker.concurrency).sort()).toEqual([...QUEUE_NAMES].sort());
    expect(worker.concurrency.render).toBe(Math.min(config.queue.renderWorkerConcurrency, 6));
    for (const value of Object.values(worker.concurrency)) expect(value).toBeGreaterThanOrEqual(1);
  });

  it('consumes a render enqueued in the render transaction and drives it to succeeded', async () => {
    const { deps } = worker;
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    await deps.db.transaction().execute(async (trx) => {
      await worker.context.queue.enqueueRender(trx, {
        renderJobId: job.id,
        projectId,
        ownerId,
      });
    });
    const started = Date.now();
    let state = job.state as string;
    while (Date.now() - started < 60_000) {
      const row = await deps.db
        .selectFrom('renderJobs')
        .select('state')
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow();
      state = row.state;
      if (['succeeded', 'failed', 'rejected'].includes(state)) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(state).toBe('succeeded');
    const asset = await deps.db
      .selectFrom('renderAssets')
      .select('id')
      .where('jobId', '=', job.id)
      .executeTakeFirst();
    expect(asset).toBeDefined();
  });
});

describe('graceful stop', () => {
  it('waits for running jobs well inside the 30 s SIGKILL grace, then closes connections', async () => {
    const calls: string[] = [];
    let timeoutMs: number | undefined;
    await stopWorkerContext(
      {
        queue: {
          async stop(options) {
            calls.push('queue.stop');
            timeoutMs = options?.timeoutMs;
          },
        },
        async close() {
          calls.push('close');
        },
      },
      { logger: createSilentLogger(), reason: 'SIGTERM' },
    );
    expect(calls).toEqual(['queue.stop', 'close']);
    expect(timeoutMs).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
  });

  it('closes connections even when the graceful wait fails', async () => {
    let closed = false;
    await stopWorkerContext(
      {
        queue: {
          async stop() {
            throw new Error('timed out');
          },
        },
        async close() {
          closed = true;
        },
      },
      { logger: createSilentLogger(), reason: 'SIGTERM', timeoutMs: 10 },
    );
    expect(closed).toBe(true);
  });
});
