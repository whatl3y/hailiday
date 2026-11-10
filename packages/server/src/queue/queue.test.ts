import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../config/index.js';
import { createTestDb } from '../db/testing.js';
import { uuidv7 } from '../ids/index.js';
import { EnqueueConflictError, createQueue } from './client.js';
import {
  RENDER_JOB_CHANNEL,
  createNotificationListener,
  notifyRenderJobChanged,
} from './notify.js';

const config = testConfig();
const db = createTestDb();
const queue = createQueue(config, { role: 'admin', max: 4 });

beforeAll(async () => {
  await queue.start();
  await queue.ensureQueues();
});

afterAll(async () => {
  await queue.stop({ graceful: false });
  await db.destroy();
});

const renderPayload = () => ({ renderJobId: uuidv7(), projectId: uuidv7(), ownerId: uuidv7() });

describe('transactional enqueue', () => {
  it('commits the job with the render job ID as the queue job ID', async () => {
    const payload = renderPayload();
    const id = await db.transaction().execute((trx) => queue.enqueueRender(trx, payload));
    expect(id).toBe(payload.renderJobId);
    const job = await queue.getJob('render', payload.renderJobId);
    expect(job?.state).toBe('created');
    expect(job?.singletonKey).toBe(payload.projectId);
    expect(job?.data).toEqual({ ...payload, correlationId: null });
    await queue.cancel('render', payload.renderJobId);
  });

  it('removes the job when the transaction rolls back', async () => {
    const payload = renderPayload();
    await expect(
      db.transaction().execute(async (trx) => {
        await queue.enqueueRender(trx, payload);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await queue.getJob('render', payload.renderJobId)).toBeNull();
  });

  it('admits one active render per project and allows a new one after cancel in the same transaction', async () => {
    const first = renderPayload();
    await db.transaction().execute((trx) => queue.enqueueRender(trx, first));
    const second = { ...renderPayload(), projectId: first.projectId };
    await expect(
      db.transaction().execute((trx) => queue.enqueueRender(trx, second)),
    ).rejects.toBeInstanceOf(EnqueueConflictError);
    await db.transaction().execute(async (trx) => {
      await queue.cancel('render', first.renderJobId, { trx });
      await queue.enqueueRender(trx, second);
    });
    expect((await queue.getJob('render', first.renderJobId))?.state).toBe('cancelled');
    expect((await queue.getJob('render', second.renderJobId))?.state).toBe('created');
    await queue.cancel('render', second.renderJobId);
  });

  it('validates payloads before sending', async () => {
    await expect(
      queue.send('upload_validate', { sourceAssetId: 'not-a-uuid', ownerId: uuidv7() }),
    ).rejects.toThrow();
  });
});

describe('worker and NOTIFY', () => {
  it('delivers a sent job to a worker with a parsed payload', async () => {
    const payload = { sourceAssetId: uuidv7(), ownerId: uuidv7() };
    const received = new Promise<unknown>((resolve) => {
      void queue.work('upload_screen', async (job) => resolve(job.data), {
        pollingIntervalSeconds: 0.5,
      });
    });
    const id = await queue.send('upload_screen', payload);
    expect(id).toBeTruthy();
    expect(await received).toEqual({ ...payload, correlationId: null });
    await queue.offWork('upload_screen');
  });

  it('publishes render_job_changed only after commit', async () => {
    const jobId = uuidv7();
    const seen: string[] = [];
    const listener = createNotificationListener({
      connectionString: config.database.url,
      channels: [RENDER_JOB_CHANNEL],
      onNotification: (_channel, payload) => {
        if (payload) seen.push(payload);
      },
    });
    await listener.start();
    try {
      await db
        .transaction()
        .execute(async (trx) => {
          await notifyRenderJobChanged(trx, { jobId, seq: 1 });
          throw new Error('rollback');
        })
        .catch(() => undefined);
      await db.transaction().execute((trx) => notifyRenderJobChanged(trx, { jobId, seq: 2 }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      const mine = seen.map((payload) => JSON.parse(payload)).filter((p) => p.jobId === jobId);
      expect(mine).toEqual([{ jobId, seq: 2 }]);
    } finally {
      await listener.stop();
    }
  });
});
