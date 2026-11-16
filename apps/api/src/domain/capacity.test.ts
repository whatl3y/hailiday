import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, factories, toJson, type Db } from '@hailiday/server/db';
import {
  DEFAULT_P50_SECONDS,
  admissionDecision,
  observedP50Seconds,
  renderLanes,
  retryAfterFor,
} from './capacity.js';
import type { ApiDeps } from '../deps.js';

/** A database whose median query answers `p50` (null when no job succeeded in the last hour). */
function medianDeps(p50: number | null) {
  const query: Record<string, unknown> = {};
  const chain = new Proxy(query, {
    get: (_target, property) =>
      property === 'executeTakeFirst' ? async () => ({ p50 }) : () => chain,
  });
  return {
    db: { selectFrom: () => chain },
    clock: { now: () => new Date('2026-11-10T12:00:00Z') },
  } as unknown as Pick<ApiDeps, 'db' | 'clock'>;
}

function lanesDeps(workers: number, provider: number) {
  return {
    config: { queue: { renderWorkerConcurrency: workers }, providers: { imageEditor: 'openai' } },
    settings: {
      providerConcurrency: async (name: string) => (name === 'openai' ? provider : 99),
    },
  } as unknown as Pick<ApiDeps, 'config' | 'settings'>;
}

describe('admission control', () => {
  it('runs as many lanes as the smaller of the worker and provider concurrency', async () => {
    expect(await renderLanes(lanesDeps(6, 2))).toBe(2);
    expect(await renderLanes(lanesDeps(2, 6))).toBe(2);
    expect(await renderLanes(lanesDeps(0, 0))).toBe(1);
  });

  it('refuses when the provider concurrency makes the predicted wait too long', async () => {
    const lanes = await renderLanes(lanesDeps(6, 2));
    const decision = admissionDecision({
      queued: 30,
      p50Seconds: 45,
      lanes,
      maxQueueDepth: 36,
      maxWaitSeconds: 240,
    });
    expect(decision.estimatedWait).toBe(698);
    expect(decision.retryAfter).toBe(300);
  });

  it('admits a short queue', () => {
    expect(
      admissionDecision({
        queued: 3,
        p50Seconds: 45,
        lanes: 2,
        maxQueueDepth: 36,
        maxWaitSeconds: 240,
      }),
    ).toEqual({ estimatedWait: 90, retryAfter: null });
  });

  it('sets Retry-After to the predicted wait rounded up to 30 s, within 30 to 300 s', () => {
    expect(retryAfterFor(70)).toBe(90);
    expect(retryAfterFor(5)).toBe(30);
    expect(retryAfterFor(90)).toBe(90);
    expect(retryAfterFor(4_000)).toBe(300);
    // A full queue refuses even with a short wait.
    expect(
      admissionDecision({
        queued: 36,
        p50Seconds: 1,
        lanes: 6,
        maxQueueDepth: 36,
        maxWaitSeconds: 240,
      }).retryAfter,
    ).toBe(30);
  });

  it('assumes the measured two-edit look before any job has succeeded in the last hour', async () => {
    expect(DEFAULT_P50_SECONDS).toBe(80);
    expect(await observedP50Seconds(medianDeps(null))).toBe(80);
    expect(await observedP50Seconds(medianDeps(0))).toBe(80);
    expect(await observedP50Seconds(medianDeps(91.5))).toBe(91.5);
    // A cold service with two lanes and the 240 s maximum wait admits five waiting jobs, not 15.
    const cold = (queued: number) =>
      admissionDecision({
        queued,
        p50Seconds: DEFAULT_P50_SECONDS,
        lanes: 2,
        maxQueueDepth: 36,
        maxWaitSeconds: 240,
      });
    expect(cold(5)).toEqual({ estimatedWait: 240, retryAfter: null });
    expect(cold(6)).toEqual({ estimatedWait: 280, retryAfter: 300 });
  });
});

describe('the measured median job duration', () => {
  let db: Db;

  beforeAll(() => {
    db = createTestDb({ max: 2 });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  /** A succeeded job started at `startedAt` whose timestamps are `seconds` after it. */
  async function succeededJob(input: {
    startedAt: Date;
    qaPassedAfter: number | null;
    succeededAfter: number;
    relightBaseOf?: boolean;
  }) {
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const at = (seconds: number) => new Date(input.startedAt.getTime() + seconds * 1000);
    const job = await factories.renderJob(db, {
      ownerId: owner.id,
      projectId: project.id,
      sourceAssetId: source.id,
      state: 'succeeded',
      requestedAt: input.startedAt,
      succeededAt: at(input.succeededAfter),
    });
    await db
      .updateTable('renderJobs')
      .set({
        startedAt: input.startedAt,
        qaPassedAt: input.qaPassedAfter === null ? null : at(input.qaPassedAfter),
        ...(input.relightBaseOf
          ? {
              inputSnapshot: toJson({
                relightBaseOf: { jobId: job.id, attemptId: job.id },
              }),
            }
          : {}),
      })
      .where('id', '=', job.id)
      .execute();
  }

  it("counts work up to the passed checks, not a reviewer's wait, and leaves out companions", async () => {
    // An hour of its own, far from the rows other tests write, so only these jobs are measured.
    const startedAt = new Date('2099-01-01T00:00:00Z');
    const deps = {
      db,
      clock: { now: () => new Date(startedAt.getTime() + 30 * 60_000) },
    } as unknown as Pick<ApiDeps, 'db' | 'clock'>;

    // Approved from pre-delivery review 20 minutes after it passed its checks at 80 s.
    await succeededJob({ startedAt, qaPassedAfter: 80, succeededAfter: 20 * 60 });
    expect(await observedP50Seconds(deps)).toBe(80);

    // The daylight companion of an evening look (40 s) does not pull the median down.
    await succeededJob({ startedAt, qaPassedAfter: 40, succeededAfter: 40, relightBaseOf: true });
    expect(await observedP50Seconds(deps)).toBe(80);
  });
});
