import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../ids/index.js';
import { isPlaceBlocked } from '../../policy/index.js';
import type { VisionModel } from '../../providers/types.js';
import type { PipelineDeps } from '../context.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { runRenderJob } from './job.js';
import { terminateRenderJob } from './terminate.js';
import { readJob } from './transitions.js';

/** A fixture place whose facade the scene analysis finds blurred by its owner. */
const BLURRED = 'ChIJfxSitkaSpruceBungalow12';
const DAY_MS = 86_400_000;

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/**
 * A Street View source of the blurred fixture place. Its property gets a place ID of its own, so
 * the opt-out rows a test writes belong to that test alone.
 */
async function blurredPlace(d: PipelineDeps = deps) {
  const created = await createStreetViewSource(d, { placeId: BLURRED });
  const placeId = `ChIJownerBlurTest${newId().replaceAll('-', '')}`;
  const project = await deps.db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', created.projectId)
    .executeTakeFirstOrThrow();
  await deps.db
    .updateTable('properties')
    .set({ placeId })
    .where('id', '=', project.propertyId as string)
    .execute();
  return { ...created, placeId };
}

async function blockRowOf(placeId: string) {
  return deps.db
    .selectFrom('blockedAddresses')
    .selectAll()
    .where('placeId', '=', placeId)
    .executeTakeFirstOrThrow();
}

/** An operator block of the place that a homeowner report led to. */
async function operatorBlock(placeId: string, patch: { expiresAt?: Date; removedAt?: Date }) {
  const reportId = newId();
  await deps.db
    .insertInto('reports')
    .values({ id: reportId, targetKind: 'render', targetId: newId(), reason: 'this_is_my_home' })
    .execute();
  await deps.db
    .insertInto('blockedAddresses')
    .values({
      id: newId(),
      placeId,
      source: 'operator',
      reportId,
      evidenceRef: 'ticket-1',
      createdBy: null,
      ...patch,
    })
    .execute();
  return reportId;
}

async function renderBlurred(d: PipelineDeps, place: Awaited<ReturnType<typeof blurredPlace>>) {
  const job = await createRenderJobRecord(d, {
    ownerId: place.ownerId,
    projectId: place.projectId,
    source: place.source,
  });
  expect((await runRenderJob(d, { renderJobId: job.id })).state).toBe('failed');
  expect(await readJob(deps.db, job.id)).toMatchObject({
    failureKind: 'source_rejected',
    failureDetail: 'owner_blurred',
  });
  return job;
}

describe('the worker lists a place whose facade its owner blurred', () => {
  it('a place with no opt-out row is listed', async () => {
    const place = await blurredPlace();
    const job = await renderBlurred(deps, place);
    expect(await isPlaceBlocked(deps.db, place.placeId, deps.clock.now())).toBe(true);
    expect(await blockRowOf(place.placeId)).toMatchObject({
      source: 'google_blur_detected',
      evidenceRef: `render_job:${job.id}`,
    });
  });

  for (const lapse of ['expired', 'removed'] as const) {
    it(`a place whose earlier block was ${lapse} is listed again`, async () => {
      const place = await blurredPlace();
      const before = new Date(deps.clock.now().getTime() - DAY_MS);
      await operatorBlock(
        place.placeId,
        lapse === 'expired' ? { expiresAt: before } : { removedAt: before },
      );
      expect(await isPlaceBlocked(deps.db, place.placeId, deps.clock.now())).toBe(false);
      const job = await renderBlurred(deps, place);
      expect(await isPlaceBlocked(deps.db, place.placeId, deps.clock.now())).toBe(true);
      // The lapsed record is replaced by this detection.
      expect(await blockRowOf(place.placeId)).toMatchObject({
        source: 'google_blur_detected',
        evidenceRef: `render_job:${job.id}`,
        createdBy: null,
        reportId: null,
        expiresAt: null,
        removedAt: null,
      });
    });
  }

  for (const ended of ['canceled', 'superseded'] as const) {
    it(`a blur found by a run whose job was ${ended} meanwhile is still listed`, async () => {
      const place = await blurredPlace();
      const job = await createRenderJobRecord(deps, {
        ownerId: place.ownerId,
        projectId: place.projectId,
        source: place.source,
      });
      // The job is ended while its scene analysis is under way.
      const inner = deps.providers.fixtures.vision;
      const vision: VisionModel = {
        ...inner,
        async analyzeScene(input, options) {
          const answer = await inner.analyzeScene(input, options);
          await terminateRenderJob(deps, { jobId: job.id, to: ended });
          return answer;
        },
      };
      const withVision = {
        ...deps,
        providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, vision } },
      };
      await runRenderJob(withVision, { renderJobId: job.id });
      expect((await readJob(deps.db, job.id))?.state).toBe(ended);
      const source = await deps.db
        .selectFrom('sourceAssets')
        .select('state')
        .where('id', '=', place.source.id)
        .executeTakeFirstOrThrow();
      expect(source.state).toBe('declined');
      expect(await isPlaceBlocked(deps.db, place.placeId, deps.clock.now())).toBe(true);
    });
  }

  it('an active block keeps its own record', async () => {
    const place = await blurredPlace();
    const until = new Date(deps.clock.now().getTime() + DAY_MS);
    // The block is placed while the job runs (after its own check before the analysis), and
    // expires later.
    let reportId: string | null = null;
    const inner = deps.providers.fixtures.vision;
    const vision: VisionModel = {
      ...inner,
      async analyzeScene(input, options) {
        reportId = await operatorBlock(place.placeId, { expiresAt: until });
        return inner.analyzeScene(input, options);
      },
    };
    const withVision = {
      ...deps,
      providers: { ...deps.providers, fixtures: { ...deps.providers.fixtures, vision } },
    } as PipelineDeps;
    await renderBlurred(withVision, place);
    expect(reportId).not.toBeNull();
    expect(await blockRowOf(place.placeId)).toMatchObject({
      source: 'operator',
      evidenceRef: 'ticket-1',
      reportId,
      expiresAt: until,
      removedAt: null,
    });
  });
});
