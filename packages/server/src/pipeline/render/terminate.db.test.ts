import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toJson } from '../../db/client.js';
import { newId } from '../../ids/index.js';
import { reservationBalance } from '../../ledger/index.js';
import { attemptQuota } from '../../limits/index.js';
import type { PipelineDeps } from '../context.js';
import { createPipelineTestDeps, createRenderJobRecord, createUploadSource } from '../testing.js';
import { terminateRenderJob } from './terminate.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/**
 * A job in `rendering` whose first attempt row was written (with its edit reservation) but never
 * dispatched, as a worker crash between the attempt insert and the send leaves it.
 */
async function jobWithUnsentAttempt(sent: boolean) {
  const { ownerId, projectId, source } = await createUploadSource(deps, {
    image: Buffer.from('not-an-image'),
  });
  const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
  await deps.db
    .updateTable('renderJobs')
    .set({ state: 'rendering', startedAt: new Date() })
    .where('id', '=', job.id)
    .execute();
  const analysisId = newId();
  await deps.db
    .insertInto('sceneAnalyses')
    .values({
      id: analysisId,
      sourceAssetId: source.id,
      analysisModel: 'terminate-test',
      analysisPromptVersion: 'x',
      schemaVersion: '1.0',
      workingWidth: 1024,
      workingHeight: 1024,
      workingChecksumSha256: newId(),
      document: toJson({}),
    })
    .execute();
  const kit = await deps.db.selectFrom('styleKits').select('id').executeTakeFirstOrThrow();
  const planId = newId();
  await deps.db
    .insertInto('decorationPlans')
    .values({
      id: planId,
      jobId: job.id,
      attemptNo: 1,
      sceneAnalysisId: analysisId,
      packVersion: '1.0.0',
      styleKitId: kit.id,
      compilerVersion: 'x',
      document: toJson({}),
      validatorResult: toJson({}),
    })
    .execute();
  const reservation = await deps.db
    .selectFrom('usageLedger')
    .select('id')
    .where('jobId', '=', job.id)
    .where('kind', '=', 'reservation')
    .where('sku', '=', 'image_edit_attempt')
    .orderBy('id')
    .executeTakeFirstOrThrow();
  const attemptId = newId();
  await deps.db
    .insertInto('renderAttempts')
    .values({
      id: attemptId,
      jobId: job.id,
      attemptNo: 1,
      isRepair: false,
      decorationPlanId: planId,
      sceneAnalysisId: analysisId,
      permissionEvaluationId: job.permissionEvaluationId,
      provider: 'fixture',
      modelSnapshot: 'x',
      promptVersion: 'x',
      compilerVersion: 'x',
      settingsHash: 'x',
      providerMode: 'fixture',
      providerOperationId: sent ? `fixture:${attemptId}` : null,
      requestSentAt: sent ? new Date() : null,
      sourceChecksumSha256: 'x',
      workingChecksumSha256: 'x',
      reservationEntryId: reservation.id,
      outcome: 'pending',
    })
    .execute();
  return { ownerId, jobId: job.id, attemptId, reservationId: reservation.id };
}

describe('terminating a job with a pending attempt', () => {
  it('cancels an attempt that was never sent and releases its reservation', async () => {
    const made = await jobWithUnsentAttempt(false);
    const ended = await terminateRenderJob(deps, { jobId: made.jobId, to: 'canceled' });
    expect(ended?.state).toBe('canceled');
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .select(['outcome', 'completedAt'])
      .where('id', '=', made.attemptId)
      .executeTakeFirstOrThrow();
    expect(attempt.outcome).toBe('canceled');
    expect(attempt.completedAt).not.toBeNull();
    expect((await reservationBalance(deps.db, made.reservationId)).openMicros).toBe(0);
    const quota = await attemptQuota(deps.db, deps.settings, {
      ownerId: made.ownerId,
      now: new Date(Date.now() + 1000),
    });
    expect(quota.used).toBe(0);
  });

  it('marks a sent attempt unknown and keeps its reservation open', async () => {
    const made = await jobWithUnsentAttempt(true);
    await terminateRenderJob(deps, { jobId: made.jobId, to: 'superseded' });
    const attempt = await deps.db
      .selectFrom('renderAttempts')
      .select('outcome')
      .where('id', '=', made.attemptId)
      .executeTakeFirstOrThrow();
    expect(attempt.outcome).toBe('unknown');
    expect((await reservationBalance(deps.db, made.reservationId)).openMicros).toBeGreaterThan(0);
    const quota = await attemptQuota(deps.db, deps.settings, {
      ownerId: made.ownerId,
      now: new Date(Date.now() + 1000),
    });
    expect(quota.used).toBe(1);
  });
});
