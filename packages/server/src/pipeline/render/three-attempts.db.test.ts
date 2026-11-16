import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type {
  CompiledRequest,
  FidelityMode,
  JudgeResult,
  LightingMode,
  NormalizedBox,
} from '@hailiday/core';
import type { Clock } from '../../clock/index.js';
import type { RenderJob } from '../../db/schema.js';
import { dailySaltedHash, newId } from '../../ids/index.js';
import { releaseJobReservations, renderReservationLines, reserve } from '../../ledger/index.js';
import { recordAllowanceResidue } from '../../limits/index.js';
import { ProviderError } from '../../providers/errors.js';
import type {
  CallOptions,
  ImageEditor,
  JudgeInput,
  Providers,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { RELIGHT_REPAIR_KEEP } from '../compile/compiler.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  createUploadSource,
} from '../testing.js';
import { keys } from '../../storage/keys.js';
import { runRenderJob } from './job.js';
import { heldKeys } from './publish.js';
import { approveReview, rejectReview } from './review.js';
import { readJob } from './transitions.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const HALLWAY = path.join(here, '../../../content/photos/samples/sample-apartment-hallway.jpg');
const SHOWCASE = 'ChIJfxLanternHillColonial01';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/** A clock that runs with the system clock plus an offset the test can move forward. */
function steppingClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms: number) {
      offset += ms;
    },
  };
}

/**
 * The shared dependencies with the fixture editor, vision model, clock, some pipeline options,
 * the settings or the storage replaced.
 */
function depsWith(o: {
  imageEditor?: ImageEditor;
  vision?: VisionModel;
  clock?: Clock;
  options?: PipelineDeps['options'];
  settings?: PipelineDeps['settings'];
  storage?: PipelineDeps['storage'];
}) {
  const providers: Providers = {
    ...base.providers,
    fixtures: {
      ...base.providers.fixtures,
      ...(o.imageEditor ? { imageEditor: o.imageEditor } : {}),
      ...(o.vision ? { vision: o.vision } : {}),
    },
  };
  return {
    ...base,
    providers,
    ...(o.clock ? { clock: o.clock } : {}),
    ...(o.options ? { options: { ...base.options, ...o.options } } : {}),
    ...(o.settings ? { settings: o.settings } : {}),
    ...(o.storage ? { storage: o.storage } : {}),
  } as PipelineDeps;
}

/** Wraps the fixture editor, recording every request. */
function recordingEditor() {
  const inner = base.providers.fixtures.imageEditor;
  const requests: CompiledRequest[] = [];
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      requests.push(request);
      return inner.edit(request, input, options);
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return { editor, requests, kinds: () => requests.map((r) => r.kind ?? 'decorate') };
}

/** Which judge calls reject, by judge mode and the plan's attempt number. */
type RejectRule = (input: JudgeInput) => 'structure_changed' | 'implausible_decor' | null;

/**
 * The fixture vision model with a finding added where `rule` says so: confident, or with the
 * confidence `confidenceOf` gives (between the uncertain and critical thresholds: uncertain).
 */
function judgingVision(
  rule: RejectRule,
  onJudge?: (input: JudgeInput) => void,
  confidenceOf: (input: JudgeInput) => number = () => 0.95,
) {
  const inner = base.providers.fixtures.vision;
  const judged: JudgeInput[] = [];
  const vision: VisionModel = {
    ...inner,
    async judge(input: JudgeInput, options?: CallOptions): Promise<VisionCallResult<JudgeResult>> {
      judged.push(input);
      onJudge?.(input);
      const result = await inner.judge(input, options);
      const code = rule(input);
      if (!code) return result;
      const entry = { code, confidence: confidenceOf(input), evidence: 'Test judge finding.' };
      return {
        ...result,
        result: {
          ...result.result,
          ...(code === 'structure_changed'
            ? { critical: [...result.result.critical, entry as JudgeResult['critical'][number]] }
            : { major: [...result.result.major, entry as JudgeResult['major'][number]] }),
        },
      };
    },
  };
  return { vision, judged };
}

const relightAttempt = (attemptNo: number, code: 'structure_changed' | 'implausible_decor') =>
  ((input) =>
    input.mode === 'relight' && input.plan.attemptNumber === attemptNo
      ? code
      : null) satisfies RejectRule;
const firstBase: RejectRule = (input) =>
  input.mode !== 'relight' && input.plan.attemptNumber === 1 ? 'implausible_decor' : null;

/** Reservation lines the test factory wrote and `reserveAsTheApi` released, per job. */
const factoryLines = new Map<string, Set<string>>();

/**
 * The job's reservation as `POST /v1/renders` writes it for its lighting mode (the test factory
 * reserves the daylight shape): the factory's lines are released and the job's own reserved.
 */
async function reserveAsTheApi(job: RenderJob, streetViewFetch: boolean): Promise<void> {
  const released = await releaseJobReservations(base.db, job.id, { clock: base.clock });
  factoryLines.set(
    job.id,
    new Set(released.map((row) => row.reservationId).filter((id): id is string => id !== null)),
  );
  await reserve(
    base.db,
    { ownerId: job.ownerId, jobId: job.id, projectId: job.projectId, isFixture: true },
    renderReservationLines({
      imageEditProvider: 'fixture',
      visionProvider: 'fixture',
      streetViewFetch,
      reuseAnalysis: false,
      lightingMode: job.lightingMode,
      relightBase: false,
    }),
    base.clock,
  );
}

async function brightJob(deps: PipelineDeps) {
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
  });
  await reserveAsTheApi(job, false);
  return { job, projectId };
}

async function eveningJob(deps: PipelineDeps) {
  const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId: SHOWCASE });
  const job = await createRenderJobRecord(deps, {
    ownerId,
    projectId,
    source,
    lightingMode: 'evening',
  });
  await reserveAsTheApi(job, true);
  return { job, projectId };
}

const jobFor = (lightingMode: LightingMode, deps: PipelineDeps) =>
  lightingMode === 'bright' ? brightJob(deps) : eveningJob(deps);

async function attemptsOf(jobId: string) {
  return base.db
    .selectFrom('renderAttempts')
    .selectAll()
    .where('jobId', '=', jobId)
    .orderBy('attemptNo')
    .execute();
}

const summary = (rows: Awaited<ReturnType<typeof attemptsOf>>) =>
  rows.map((a) => [a.attemptNo, a.isRepair, a.outcome, a.fidelityMode]);

async function assetsOf(projectId: string) {
  return base.db
    .selectFrom('renderAssets')
    .selectAll()
    .where('projectId', '=', projectId)
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
}

/** The job's ledger rows: per SKU and stage, how many lines were reserved and settled. */
async function ledgerOf(jobId: string) {
  const rows = await base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('jobId', '=', jobId)
    .execute();
  const ignored = factoryLines.get(jobId) ?? new Set<string>();
  const live = rows.filter((row) => !ignored.has(row.id) && !ignored.has(row.reservationId ?? ''));
  const count = (kind: string, sku: string, stage?: string) =>
    live.filter(
      (row) => row.kind === kind && row.sku === sku && (stage === undefined || row.stage === stage),
    ).length;
  const open = rows
    .filter((row) => row.kind === 'reservation')
    .filter((row) => !rows.some((other) => other.reservationId === row.id));
  const settledMicros = rows
    .filter((row) => row.kind === 'settlement' || row.kind === 'charge')
    .reduce((total, row) => total + Number(row.amountMicros), 0);
  return { rows, count, open, settledMicros };
}

/**
 * The job's reservations that are still open or were closed more than once, as `sku/stage:
 * closures`. A reservation is closed once by one settlement (with the release of its unused
 * remainder written after it) or by one release.
 */
async function notClosedOnce(jobId: string): Promise<string[]> {
  const rows = await base.db
    .selectFrom('usageLedger')
    .selectAll()
    .where('jobId', '=', jobId)
    .execute();
  return rows
    .filter((row) => row.kind === 'reservation')
    .flatMap((reservation) => {
      const closures = rows.filter((row) => row.reservationId === reservation.id);
      const settlements = closures.filter((row) => row.kind === 'settlement');
      const releases = closures.filter((row) => row.kind === 'release');
      const [settlement] = settlements;
      const [release] = releases;
      const once =
        closures.length === settlements.length + releases.length &&
        releases.length <= 1 &&
        (settlements.length === 1 || (settlements.length === 0 && releases.length === 1)) &&
        !(settlement && release && release.createdAt < settlement.createdAt);
      return once
        ? []
        : [
            `${reservation.sku}/${reservation.stage}: ${closures.map((row) => row.kind).join('+') || 'open'}`,
          ];
    });
}

async function succeededEvents(ownerId: string) {
  return base.db
    .selectFrom('analyticsEvents')
    .select('properties')
    .where('eventName', '=', 'render_succeeded')
    .where(
      'sessionHash',
      '=',
      dailySaltedHash(base.config.sessionSecret, `owner:${ownerId}`, base.clock.now()),
    )
    .execute();
}

describe('a relit look that decorates its own base: the relight is repaired on attempt 3', () => {
  for (const lightingMode of ['bright', 'evening'] as const) {
    it(`${lightingMode}: base accepted, relight rejected and repaired, the repair is delivered`, async () => {
      const editor = recordingEditor();
      const vision = judgingVision(relightAttempt(2, 'structure_changed'));
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 3, repairUsed: true });
      expect(editor.kinds()).toEqual(['decorate', 'relight', 'relight']);
      // The repair of the relight carries the stronger keep clause; the first relight does not.
      expect(editor.requests[2]?.instructionText).toContain(RELIGHT_REPAIR_KEEP);
      expect(editor.requests[1]?.instructionText).not.toContain(RELIGHT_REPAIR_KEEP);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'qa_rejected', 'global_relight'],
        [3, true, 'succeeded', 'global_relight'],
      ]);
      // Both relights start from the base attempt 1 decorated.
      for (const relight of attempts.slice(1)) {
        expect(relight.fallback).toMatchObject({ kind: 'relight', baseAttemptId: attempts[0]?.id });
      }
      const assets = await assetsOf(projectId);
      expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual(
        lightingMode === 'bright'
          ? [['bright', 'global_relight']]
          : [
              ['source', 'composite_additive'],
              ['evening', 'global_relight'],
            ],
      );
      expect(assets[assets.length - 1]?.jobId).toBe(job.id);
      expect((await succeededEvents(job.ownerId)).map((e) => e.properties)).toEqual([
        expect.objectContaining({ attempts: 3, repaired: true, lightingMode }),
      ]);

      // Reservation and settlement agree: three edits and three judges reserved and settled, the
      // two localization lines one used and one released, nothing left open.
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('reservation', 'image_edit_attempt')).toBe(3);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(3);
      expect(ledger.count('charge', 'image_edit_attempt')).toBe(0);
      expect(ledger.count('settlement', 'vision_call', 'localizing')).toBe(1);
      expect(ledger.count('settlement', 'vision_call', 'checking')).toBe(3);
      expect(ledger.count('charge', 'vision_call')).toBe(0);
      expect(ledger.open).toEqual([]);
      const linked = attempts.map((a) => a.reservationEntryId);
      expect(new Set(linked).size).toBe(3);
      expect(linked.every((id) => id !== null)).toBe(true);
    });

    it(`${lightingMode}: base accepted, relight rejected twice: the existing fallback`, async () => {
      const editor = recordingEditor();
      const vision = judgingVision((input) =>
        input.mode === 'relight' ? 'structure_changed' : null,
      );
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'qa_rejected', 'global_relight'],
        [3, true, 'qa_rejected', 'global_relight'],
      ]);
      const assets = await assetsOf(projectId);
      if (lightingMode === 'bright') {
        expect(result.state).toBe('succeeded');
        expect(attempts[0]?.fallback).toEqual({
          kind: 'relight_fallback',
          target: 'bright',
          reason: 'relight_rejected',
          deliveredAs: 'result',
          relightAttemptId: attempts[2]?.id,
          codes: ['structure_changed'],
        });
        expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
          ['bright', 'composite_additive'],
        ]);
        // The delivered base was attempt 1, after three attempts and the relight's repair.
        expect((await succeededEvents(job.ownerId)).map((e) => e.properties)).toEqual([
          expect.objectContaining({
            attempts: 3,
            repaired: true,
            fidelityMode: 'composite_additive',
          }),
        ]);
      } else {
        expect(result.state).toBe('rejected');
        expect(await readJob(base.db, job.id)).toMatchObject({
          rejectionReason: 'qa_critical',
          failureCodes: ['structure_changed'],
          attemptCount: 3,
          repairUsed: true,
        });
        // The daylight companion published from attempt 1 stays; there is no evening variant.
        expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
      }
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });
  }

  it('bright in pre-delivery review: an uncertain base held after both relights failed stays unpassed', async () => {
    const vision = judgingVision(
      (input) =>
        input.mode === 'relight' || input.plan.attemptNumber === 1 ? 'structure_changed' : null,
      undefined,
      // The base's finding is uncertain (held for a reviewer); the relights' are confident.
      (input) => (input.mode === 'relight' ? 0.95 : 0.5),
    );
    const deps = depsWith({ vision: vision.vision });
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
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'qa_rejected', 'global_relight'],
      [3, true, 'qa_rejected', 'global_relight'],
    ]);
    // The held candidate is the base, which its own QA left uncertain: not marked as passed.
    expect(attempts[0]?.candidateObjectKey).toBe(
      `attempts/${job.id}/${attempts[0]?.id}/held-delivered.jpg`,
    );
    expect(await readJob(base.db, job.id)).toMatchObject({ qaPassedAt: null });
  });

  it('a confident major on the first relight is repaired too while the repair is unused', async () => {
    const editor = recordingEditor();
    const vision = judgingVision(relightAttempt(2, 'implausible_decor'));
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { job } = await brightJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'qa_rejected', 'global_relight'],
      [3, true, 'succeeded', 'global_relight'],
    ]);
  });
});

describe('a relit look whose base needed its repair: the relight takes attempt 3', () => {
  for (const lightingMode of ['bright', 'evening'] as const) {
    it(`${lightingMode}: base rejected, repaired, then relit on attempt 3 and delivered`, async () => {
      const editor = recordingEditor();
      const vision = judgingVision(firstBase);
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(await readJob(base.db, job.id)).toMatchObject({
        state: 'succeeded',
        attemptCount: 3,
        repairUsed: true,
      });
      expect(editor.kinds()).toEqual(['decorate', 'decorate', 'relight']);
      // The relight of the repaired base is not a repair: the job has used its one repair.
      expect(editor.requests[2]?.instructionText).not.toContain(RELIGHT_REPAIR_KEEP);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
        [3, false, 'succeeded', 'global_relight'],
      ]);
      expect(attempts[1]?.fallback).toBeNull();
      expect(attempts[2]?.fallback).toMatchObject({
        kind: 'relight',
        base: 'attempt',
        baseAttemptId: attempts[1]?.id,
      });
      const assets = await assetsOf(projectId);
      if (lightingMode === 'bright') {
        expect(assets.map((a) => [a.jobId, a.lightingMode, a.fidelityMode])).toEqual([
          [job.id, 'bright', 'global_relight'],
        ]);
      } else {
        // The repaired base is the daylight companion, and the relight of it the evening look.
        expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
          ['source', 'composite_additive'],
          ['evening', 'global_relight'],
        ]);
        const companion = await readJob(base.db, assets[0]?.jobId as string);
        expect(
          (companion?.inputSnapshot as { relightBaseOf?: unknown } | null)?.relightBaseOf,
        ).toEqual({ jobId: job.id, attemptId: attempts[1]?.id });
        expect(attempts[2]?.fallback).toMatchObject({ baseRenderAssetId: assets[0]?.id });
      }
      expect((await succeededEvents(job.ownerId)).map((e) => e.properties)).toEqual([
        expect.objectContaining({ attempts: 3, repaired: true, lightingMode }),
      ]);
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(3);
      expect(ledger.count('charge', 'image_edit_attempt')).toBe(0);
      // Both decorate attempts were localized (the two reserved lines); the relight is not.
      expect(ledger.count('settlement', 'vision_call', 'localizing')).toBe(2);
      expect(ledger.count('charge', 'vision_call')).toBe(0);
      expect(ledger.open).toEqual([]);
    });

    it(`${lightingMode}: base repaired, the relight on attempt 3 rejected: the existing fallback`, async () => {
      const vision = judgingVision(
        (input) => firstBase(input) ?? (input.mode === 'relight' ? 'structure_changed' : null),
      );
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      // No repair is left for the relight.
      expect(editor.kinds()).toEqual(['decorate', 'decorate', 'relight']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
        [3, false, 'qa_rejected', 'global_relight'],
      ]);
      const assets = await assetsOf(projectId);
      if (lightingMode === 'bright') {
        expect(result.state).toBe('succeeded');
        expect(attempts[1]?.fallback).toEqual({
          kind: 'relight_fallback',
          target: 'bright',
          reason: 'relight_rejected',
          deliveredAs: 'result',
          relightAttemptId: attempts[2]?.id,
          codes: ['structure_changed'],
        });
        expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
          ['bright', 'composite_additive'],
        ]);
      } else {
        expect(result.state).toBe('rejected');
        expect(await readJob(base.db, job.id)).toMatchObject({
          rejectionReason: 'qa_critical',
          failureCodes: ['structure_changed'],
          attemptCount: 3,
        });
        expect(assets.map((a) => a.lightingMode)).toEqual(['source']);
      }
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });

    it(`${lightingMode}: base repaired with no time left for a third attempt: not attempted`, async () => {
      const clock = steppingClock();
      // The repaired base's judge runs when the job is 200 s old: under the 48 s repair budget
      // of the 240 s job limit, so no relight is started.
      const vision = judgingVision(firstBase, (input) => {
        if (input.mode !== 'relight' && input.plan.attemptNumber === 2) clock.advance(200_000);
      });
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision, clock });
      const { job, projectId } = await jobFor(lightingMode, deps);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate', 'decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
      ]);
      expect(attempts[1]?.fallback).toEqual({
        kind: 'relight_fallback',
        target: lightingMode,
        reason: 'relight_not_attempted',
        deliveredAs: lightingMode === 'bright' ? 'result' : 'daylight_variant',
        relightAttemptId: null,
        codes: ['implausible_decor'],
      });
      expect(result.state).toBe(lightingMode === 'bright' ? 'succeeded' : 'rejected');
      expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual([
        lightingMode === 'bright' ? 'bright' : 'source',
      ]);
      // The third edit line is released with the job's other untouched lines.
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(2);
      expect(ledger.open).toEqual([]);
    });
  }

  it('bright: a repaired base that fails too rejects the job after two attempts', async () => {
    const vision = judgingVision((input) =>
      input.mode !== 'relight' ? 'structure_changed' : null,
    );
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { job } = await brightJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(editor.kinds()).toEqual(['decorate', 'decorate']);
    expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 2, repairUsed: true });
  });
});

describe('fixture mode', () => {
  it('the repair scenario place: its evening first look is decorated, repaired and relit', async () => {
    const { ownerId, projectId, source } = await createStreetViewSource(base, {
      placeId: 'ChIJfxGullwingLaneCapeXXX05',
    });
    const job = await createRenderJobRecord(base, {
      ownerId,
      projectId,
      source,
      style: 'abundant',
      lightingMode: 'evening',
    });
    await reserveAsTheApi(job, true);
    expect((await runRenderJob(base, { renderJobId: job.id })).state).toBe('succeeded');
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
      [2, true, 'succeeded', 'composite_additive'],
      [3, false, 'succeeded', 'global_relight'],
    ]);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source', 'evening']);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });
});

describe('jobs that keep two attempts', () => {
  it('as photographed: an attempt and its repair, never a third', async () => {
    const vision = judgingVision((input) =>
      input.mode !== 'relight' ? 'structure_changed' : null,
    );
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(editor.kinds()).toEqual(['decorate', 'decorate']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
      [2, true, 'qa_rejected', 'composite_additive'],
    ]);
  });

  it('evening relighting an existing daylight variant: the relight and its repair only', async () => {
    const editor = recordingEditor();
    const vision = judgingVision((input) =>
      input.mode === 'relight' ? 'structure_changed' : null,
    );
    const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const day = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: day.id })).state).toBe('succeeded');
    const evening = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    const before = editor.requests.length;
    expect((await runRenderJob(deps, { renderJobId: evening.id })).state).toBe('rejected');
    expect(editor.kinds().slice(before)).toEqual(['relight', 'relight']);
    expect(summary(await attemptsOf(evening.id))).toEqual([
      [1, false, 'qa_rejected', 'global_relight'],
      [2, true, 'qa_rejected', 'global_relight'],
    ]);
    expect(await readJob(base.db, evening.id)).toMatchObject({ attemptCount: 2 });
  });
});

describe('the database allows a third attempt only as a relight, and one repair per job', () => {
  it('refuses a third decorate attempt and a second repair', async () => {
    const deps = depsWith({});
    const { job } = await brightJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const [first, second] = await attemptsOf(job.id);
    const attempt = (o: { attemptNo: number; isRepair: boolean; fidelityMode: FidelityMode }) => {
      const row = first as NonNullable<typeof first>;
      return {
        id: newId(),
        jobId: job.id,
        decorationPlanId: row.decorationPlanId,
        sceneAnalysisId: row.sceneAnalysisId,
        permissionEvaluationId: row.permissionEvaluationId,
        provider: row.provider,
        modelSnapshot: row.modelSnapshot,
        promptVersion: row.promptVersion,
        compilerVersion: row.compilerVersion,
        settingsHash: row.settingsHash,
        providerMode: row.providerMode,
        sourceChecksumSha256: row.sourceChecksumSha256,
        workingChecksumSha256: row.workingChecksumSha256,
        outcome: 'pending' as const,
        ...o,
      };
    };
    const insert = (o: Parameters<typeof attempt>[0]) =>
      base.db.insertInto('renderAttempts').values(attempt(o)).execute();
    await expect(
      insert({ attemptNo: 3, isRepair: false, fidelityMode: 'composite_additive' }),
    ).rejects.toThrow(/render_attempts_third_is_relight/);
    await expect(
      insert({ attemptNo: 4, isRepair: false, fidelityMode: 'global_relight' }),
    ).rejects.toThrow(/render_attempts_attempt_no_check/);
    await base.db
      .updateTable('renderAttempts')
      .set({ isRepair: true })
      .where('id', '=', second?.id as string)
      .execute();
    await expect(
      insert({ attemptNo: 3, isRepair: true, fidelityMode: 'global_relight' }),
    ).rejects.toThrow(/render_attempts_one_repair_per_job_idx/);
    // A third attempt that is a relight and not a second repair is allowed.
    await insert({ attemptNo: 3, isRepair: false, fidelityMode: 'global_relight' });
  });
});

/** A stored image decoded to raw pixels (`channels` per pixel). */
async function rawOf(key: string, channels: 1 | 3) {
  const object = await base.storage.get('private', key);
  if (!object) throw new Error(`missing ${key}`);
  const image = sharp(object.body).removeAlpha();
  const { data, info } = await (channels === 1 ? image.greyscale() : image.toColourspace('srgb'))
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

type Raw = Awaited<ReturnType<typeof rawOf>>;

/** Pixel indices of a normalized box on an image grid. */
function boxPixels(box: NormalizedBox, width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = Math.round(box[1] * height); y < Math.round(box[3] * height); y += 1) {
    for (let x = Math.round(box[0] * width); x < Math.round(box[2] * width); x += 1) {
      out.push(y * width + x);
    }
  }
  return out;
}

/** Mean absolute channel difference of two images inside a box. */
function meanDiff(a: Raw, b: Raw, box: NormalizedBox): number {
  const pixels = boxPixels(box, a.width, a.height);
  let total = 0;
  for (const i of pixels) {
    for (let c = 0; c < a.channels; c += 1) {
      total += Math.abs(
        (a.data[i * a.channels + c] as number) - (b.data[i * b.channels + c] as number),
      );
    }
  }
  return total / (pixels.length * a.channels);
}

/**
 * A 16 px box well inside the hard composite mask an attempt stored (the editor was free to
 * draw there), as a judge evidence box.
 */
async function editableBox(jobId: string, attemptNo: number): Promise<NormalizedBox> {
  const mask = await rawOf(keys.working(jobId, `mask-${attemptNo}.png`), 1);
  const { data, width, height } = mask;
  const set = (x: number, y: number) => (data[y * width + x] as number) > 127;
  for (let y = 24; y < height - 24; y += 4) {
    for (let x = 24; x < width - 24; x += 4) {
      let inside = true;
      for (let dy = -20; dy <= 20 && inside; dy += 2) {
        for (let dx = -20; dx <= 20 && inside; dx += 2) inside = set(x + dx, y + dy);
      }
      if (inside) return [(x - 8) / width, (y - 8) / height, (x + 8) / width, (y + 8) / height];
    }
  }
  throw new Error('no editable area in the mask');
}

type RestoreState = {
  box: NormalizedBox | null;
  candidates: Map<number, Buffer>;
  repairAtAttempt2: unknown;
};

/**
 * The fixture editor that paints a solid patch over `state.box` (an editable spot of attempt 1's
 * mask, chosen on the first decorate edit) in the output of every decorate edit, the repair
 * included: an editor that redraws the same wrong pixels whatever the repair constraints say.
 */
function paintingEditor(state: RestoreState) {
  const inner = base.providers.fixtures.imageEditor;
  const requests: CompiledRequest[] = [];
  const editor: ImageEditor = {
    ...inner,
    async edit(request, input, options) {
      requests.push(request);
      const outcome = await inner.edit(request, input, options);
      if (outcome.status !== 'completed' || (request.kind ?? 'decorate') !== 'decorate') {
        return outcome;
      }
      const attempt = await base.db
        .selectFrom('renderAttempts')
        .select('jobId')
        .where('id', '=', options.attemptId)
        .executeTakeFirstOrThrow();
      state.box ??= await editableBox(attempt.jobId, 1);
      const [x0, y0, x1, y1] = state.box;
      const left = Math.round(x0 * outcome.width);
      const top = Math.round(y0 * outcome.height);
      const patch = await sharp({
        create: {
          width: Math.max(1, Math.round(x1 * outcome.width) - left),
          height: Math.max(1, Math.round(y1 * outcome.height) - top),
          channels: 3,
          background: { r: 255, g: 0, b: 255 },
        },
      })
        .png()
        .toBuffer();
      const image = await sharp(outcome.image)
        .composite([{ input: patch, left, top }])
        .png()
        .toBuffer();
      return { ...outcome, image, format: 'png' };
    },
    getOperation: (operationId) => inner.getOperation(operationId),
  };
  return { editor, kinds: () => requests.map((r) => r.kind ?? 'decorate') };
}

/**
 * The fixture vision model with a `text_added` critical finding on every judge call of attempt 1
 * (its escalation included), boxed on `state.box`. `state` records the candidates per attempt and
 * the job's stored repair state when attempt 2 is judged.
 */
function textAddedOnFirstAttempt(confidence: number) {
  const inner = base.providers.fixtures.vision;
  const state: RestoreState = { box: null, candidates: new Map(), repairAtAttempt2: null };
  const vision: VisionModel = {
    ...inner,
    async judge(input: JudgeInput, options?: CallOptions): Promise<VisionCallResult<JudgeResult>> {
      const result = await inner.judge(input, options);
      if (input.mode === 'relight') return result;
      const attemptNo = input.plan.attemptNumber;
      if (!input.escalated) state.candidates.set(attemptNo, Buffer.from(input.candidate.bytes));
      if (attemptNo === 2 && !input.escalated) {
        state.repairAtAttempt2 = (await readJob(base.db, input.plan.renderJobId))
          ?.repairConstraints;
      }
      if (attemptNo !== 1) return result;
      state.box ??= await editableBox(input.plan.renderJobId, 1);
      const finding = {
        code: 'text_added' as const,
        confidence,
        evidence: 'A number plaque looks altered.',
        box: state.box,
      };
      return {
        ...result,
        result: { ...result.result, critical: [...result.result.critical, finding] },
      };
    },
  };
  return { vision, state };
}

describe('restore on repair: the repair pastes the judge box back from the original', () => {
  for (const [label, confidence] of [
    ['confident', 0.95],
    ['uncertain', 0.5],
  ] as const) {
    it(`bright: attempt 1 rejected text_added (${label}); the repaired base keeps the original there and is relit`, async () => {
      const { vision, state } = textAddedOnFirstAttempt(confidence);
      const editor = paintingEditor(state);
      const deps = depsWith({ imageEditor: editor.editor, vision });
      const { job, projectId } = await brightJob(deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      const box = state.box as NormalizedBox;
      expect(box).not.toBeNull();
      expect(editor.kinds()).toEqual(['decorate', 'decorate', 'relight']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
        [3, false, 'succeeded', 'global_relight'],
      ]);
      expect(await readJob(base.db, job.id)).toMatchObject({
        attemptCount: 3,
        repairUsed: true,
      });
      // The repair constraints the job stored carry the box; the repair attempt records it.
      expect(state.repairAtAttempt2).toMatchObject({
        codes: ['text_added'],
        verdict: label === 'confident' ? 'fail' : 'uncertain',
        adjustments: { restoreBoxes: [box] },
      });
      expect(attempts[1]?.compositeMask).toMatchObject({ restoreBoxes: [box] });
      expect(attempts[0]?.compositeMask).not.toHaveProperty('restoreBoxes');
      const plan = await base.db
        .selectFrom('decorationPlans')
        .select('document')
        .where('id', '=', attempts[1]?.decorationPlanId as string)
        .executeTakeFirstOrThrow();
      expect(plan.document).toMatchObject({ compositeMask: { restoreBoxes: [box] } });

      // Attempt 1 could edit the box; the repair's mask cannot.
      const mask1 = await rawOf(keys.working(job.id, 'mask-1.png'), 1);
      const mask2 = await rawOf(keys.working(job.id, 'mask-2.png'), 1);
      const inBox = boxPixels(box, mask1.width, mask1.height);
      expect(inBox.every((i) => (mask1.data[i] as number) > 127)).toBe(true);
      expect(inBox.every((i) => mask2.data[i] === 0)).toBe(true);

      // The repaired base (stored losslessly for the relight) equals the original inside the box,
      // although the editor painted over it on both attempts.
      const working = await rawOf(keys.working(job.id, 'working.png'), 3);
      const repaired = await rawOf(
        keys.attempt(job.id, attempts[1]?.id as string, 'relight-base.png'),
        3,
      );
      expect(meanDiff(repaired, working, box)).toBe(0);
      const firstCandidate = await sharp(state.candidates.get(1) as Buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const first: Raw = {
        data: firstCandidate.data,
        width: firstCandidate.info.width,
        height: firstCandidate.info.height,
        channels: firstCandidate.info.channels,
      };
      expect(meanDiff(first, working, box)).toBeGreaterThan(10);

      // The repaired base is relit on attempt 3 and delivered.
      expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        ['bright', 'global_relight'],
      ]);
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });
  }

  it('as photographed: the repair restores the box and is delivered on attempt 2', async () => {
    const { vision, state } = textAddedOnFirstAttempt(0.95);
    const deps = depsWith({ imageEditor: paintingEditor(state).editor, vision });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    const box = state.box as NormalizedBox;
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
      [2, true, 'succeeded', 'composite_additive'],
    ]);
    expect(await readJob(base.db, job.id)).toMatchObject({
      repairConstraints: { adjustments: { restoreBoxes: [box] } },
    });
    expect(attempts[1]?.compositeMask).toMatchObject({ restoreBoxes: [box] });
    const working = await rawOf(keys.working(job.id, 'working.png'), 3);
    const decode = async (bytes: Buffer): Promise<Raw> => {
      const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
      return { data, width: info.width, height: info.height, channels: info.channels };
    };
    // The judged candidates (JPEG at quality 92): the editor painted over the box on both
    // attempts; attempt 1 kept the paint, the repair restored the original there.
    const first = await decode(state.candidates.get(1) as Buffer);
    const second = await decode(state.candidates.get(2) as Buffer);
    expect(meanDiff(first, working, box)).toBeGreaterThan(10);
    expect(meanDiff(second, working, box)).toBeLessThan(2);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });
});

describe('a relight that ends without a QA decision falls back to its base', () => {
  /** The fixture editor with a relight request answered by `relight`. */
  function relightEditor(relight: ImageEditor['edit']) {
    const inner = base.providers.fixtures.imageEditor;
    const editor: ImageEditor = {
      ...inner,
      edit: (request, input, options) =>
        request.kind === 'relight'
          ? relight(request, input, options)
          : inner.edit(request, input, options),
      getOperation: (operationId) => inner.getOperation(operationId),
    };
    return editor;
  }

  /** The judge answers no relight call (a failure after its retries). */
  const judgeUnavailable = (): VisionModel => {
    const inner = base.providers.fixtures.vision;
    return {
      ...inner,
      async judge(input, options) {
        if (input.mode === 'relight') {
          throw new ProviderError('fixture', 'provider_error', 'judge unavailable', {
            retryable: false,
          });
        }
        return inner.judge(input, options);
      },
    };
  };

  /** The editor answers a relight with bytes that are not an image. */
  const undecodable = () =>
    relightEditor(async (request, input, options) => {
      const outcome = await base.providers.fixtures.imageEditor.edit(request, input, options);
      return outcome.status === 'completed'
        ? { ...outcome, image: Buffer.from('not an image') }
        : outcome;
    });

  async function expectFallback(
    lightingMode: 'bright' | 'evening',
    jobId: string,
    projectId: string,
    failureKind: string,
  ) {
    const job = await readJob(base.db, jobId);
    const attempts = await attemptsOf(jobId);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: lightingMode,
      reason: 'relight_failed',
      deliveredAs: lightingMode === 'bright' ? 'result' : 'daylight_variant',
      relightAttemptId: attempts[1]?.id,
      codes: [],
      failureKind,
    });
    const assets = await assetsOf(projectId);
    if (lightingMode === 'bright') {
      expect(job?.state).toBe('succeeded');
      expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        ['bright', 'composite_additive'],
      ]);
    } else {
      expect(job).toMatchObject({ state: 'rejected', rejectionReason: 'qa_critical' });
      expect(assets.map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        ['source', 'composite_additive'],
      ]);
    }
    expect((await ledgerOf(jobId)).open).toEqual([]);
  }

  for (const lightingMode of ['bright', 'evening'] as const) {
    it(`${lightingMode}: the relight's judge is unavailable`, async () => {
      const deps = depsWith({ vision: judgeUnavailable() });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await runRenderJob(deps, { renderJobId: job.id });
      await expectFallback(lightingMode, job.id, projectId, 'provider_error');
    });

    it(`${lightingMode}: the relight's output cannot be decoded`, async () => {
      const deps = depsWith({ imageEditor: undecodable() });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await runRenderJob(deps, { renderJobId: job.id });
      await expectFallback(lightingMode, job.id, projectId, 'provider_error');
    });

    it(`${lightingMode}: a late relight's edit is bounded by the time left and times out`, async () => {
      const clock = steppingClock();
      // The base is judged when the job is 180 s old: 60 s are left of the 240 s limit, more
      // than the 48 s repair budget, so the relight starts with 45 s for its edit.
      const vision = judgingVision(
        () => null,
        (input) => {
          if (input.mode !== 'relight' && input.plan.attemptNumber === 1) clock.advance(180_000);
        },
      );
      const timeouts: number[] = [];
      const editor = relightEditor(async (_request, _input, options) => {
        timeouts.push(options.timeoutMs ?? 0);
        return { status: 'failed', kind: 'timeout', retryable: false };
      });
      const deps = depsWith({ imageEditor: editor, vision: vision.vision, clock });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await runRenderJob(deps, { renderJobId: job.id });
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeLessThanOrEqual(45_000);
      // The clock also runs in real time, so a busy machine eats a few seconds of what is left.
      expect(timeouts[0]).toBeGreaterThan(30_000);
      expect((await attemptsOf(job.id))[1]?.outcome).toBe('timeout');
      await expectFallback(lightingMode, job.id, projectId, 'timeout');
    });

    it(`${lightingMode}: a relight edit that could not finish in the time left is never sent`, async () => {
      const clock = steppingClock();
      // The base is judged when the job is 210 s old: 30 s are left, more than the 5 s repair
      // budget, so the relight is planned; with the 15 s guard only 15 s remain for its edit,
      // under the 20 s a relight edit needs, so it is not sent.
      const vision = judgingVision(
        () => null,
        (input) => {
          if (input.mode !== 'relight' && input.plan.attemptNumber === 1) clock.advance(210_000);
        },
      );
      const editor = recordingEditor();
      const deps = depsWith({
        imageEditor: editor.editor,
        vision: vision.vision,
        clock,
        options: { repairBudgetMs: 5_000 },
      });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'canceled', 'global_relight'],
      ]);
      expect(attempts[1]?.requestSentAt).toBeNull();
      expect(attempts[1]?.errorDetail).toMatchObject({ notDispatched: 'deadline' });
      await expectFallback(lightingMode, job.id, projectId, 'timeout');
      // One edit settled (the base); the relight's reservation was released, not settled.
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(1);
      expect(ledger.count('charge', 'image_edit_attempt')).toBe(0);
      const relightLine = ledger.rows.find((row) => row.id === attempts[1]?.reservationEntryId);
      expect(relightLine?.kind).toBe('reservation');
      expect(
        ledger.rows.filter((row) => row.reservationId === relightLine?.id).map((row) => row.kind),
      ).toEqual(['release']);
    });

    it(`${lightingMode}: the job's deadline passes while the relight is judged`, async () => {
      // The job's limit is 15 s of real time. Once the base is judged the clock is set back two
      // minutes, so the relight is planned and its edit sent; its judge then answers only when
      // the run is aborted, which the deadline does.
      const clock = steppingClock();
      const inner = base.providers.fixtures.vision;
      const vision: VisionModel = {
        ...inner,
        async judge(input, options) {
          if (input.mode === 'relight') {
            return new Promise((_resolve, reject) => {
              const signal = options?.signal;
              const abort = () => reject(new Error('judge aborted'));
              if (signal?.aborted) abort();
              signal?.addEventListener('abort', abort, { once: true });
            });
          }
          const result = await inner.judge(input, options);
          if (input.plan.attemptNumber === 1 && !input.escalated) clock.advance(-120_000);
          return result;
        },
      };
      const editor = recordingEditor();
      const deps = depsWith({
        imageEditor: editor.editor,
        vision,
        clock,
        options: { maxJobDurationMs: 15_000, repairBudgetMs: 5_000 },
      });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate', 'relight']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'succeeded', 'global_relight'],
      ]);
      await expectFallback(lightingMode, job.id, projectId, 'timeout');
      // Both edits were sent and settled; the relight's judge line was released.
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(2);
    }, 60_000);
  }
});

describe('a look the judge only doubts is delivered rather than none', () => {
  /** Every decorate judge call reports the finding at a confidence under the critical floor. */
  const doubtingEveryBase = (code: JudgeResult['critical'][number]['code']) => {
    const inner = base.providers.fixtures.vision;
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        const result = await inner.judge(input, options);
        if (input.mode === 'relight') return result;
        const finding = { code, confidence: 0.5, evidence: 'Test judge doubt.' };
        return {
          ...result,
          result: { ...result.result, critical: [...result.result.critical, finding] },
        };
      },
    };
    return vision;
  };

  it('evening: a base doubted on both attempts is relit and delivered', async () => {
    const editor = recordingEditor();
    const deps = depsWith({
      imageEditor: editor.editor,
      vision: doubtingEveryBase('structure_changed'),
    });
    const { job, projectId } = await eveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    // With time for it the doubt is repaired once; the repaired base, doubted again, is relit.
    expect(editor.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
      [2, true, 'succeeded', 'composite_additive'],
      [3, false, 'succeeded', 'global_relight'],
    ]);
    const assets = await assetsOf(projectId);
    expect(assets.map((asset) => asset.lightingMode)).toContain('evening');
  });

  it('evening: with too little time for a repair and the relight, the doubted base is relit at once', async () => {
    const clock = steppingClock();
    const inner = doubtingEveryBase('structure_changed');
    let aged = false;
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        // The first base is judged when the job is 140 s old: 100 s are left of the 240 s limit,
        // enough for a repair alone but not for a repair and the relight after it.
        if (!aged) clock.advance(140_000);
        aged = true;
        return inner.judge(input, options);
      },
    };
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision, clock });
    const { job, projectId } = await eveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(await readJob(base.db, job.id)).toMatchObject({ repairUsed: false });
    const assets = await assetsOf(projectId);
    expect(assets.map((asset) => asset.lightingMode)).toContain('evening');
  });

  it('a doubt about a person is never delivered', async () => {
    const editor = recordingEditor();
    const deps = depsWith({
      imageEditor: editor.editor,
      vision: doubtingEveryBase('people_altered'),
    });
    const { job, projectId } = await eveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(await readJob(base.db, job.id)).toMatchObject({ rejectionReason: 'qa_uncertain' });
    expect(await assetsOf(projectId)).toEqual([]);
  });
});

describe('the base of a relit look that is short on time keeps it for the relight', () => {
  /** Every decorate judge call reports one confident major finding. */
  const majorOnEveryBase = (): VisionModel => {
    const inner = base.providers.fixtures.vision;
    return {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        const result = await inner.judge(input, options);
        if (input.mode === 'relight') return result;
        const finding = {
          code: 'unrequested_change' as const,
          confidence: 0.9,
          evidence: 'Test judge major.',
        };
        return {
          ...result,
          result: { ...result.result, major: [...result.result.major, finding] },
        };
      },
    };
  };

  it('evening: a confident major is recorded, not repaired, when a repair would leave no time for the relight', async () => {
    const clock = steppingClock();
    const inner = majorOnEveryBase();
    let aged = false;
    const vision: VisionModel = {
      ...inner,
      async judge(input: JudgeInput, options?: CallOptions) {
        // The first base is judged when the job is 140 s old: 100 s are left of the 240 s limit,
        // enough for a repair alone but not for a repair and the relight after it.
        if (!aged) clock.advance(140_000);
        aged = true;
        return inner.judge(input, options);
      },
    };
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision, clock });
    const { job, projectId } = await eveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(await readJob(base.db, job.id)).toMatchObject({ repairUsed: false });
    const assets = await assetsOf(projectId);
    expect(assets.map((asset) => asset.lightingMode)).toContain('evening');
  });

  it('evening: with time for both, the same major is repaired before the relight', async () => {
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, vision: majorOnEveryBase() });
    const { job, projectId } = await eveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate', 'decorate', 'relight']);
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
      [2, true, 'succeeded', 'composite_additive'],
      [3, false, 'succeeded', 'global_relight'],
    ]);
    const assets = await assetsOf(projectId);
    expect(assets.map((asset) => asset.lightingMode)).toContain('evening');
  });
});

describe('the time budget closes a relight after an accepted first base', () => {
  for (const lightingMode of ['bright', 'evening'] as const) {
    it(`${lightingMode}: no time left for the relight: not attempted`, async () => {
      const clock = steppingClock();
      // The base is judged when the job is 200 s old: 40 s are left, under the 48 s budget.
      const vision = judgingVision(
        () => null,
        (input) => {
          if (input.mode !== 'relight' && input.plan.attemptNumber === 1) clock.advance(200_000);
        },
      );
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision, clock });
      const { job, projectId } = await jobFor(lightingMode, deps);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([[1, false, 'succeeded', 'composite_additive']]);
      expect(attempts[0]?.fallback).toEqual({
        kind: 'relight_fallback',
        target: lightingMode,
        reason: 'relight_not_attempted',
        deliveredAs: lightingMode === 'bright' ? 'result' : 'daylight_variant',
        relightAttemptId: null,
        codes: [],
      });
      expect(result.state).toBe(lightingMode === 'bright' ? 'succeeded' : 'rejected');
      expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual([
        lightingMode === 'bright' ? 'bright' : 'source',
      ]);
      const ledger = await ledgerOf(job.id);
      expect(ledger.count('settlement', 'image_edit_attempt')).toBe(1);
      expect(ledger.open).toEqual([]);
    });

    it(`${lightingMode}: a confident major on the first relight is recorded when no repair can run`, async () => {
      const clock = steppingClock();
      // The relight is judged when the job is 200 s old: its repair cannot run, so the major
      // is recorded on the delivered relight instead of rejecting it.
      const vision = judgingVision(relightAttempt(2, 'implausible_decor'), (input) => {
        if (input.mode === 'relight' && input.plan.attemptNumber === 2 && !input.escalated) {
          clock.advance(200_000);
        }
      });
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision, clock });
      const { job, projectId } = await jobFor(lightingMode, deps);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(editor.kinds()).toEqual(['decorate', 'relight']);
      expect(summary(await attemptsOf(job.id))).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'succeeded', 'global_relight'],
      ]);
      expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual(
        lightingMode === 'bright'
          ? [['bright', 'global_relight']]
          : [
              ['source', 'composite_additive'],
              ['evening', 'global_relight'],
            ],
      );
    });
  }
});

describe('pre-delivery review: an evening job that ends without its relight holds its base', () => {
  async function reviewer() {
    const ownerId = (
      await base.db
        .insertInto('owners')
        .values({ id: newId(), kind: 'user' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    return (
      await base.db
        .insertInto('users')
        .values({
          id: newId(),
          ownerId,
          emailNormalized: `reviewer-${ownerId}@example.com`,
          roles: ['reviewer'],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  }

  async function reviewEveningJob(deps: PipelineDeps) {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    await reserveAsTheApi(job, true);
    return { job, projectId };
  }

  async function expectHeldAndApproved(
    deps: PipelineDeps,
    jobId: string,
    projectId: string,
    reason: 'relight_rejected' | 'relight_not_attempted',
  ) {
    expect(await readJob(base.db, jobId)).toMatchObject({ state: 'rejected' });
    expect(await assetsOf(projectId)).toEqual([]);
    const companion = await base.db
      .selectFrom('renderJobs')
      .selectAll()
      .where('idempotencyKey', '=', `relight-base:${jobId}`)
      .executeTakeFirstOrThrow();
    const attempts = await attemptsOf(jobId);
    expect(companion).toMatchObject({
      state: 'needs_review',
      lightingMode: 'source',
      projectId,
      attemptCount: 0,
    });
    expect(companion.qaPassedAt).not.toBeNull();
    expect(companion.inputSnapshot).toMatchObject({
      relightBaseOf: { jobId, attemptId: attempts[0]?.id },
    });
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      target: 'evening',
      reason,
      deliveredAs: null,
      heldJobId: companion.id,
    });
    const held = heldKeys(companion.id, attempts[0]?.id as string);
    expect(await base.storage.get('private', held.delivered)).not.toBeNull();
    expect((await ledgerOf(jobId)).open).toEqual([]);

    // Approval publishes the held base as the daylight variant.
    const asset = await approveReview(deps, {
      jobId: companion.id,
      reviewerUserId: await reviewer(),
    });
    expect(asset).toMatchObject({
      jobId: companion.id,
      lightingMode: 'source',
      fidelityMode: 'composite_additive',
    });
    expect(await readJob(base.db, companion.id)).toMatchObject({ state: 'succeeded' });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect((await attemptsOf(jobId))[0]?.outcome).toBe('succeeded');
    expect(await base.storage.get('private', held.delivered)).toBeNull();
  }

  it('the relight rejected for good', async () => {
    const vision = judgingVision((input) =>
      input.mode === 'relight' ? 'structure_changed' : null,
    );
    const deps = depsWith({ vision: vision.vision });
    const { job, projectId } = await reviewEveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'qa_rejected', 'global_relight'],
      [3, true, 'qa_rejected', 'global_relight'],
    ]);
    await expectHeldAndApproved(deps, job.id, projectId, 'relight_rejected');
  });

  it('the relight not attempted', async () => {
    const clock = steppingClock();
    const vision = judgingVision(
      () => null,
      (input) => {
        if (input.mode !== 'relight' && input.plan.attemptNumber === 1) clock.advance(200_000);
      },
    );
    const deps = depsWith({ vision: vision.vision, clock });
    const { job, projectId } = await reviewEveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
    ]);
    await expectHeldAndApproved(deps, job.id, projectId, 'relight_not_attempted');
  });

  it('the relight failed without a QA decision; a reviewer rejects the held base', async () => {
    const inner = base.providers.fixtures.vision;
    const vision: VisionModel = {
      ...inner,
      async judge(input, options) {
        if (input.mode === 'relight') {
          throw new ProviderError('fixture', 'provider_error', 'judge unavailable', {
            retryable: false,
          });
        }
        return inner.judge(input, options);
      },
    };
    const deps = depsWith({ vision });
    const { job, projectId } = await reviewEveningJob(deps);
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    const attempts = await attemptsOf(job.id);
    expect(attempts.map((a) => a.attemptNo)).toEqual([1, 2]);
    const companion = await base.db
      .selectFrom('renderJobs')
      .selectAll()
      .where('idempotencyKey', '=', `relight-base:${job.id}`)
      .executeTakeFirstOrThrow();
    expect(companion).toMatchObject({ state: 'needs_review', lightingMode: 'source' });
    expect(attempts[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'evening',
      reason: 'relight_failed',
      deliveredAs: null,
      relightAttemptId: attempts[1]?.id,
      codes: [],
      failureKind: 'provider_error',
      heldJobId: companion.id,
    });
    const held = heldKeys(companion.id, attempts[0]?.id as string);
    expect(await base.storage.get('private', held.delivered)).not.toBeNull();
    expect((await ledgerOf(job.id)).open).toEqual([]);

    const ended = await rejectReview(deps, {
      jobId: companion.id,
      reviewerUserId: await reviewer(),
      reasonCodes: ['implausible_decor'],
    });
    expect(ended).toMatchObject({ state: 'rejected', rejectionReason: 'reviewer_rejected' });
    expect(await base.storage.get('private', held.delivered)).toBeNull();
    expect(await assetsOf(projectId)).toEqual([]);
  });

  it('a worker stopped while the base is held leaves the job to its redelivery, which holds it', async () => {
    const vision = judgingVision((input) =>
      input.mode === 'relight' ? 'structure_changed' : null,
    );
    // The worker stops (the queue aborts the run) while the held base is written.
    const stop = new AbortController();
    let stopped = false;
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      async put(input) {
        if (!stopped && input.key.endsWith('/held-delivered.jpg')) {
          stopped = true;
          stop.abort();
          throw new Error('worker stopped');
        }
        return base.storage.put(input);
      },
    };
    const deps = { ...depsWith({ vision: vision.vision }), storage } as PipelineDeps;
    // A stored frame: the redelivery reloads the decorated base from storage (a transient frame's
    // base lives only in the run that rendered it).
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    await reserveAsTheApi(job, true);
    await expect(runRenderJob(deps, { renderJobId: job.id, signal: stop.signal })).rejects.toThrow(
      'worker stopped',
    );
    expect(stopped).toBe(true);
    // Nothing ended: no companion, and the evening job waits for its redelivery.
    expect((await readJob(base.db, job.id))?.state).toBe('checking');
    expect(
      await base.db
        .selectFrom('renderJobs')
        .select('id')
        .where('idempotencyKey', '=', `relight-base:${job.id}`)
        .execute(),
    ).toEqual([]);

    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('rejected');
    await expectHeldAndApproved(deps, job.id, projectId, 'relight_rejected');
  });
});

describe('a worker stopped while a relight that ended without a QA decision falls back', () => {
  /**
   * Storage that stops the worker (the queue aborts the run and the write fails) on the first
   * write of a delivered image: a published output, or a base held for review.
   */
  function stoppingStorage() {
    const stop = new AbortController();
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      async put(input) {
        if (
          !stop.signal.aborted &&
          (input.key.startsWith('outputs/') || input.key.endsWith('/held-delivered.jpg'))
        ) {
          stop.abort();
          throw new Error('worker stopped');
        }
        return base.storage.put(input);
      },
    };
    return { storage, signal: stop.signal };
  }

  /** An evening job in pre-delivery review on a stored frame (its base is stored too). */
  async function heldEveningJob(deps: PipelineDeps) {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    await reserveAsTheApi(job, true);
    return { job, projectId };
  }

  for (const lightingMode of ['bright', 'evening'] as const) {
    for (const cause of ['provider_error', 'not_sent'] as const) {
      const what =
        cause === 'provider_error'
          ? 'the relight edit failed'
          : 'the relight edit was not sent for lack of time';
      const look = lightingMode === 'bright' ? 'bright' : 'evening in pre-delivery review';
      it(`${look}: ${what}; the redelivery ${lightingMode === 'bright' ? 'delivers' : 'holds'} the base`, async () => {
        const clock = steppingClock();
        // Not sent: the base is judged when the job is 210 s old, so 15 s are left for the edit
        // after the 15 s guard, under the 20 s a relight edit needs.
        const vision = judgingVision(
          () => null,
          (input) => {
            if (cause === 'not_sent' && input.mode !== 'relight' && input.plan.attemptNumber === 1)
              clock.advance(210_000);
          },
        );
        const inner = base.providers.fixtures.imageEditor;
        const kinds: string[] = [];
        const editor: ImageEditor = {
          ...inner,
          async edit(request, input, options) {
            kinds.push(request.kind ?? 'decorate');
            if (cause === 'provider_error' && request.kind === 'relight') {
              return {
                status: 'failed',
                kind: 'provider_error',
                retryable: false,
                httpStatus: 500,
              };
            }
            return inner.edit(request, input, options);
          },
          getOperation: (operationId) => inner.getOperation(operationId),
        };
        const stopping = stoppingStorage();
        const deps = depsWith({
          imageEditor: editor,
          vision: vision.vision,
          clock,
          storage: stopping.storage,
          options: { repairBudgetMs: 5_000 },
        });
        const { job, projectId } =
          lightingMode === 'bright' ? await brightJob(deps) : await heldEveningJob(deps);
        await expect(
          runRenderJob(deps, { renderJobId: job.id, signal: stopping.signal }),
        ).rejects.toThrow('worker stopped');
        expect(stopping.signal.aborted).toBe(true);
        // The fallback had moved the job to checking; nothing ended it.
        expect((await readJob(base.db, job.id))?.state).toBe('checking');

        const result = await runRenderJob(deps, { renderJobId: job.id });
        // The redelivery sends no edit.
        expect(kinds).toEqual(cause === 'provider_error' ? ['decorate', 'relight'] : ['decorate']);
        const attempts = await attemptsOf(job.id);
        expect(summary(attempts)).toEqual([
          [1, false, 'succeeded', 'composite_additive'],
          [2, false, cause === 'provider_error' ? 'provider_error' : 'canceled', 'global_relight'],
        ]);
        const record = {
          kind: 'relight_fallback',
          target: lightingMode,
          reason: 'relight_failed',
          relightAttemptId: attempts[1]?.id,
          codes: [],
          failureKind: cause === 'provider_error' ? 'provider_error' : 'timeout',
        };
        if (lightingMode === 'bright') {
          expect(result.state).toBe('succeeded');
          expect(attempts[0]?.fallback).toEqual({ ...record, deliveredAs: 'result' });
          expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
            ['bright', 'composite_additive'],
          ]);
        } else {
          expect(result.state).toBe('rejected');
          const companion = await base.db
            .selectFrom('renderJobs')
            .selectAll()
            .where('idempotencyKey', '=', `relight-base:${job.id}`)
            .executeTakeFirstOrThrow();
          expect(companion).toMatchObject({ state: 'needs_review', lightingMode: 'source' });
          expect(attempts[0]?.fallback).toEqual({
            ...record,
            deliveredAs: null,
            heldJobId: companion.id,
          });
          const held = heldKeys(companion.id, attempts[0]?.id as string);
          expect(await base.storage.get('private', held.delivered)).not.toBeNull();
          expect(await assetsOf(projectId)).toEqual([]);
        }
        // Every reservation was settled or released exactly once over both runs.
        expect(await notClosedOnce(job.id)).toEqual([]);
        const ledger = await ledgerOf(job.id);
        expect(ledger.count('charge', 'image_edit_attempt')).toBe(0);
        expect(ledger.count('charge', 'vision_call')).toBe(0);
      });
    }
  }
});

describe('a worker stopped while a bright job delivers its base', () => {
  it('a redelivery that relights and delivers clears the fallback recorded on the base attempt', async () => {
    // The paid-attempt cap allows one attempt in the first run, so the base is delivered without
    // its relight; the worker stops while it is published. The redelivery finds room for the
    // relight.
    let capped = true;
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      get: (async (key: string) =>
        capped && key === 'quota.attempts_per_owner_24h'
          ? 1
          : base.settings.get(key as never)) as PipelineDeps['settings']['get'],
    };
    const stop = new AbortController();
    const storage: PipelineDeps['storage'] = {
      ...base.storage,
      async put(input) {
        if (!stop.signal.aborted && input.key.startsWith('outputs/')) {
          stop.abort();
          throw new Error('worker stopped');
        }
        return base.storage.put(input);
      },
    };
    const editor = recordingEditor();
    const deps = depsWith({ imageEditor: editor.editor, settings, storage });
    const { job, projectId } = await brightJob(deps);
    await expect(runRenderJob(deps, { renderJobId: job.id, signal: stop.signal })).rejects.toThrow(
      'worker stopped',
    );
    expect(stop.signal.aborted).toBe(true);
    expect((await attemptsOf(job.id))[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      reason: 'relight_not_attempted',
      deliveredAs: 'result',
    });
    expect(await assetsOf(projectId)).toEqual([]);

    capped = false;
    const result = await runRenderJob(deps, { renderJobId: job.id });
    expect(result.state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate', 'relight']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(attempts[0]?.fallback).toBeNull();
    expect(attempts[1]?.fallback).toMatchObject({
      kind: 'relight',
      baseAttemptId: attempts[0]?.id,
    });
    expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
      ['bright', 'global_relight'],
    ]);
    expect(await notClosedOnce(job.id)).toEqual([]);
  });
});

describe('the paid-attempt cap closes a relight', () => {
  /** The owner has used all but two of the paid attempts of the rolling window. */
  async function twoAttemptsLeft(ownerId: string) {
    const limit = await base.settings.get('quota.attempts_per_owner_24h');
    const now = base.clock.now();
    await recordAllowanceResidue(base.db, {
      ownerId,
      now,
      units: Array.from({ length: limit - 2 }, () => ({
        kind: 'attempt' as const,
        countedAt: new Date(now.getTime() - 3_600_000),
      })),
    });
  }

  for (const lightingMode of ['bright', 'evening'] as const) {
    it(`${lightingMode}: with one attempt allowed, the relight is not attempted`, async () => {
      const settings: PipelineDeps['settings'] = {
        ...base.settings,
        get: (async (key: string) =>
          key === 'quota.attempts_per_owner_24h'
            ? 1
            : base.settings.get(key as never)) as PipelineDeps['settings']['get'],
      };
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, settings });
      const { job, projectId } = await jobFor(lightingMode, deps);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([[1, false, 'succeeded', 'composite_additive']]);
      expect(attempts[0]?.fallback).toEqual({
        kind: 'relight_fallback',
        target: lightingMode,
        reason: 'relight_not_attempted',
        deliveredAs: lightingMode === 'bright' ? 'result' : 'daylight_variant',
        relightAttemptId: null,
        codes: [],
      });
      expect(result.state).toBe(lightingMode === 'bright' ? 'succeeded' : 'rejected');
      expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        [lightingMode === 'bright' ? 'bright' : 'source', 'composite_additive'],
      ]);
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });

    it(`${lightingMode}: base accepted, relight rejected with a repairable major: no repair, the major recorded`, async () => {
      const editor = recordingEditor();
      const vision = judgingVision(relightAttempt(2, 'implausible_decor'));
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await twoAttemptsLeft(job.ownerId);
      expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
      expect(editor.kinds()).toEqual(['decorate', 'relight']);
      expect(summary(await attemptsOf(job.id))).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'succeeded', 'global_relight'],
      ]);
      expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 2, repairUsed: false });
      const relight = await base.db
        .selectFrom('judgeResults')
        .select('majorCodes')
        .where('attemptId', '=', (await attemptsOf(job.id))[1]?.id as string)
        .where('escalated', '=', false)
        .executeTakeFirstOrThrow();
      expect(relight.majorCodes).toContain('implausible_decor');
      expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual(
        lightingMode === 'bright'
          ? [['bright', 'global_relight']]
          : [
              ['source', 'composite_additive'],
              ['evening', 'global_relight'],
            ],
      );
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });

    it(`${lightingMode}: base rejected and repaired on attempt 2: no third attempt`, async () => {
      const editor = recordingEditor();
      const vision = judgingVision(firstBase);
      const deps = depsWith({ imageEditor: editor.editor, vision: vision.vision });
      const { job, projectId } = await jobFor(lightingMode, deps);
      await twoAttemptsLeft(job.ownerId);
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate', 'decorate']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
      ]);
      expect(attempts[1]?.fallback).toEqual({
        kind: 'relight_fallback',
        target: lightingMode,
        reason: 'relight_not_attempted',
        deliveredAs: lightingMode === 'bright' ? 'result' : 'daylight_variant',
        relightAttemptId: null,
        codes: ['implausible_decor'],
      });
      expect(result.state).toBe(lightingMode === 'bright' ? 'succeeded' : 'rejected');
      expect((await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode])).toEqual([
        [lightingMode === 'bright' ? 'bright' : 'source', 'composite_additive'],
      ]);
      expect((await ledgerOf(job.id)).open).toEqual([]);
    });
  }
});

describe('the paid-attempt cap across jobs of one owner', () => {
  it('two jobs reaching the last allowed attempt together create exactly one attempt', async () => {
    // Both jobs read the cap before either counts the owner's attempts.
    const arrived: (() => void)[] = [];
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      get: (async (key: string) => {
        if (key !== 'quota.attempts_per_owner_24h') return base.settings.get(key as never);
        if (arrived.length < 2) {
          await new Promise<void>((resolve) => {
            arrived.push(resolve);
            if (arrived.length === 2) for (const release of arrived) release();
          });
        }
        return 1;
      }) as PipelineDeps['settings']['get'],
    };
    const deps = depsWith({ settings });
    const image = await readFile(HALLWAY);
    const upload = { image, fileName: 'hallway.jpg', sceneType: 'apartment_entry' as const };
    const first = await createUploadSource(deps, upload);
    const second = await createUploadSource(deps, upload);
    // The second project and its photo belong to the first owner too.
    await base.db
      .updateTable('projects')
      .set({ ownerId: first.ownerId })
      .where('id', '=', second.projectId)
      .execute();
    await base.db
      .updateTable('sourceAssets')
      .set({ ownerId: first.ownerId })
      .where('id', '=', second.source.id)
      .execute();
    const jobs = await Promise.all(
      [first, second].map(({ projectId, source }) =>
        createRenderJobRecord(deps, { ownerId: first.ownerId, projectId, source }),
      ),
    );
    const results = await Promise.all(
      jobs.map((job) => runRenderJob(deps, { renderJobId: job.id })),
    );
    expect(arrived).toHaveLength(2);
    const attempts = await base.db
      .selectFrom('renderAttempts')
      .select('jobId')
      .where(
        'jobId',
        'in',
        jobs.map((job) => job.id),
      )
      .execute();
    expect(attempts).toHaveLength(1);
    const refused = jobs.find((job) => job.id !== attempts[0]?.jobId) as RenderJob;
    expect(await readJob(base.db, refused.id)).toMatchObject({
      state: 'failed',
      failureKind: 'policy_denied',
    });
    expect(results.map((r) => r.state).sort()).toEqual(['failed', 'succeeded']);
    for (const job of jobs) expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('two bright jobs reaching their relights with one attempt left: the refused one delivers its base', async () => {
    const CAP = 'quota.attempts_per_owner_24h';
    const image = await readFile(HALLWAY);
    const upload = { image, fileName: 'hallway.jpg', sceneType: 'apartment_entry' as const };
    const first = await createUploadSource(base, upload);
    const second = await createUploadSource(base, upload);
    await base.db
      .updateTable('projects')
      .set({ ownerId: first.ownerId })
      .where('id', '=', second.projectId)
      .execute();
    await base.db
      .updateTable('sourceAssets')
      .set({ ownerId: first.ownerId })
      .where('id', '=', second.source.id)
      .execute();
    // Three attempts are left: both bases, and one relight.
    const limit = await base.settings.get(CAP);
    const now = base.clock.now();
    await recordAllowanceResidue(base.db, {
      ownerId: first.ownerId,
      now,
      units: Array.from({ length: limit - 3 }, () => ({
        kind: 'attempt' as const,
        countedAt: new Date(now.getTime() - 3_600_000),
      })),
    });
    // Each job reads the cap when it plans its base, twice after the base is judged, and when it
    // plans its relight: both wait at that fourth read until the other job reaches it too.
    const waiting: (() => void)[] = [];
    const bothRelights = () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 2) for (const go of waiting) go();
        setTimeout(resolve, 20_000);
      });
    const settingsOfOneJob = (): PipelineDeps['settings'] => {
      let reads = 0;
      return {
        ...base.settings,
        get: (async (key: string) => {
          if (key === CAP) {
            reads += 1;
            if (reads === 4) await bothRelights();
          }
          return base.settings.get(key as never);
        }) as PipelineDeps['settings']['get'],
      };
    };
    const jobs: RenderJob[] = [];
    for (const { projectId, source } of [first, second]) {
      const job = await createRenderJobRecord(base, {
        ownerId: first.ownerId,
        projectId,
        source,
        style: 'abundant',
        lightingMode: 'bright',
      });
      await reserveAsTheApi(job, false);
      jobs.push(job);
    }
    const results = await Promise.all(
      jobs.map((job) =>
        runRenderJob(depsWith({ settings: settingsOfOneJob() }), { renderJobId: job.id }),
      ),
    );
    expect(waiting).toHaveLength(2);
    expect(results.map((r) => r.state)).toEqual(['succeeded', 'succeeded']);
    const attempts = await Promise.all(jobs.map((job) => attemptsOf(job.id)));
    // The cap held: three attempts in all.
    expect(attempts.flat()).toHaveLength(3);
    const relit = attempts.findIndex((rows) => rows.length === 2);
    const refused = 1 - relit;
    expect(summary(attempts[relit] ?? [])).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
      [2, false, 'succeeded', 'global_relight'],
    ]);
    expect(summary(attempts[refused] ?? [])).toEqual([
      [1, false, 'succeeded', 'composite_additive'],
    ]);
    expect(attempts[refused]?.[0]?.fallback).toEqual({
      kind: 'relight_fallback',
      target: 'bright',
      reason: 'relight_not_attempted',
      deliveredAs: 'result',
      relightAttemptId: null,
      codes: [],
    });
    expect(
      (await assetsOf(jobs[refused]?.projectId as string)).map((a) => [
        a.lightingMode,
        a.fidelityMode,
      ]),
    ).toEqual([['bright', 'composite_additive']]);
    expect(
      (await assetsOf(jobs[relit]?.projectId as string)).map((a) => [
        a.lightingMode,
        a.fidelityMode,
      ]),
    ).toEqual([['bright', 'global_relight']]);
    for (const job of jobs) expect(await notClosedOnce(job.id)).toEqual([]);
  });
});

describe('the paid-attempt cap refuses an attempt after the job checked it', () => {
  const CAP = 'quota.attempts_per_owner_24h';

  /**
   * Settings whose paid-attempt cap refuses the attempt the job plans after `attemptsBefore`
   * attempts (the read made while the job is planning it); every other read is the real limit.
   * `job.id` is set once the job exists.
   */
  function refusingAfter(attemptsBefore: number) {
    const job = { id: '' };
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      get: (async (key: string) => {
        if (key === CAP && job.id) {
          const row = await readJob(base.db, job.id);
          if (row?.state === 'planning' && (await attemptsOf(job.id)).length === attemptsBefore) {
            return 0;
          }
        }
        return base.settings.get(key as never);
      }) as PipelineDeps['settings']['get'],
    };
    return { settings, job };
  }

  async function heldEveningJob(deps: PipelineDeps) {
    const { ownerId, projectId, source } = await createStreetViewSource(deps, {
      placeId: SHOWCASE,
    });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
      reviewMode: 'pre_delivery',
    });
    await reserveAsTheApi(job, true);
    return { job, projectId };
  }

  const looks = ['bright', 'evening', 'evening in pre-delivery review'] as const;
  type Look = (typeof looks)[number];
  const create = (look: Look, deps: PipelineDeps) =>
    look === 'evening in pre-delivery review' ? heldEveningJob(deps) : jobFor(look, deps);

  /** How the base ended the job: delivered, published as the daylight variant, or held. */
  async function expectBaseEnded(
    look: Look,
    job: RenderJob,
    projectId: string,
    state: string,
    record: Record<string, unknown>,
    baseAttemptNo: number,
  ) {
    const attempts = await attemptsOf(job.id);
    const baseAttempt = attempts.find((a) => a.attemptNo === baseAttemptNo);
    const assets = (await assetsOf(projectId)).map((a) => [a.lightingMode, a.fidelityMode]);
    if (look === 'bright') {
      expect(state).toBe('succeeded');
      expect(baseAttempt?.fallback).toEqual({ ...record, target: 'bright', deliveredAs: 'result' });
      expect(assets).toEqual([['bright', 'composite_additive']]);
    } else if (look === 'evening') {
      expect(state).toBe('rejected');
      expect(baseAttempt?.fallback).toEqual({
        ...record,
        target: 'evening',
        deliveredAs: 'daylight_variant',
      });
      expect(assets).toEqual([['source', 'composite_additive']]);
    } else {
      expect(state).toBe('rejected');
      const companion = await base.db
        .selectFrom('renderJobs')
        .selectAll()
        .where('idempotencyKey', '=', `relight-base:${job.id}`)
        .executeTakeFirstOrThrow();
      expect(companion).toMatchObject({ state: 'needs_review', lightingMode: 'source' });
      expect(baseAttempt?.fallback).toEqual({
        ...record,
        target: 'evening',
        deliveredAs: null,
        heldJobId: companion.id,
      });
      const held = heldKeys(companion.id, baseAttempt?.id as string);
      expect(await base.storage.get('private', held.delivered)).not.toBeNull();
      expect(assets).toEqual([]);
    }
    expect(await notClosedOnce(job.id)).toEqual([]);
    const ledger = await ledgerOf(job.id);
    expect(ledger.count('charge', 'image_edit_attempt')).toBe(0);
    expect(ledger.count('charge', 'vision_call')).toBe(0);
  }

  for (const look of looks) {
    it(`${look}: the relight of the accepted base is refused: the base ends the job`, async () => {
      const refusal = refusingAfter(1);
      const editor = recordingEditor();
      const deps = depsWith({ imageEditor: editor.editor, settings: refusal.settings });
      const { job, projectId } = await create(look, deps);
      refusal.job.id = job.id;
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate']);
      expect(summary(await attemptsOf(job.id))).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
      ]);
      expect(await readJob(base.db, job.id)).toMatchObject({ attemptCount: 1 });
      await expectBaseEnded(
        look,
        job,
        projectId,
        result.state,
        {
          kind: 'relight_fallback',
          reason: 'relight_not_attempted',
          relightAttemptId: null,
          codes: [],
        },
        1,
      );
      if (look === 'evening') {
        expect(await readJob(base.db, job.id)).toMatchObject({
          rejectionReason: 'qa_critical',
          failureCodes: [],
        });
      }
    });
  }

  for (const look of ['bright', 'evening'] as const) {
    it(`${look}: the relight of a repaired base is refused: the base ends the job with the first attempt's codes`, async () => {
      const refusal = refusingAfter(2);
      const editor = recordingEditor();
      const vision = judgingVision(firstBase);
      const deps = depsWith({
        imageEditor: editor.editor,
        vision: vision.vision,
        settings: refusal.settings,
      });
      const { job, projectId } = await create(look, deps);
      refusal.job.id = job.id;
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate', 'decorate']);
      expect(summary(await attemptsOf(job.id))).toEqual([
        [1, false, 'qa_rejected', 'composite_additive'],
        [2, true, 'succeeded', 'composite_additive'],
      ]);
      await expectBaseEnded(
        look,
        job,
        projectId,
        result.state,
        {
          kind: 'relight_fallback',
          reason: 'relight_not_attempted',
          relightAttemptId: null,
          codes: ['implausible_decor'],
        },
        2,
      );
      if (look === 'evening') {
        expect(await readJob(base.db, job.id)).toMatchObject({
          rejectionReason: 'qa_critical',
          failureCodes: ['implausible_decor'],
          attemptCount: 2,
        });
      }
    });

    it(`${look}: the repair of a rejected relight is refused: the base ends the job`, async () => {
      const refusal = refusingAfter(2);
      const editor = recordingEditor();
      const vision = judgingVision(relightAttempt(2, 'implausible_decor'));
      const deps = depsWith({
        imageEditor: editor.editor,
        vision: vision.vision,
        settings: refusal.settings,
      });
      const { job, projectId } = await create(look, deps);
      refusal.job.id = job.id;
      const result = await runRenderJob(deps, { renderJobId: job.id });
      expect(editor.kinds()).toEqual(['decorate', 'relight']);
      const attempts = await attemptsOf(job.id);
      expect(summary(attempts)).toEqual([
        [1, false, 'succeeded', 'composite_additive'],
        [2, false, 'qa_rejected', 'global_relight'],
      ]);
      await expectBaseEnded(
        look,
        job,
        projectId,
        result.state,
        {
          kind: 'relight_fallback',
          reason: 'relight_rejected',
          relightAttemptId: attempts[1]?.id,
          codes: ['implausible_decor'],
        },
        1,
      );
    });
  }

  it('bright: a first base that passes with no repair after it is the result when its repair is refused', async () => {
    const refusal = refusingAfter(1);
    const editor = recordingEditor();
    const vision = judgingVision(firstBase);
    const deps = depsWith({
      imageEditor: editor.editor,
      vision: vision.vision,
      settings: refusal.settings,
    });
    const { job, projectId } = await brightJob(deps);
    refusal.job.id = job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(editor.kinds()).toEqual(['decorate']);
    const attempts = await attemptsOf(job.id);
    expect(summary(attempts)).toEqual([[1, false, 'succeeded', 'composite_additive']]);
    expect(attempts[0]?.fallback).toMatchObject({
      kind: 'relight_fallback',
      target: 'bright',
      deliveredAs: 'result',
      reason: 'relight_not_attempted',
      codes: [],
    });
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['bright']);
    expect(await notClosedOnce(job.id)).toEqual([]);
  });

  it('a job with no accepted base still fails policy_denied when its repair is refused', async () => {
    const refusal = refusingAfter(1);
    const editor = recordingEditor();
    // A confident critical finding without a box: nothing the job could fall back on.
    const vision = judgingVision((input) =>
      input.mode !== 'relight' && input.plan.attemptNumber === 1 ? 'structure_changed' : null,
    );
    const deps = depsWith({
      imageEditor: editor.editor,
      vision: vision.vision,
      settings: refusal.settings,
    });
    const { job, projectId } = await brightJob(deps);
    refusal.job.id = job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(editor.kinds()).toEqual(['decorate']);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'policy_denied' });
    expect(summary(await attemptsOf(job.id))).toEqual([
      [1, false, 'qa_rejected', 'composite_additive'],
    ]);
    expect(await assetsOf(projectId)).toEqual([]);
    expect(await notClosedOnce(job.id)).toEqual([]);
  });

  it('an evening job relighting a published daylight variant still fails policy_denied', async () => {
    const editor = recordingEditor();
    const { ownerId, projectId, source } = await createStreetViewSource(base, {
      placeId: SHOWCASE,
      streetViewMode: 'persist',
    });
    const day = await createRenderJobRecord(base, { ownerId, projectId, source });
    expect((await runRenderJob(base, { renderJobId: day.id })).state).toBe('succeeded');
    const refusal = refusingAfter(0);
    const deps = depsWith({ imageEditor: editor.editor, settings: refusal.settings });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    await reserveAsTheApi(job, true);
    refusal.job.id = job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(editor.kinds()).toEqual([]);
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'policy_denied' });
    expect(await attemptsOf(job.id)).toEqual([]);
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
    expect(await notClosedOnce(job.id)).toEqual([]);
  });
});

describe('a place put on the opt-out list while its job runs', () => {
  const PLACE = 'ChIJfxHearthstoneLaneColo13';

  /** Puts the place on the opt-out list. */
  async function blockPlace() {
    await base.db
      .insertInto('blockedAddresses')
      .values({
        id: newId(),
        placeId: PLACE,
        source: 'operator',
        evidenceRef: 'test',
        createdBy: null,
      })
      .onConflict((oc) => oc.column('placeId').doNothing())
      .execute();
  }

  /** The fixture vision model; the place is blocked before the judge answers `when`. */
  function blockingVision(when: (input: JudgeInput) => boolean): VisionModel {
    const inner = base.providers.fixtures.vision;
    return {
      ...inner,
      async judge(input, options) {
        if (when(input)) await blockPlace();
        return inner.judge(input, options);
      },
    };
  }

  afterEach(async () => {
    await base.db.deleteFrom('blockedAddresses').where('placeId', '=', PLACE).execute();
  });

  it('as photographed: the accepted look is not published', async () => {
    const deps = depsWith({ vision: blockingVision(() => true) });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId: PLACE });
    const job = await createRenderJobRecord(deps, { ownerId, projectId, source });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'source_rejected' });
    expect(await assetsOf(projectId)).toEqual([]);
    expect((await ledgerOf(job.id)).open).toEqual([]);
  });

  it('evening: blocked while the relight is judged, the evening look is not published', async () => {
    const deps = depsWith({ vision: blockingVision((input) => input.mode === 'relight') });
    const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId: PLACE });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      lightingMode: 'evening',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('failed');
    expect(await readJob(base.db, job.id)).toMatchObject({ failureKind: 'source_rejected' });
    // The daylight base was published before the block; the evening look never is.
    expect((await assetsOf(projectId)).map((a) => a.lightingMode)).toEqual(['source']);
  });

  it('pre-delivery review: a look held before the block is not published by an approval', async () => {
    const deps = depsWith({});
    const { ownerId, projectId, source } = await createStreetViewSource(deps, { placeId: PLACE });
    const job = await createRenderJobRecord(deps, {
      ownerId,
      projectId,
      source,
      reviewMode: 'pre_delivery',
    });
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('needs_review');
    await blockPlace();
    const reviewerOwner = await base.db
      .insertInto('owners')
      .values({ id: newId(), kind: 'user' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const reviewerUserId = (
      await base.db
        .insertInto('users')
        .values({
          id: newId(),
          ownerId: reviewerOwner.id,
          emailNormalized: `reviewer-${reviewerOwner.id}@example.com`,
          roles: ['reviewer'],
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await expect(approveReview(deps, { jobId: job.id, reviewerUserId })).rejects.toThrow(
      'the place is on the opt-out list',
    );
    expect(await assetsOf(projectId)).toEqual([]);
    expect(await readJob(base.db, job.id)).toMatchObject({ state: 'needs_review' });
  });
});

describe('the relight sub-stage of a relit look that decorates its own base', () => {
  it('is `relight` in planning and rendering of the relight and its repair, null in checking', async () => {
    let jobId = '';
    const seen: Promise<string>[] = [];
    const observe = () =>
      seen.push(readJob(base.db, jobId).then((job) => `${job?.state}:${job?.subStage ?? '-'}`));
    const inner = base.providers.fixtures.imageEditor;
    const editor: ImageEditor = {
      ...inner,
      async edit(request, input, options) {
        observe();
        return inner.edit(request, input, options);
      },
      getOperation: (operationId) => inner.getOperation(operationId),
    };
    const vision = judgingVision(relightAttempt(2, 'structure_changed'), () => observe());
    const settings: PipelineDeps['settings'] = {
      ...base.settings,
      async get(key) {
        if (key === 'quota.attempts_per_owner_24h') observe();
        return base.settings.get(key);
      },
    };
    const deps = depsWith({ imageEditor: editor, vision: vision.vision, settings });
    const { job } = await eveningJob(deps);
    jobId = job.id;
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    // The cap is also read while checking, so repeated readings of one stage are folded.
    const stages = (await Promise.all(seen)).filter((entry, i, all) => entry !== all[i - 1]);
    expect(stages).toEqual([
      'planning:-',
      'rendering:-',
      'checking:-',
      'planning:relight',
      'rendering:relight',
      'checking:-',
      'planning:relight',
      'rendering:relight',
      'checking:-',
    ]);
  });
});
