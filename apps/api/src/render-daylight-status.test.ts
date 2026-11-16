import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderStatusSchema, type JudgeResult, type RenderStatus } from '@hailiday/core';
import { createRenderJobRecord, runRenderJob, type PipelineDeps } from '@hailiday/server/pipeline';
import { createHarness, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

type Vision = PipelineDeps['providers']['fixtures']['vision'];
type JudgeInput = Parameters<Vision['judge']>[0];
type Finding = { code: JudgeResult['critical'][number]['code']; box?: boolean };

let harness: Harness;
let client: TestClient;
let looks = 0;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

/**
 * The harness pipeline with the fixture judge adding a confident critical finding wherever
 * `findingOf` gives one (boxed on a small spot inside the plan's first placement when `box`).
 */
function judgedBy(findingOf: (input: JudgeInput) => Finding | null): PipelineDeps {
  const fixtures = harness.pipeline.providers.fixtures;
  const vision: Vision = {
    ...fixtures.vision,
    async judge(input, options) {
      const result = await fixtures.vision.judge(input, options);
      const finding = findingOf(input);
      if (!finding) return result;
      const region = input.plan.placements[0]?.region ?? [0.4, 0.4, 0.6, 0.6];
      const cx = (region[0] + region[2]) / 2;
      const cy = (region[1] + region[3]) / 2;
      const entry = {
        code: finding.code,
        confidence: 0.95,
        evidence: 'Test judge finding.',
        ...(finding.box ? { box: [cx - 0.01, cy - 0.01, cx + 0.01, cy + 0.01] } : {}),
      } as JudgeResult['critical'][number];
      return {
        ...result,
        result: { ...result.result, critical: [...result.result.critical, entry] },
      };
    },
  };
  return {
    ...harness.pipeline,
    providers: {
      ...harness.pipeline.providers,
      fixtures: { ...fixtures, vision },
    },
  };
}

/** Runs a look of a fresh project of the client's owner to its end; returns its status. */
async function statusAfter(
  deps: PipelineDeps,
  o: { lightingMode: 'source' | 'evening'; reviewMode?: 'pre_delivery' },
): Promise<{ status: RenderStatus; jobId: string }> {
  // Each look has an owner of its own, so the owner's paid-attempt cap never closes one.
  looks += 1;
  client = harness.client({ remoteAddress: `10.78.0.${looks}` });
  await client.createSession();
  const adopted = await adoptStreetViewProject(harness, client);
  const source = await harness.context.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', adopted.sourceAssetId)
    .executeTakeFirstOrThrow();
  const job = await createRenderJobRecord(deps, {
    ownerId: source.ownerId,
    projectId: adopted.projectId,
    source,
    lightingMode: o.lightingMode,
    ...(o.reviewMode ? { reviewMode: o.reviewMode } : {}),
  });
  await runRenderJob(deps, { renderJobId: job.id });
  const ended = await harness.context.db
    .selectFrom('renderJobs')
    .select(['state', 'failureKind', 'failureDetail'])
    .where('id', '=', job.id)
    .executeTakeFirstOrThrow();
  expect(ended.state, JSON.stringify(ended)).not.toBe('failed');
  const response = await client.get(`/v1/renders/${job.id}`);
  expect(response.statusCode).toBe(200);
  return { status: RenderStatusSchema.parse(response.json()), jobId: job.id };
}

const relightRejected = () =>
  judgedBy((input) => (input.mode === 'relight' ? { code: 'structure_changed' } : null));

describe('the render status of a rejected evening job', () => {
  it('carries the daylight look published from its own base', async () => {
    const { status, jobId } = await statusAfter(relightRejected(), { lightingMode: 'evening' });
    expect(status).toMatchObject({
      state: 'rejected',
      rejectionReason: 'qa_critical',
      failureCodes: ['structure_changed'],
    });
    const companion = await harness.context.db
      .selectFrom('renderJobs')
      .select(['id', 'renderAssetId'])
      .where('idempotencyKey', '=', `relight-base:${jobId}`)
      .executeTakeFirstOrThrow();
    expect(status.variant).toMatchObject({
      renderAssetId: companion.renderAssetId,
      renderJobId: companion.id,
      lightingMode: 'source',
    });
    expect(status.variant?.imageUrl).toBeTruthy();
    expect(status.variant?.placements.length).toBeGreaterThan(0);
  });

  it('carries none when its base is held for review', async () => {
    const { status } = await statusAfter(relightRejected(), {
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    expect(status.state).toBe('rejected');
    expect(status.variant).toBeNull();
  });

  it('carries none when it has no base', async () => {
    const decorateRejected = judgedBy((input) =>
      input.mode === 'relight' ? null : { code: 'structure_changed' },
    );
    const { status } = await statusAfter(decorateRejected, { lightingMode: 'evening' });
    expect(status).toMatchObject({ state: 'rejected', failureCodes: ['structure_changed'] });
    expect(status.variant).toBeNull();
  });
});

describe('a plain look delivered with the objected spots put back', () => {
  it('answers succeeded with its variant', async () => {
    const boxed = judgedBy((input) =>
      input.mode === 'relight' ? null : { code: 'structure_changed', box: true },
    );
    const { status, jobId } = await statusAfter(boxed, { lightingMode: 'source' });
    expect(status).toMatchObject({ state: 'succeeded', failureCodes: [] });
    expect(status.variant).toMatchObject({ renderJobId: jobId, lightingMode: 'source' });
    const attempts = await harness.context.db
      .selectFrom('renderAttempts')
      .select(['attemptNo', 'outcome', 'compositeMask'])
      .where('jobId', '=', jobId)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => a.outcome)).toEqual(['qa_rejected', 'succeeded']);
    expect(attempts[1]?.compositeMask).toMatchObject({
      restored: { kind: 'objected', codes: ['structure_changed'] },
    });
  });
});
