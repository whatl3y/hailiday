import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JudgeResult } from '@hailiday/core';
import {
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
  heldKeys,
  runRenderJob,
  type PipelineDeps,
} from '@hailiday/server/pipeline';
import { newId } from '@hailiday/server/ids';
import type { VisionModel } from '@hailiday/server/providers';
import { keys } from '@hailiday/server/storage';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HALLWAY = path.join(
  here,
  '../../../packages/server/content/photos/samples/sample-apartment-hallway.jpg',
);

let harness: Harness;
let operator: TestClient;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator } = await operatorClient(harness));
});

afterAll(async () => {
  await harness?.close();
});

/** The pipeline with a judge that rejects every relight with a confident critical finding. */
function rejectingRelights(): PipelineDeps {
  const base = harness.pipeline;
  const inner = base.providers.fixtures.vision;
  const vision: VisionModel = {
    ...inner,
    async judge(input, options) {
      const result = await inner.judge(input, options);
      if (input.mode !== 'relight') return result;
      const finding = {
        code: 'structure_changed',
        confidence: 0.95,
        evidence: 'Test judge finding.',
      } as JudgeResult['critical'][number];
      return { ...result, result: { ...result.result, critical: [finding] } };
    },
  };
  return {
    ...base,
    providers: { ...base.providers, fixtures: { ...base.providers.fixtures, vision } },
  };
}

interface ReviewItem {
  renderJobId: string;
  lightingMode: string;
  sourceUrl: string | null;
  enhancedSourceUrl: string | null;
  enhancement: { outcome: string; enhancementId: string | null; reason: string | null } | null;
  candidateUrl: string | null;
  plan: { attemptNumber?: number; relightOf?: unknown } | null;
  judge: { decision: string; document: unknown } | null;
}

async function reviewItem(jobId: string): Promise<ReviewItem> {
  const response = await operator.get('/internal/v1/reviews?limit=100');
  expect(response.statusCode).toBe(200);
  const item = json<{ items: ReviewItem[] }>(response).items.find(
    (entry) => entry.renderJobId === jobId,
  );
  if (!item) throw new Error(`job ${jobId} is not in the review queue`);
  return item;
}

async function attemptsOf(jobId: string) {
  return harness.context.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

async function judgeDecisionOf(attemptId: string) {
  return (
    await harness.context.db
      .selectFrom('judgeResults')
      .select('decision')
      .where('attemptId', '=', attemptId)
      .orderBy('escalated', 'desc')
      .executeTakeFirstOrThrow()
  ).decision;
}

describe('the review queue lists the attempt whose candidate is held', () => {
  it('a bright job held with its decorated base after both relights were rejected', async () => {
    const deps = rejectingRelights();
    const { ownerId, projectId, source } = await createUploadSource(deps, {
      image: await readFile(HALLWAY),
      fileName: 'hallway.jpg',
      sceneType: 'apartment_entry',
      roomType: null,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      style: 'abundant',
      lightingMode: 'bright',
      reviewMode: 'pre_delivery',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => [a.attemptNo, a.fidelityMode, a.outcome])).toEqual([
      [1, 'composite_additive', 'succeeded'],
      [2, 'global_relight', 'qa_rejected'],
      [3, 'global_relight', 'qa_rejected'],
    ]);
    const baseAttempt = attempts[0] as (typeof attempts)[number];

    const item = await reviewItem(job.id);
    expect(item.lightingMode).toBe('bright');
    // The held file is the decorated base's, with the base's own plan and judge decision.
    expect(item.candidateUrl).toContain(heldKeys(job.id, baseAttempt.id).delivered);
    expect(item.plan).toMatchObject({ attemptNumber: 1 });
    expect(item.plan).not.toHaveProperty('relightOf');
    expect(item.judge?.decision).toBe(await judgeDecisionOf(baseAttempt.id));
    expect(item.judge?.decision).toBe('pass');
  });

  it('the companion that holds an evening job’s daylight base after its relight was rejected', async () => {
    const deps = rejectingRelights();
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const baseAttempt = (await attemptsOf(job.id))[0] as Awaited<
      ReturnType<typeof attemptsOf>
    >[number];
    const companion = await harness.context.db
      .selectFrom('renderJobs')
      .select('id')
      .where('idempotencyKey', '=', `relight-base:${job.id}`)
      .executeTakeFirstOrThrow();

    const item = await reviewItem(companion.id);
    expect(item.lightingMode).toBe('source');
    expect(item.candidateUrl).toContain(heldKeys(companion.id, baseAttempt.id).delivered);
    expect(item.plan).toMatchObject({ attemptNumber: 1 });
    expect(item.judge?.decision).toBe(await judgeDecisionOf(baseAttempt.id));
  });
});

describe('the review queue shows the enhanced street photo a job decorated', () => {
  /** A Street View job held for review with the given enhancement record. */
  async function heldJob(enhancement: Record<string, unknown> | null) {
    const deps = harness.pipeline;
    const created = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, { ...created, reviewMode: 'pre_delivery' });
    await harness.context.db
      .updateTable('renderJobs')
      .set({
        state: 'needs_review',
        enhancement: enhancement ? JSON.stringify(enhancement) : null,
      })
      .where('id', '=', job.id)
      .execute();
    return { ...created, job };
  }

  it('signs the accepted enhancement beside the frame, and nothing for a job on the frame', async () => {
    const enhancementId = newId();
    const record = { outcome: 'made', enhancementId, reason: null };
    const { source, ownerId, job } = await heldJob(record);
    const objectKey = keys.enhanced(ownerId, source.id, enhancementId);
    await harness.context.storage.put({
      bucket: 'private',
      key: objectKey,
      body: new Uint8Array([137, 80, 78, 71]),
      contentType: 'image/png',
      provenance: { sourceKind: 'system' },
    });
    await harness.context.db
      .insertInto('sourceEnhancements')
      .values({
        id: enhancementId,
        sourceAssetId: source.id,
        frameChecksumSha256: 'a'.repeat(64),
        compilerVersion: job.compilerVersion,
        workingWidth: 1024,
        workingHeight: 1024,
        status: 'accepted',
        objectKey,
        enhancedChecksumSha256: 'b'.repeat(64),
      })
      .execute();
    const item = await reviewItem(job.id);
    expect(item.enhancement).toEqual(record);
    expect(item.enhancedSourceUrl).toContain(objectKey);
    expect(item.enhancedSourceUrl).not.toBe(item.sourceUrl);

    const reused = await heldJob({ ...record, outcome: 'reused' });
    expect((await reviewItem(reused.job.id)).enhancedSourceUrl).toContain(objectKey);

    const rejected = await heldJob({ outcome: 'rejected', enhancementId, reason: 'qa' });
    const rejectedItem = await reviewItem(rejected.job.id);
    expect(rejectedItem.enhancedSourceUrl).toBeNull();
    expect(rejectedItem.enhancement).toMatchObject({ outcome: 'rejected', reason: 'qa' });

    const plain = await heldJob(null);
    const plainItem = await reviewItem(plain.job.id);
    expect(plainItem.enhancedSourceUrl).toBeNull();
    expect(plainItem.enhancement).toBeNull();

    for (const id of [job.id, reused.job.id, rejected.job.id, plain.job.id]) {
      await harness.context.db
        .updateTable('renderJobs')
        .set({ state: 'canceled', terminalAt: new Date() })
        .where('id', '=', id)
        .execute();
    }
  });
});
