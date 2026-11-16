import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RENDER_JOB_CHANNEL, createNotificationListener } from '../../queue/notify.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { readJob, setJobSubStage, transitionJob } from './transitions.js';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

async function queuedJob() {
  const created = await createStreetViewSource(base, {
    placeId: 'ChIJfxLanternHillColonial01',
  });
  return createRenderJobRecord(base, created);
}

describe('the sub-stage of a render job', () => {
  it('a transition clears the sub-stage unless its patch sets one', async () => {
    const job = await queuedJob();
    const clock = base.clock;
    await transitionJob(base.db, { jobId: job.id, from: 'queued', to: 'preparing', clock });
    await transitionJob(base.db, { jobId: job.id, from: 'preparing', to: 'analyzing', clock });
    expect(
      await setJobSubStage(base.db, { jobId: job.id, state: 'analyzing', subStage: 'enhancing' }),
    ).toMatchObject({ subStage: 'enhancing' });
    const planning = await transitionJob(base.db, {
      jobId: job.id,
      from: 'analyzing',
      to: 'planning',
      clock,
    });
    expect(planning.subStage).toBeNull();
    const rendering = await transitionJob(base.db, {
      jobId: job.id,
      from: 'planning',
      to: 'rendering',
      patch: { subStage: 'relight' },
      clock,
    });
    expect(rendering.subStage).toBe('relight');
    const checking = await transitionJob(base.db, {
      jobId: job.id,
      from: 'rendering',
      to: 'checking',
      clock,
    });
    expect(checking.subStage).toBeNull();
  });

  it('setJobSubStage increments the sequence and notifies; nothing in another state or for the same value', async () => {
    const job = await queuedJob();
    const clock = base.clock;
    await transitionJob(base.db, { jobId: job.id, from: 'queued', to: 'preparing', clock });
    const analyzing = await transitionJob(base.db, {
      jobId: job.id,
      from: 'preparing',
      to: 'analyzing',
      clock,
    });
    const seen: string[] = [];
    const listener = createNotificationListener({
      connectionString: base.config.database.url,
      channels: [RENDER_JOB_CHANNEL],
      onNotification: (_channel, payload) => {
        if (payload?.includes(job.id)) seen.push(payload);
      },
    });
    await listener.start();
    try {
      const set = await setJobSubStage(base.db, {
        jobId: job.id,
        state: 'analyzing',
        subStage: 'enhancing',
      });
      expect(set).toMatchObject({ subStage: 'enhancing', stateSeq: analyzing.stateSeq + 1 });
      // The same value, or a job in another state: nothing changes and nothing is sent.
      expect(
        await setJobSubStage(base.db, { jobId: job.id, state: 'analyzing', subStage: 'enhancing' }),
      ).toBeNull();
      expect(
        await setJobSubStage(base.db, { jobId: job.id, state: 'planning', subStage: 'relight' }),
      ).toBeNull();
      expect(
        await setJobSubStage(base.db, { jobId: job.id, state: 'analyzing', subStage: null }),
      ).toMatchObject({ subStage: null, stateSeq: analyzing.stateSeq + 2 });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await listener.stop();
    }
    expect(seen.map((payload) => JSON.parse(payload).seq)).toEqual([
      analyzing.stateSeq + 1,
      analyzing.stateSeq + 2,
    ]);
    expect((await readJob(base.db, job.id))?.stateSeq).toBe(analyzing.stateSeq + 2);
  });
});
