import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { testConfig } from '../../config/index.js';
import { toJson } from '../../db/client.js';
import type { SourceAsset, ViewpointJson } from '../../db/schema.js';
import { fixturePanoramaGeometry, renderFixturePanorama } from '../../fixtures/street-view.js';
import { sha256Hex } from '../../ids/index.js';
import { createSilentLogger } from '../../logger/index.js';
import { openReservations } from '../../ledger/index.js';
import { evaluatePermission, permissionSettingsOf } from '../../policy/index.js';
import { ProviderError } from '../../providers/errors.js';
import { aimAt, frameView, framedViewOf } from '../../providers/street-view/framing.js';
import type {
  AnalyzeSceneInput,
  LocateHomeInput,
  LocateHomeResult,
  StreetViewProvider,
  StreetViewView,
  VisionCallResult,
  VisionModel,
} from '../../providers/types.js';
import { fixtureRoadHome } from '../../providers/vision/fixture.js';
import { keys } from '../../storage/keys.js';
import { providerLegsFor, type PipelineDeps } from '../context.js';
import { prepareWorkingImage } from '../imaging/working.js';
import { placePreservationHold } from '../jobs/holds.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
  fixturePlace,
  primaryViewpoint,
} from '../testing.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { frameStreetViewSource, framingDecision } from './framing.js';
import { runRenderJob } from './job.js';
import { terminateRenderJob } from './terminate.js';
import { readJob } from './transitions.js';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps({ config: testConfig({ STREET_VIEW_FRAMING: 'on' }) });
});

afterAll(async () => {
  await base.close();
});

/** A place whose wide frame shows its home small enough to zoom in on. */
const FRAMED_PLACE = 'ChIJfxOldQuarryRoadColoni19';
/** A place whose home already fills its frame (zooming in gains too little). */
const FILLED_PLACE = 'ChIJfxLanternHillColonial01';

const PARAMS = {
  marginFraction: PIPELINE_DEFAULTS.framing.marginFraction,
  minFovDeg: PIPELINE_DEFAULTS.framing.minFovDeg,
  slackBelowShare: PIPELINE_DEFAULTS.framing.slackBelowShare,
};

interface Seen {
  locate: number;
  /** The input of every locate call, in order. */
  located: LocateHomeInput[];
  subStagesAtLocate: (string | null)[];
  /** The job's sub-stage when its working image was stored (after the framing step). */
  subStagesAtWorking: (string | null)[];
  fetches: StreetViewView[];
  analyzed: AnalyzeSceneInput[];
}

/**
 * Deps whose fixture vision and Street View legs are watched: every locate call, every fetch and
 * every scene analysis is recorded, and the locate answer or a fetch can be replaced.
 */
function watched(
  deps: PipelineDeps,
  options: {
    jobId?: () => string | null;
    locate?: (
      input: LocateHomeInput,
      inner: VisionModel,
    ) => Promise<VisionCallResult<LocateHomeResult>>;
    fetch?: (view: StreetViewView, inner: StreetViewProvider) => Promise<unknown>;
    /** Replaces what a fetch returned. */
    fetched?: (view: StreetViewView, fetched: FetchedFrame) => FetchedFrame;
    /** Runs (and is awaited) before each scene analysis is sent. */
    analyze?: () => void | Promise<void>;
    /** Replaces what a scene analysis answered. */
    analysis?: (input: AnalyzeSceneInput, answer: AnalysisAnswer) => AnalysisAnswer;
  } = {},
) {
  const seen: Seen = {
    locate: 0,
    located: [],
    subStagesAtLocate: [],
    subStagesAtWorking: [],
    fetches: [],
    analyzed: [],
  };
  const innerVision = deps.providers.fixtures.vision;
  const innerStreetView = deps.providers.fixtures.streetView;
  const vision: VisionModel = {
    ...innerVision,
    async locateHome(input, callOptions) {
      seen.locate += 1;
      seen.located.push(input);
      const jobId = options.jobId?.();
      if (jobId) seen.subStagesAtLocate.push((await readJob(deps.db, jobId))?.subStage ?? null);
      return options.locate
        ? options.locate(input, innerVision)
        : innerVision.locateHome(input, callOptions);
    },
    async analyzeScene(input, callOptions) {
      seen.analyzed.push(input);
      await options.analyze?.();
      const call = await innerVision.analyzeScene(input, callOptions);
      return options.analysis ? { ...call, result: options.analysis(input, call.result) } : call;
    },
  };
  const streetView: StreetViewProvider = {
    ...innerStreetView,
    async fetchTransient(view, callOptions) {
      seen.fetches.push(view);
      if (options.fetch) await options.fetch(view, innerStreetView);
      const fetched = await innerStreetView.fetchTransient(view, callOptions);
      return options.fetched ? options.fetched(view, fetched) : fetched;
    },
  };
  const storage: PipelineDeps['storage'] = {
    ...deps.storage,
    async put(object) {
      const jobId = options.jobId?.();
      if (jobId && object.key === keys.working(jobId, 'working.png')) {
        seen.subStagesAtWorking.push((await readJob(deps.db, jobId))?.subStage ?? null);
      }
      return deps.storage.put(object);
    },
  };
  return {
    deps: {
      ...deps,
      storage,
      providers: {
        ...deps.providers,
        fixtures: { ...deps.providers.fixtures, vision, streetView },
      },
    } satisfies PipelineDeps,
    seen,
  };
}

type FetchedFrame = Awaited<ReturnType<StreetViewProvider['fetchTransient']>>;
type AnalysisAnswer = Awaited<ReturnType<VisionModel['analyzeScene']>>['result'];

/** A locate answer replacing the fixture's. */
function answering(result: LocateHomeResult) {
  return async (input: LocateHomeInput, inner: VisionModel) => ({
    ...(await inner.locateHome(input)),
    result,
  });
}

async function sourceRow(id: string): Promise<SourceAsset> {
  return base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

async function framingCharges(jobId: string) {
  return base.db
    .selectFrom('usageLedger')
    .select(['kind', 'sku', 'stage', 'units', 'unitPriceMicros', 'isFixture', 'reservationId'])
    .where('jobId', '=', jobId)
    .where('stage', '=', 'framing')
    .orderBy('sku')
    .execute();
}

/** Runs one look of a source with the watched deps; `jobId` follows the job being run. */
async function look(
  made: { ownerId: string; projectId: string; source: SourceAsset },
  options: Parameters<typeof watched>[1] & { deps?: PipelineDeps; holidayId?: 'halloween' } = {},
) {
  let current: string | null = null;
  const { deps, seen } = watched(options.deps ?? base, { ...options, jobId: () => current });
  const job = await createRenderJobRecord(deps, {
    ...made,
    source: await sourceRow(made.source.id),
    ...(options.holidayId ? { holidayId: options.holidayId } : {}),
  });
  current = job.id;
  const ended = await runRenderJob(deps, { renderJobId: job.id });
  return { state: ended.state, job: await readJob(base.db, job.id), seen };
}

/** The framed view the fixture analysis of a source's wide frame leads to. */
function expectedFramedView(viewpoint: ViewpointJson): StreetViewView {
  const wide = framedViewOf(viewpoint);
  const facade = fixturePanoramaGeometry(wide)?.targetFacade;
  if (!facade) throw new Error('the fixture frame has no facade');
  const framed = frameView(wide, facade, PARAMS);
  return { ...wide, heading: framed.heading, pitch: framed.pitch, fov: framed.fov };
}

/** The display loads counted on the property of a project. */
async function displayLoadsOf(projectId: string): Promise<number> {
  const row = await base.db
    .selectFrom('projects')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select('properties.displayLoadsIssued')
    .where('projects.id', '=', projectId)
    .executeTakeFirstOrThrow();
  return row.displayLoadsIssued;
}

/** Releases a preservation hold. */
async function releaseHold(holdId: string) {
  await base.db
    .updateTable('preservationHolds')
    .set({ releasedAt: new Date(), releaseReason: 'test' })
    .where('id', '=', holdId)
    .execute();
}

/** Removes a source's looks, so only the recorded framing decides whether it is framed again. */
async function deleteLooks(sourceAssetId: string) {
  await base.db
    .updateTable('renderAssets')
    .set({ deletedAt: new Date() })
    .where('sourceAssetId', '=', sourceAssetId)
    .execute();
}

/** The scene analyses of a source, oldest first. */
async function analysesOf(sourceAssetId: string) {
  return base.db
    .selectFrom('sceneAnalyses')
    .select(['id', 'workingChecksumSha256'])
    .where('sourceAssetId', '=', sourceAssetId)
    .orderBy('createdAt')
    .execute();
}

/** The looks (render assets that are not deleted) of a source, oldest first. */
async function looksOf(sourceAssetId: string) {
  return base.db
    .selectFrom('renderAssets')
    .select(['id', 'jobId', 'createdAt'])
    .where('sourceAssetId', '=', sourceAssetId)
    .where('deletedAt', 'is', null)
    .orderBy('createdAt')
    .execute();
}

/**
 * Inserts an unfinished render job of `source` in `state`. A project has at most one unfinished
 * job, so the job belongs to another project.
 */
async function otherUnfinishedJob(
  source: SourceAsset,
  state: 'queued' | 'rendering' | 'needs_review',
): Promise<string> {
  const other = await createStreetViewSource(base, {
    placeId: FILLED_PLACE,
    streetViewMode: 'persist',
  });
  const job = await createRenderJobRecord(base, {
    ownerId: other.ownerId,
    projectId: other.projectId,
    source,
  });
  if (state !== 'queued') {
    await base.db.updateTable('renderJobs').set({ state }).where('id', '=', job.id).execute();
  }
  return job.id;
}

/** Ends a job inserted by `otherUnfinishedJob`. */
async function endJob(jobId: string) {
  await base.db
    .updateTable('renderJobs')
    .set({ state: 'canceled', terminalAt: new Date() })
    .where('id', '=', jobId)
    .execute();
}

describe('the framing decision', () => {
  const view = { panoId: 'p', heading: 10, pitch: 2, fov: 60, width: 640, height: 640 };
  const box: NormalizedBox = [0.3, 0.3, 0.6, 0.65];

  it('frames a confident, unambiguous home and keeps the wide frame otherwise', () => {
    expect(framingDecision(view, { home: box, ambiguous: false, confidence: 0.9 })).toMatchObject({
      status: 'framed',
      box,
    });
    expect(framingDecision(view, { home: null, ambiguous: false, confidence: 0.9 })).toEqual({
      status: 'kept',
      reason: 'no_home',
      box: null,
    });
    expect(framingDecision(view, { home: null, ambiguous: true, confidence: 0.9 })).toEqual({
      status: 'kept',
      reason: 'ambiguous',
      box: null,
    });
    expect(framingDecision(view, { home: box, ambiguous: false, confidence: 0.49 })).toEqual({
      status: 'kept',
      reason: 'ambiguous',
      box,
    });
    expect(
      framingDecision(view, { home: [0.05, 0.1, 0.95, 0.9], ambiguous: false, confidence: 0.9 }),
    ).toEqual({ status: 'kept', reason: 'small_gain', box: [0.05, 0.1, 0.95, 0.9] });
  });

  it("keeps the wide frame when the home does not reach the frame's middle third", () => {
    const answer = (home: NormalizedBox) => ({ home, ambiguous: false, confidence: 0.9 });
    for (const home of [
      [0, 0.3, 0.33, 0.7],
      [0.67, 0.3, 1, 0.7],
    ] as NormalizedBox[]) {
      expect(framingDecision(view, answer(home))).toEqual({
        status: 'kept',
        reason: 'ambiguous',
        box: home,
      });
    }
    expect(framingDecision(view, answer([0.05, 0.3, 0.34, 0.7]))).toMatchObject({
      status: 'framed',
    });
    expect(framingDecision(view, answer([0.66, 0.3, 0.95, 0.7]))).toMatchObject({
      status: 'framed',
    });
  });
});

// Each case runs several looks end to end.
describe('framing a Street View source at its first look', { timeout: 120_000 }, () => {
  it('zooms in on the home, keeps the viewpoint identity and charges both calls', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideViewpoint = made.source.viewpoint!;
    const expected = expectedFramedView(wideViewpoint);
    const first = await look(made);
    expect(first.state).toBe('succeeded');

    const row = await sourceRow(made.source.id);
    const viewpoint = row.viewpoint!;
    expect(viewpoint.framing).toMatchObject({
      status: 'framed',
      heading: expected.heading,
      pitch: expected.pitch,
      fov: expected.fov,
      promptVersion: 'frame-2026.11.0',
    });
    expect(viewpoint.framing?.status === 'framed' && viewpoint.framing.zoom).toBeGreaterThan(
      PIPELINE_DEFAULTS.framing.minZoom,
    );
    // The identity of the viewpoint stays the candidate's.
    expect(viewpoint).toMatchObject({
      heading: wideViewpoint.heading,
      pitch: wideViewpoint.pitch,
      fov: wideViewpoint.fov,
    });
    expect(row.viewpointKey).toBe(made.source.viewpointKey);

    // The stored frame is the framed view's.
    const framedFrame = await renderFixturePanorama(expected);
    const stored = await base.storage.get('private', row.objectKey!);
    expect(sha256Hex(stored!.body)).toBe(framedFrame!.checksum);
    expect(row.checksumSha256).toBe(framedFrame!.checksum);
    expect(Number(row.byteLength)).toBe(framedFrame!.image.length);

    // The wide frame, then the framed view. The step's sub-stage stays until the move to
    // `analyzing` clears it.
    expect(first.seen.fetches.map((view) => view.fov)).toEqual([wideViewpoint.fov, expected.fov]);
    expect(first.seen.locate).toBe(1);
    expect(first.seen.subStagesAtLocate).toEqual(['framing']);
    expect(first.seen.subStagesAtWorking).toEqual(['framing']);
    expect(first.seen.analyzed).toHaveLength(1);
    expect(first.job?.subStage).toBeNull();

    // The analysis and the working image are of the framed frame.
    expect(first.seen.analyzed).toHaveLength(1);
    expect(first.seen.analyzed[0]?.fixture?.scene).toEqual({
      kind: 'street_view',
      panoId: expected.panoId,
      heading: expected.heading,
      fov: expected.fov,
      pitch: expected.pitch,
    });
    const working = await prepareWorkingImage(framedFrame!.image, 'street_view');
    expect(first.job?.workingChecksumSha256).toBe(working.checksum);

    // Two direct charges on the framing stage: the locate call and the framed fetch.
    expect(await framingCharges(first.job!.id)).toEqual([
      {
        kind: 'charge',
        sku: 'street_view_static_fetch',
        stage: 'framing',
        units: expect.anything(),
        unitPriceMicros: expect.anything(),
        isFixture: true,
        reservationId: null,
      },
      {
        kind: 'charge',
        sku: 'vision_call',
        stage: 'framing',
        units: expect.anything(),
        unitPriceMicros: expect.anything(),
        isFixture: true,
        reservationId: null,
      },
    ]);

    // The project shows the stored frame, so no display load is counted for it.
    expect(await displayLoadsOf(made.projectId)).toBe(0);
    expect(viewpoint.framing).not.toHaveProperty('displayIssuedAt');

    // A later look reuses the framed frame: no locate call, no fetch.
    const second = await look(made, { holidayId: 'halloween' });
    expect(second.state).toBe('succeeded');
    expect(second.seen.locate).toBe(0);
    expect(second.seen.fetches).toEqual([]);
    expect(await framingCharges(second.job!.id)).toEqual([]);
    expect(second.job?.workingChecksumSha256).toBe(working.checksum);

    // An aged framed frame is fetched again with the framed view.
    await base.db
      .updateTable('sourceAssets')
      .set({ viewpoint: toJson({ ...viewpoint, fetchedAt: '2020-01-01T00:00:00.000Z' }) })
      .where('id', '=', row.id)
      .execute();
    const aged = await look(made, { holidayId: 'halloween' });
    expect(aged.state).toBe('succeeded');
    expect(aged.seen.locate).toBe(0);
    expect(aged.seen.fetches).toEqual([expected]);
    expect((await sourceRow(made.source.id)).checksumSha256).toBe(framedFrame!.checksum);
  });

  it('records the framing of a transient source and stores nothing', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'transient',
    });
    const expected = expectedFramedView(made.source.viewpoint!);
    const first = await look(made);
    expect(first.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.objectKey).toBeNull();
    expect(row.checksumSha256).toBeNull();
    expect(row.viewpoint?.framing).toMatchObject({ status: 'framed', fov: expected.fov });
    expect(first.seen.fetches.map((view) => view.fov)).toEqual([
      made.source.viewpoint!.fov,
      expected.fov,
    ]);
    const framedFrame = await renderFixturePanorama(expected);
    const working = await prepareWorkingImage(framedFrame!.image, 'street_view');
    expect(first.job?.workingChecksumSha256).toBe(working.checksum);
    // The browser loads the framed view from the provider's display URL: one display load,
    // ledgered and counted against the property's display budget.
    expect((await framingCharges(first.job!.id)).map((line) => [line.kind, line.sku])).toEqual([
      ['charge', 'street_view_static_display'],
      ['charge', 'street_view_static_fetch'],
      ['charge', 'vision_call'],
    ]);
    expect(await displayLoadsOf(made.projectId)).toBe(1);
    // The record says that display load is issued, so it is never counted again.
    expect(row.viewpoint?.framing).toMatchObject({
      displayIssuedAt: row.viewpoint?.framing?.framedAt,
    });

    // The next look fetches the framed view directly.
    await deleteLooks(made.source.id);
    const second = await look(made, { holidayId: 'halloween' });
    expect(second.state).toBe('succeeded');
    expect(second.seen.locate).toBe(0);
    expect(second.seen.fetches).toEqual([expected]);
  });

  it('keeps the wide frame for good when zooming in gains too little', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FILLED_PLACE,
      streetViewMode: 'persist',
    });
    const first = await look(made);
    expect(first.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'small_gain' });
    expect(row.viewpoint?.framing?.box).not.toBeNull();
    expect(first.seen.fetches).toHaveLength(1);
    // The locate call is charged; nothing was fetched for the framing.
    expect((await framingCharges(first.job!.id)).map((line) => line.sku)).toEqual(['vision_call']);
    await deleteLooks(made.source.id);
    const second = await look(made, { holidayId: 'halloween' });
    expect(second.state).toBe('succeeded');
    expect(second.seen.locate).toBe(0);
  });

  const keptCases: [string, LocateHomeResult, string][] = [
    ['no home', { home: null, ambiguous: false, confidence: 0.9 }, 'no_home'],
    ['an ambiguous frame', { home: null, ambiguous: true, confidence: 0.8 }, 'ambiguous'],
    [
      'a home located with low confidence',
      { home: [0.3, 0.2, 0.7, 0.7], ambiguous: false, confidence: 0.3 },
      'ambiguous',
    ],
  ];
  for (const [name, answer, reason] of keptCases) {
    it(`keeps the wide frame for good for ${name}`, async () => {
      const made = await createStreetViewSource(base, {
        placeId: FRAMED_PLACE,
        streetViewMode: 'persist',
      });
      const first = await look(made, { locate: answering(answer) });
      expect(first.state).toBe('succeeded');
      const row = await sourceRow(made.source.id);
      expect(row.viewpoint?.framing).toMatchObject({ status: 'kept', reason, box: answer.home });
      expect(first.seen.fetches).toHaveLength(1);
      expect(row.checksumSha256).toBe(
        (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!.checksum,
      );
      await deleteLooks(made.source.id);
      const second = await look(made, { holidayId: 'halloween' });
      expect(second.seen.locate).toBe(0);
    });
  }

  it('records nothing when locating fails or the framed fetch fails, and the look goes on', async () => {
    const located = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const refused = await look(located, {
      locate: async () => {
        throw new ProviderError('fixture-vision', 'moderation_blocked', 'refused', {
          retryable: false,
        });
      },
    });
    expect(refused.state).toBe('succeeded');
    expect((await sourceRow(located.source.id)).viewpoint?.framing).toBeUndefined();
    expect(await framingCharges(refused.job!.id)).toEqual([]);

    const fetched = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideFov = fetched.source.viewpoint!.fov;
    const failing = await look(fetched, {
      fetch: async (view) => {
        if (view.fov !== wideFov) {
          throw new ProviderError('fixture-street-view', 'provider_error', 'failed', {
            retryable: false,
          });
        }
      },
    });
    expect(failing.state).toBe('succeeded');
    const row = await sourceRow(fetched.source.id);
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(row.checksumSha256).toBe(
      (await renderFixturePanorama(framedViewOf(fetched.source.viewpoint!)))!.checksum,
    );
    expect((await framingCharges(failing.job!.id)).map((line) => line.sku)).toEqual([
      'vision_call',
    ]);
    // Nothing was recorded, so the next first look tries again.
    await deleteLooks(fetched.source.id);
    const again = await look(fetched, { holidayId: 'halloween' });
    expect(again.seen.locate).toBe(1);
    expect((await sourceRow(fetched.source.id)).viewpoint?.framing?.status).toBe('framed');
  });

  it('skips while the vision provider is paused', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    // The job's own check before the Street View fetch passes; the framing's check is paused.
    let checks = 0;
    const settings = {
      ...base.settings,
      async isProviderPaused(provider: string) {
        checks += 1;
        return checks === 2 ? true : base.settings.isProviderPaused(provider);
      },
    };
    const paused = await look(made, { deps: { ...base, settings } });
    expect(paused.state).toBe('succeeded');
    expect(paused.seen.locate).toBe(0);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
  });

  it('frames a source that has a look at its next look', async () => {
    // A first look with the framing off (and the enhancement on) is made from the wide frame.
    const withLook = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideOnly = {
      ...base,
      config: {
        ...base.config,
        streetView: { ...base.config.streetView, framing: false, enhance: true },
      },
    };
    const firstJob = await createRenderJobRecord(wideOnly, { ...withLook, enhance: true });
    expect((await runRenderJob(wideOnly, { renderJobId: firstJob.id })).state).toBe('succeeded');
    const wideRow = await sourceRow(withLook.source.id);
    expect(wideRow.checksumSha256).toBe(await wideChecksum(withLook));
    const enhanced = await base.db
      .selectFrom('sourceEnhancements')
      .select(['id', 'objectKey'])
      .where('sourceAssetId', '=', withLook.source.id)
      .execute();
    expect(enhanced).toHaveLength(1);
    const picture = enhanced[0]?.objectKey ?? null;
    const analysesBefore = await analysesOf(withLook.source.id);
    expect(analysesBefore).toHaveLength(1);

    // The next look, with the first look still there, zooms in on the home.
    const expected = expectedFramedView(withLook.source.viewpoint!);
    const later = await look(withLook, { holidayId: 'halloween' });
    expect(later.state).toBe('succeeded');
    expect(later.seen.locate).toBe(1);
    const row = await sourceRow(withLook.source.id);
    expect(row.viewpoint?.framing).toMatchObject({ status: 'framed', fov: expected.fov });

    // The framed frame replaces the stored frame under the same key.
    const framedFrame = (await renderFixturePanorama(expected))!;
    expect(row.objectKey).toBe(wideRow.objectKey);
    expect(row.checksumSha256).toBe(framedFrame.checksum);
    expect(await storedChecksum(withLook.source.id)).toBe(framedFrame.checksum);

    // The enhancements of the wide frame go with it.
    expect(
      await base.db
        .selectFrom('sourceEnhancements')
        .select('id')
        .where('sourceAssetId', '=', withLook.source.id)
        .execute(),
    ).toEqual([]);
    if (picture) expect(await base.storage.head('private', picture)).toBeNull();

    // The framed frame is analyzed again: a second analysis, of the framed view.
    expect(later.seen.analyzed).toHaveLength(1);
    expect(later.seen.analyzed[0]?.fixture?.scene).toMatchObject({ fov: expected.fov });
    const analyses = await analysesOf(withLook.source.id);
    expect(analyses).toHaveLength(2);
    const working = await prepareWorkingImage(framedFrame.image, 'street_view');
    expect(later.job?.workingChecksumSha256).toBe(working.checksum);
    expect(analyses.map((analysis) => analysis.workingChecksumSha256)).toContain(working.checksum);

    // The first look stays; it was created before the record, the framed look at or after it.
    const looks = await looksOf(withLook.source.id);
    expect(looks.map((asset) => asset.jobId)).toEqual([firstJob.id, later.job!.id]);
    const framedAt = Date.parse(
      row.viewpoint?.framing?.status === 'framed' ? row.viewpoint.framing.framedAt : '',
    );
    expect(looks[0]!.createdAt.getTime()).toBeLessThan(framedAt);
    expect(looks[1]!.createdAt.getTime()).toBeGreaterThanOrEqual(framedAt);
  });

  it('never frames a held source', async () => {
    const heldSource = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const { holdId } = await placePreservationHold(base.db, {
      targetKind: 'source_asset',
      targetId: heldSource.source.id,
      reason: 'complaint_investigation',
      authorityRef: `test:${heldSource.source.id}`,
      releaseCondition: 'test',
      placedBy: null,
    });
    try {
      const held = await look(heldSource);
      expect(held.state).toBe('succeeded');
      expect(held.seen.locate).toBe(0);
      expect((await sourceRow(heldSource.source.id)).viewpoint?.framing).toBeUndefined();
    } finally {
      await base.db
        .updateTable('preservationHolds')
        .set({ releasedAt: new Date(), releaseReason: 'test' })
        .where('id', '=', holdId)
        .execute();
    }
  });

  it('loads the frame of a job that recorded its framing first', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const expected = expectedFramedView(made.source.viewpoint!);
    // Another job frames the source while this one locates the home: a slightly wider view.
    const winner = { ...expected, fov: expected.fov + 4 };
    const winnerFrame = (await renderFixturePanorama(winner))!;
    const race = await look(made, {
      locate: async (input, inner) => {
        const row = await sourceRow(made.source.id);
        await base.storage.put({
          bucket: 'private',
          key: row.objectKey!,
          body: winnerFrame.image,
          contentType: 'image/jpeg',
          provenance: {
            sourceKind: 'street_view',
            permission: { store: true, evidenceId: 'test' } as never,
          },
        });
        await base.db
          .updateTable('sourceAssets')
          .set({
            checksumSha256: winnerFrame.checksum,
            byteLength: winnerFrame.image.length,
            viewpoint: toJson({
              ...row.viewpoint!,
              fetchedAt: new Date().toISOString(),
              framing: {
                status: 'framed',
                heading: winner.heading,
                pitch: winner.pitch,
                fov: winner.fov,
                box: [0.2, 0.05, 0.75, 0.7],
                zoom: 1.2,
                promptVersion: 'frame-2026.11.0',
                model: 'other-job',
                framedAt: new Date().toISOString(),
              },
            }),
          })
          .where('id', '=', row.id)
          .execute();
        return inner.locateHome(input);
      },
    });
    expect(race.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toMatchObject({ status: 'framed', model: 'other-job' });
    expect(row.checksumSha256).toBe(winnerFrame.checksum);
    const stored = await base.storage.get('private', row.objectKey!);
    expect(sha256Hex(stored!.body)).toBe(winnerFrame.checksum);
    const working = await prepareWorkingImage(winnerFrame.image, 'street_view');
    expect(race.job?.workingChecksumSha256).toBe(working.checksum);
  });

  it('fails the look when the source is no longer ready as the framing is recorded', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const gone = await look(made, {
      locate: async (input, inner) => {
        await base.db
          .updateTable('sourceAssets')
          .set({ state: 'stale', staleAt: new Date() })
          .where('id', '=', made.source.id)
          .execute();
        return inner.locateHome(input);
      },
    });
    expect(gone.state).toBe('failed');
    expect(gone.job).toMatchObject({ failureKind: 'source_unavailable' });
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
  });
});

/** The checksum of a source's wide frame (its candidate's view). */
async function wideChecksum(made: { source: SourceAsset }): Promise<string> {
  return (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!.checksum;
}

/** The SHA-256 of the frame stored for a source, if any. */
async function storedChecksum(sourceId: string): Promise<string | null> {
  const row = await sourceRow(sourceId);
  const stored = row.objectKey ? await base.storage.get('private', row.objectKey) : null;
  return stored ? sha256Hex(stored.body) : null;
}

/** A persist source of the framed place whose wide frame is stored and has no look. */
async function storedWideSource() {
  const made = await createStreetViewSource(base, {
    placeId: FRAMED_PLACE,
    streetViewMode: 'persist',
  });
  const off = {
    ...base,
    config: { ...base.config, streetView: { ...base.config.streetView, framing: false } },
  };
  expect((await look(made, { deps: off })).state).toBe('succeeded');
  await deleteLooks(made.source.id);
  return made;
}

describe('when the framing step runs and what it leaves', { timeout: 120_000 }, () => {
  it('never frames a job redelivered past preparing', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    // The first run's locate call fails, so it goes on with the wide frame; it is stopped once
    // the analysis starts.
    const controller = new AbortController();
    const first = watched(base, {
      locate: async () => {
        throw new ProviderError('fixture-vision', 'provider_error', 'down', { retryable: false });
      },
      analyze: () => controller.abort(),
    });
    const job = await createRenderJobRecord(first.deps, {
      ...made,
      source: await sourceRow(made.source.id),
    });
    await runRenderJob(first.deps, { renderJobId: job.id, signal: controller.signal }).catch(
      () => null,
    );
    const stopped = await readJob(base.db, job.id);
    expect(stopped?.state).not.toBe('preparing');
    expect(first.seen.locate).toBe(1);

    const second = watched(base);
    expect((await runRenderJob(second.deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(second.seen.locate).toBe(0);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    expect((await readJob(base.db, job.id))?.workingChecksumSha256).toBe(
      stopped?.workingChecksumSha256,
    );
  });

  it('records nothing when the Street View provider is paused before the framed fetch', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    // The first pause check after the locate answer (the one before the framed fetch) is paused.
    let pauseNext = false;
    const settings = {
      ...base.settings,
      async isProviderPaused(provider: string) {
        if (pauseNext) {
          pauseNext = false;
          return true;
        }
        return base.settings.isProviderPaused(provider);
      },
    };
    const paused = await look(made, {
      deps: { ...base, settings },
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        pauseNext = true;
        return answer;
      },
    });
    expect(paused.state).toBe('succeeded');
    expect(paused.seen.locate).toBe(1);
    expect(paused.seen.fetches).toHaveLength(1);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    expect((await framingCharges(paused.job!.id)).map((line) => line.sku)).toEqual(['vision_call']);
  });

  it('records nothing when the framed frame does not decode', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideFov = made.source.viewpoint!.fov;
    const garbage = Buffer.from('this is not a picture');
    const result = await look(made, {
      fetched: (view, fetched) =>
        view.fov === wideFov
          ? fetched
          : { ...fetched, bytes: garbage, checksum: sha256Hex(garbage) },
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.fetches).toHaveLength(2);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(row.checksumSha256).toBe(await wideChecksum(made));
    expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'vision_call',
    ]);
  });

  it('never locates a source that a hold covers only through the held set', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const { holdId } = await placePreservationHold(base.db, {
      targetKind: 'project',
      targetId: made.projectId,
      reason: 'complaint_investigation',
      authorityRef: `test:${made.projectId}`,
      releaseCondition: 'test',
      placedBy: null,
    });
    try {
      // The hold reaches the source through its project only.
      await base.db
        .updateTable('sourceAssets')
        .set({ preservationHoldId: null })
        .where('id', '=', made.source.id)
        .execute();
      const held = await look(made);
      expect(held.state).toBe('succeeded');
      expect(held.seen.locate).toBe(0);
      expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    } finally {
      await releaseHold(holdId);
    }
  });

  it('keeps the wide frame when a hold is placed while the home is located', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    let holdId: string | null = null;
    try {
      const result = await look(made, {
        locate: async (input, inner) => {
          const answer = await inner.locateHome(input);
          holdId = (
            await placePreservationHold(base.db, {
              targetKind: 'source_asset',
              targetId: made.source.id,
              reason: 'complaint_investigation',
              authorityRef: `test:${made.source.id}`,
              releaseCondition: 'test',
              placedBy: null,
            })
          ).holdId;
          return answer;
        },
      });
      expect(result.state).toBe('succeeded');
      // The framed view was fetched; the record found the hold under the row's lock.
      expect(result.seen.fetches).toHaveLength(2);
      const row = await sourceRow(made.source.id);
      expect(row.viewpoint?.framing).toBeUndefined();
      expect(row.checksumSha256).toBe(await wideChecksum(made));
      expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
    } finally {
      if (holdId) await releaseHold(holdId);
    }
  });

  it('never locates under a permission without AI processing', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const { deps, seen } = watched(base);
    const job = await createRenderJobRecord(deps, made);
    const policy = await base.db
      .selectFrom('assetPolicies')
      .selectAll()
      .where('id', '=', made.source.assetPolicyId as string)
      .executeTakeFirstOrThrow();
    const permission = evaluatePermission({
      policy,
      capabilityState: 'fixture',
      ...permissionSettingsOf(base.config),
      now: new Date(),
      sourceKind: 'street_view',
      isGoogleImagery: made.source.isGoogleImagery,
      copyright: made.source.copyright,
    });
    expect(permission.aiProcess).toBe(true);
    const wide = (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!;
    const loaded = {
      bytes: wide.image,
      checksum: wide.checksum,
      streetViewMode: 'persist' as const,
      fetched: true,
    };
    const result = await frameStreetViewSource(deps, {
      job: { ...job, state: 'preparing' },
      source: made.source,
      loaded,
      permission: { ...permission, aiProcess: false },
      legs: await providerLegsFor(deps, 'street_view', []),
      sceneType: 'house_exterior',
      signal: new AbortController().signal,
      log: createSilentLogger(),
      checkAbort: () => undefined,
      isPaused: async () => false,
      visionProvider: () => 'fixture',
    });
    expect(seen.locate).toBe(0);
    expect(result.loaded).toBe(loaded);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
  });

  it('drops the enhancements of the wide frame when the framed frame replaces it', async () => {
    // A first look with the enhancement on and the framing off sharpens the wide frame.
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const enhancing = {
      ...base,
      config: {
        ...base.config,
        streetView: { ...base.config.streetView, framing: false, enhance: true },
      },
    };
    const job = await createRenderJobRecord(enhancing, { ...made, enhance: true });
    expect((await runRenderJob(enhancing, { renderJobId: job.id })).state).toBe('succeeded');
    const enhanced = await base.db
      .selectFrom('sourceEnhancements')
      .selectAll()
      .where('sourceAssetId', '=', made.source.id)
      .execute();
    expect(enhanced).toHaveLength(1);
    const picture = enhanced[0]?.objectKey ?? null;
    if (picture) expect(await base.storage.head('private', picture)).not.toBeNull();

    // With no look left, the next first look frames the source and replaces the stored frame.
    await deleteLooks(made.source.id);
    const framed = await look(made, { holidayId: 'halloween' });
    expect(framed.state).toBe('succeeded');
    expect((await sourceRow(made.source.id)).viewpoint?.framing?.status).toBe('framed');
    expect(
      await base.db
        .selectFrom('sourceEnhancements')
        .select('id')
        .where('sourceAssetId', '=', made.source.id)
        .execute(),
    ).toEqual([]);
    if (picture) expect(await base.storage.head('private', picture)).toBeNull();
  });

  it('never locates the home of a scene that is not a house exterior', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    await base.db
      .updateTable('sourceAssets')
      .set({ sceneType: 'apartment_entry', buildingForm: null })
      .where('id', '=', made.source.id)
      .execute();
    const result = await look(made);
    expect(result.seen.locate).toBe(0);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
  });

  it('skips a transient job whose source still has a stored frame, before any paid call', async () => {
    const made = await storedWideSource();
    const { deps, seen } = watched(base);
    const job = await createRenderJobRecord(deps, {
      ...made,
      source: await sourceRow(made.source.id),
      holidayId: 'halloween',
    });
    // The policy stops allowing storage after admission: the job runs `transient`.
    await base.db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', made.source.assetPolicyId as string)
      .execute();
    expect((await runRenderJob(deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(seen.locate).toBe(0);
    expect(await framingCharges(job.id)).toEqual([]);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
  });

  it('records nothing for a run canceled while it located the home', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    let jobId = '';
    const result = await look(made, {
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        // The job is canceled while its run, which has not seen the cancel yet, goes on.
        const job = await base.db
          .selectFrom('renderJobs')
          .select('id')
          .where('projectId', '=', made.projectId)
          .executeTakeFirstOrThrow();
        jobId = job.id;
        await terminateRenderJob(base, { jobId, to: 'canceled' });
        return answer;
      },
    });
    expect(result.state).toBe('canceled');
    expect(result.seen.fetches).toHaveLength(2);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
  });

  it('records nothing for a canceled run once the next job made a look from the wide frame', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const locating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Run A holds its locate answer; it is canceled meanwhile and keeps running.
    const a = watched(base, {
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        entered();
        await gate;
        return answer;
      },
    });
    const jobA = await createRenderJobRecord(a.deps, made);
    const runA = runRenderJob(a.deps, { renderJobId: jobA.id }).catch(() => null);
    await locating;
    await terminateRenderJob(base, { jobId: jobA.id, to: 'canceled' });
    // Job B's locate call fails: it makes a look from the wide frame.
    const b = await look(made, {
      holidayId: 'halloween',
      locate: async () => {
        throw new ProviderError('fixture-vision', 'provider_error', 'down', { retryable: false });
      },
    });
    expect(b.state).toBe('succeeded');
    open();
    await runA;
    expect((await readJob(base.db, jobA.id))?.state).toBe('canceled');
    // A's answer changes nothing: the source keeps the wide frame its only look was made from.
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(row.checksumSha256).toBe(await wideChecksum(made));
    expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
    expect((await framingCharges(jobA.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'vision_call',
    ]);
  });

  it('records the framing although a look of the source was made while the home was located', async () => {
    const made = await storedWideSource();
    const expected = expectedFramedView(made.source.viewpoint!);
    const result = await look(made, {
      holidayId: 'halloween',
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        // The earlier look is back (another run made one meanwhile and has finished).
        await base.db
          .updateTable('renderAssets')
          .set({ deletedAt: null })
          .where('sourceAssetId', '=', made.source.id)
          .execute();
        return answer;
      },
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toMatchObject({ status: 'framed', fov: expected.fov });
    expect(await storedChecksum(made.source.id)).toBe(
      (await renderFixturePanorama(expected))!.checksum,
    );
  });

  const unfinished: [string, ('queued' | 'rendering' | 'needs_review')[]][] = [
    ['queued or running', ['queued', 'rendering']],
    ['held for review', ['needs_review']],
  ];
  for (const [name, states] of unfinished) {
    it(`records nothing while another job of the source is ${name}`, async () => {
      for (const state of states) {
        const made = await storedWideSource();
        const otherJobId = await otherUnfinishedJob(made.source, state);
        const blocked = await look(made, { holidayId: 'halloween' });
        // The home is located; the record is refused under the row's lock and the look is made
        // from the frame the job loaded.
        expect(blocked.state).toBe('succeeded');
        expect(blocked.seen.locate).toBe(1);
        expect(blocked.seen.fetches.map((view) => view.fov)).toEqual([
          expectedFramedView(made.source.viewpoint!).fov,
        ]);
        const row = await sourceRow(made.source.id);
        expect(row.viewpoint?.framing).toBeUndefined();
        expect(row.checksumSha256).toBe(await wideChecksum(made));
        expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
        const wideWorking = await prepareWorkingImage(
          (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!.image,
          'street_view',
        );
        expect(blocked.job?.workingChecksumSha256).toBe(wideWorking.checksum);

        // Once that job has ended, the next look frames the source.
        await endJob(otherJobId);
        const next = await look(made, { holidayId: 'halloween' });
        expect(next.state).toBe('succeeded');
        expect((await sourceRow(made.source.id)).viewpoint?.framing?.status).toBe('framed');
      }
    });
  }

  it('times the record after a look another job finished while the framed view was fetched', async () => {
    const made = await storedWideSource();
    const wideFov = made.source.viewpoint!.fov;
    const off = {
      ...base,
      config: { ...base.config, streetView: { ...base.config.streetView, framing: false } },
    };
    let otherJobId: string | null = null;
    const result = await look(made, {
      holidayId: 'halloween',
      fetch: async (view) => {
        if (view.fov === wideFov || otherJobId) return;
        // Another job of the source makes a look from the wide frame and finishes meanwhile.
        otherJobId = await otherUnfinishedJob(made.source, 'queued');
        expect((await runRenderJob(off, { renderJobId: otherJobId })).state).toBe('succeeded');
      },
    });
    expect(result.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing?.status).toBe('framed');
    const framedAt = Date.parse(row.viewpoint?.framing?.framedAt ?? '');
    const looks = await looksOf(made.source.id);
    const other = looks.find((asset) => asset.jobId === otherJobId);
    const own = looks.find((asset) => asset.jobId === result.job!.id);
    expect(other!.createdAt.getTime()).toBeLessThan(framedAt);
    expect(own!.createdAt.getTime()).toBeGreaterThanOrEqual(framedAt);
  });

  it('gives the locate call one try', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    let calls = 0;
    const result = await look(made, {
      locate: async (input, inner) => {
        calls += 1;
        if (calls === 1) {
          throw new ProviderError('fixture-vision', 'timeout', 'slow', { retryable: true });
        }
        return inner.locateHome(input);
      },
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    expect(await framingCharges(result.job!.id)).toEqual([]);
  });

  it('records nothing when the framing record would not read back', async () => {
    const outside: NormalizedBox = [0.3, 0.2, 0.7, 1.4];
    for (const answer of [
      { home: outside, ambiguous: false, confidence: 0.9 },
      { home: outside, ambiguous: true, confidence: 0.9 },
    ]) {
      const made = await createStreetViewSource(base, {
        placeId: FRAMED_PLACE,
        streetViewMode: 'persist',
      });
      const result = await look(made, { locate: answering(answer) });
      expect(result.state).toBe('succeeded');
      // Nothing is fetched for a record that is never written.
      expect(result.seen.fetches).toHaveLength(1);
      expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
      expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
        'vision_call',
      ]);
    }
  });

  it('skips a source without a stored frame when its display budget has no room', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'transient',
    });
    const limit = await base.settings.get('rate.static_display_loads_per_address');
    const project = await base.db
      .selectFrom('projects')
      .select('propertyId')
      .where('id', '=', made.projectId)
      .executeTakeFirstOrThrow();
    await base.db
      .updateTable('properties')
      .set({ displayLoadsIssued: limit, displayLoadsWindowStartedAt: new Date() })
      .where('id', '=', project.propertyId!)
      .execute();
    const result = await look(made);
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(0);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    expect(await framingCharges(result.job!.id)).toEqual([]);
    expect(await displayLoadsOf(made.projectId)).toBe(limit);
  });
});

/** Fills the display budget of a project's property. */
async function spendDisplayBudget(projectId: string): Promise<number> {
  const limit = await base.settings.get('rate.static_display_loads_per_address');
  const project = await base.db
    .selectFrom('projects')
    .select('propertyId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  await base.db
    .updateTable('properties')
    .set({ displayLoadsIssued: limit, displayLoadsWindowStartedAt: new Date() })
    .where('id', '=', project.propertyId!)
    .execute();
  return limit;
}

describe('the display budget of a framed view', { timeout: 120_000 }, () => {
  it('records nothing when the budget fills while the home is located', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'transient',
    });
    let limit = 0;
    const result = await look(made, {
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        // The early check found room; another view of the place spends the rest meanwhile.
        limit = await spendDisplayBudget(made.projectId);
        return answer;
      },
    });
    // The record finds no room under the property's lock: nothing is recorded or ledgered and
    // the look is made from the wide frame.
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'vision_call',
    ]);
    expect(await displayLoadsOf(made.projectId)).toBe(limit);
    const wideWorking = await prepareWorkingImage(
      (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(wideWorking.checksum);
  });

  it('frames a source with a stored frame whatever its display budget', async () => {
    const made = await storedWideSource();
    const limit = await spendDisplayBudget(made.projectId);
    const result = await look(made, { holidayId: 'halloween' });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    const row = await sourceRow(made.source.id);
    const expected = expectedFramedView(made.source.viewpoint!);
    expect(row.viewpoint?.framing).toMatchObject({ status: 'framed', fov: expected.fov });
    expect(await storedChecksum(made.source.id)).toBe(
      (await renderFixturePanorama(expected))!.checksum,
    );
    // The stored frame is what the project shows: no display load is counted or ledgered.
    expect(await displayLoadsOf(made.projectId)).toBe(limit);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'vision_call',
    ]);
  });
});

/** An analysis answer that cannot tell which facade in the frame is the home. */
const noHome = (answer: AnalysisAnswer): AnalysisAnswer => ({
  ...answer,
  targetFacadeAmbiguous: true,
});

type Made = Awaited<ReturnType<typeof createStreetViewSource>>;

/** A scene analysis that refuses only the framed frame of a source (its wide frame is fine). */
function refusingFramed(made: { source: SourceAsset }) {
  const expected = expectedFramedView(made.source.viewpoint!);
  return (input: AnalyzeSceneInput, answer: AnalysisAnswer): AnalysisAnswer =>
    input.fixture?.scene?.kind === 'street_view' && input.fixture.scene.fov === expected.fov
      ? noHome(answer)
      : answer;
}

/**
 * Records on a source with a stored wide frame the framing an earlier job made at `framedAt`: the
 * framed frame is stored and the `framed` record written.
 */
async function framedByEarlierJob(made: { source: SourceAsset }, framedAt: Date) {
  const expected = expectedFramedView(made.source.viewpoint!);
  const framedFrame = (await renderFixturePanorama(expected))!;
  const row = await sourceRow(made.source.id);
  await base.storage.put({
    bucket: 'private',
    key: row.objectKey!,
    body: framedFrame.image,
    contentType: 'image/jpeg',
    provenance: {
      sourceKind: 'street_view',
      permission: { store: true, evidenceId: 'test' } as never,
    },
  });
  const framing = {
    status: 'framed' as const,
    heading: expected.heading,
    pitch: expected.pitch,
    fov: expected.fov,
    box: [0.3, 0.2, 0.7, 0.8] as NormalizedBox,
    zoom: 2,
    promptVersion: 'frame-2026.11.0',
    model: 'earlier-job',
    framedAt: framedAt.toISOString(),
  };
  await base.db
    .updateTable('sourceAssets')
    .set({
      checksumSha256: framedFrame.checksum,
      byteLength: framedFrame.image.length,
      viewpoint: toJson({ ...row.viewpoint!, framing }),
    })
    .where('id', '=', row.id)
    .execute();
  return { framing, framedFrame };
}

describe('a framed frame the analysis refuses', { timeout: 120_000 }, () => {
  it('takes the framing back and decorates the wide frame when only the framed frame is refused', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    const result = await look(made, {
      analysis: (input, answer) =>
        input.fixture?.scene?.kind === 'street_view' && input.fixture.scene.fov === expected.fov
          ? noHome(answer)
          : answer,
    });
    expect(result.state).toBe('succeeded');

    // The framing is taken back: `kept`, the box it located, and the wide frame stored again.
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'kept',
      reason: 'refused_framed',
      promptVersion: 'frame-2026.11.0',
    });
    expect(row.viewpoint?.framing?.box).not.toBeNull();
    expect(row.checksumSha256).toBe(await wideChecksum(made));
    expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));

    // The wide frame, the framed view, then the wide view again; the framed frame and then the
    // wide frame are analyzed, and the look is made from the wide frame.
    expect(result.seen.fetches.map((view) => view.fov)).toEqual([
      wideView.fov,
      expected.fov,
      wideView.fov,
    ]);
    expect(result.seen.analyzed.map((input) => input.fixture?.scene)).toEqual([
      expect.objectContaining({ fov: expected.fov }),
      expect.objectContaining({ fov: wideView.fov }),
    ]);
    const wideWorking = await prepareWorkingImage(
      (await renderFixturePanorama(wideView))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(wideWorking.checksum);
    expect((await looksOf(made.source.id)).map((asset) => asset.jobId)).toEqual([result.job!.id]);
    // One fetch more on the framing stage than a framing that stays.
    expect(await framingCharges(result.job!.id)).toEqual([
      expect.objectContaining({
        kind: 'charge',
        sku: 'street_view_static_fetch',
        reservationId: null,
      }),
      expect.objectContaining({
        kind: 'charge',
        sku: 'street_view_static_fetch',
        reservationId: null,
      }),
      expect.objectContaining({ kind: 'charge', sku: 'vision_call', reservationId: null }),
    ]);

    // The next look keeps the wide frame: no locate call, no fetch.
    const next = await look(made, { holidayId: 'halloween' });
    expect(next.state).toBe('succeeded');
    expect(next.seen.locate).toBe(0);
    expect(next.seen.fetches).toEqual([]);
    expect(next.job?.workingChecksumSha256).toBe(wideWorking.checksum);
  });

  it('takes the framing of a transient source back and fetches the wide view once', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'transient',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    const result = await look(made, {
      analysis: (input, answer) =>
        input.fixture?.scene?.kind === 'street_view' && input.fixture.scene.fov === expected.fov
          ? noHome(answer)
          : answer,
    });
    expect(result.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.objectKey).toBeNull();
    expect(row.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'refused_framed' });
    expect(result.seen.fetches.map((view) => view.fov)).toEqual([
      wideView.fov,
      expected.fov,
      wideView.fov,
    ]);
    const wideWorking = await prepareWorkingImage(
      (await renderFixturePanorama(wideView))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(wideWorking.checksum);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_display',
      'street_view_static_fetch',
      'street_view_static_fetch',
      'vision_call',
    ]);
  });

  it('declines the source when the wide frame is refused too', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const result = await look(made, { analysis: (_input, answer) => noHome(answer) });
    expect(result.state).toBe('failed');
    expect(result.job).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'facade_not_in_frame',
    });
    expect(result.seen.analyzed).toHaveLength(2);
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('declined');
    expect(row.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'refused_framed' });
    expect(await looksOf(made.source.id)).toEqual([]);
  });

  it('takes back the framing an earlier job recorded while its framed frame has no look', async () => {
    const made = await storedWideSource();
    const wideView = framedViewOf(made.source.viewpoint!);
    const { framing, framedFrame } = await framedByEarlierJob(made, new Date());

    const result = await look(made, { holidayId: 'halloween', analysis: refusingFramed(made) });
    expect(result.state).toBe('succeeded');
    // The framed frame is loaded from storage and refused; the wide view is fetched once, and its
    // analysis from the source's earlier look is reused. The look is made from the wide frame.
    expect(result.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov]);
    expect(result.seen.analyzed.map((input) => input.fixture?.scene)).toEqual([
      expect.objectContaining({ fov: framing.fov }),
    ]);
    const wideWorking = await prepareWorkingImage(
      (await renderFixturePanorama(wideView))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(wideWorking.checksum);
    const after = await sourceRow(made.source.id);
    expect(after.state).toBe('ready');
    expect(after.viewpoint?.framing).toMatchObject({
      status: 'kept',
      reason: 'refused_framed',
      box: framing.box,
      model: 'earlier-job',
    });
    expect(after.checksumSha256).toBe(await wideChecksum(made));
    expect(await storedChecksum(made.source.id)).not.toBe(framedFrame.checksum);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
    ]);
  });

  it('declines a source whose framed frame has produced a look, as before', async () => {
    const made = await storedWideSource();
    // The framing is recorded before the source's look was created, so that look was made from
    // the framed frame (deleted looks count too).
    const [earlierLook] = await base.db
      .selectFrom('renderAssets')
      .select('createdAt')
      .where('sourceAssetId', '=', made.source.id)
      .execute();
    const { framing, framedFrame } = await framedByEarlierJob(
      made,
      new Date(earlierLook!.createdAt.getTime() - 60_000),
    );

    const result = await look(made, {
      holidayId: 'halloween',
      analysis: (_input, answer) => noHome(answer),
    });
    expect(result.state).toBe('failed');
    expect(result.job).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'facade_not_in_frame',
    });
    expect(result.seen.fetches).toEqual([]);
    expect(result.seen.analyzed).toHaveLength(1);
    const after = await sourceRow(made.source.id);
    expect(after.state).toBe('declined');
    expect(after.viewpoint?.framing).toEqual(framing);
    expect(await storedChecksum(made.source.id)).toBe(framedFrame.checksum);
    expect(await framingCharges(result.job!.id)).toEqual([]);
  });

  it('stops a run superseded while the framed frame is analyzed; the next look takes it back', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    const framedChecksum = (await renderFixturePanorama(expected))!.checksum;
    let superseded = false;
    const first = await look(made, {
      analysis: refusingFramed(made),
      // Another look is requested while the framed frame is analyzed: this job is superseded.
      analyze: async () => {
        if (superseded) return;
        superseded = true;
        const job = await base.db
          .selectFrom('renderJobs')
          .select('id')
          .where('projectId', '=', made.projectId)
          .executeTakeFirstOrThrow();
        await terminateRenderJob(base, { jobId: job.id, to: 'superseded' });
      },
    });
    expect(first.job?.state).toBe('superseded');
    // The superseded run neither fetches the wide view nor declines the source.
    expect(first.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov, expected.fov]);
    expect((await framingCharges(first.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'vision_call',
    ]);
    const between = await sourceRow(made.source.id);
    expect(between.state).toBe('ready');
    expect(between.viewpoint?.framing?.status).toBe('framed');
    expect(between.checksumSha256).toBe(framedChecksum);

    // The job that replaced it meets the refused framed frame and takes the framing back.
    const next = await look(made, { holidayId: 'halloween', analysis: refusingFramed(made) });
    expect(next.state).toBe('succeeded');
    expect(next.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov]);
    const after = await sourceRow(made.source.id);
    expect(after.state).toBe('ready');
    expect(after.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'refused_framed' });
    expect(after.checksumSha256).toBe(await wideChecksum(made));
    expect((await looksOf(made.source.id)).map((asset) => asset.jobId)).toEqual([next.job!.id]);
  });

  it('takes the framing back in a job redelivered after it recorded the framing', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    // The first delivery is stopped by the queue while the framed frame is analyzed.
    const stop = new AbortController();
    const first = watched(base, { analysis: refusingFramed(made), analyze: () => stop.abort() });
    const job = await createRenderJobRecord(first.deps, {
      ...made,
      source: await sourceRow(made.source.id),
    });
    await expect(
      runRenderJob(first.deps, { renderJobId: job.id, signal: stop.signal }),
    ).rejects.toThrow();
    expect((await readJob(base.db, job.id))?.state).toBe('analyzing');
    expect(first.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov, expected.fov]);
    expect((await sourceRow(made.source.id)).viewpoint?.framing?.status).toBe('framed');

    // The redelivery meets the framed frame this job recorded in its first delivery.
    const second = watched(base, { analysis: refusingFramed(made) });
    expect((await runRenderJob(second.deps, { renderJobId: job.id })).state).toBe('succeeded');
    expect(second.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov]);
    expect(second.seen.analyzed.map((input) => input.fixture?.scene)).toContainEqual(
      expect.objectContaining({ fov: wideView.fov }),
    );
    const after = await sourceRow(made.source.id);
    expect(after.state).toBe('ready');
    expect(after.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'refused_framed' });
    expect(after.checksumSha256).toBe(await wideChecksum(made));
  });

  it('fails without declining when the wide fetch fails, and the next look takes it back', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    let wideFetches = 0;
    const first = await look(made, {
      analysis: refusingFramed(made),
      fetch: async (view) => {
        if (view.fov !== wideView.fov) return;
        wideFetches += 1;
        if (wideFetches > 1) {
          throw new ProviderError('fixture', 'provider_error', 'down', { retryable: false });
        }
      },
    });
    expect(first.state).toBe('failed');
    expect(first.job?.failureKind).toBe('source_unavailable');
    const between = await sourceRow(made.source.id);
    expect(between.state).toBe('ready');
    expect(between.viewpoint?.framing?.status).toBe('framed');
    expect(between.checksumSha256).toBe((await renderFixturePanorama(expected))!.checksum);

    const next = await look(made, { holidayId: 'halloween', analysis: refusingFramed(made) });
    expect(next.state).toBe('succeeded');
    expect(next.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov]);
    const after = await sourceRow(made.source.id);
    expect(after.state).toBe('ready');
    expect(after.viewpoint?.framing).toMatchObject({ status: 'kept', reason: 'refused_framed' });
    expect(after.checksumSha256).toBe(await wideChecksum(made));
  });

  it('declines nothing in a run superseded while it is analyzed; the next job decides', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const off = {
      ...base,
      config: { ...base.config, streetView: { ...base.config.streetView, framing: false } },
    };
    let superseded = false;
    const first = await look(made, {
      deps: off,
      analysis: (_input, answer) => noHome(answer),
      analyze: async () => {
        if (superseded) return;
        superseded = true;
        const job = await base.db
          .selectFrom('renderJobs')
          .select('id')
          .where('projectId', '=', made.projectId)
          .executeTakeFirstOrThrow();
        await terminateRenderJob(base, { jobId: job.id, to: 'superseded' });
      },
    });
    expect(first.job?.state).toBe('superseded');
    expect((await sourceRow(made.source.id)).state).toBe('ready');

    const next = await look(made, { deps: off, holidayId: 'halloween' });
    expect(next.state).toBe('failed');
    expect(next.job).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'facade_not_in_frame',
    });
    expect((await sourceRow(made.source.id)).state).toBe('declined');
  });

  it('fails without declining while a hold covers the source, before any fetch', async () => {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const expected = expectedFramedView(made.source.viewpoint!);
    let holdId: string | null = null;
    try {
      const result = await look(made, {
        analysis: refusingFramed(made),
        // The hold is placed once the framing is recorded, while the framed frame is analyzed.
        analyze: async () => {
          holdId ??= (
            await placePreservationHold(base.db, {
              targetKind: 'source_asset',
              targetId: made.source.id,
              reason: 'complaint_investigation',
              authorityRef: `test:${made.source.id}`,
              releaseCondition: 'test',
              placedBy: null,
            })
          ).holdId;
        },
      });
      expect(result.state).toBe('failed');
      expect(result.job?.failureKind).toBe('source_unavailable');
      expect(result.seen.fetches.map((view) => view.fov)).toEqual([wideView.fov, expected.fov]);
      const row = await sourceRow(made.source.id);
      expect(row.state).toBe('ready');
      expect(row.viewpoint?.framing?.status).toBe('framed');
      expect(row.checksumSha256).toBe((await renderFixturePanorama(expected))!.checksum);
    } finally {
      if (holdId) await releaseHold(holdId);
    }
  });
});

describe('the write guards of the take-back', { timeout: 120_000 }, () => {
  /**
   * Runs the first look of a new persist source whose framed frame is refused, calling `meanwhile`
   * while the take-back fetches the wide view (after its checks, before its write). Returns the
   * look, the source row as `meanwhile` left it and the framed frame's checksum.
   */
  async function guardedTakeBack(
    meanwhile: (input: { made: Made; jobId: string; row: SourceAsset }) => Promise<void>,
  ) {
    const made = await createStreetViewSource(base, {
      placeId: FRAMED_PLACE,
      streetViewMode: 'persist',
    });
    const wideView = framedViewOf(made.source.viewpoint!);
    const framedChecksum = (await renderFixturePanorama(
      expectedFramedView(made.source.viewpoint!),
    ))!.checksum;
    let wideFetches = 0;
    const meanwhileLeft: { row: SourceAsset | null } = { row: null };
    const result = await look(made, {
      analysis: refusingFramed(made),
      fetch: async (view) => {
        if (view.fov !== wideView.fov) return;
        wideFetches += 1;
        if (wideFetches !== 2) return;
        const job = await base.db
          .selectFrom('renderJobs')
          .select('id')
          .where('projectId', '=', made.projectId)
          .executeTakeFirstOrThrow();
        await meanwhile({ made, jobId: job.id, row: await sourceRow(made.source.id) });
        meanwhileLeft.row = await sourceRow(made.source.id);
      },
    });
    expect(wideFetches).toBe(2);
    const left = meanwhileLeft.row;
    if (!left) throw new Error('the take-back did not fetch the wide view');
    return { made, result, left, framedChecksum };
  }

  /** The source is as `meanwhile` left it: still ready, its framing and stored frame unchanged. */
  async function expectUnchanged(made: Made, left: SourceAsset) {
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.viewpoint?.framing).toEqual(left.viewpoint?.framing);
    expect(row.checksumSha256).toBe(left.checksumSha256);
    expect(await storedChecksum(made.source.id)).toBe(left.checksumSha256);
    expect(await looksOf(made.source.id)).toEqual([]);
  }

  it('writes nothing when a hold is placed meanwhile', async () => {
    let holdId: string | null = null;
    try {
      const { made, result, left, framedChecksum } = await guardedTakeBack(async ({ made }) => {
        holdId = (
          await placePreservationHold(base.db, {
            targetKind: 'source_asset',
            targetId: made.source.id,
            reason: 'complaint_investigation',
            authorityRef: `test:${made.source.id}`,
            releaseCondition: 'test',
            placedBy: null,
          })
        ).holdId;
      });
      expect(result.state).toBe('failed');
      expect(result.job?.failureKind).toBe('source_unavailable');
      expect(left.viewpoint?.framing?.status).toBe('framed');
      expect(left.checksumSha256).toBe(framedChecksum);
      await expectUnchanged(made, left);
    } finally {
      if (holdId) await releaseHold(holdId);
    }
  });

  it('writes nothing when the framing changed meanwhile', async () => {
    const { made, result, left } = await guardedTakeBack(async ({ made, row }) => {
      const framing = row.viewpoint!.framing!;
      await base.db
        .updateTable('sourceAssets')
        .set({
          viewpoint: toJson({
            ...row.viewpoint!,
            framing: { ...framing, framedAt: new Date(Date.now() - 1_000).toISOString() },
          }),
        })
        .where('id', '=', made.source.id)
        .execute();
    });
    expect(result.state).toBe('failed');
    expect(result.job?.failureKind).toBe('source_unavailable');
    expect(left.viewpoint?.framing?.status).toBe('framed');
    await expectUnchanged(made, left);
  });

  it('writes nothing when the stored frame changed meanwhile', async () => {
    const { made, result, left, framedChecksum } = await guardedTakeBack(async ({ made, row }) => {
      // The wide frame is stored again under the framed record.
      const other = (await renderFixturePanorama(framedViewOf(made.source.viewpoint!)))!;
      await base.storage.put({
        bucket: 'private',
        key: row.objectKey!,
        body: other.image,
        contentType: 'image/jpeg',
        provenance: {
          sourceKind: 'street_view',
          permission: { store: true, evidenceId: 'test' } as never,
        },
      });
      await base.db
        .updateTable('sourceAssets')
        .set({ checksumSha256: other.checksum, byteLength: other.image.length })
        .where('id', '=', made.source.id)
        .execute();
    });
    expect(result.state).toBe('failed');
    expect(result.job?.failureKind).toBe('source_unavailable');
    expect(left.checksumSha256).not.toBe(framedChecksum);
    await expectUnchanged(made, left);
  });

  it('writes nothing and stops when the job is canceled meanwhile', async () => {
    const { made, result, left, framedChecksum } = await guardedTakeBack(async ({ jobId }) => {
      await terminateRenderJob(base, { jobId, to: 'canceled' });
    });
    expect(result.job?.state).toBe('canceled');
    expect(left.checksumSha256).toBe(framedChecksum);
    await expectUnchanged(made, left);
  });

  it('writes nothing while another job of the source is unfinished', async () => {
    let other: string | null = null;
    try {
      const { made, result, left, framedChecksum } = await guardedTakeBack(async ({ made }) => {
        other = await otherUnfinishedJob(await sourceRow(made.source.id), 'queued');
      });
      expect(result.state).toBe('failed');
      expect(result.job?.failureKind).toBe('source_unavailable');
      expect(left.checksumSha256).toBe(framedChecksum);
      await expectUnchanged(made, left);
    } finally {
      if (other) await endJob(other);
    }
  });
});

/** The fixture place whose target point lies on the road, and its two panoramas. */
const ROAD_PLACE = 'ChIJfxMillpondRoadCapeXXX26';
const ROAD_P1 = 'fxSvMillpondRoad26p1Sv';
const ROAD_P2 = 'fxSvMillpondRoad26p2Sv';

/** A view of a road panorama as a road candidate takes it (pitch 3.8, fov 90). */
function roadView(heading: number, panoId = ROAD_P1): StreetViewView {
  return { panoId, heading, pitch: 3.8, fov: 90, width: 640, height: 640 };
}

/** A `ready` Street View source bound to a view of the road place with heading mode `road`. */
async function roadSource(
  heading: number,
  options: { panoId?: string; mode?: 'persist' | 'transient' } = {},
) {
  const view = roadView(heading, options.panoId);
  return createStreetViewSource(base, {
    placeId: ROAD_PLACE,
    streetViewMode: options.mode ?? 'persist',
    view: {
      panoId: view.panoId,
      heading: view.heading,
      pitch: view.pitch,
      fov: view.fov,
      headingMode: 'road',
    },
  });
}

/**
 * What the fixture shows and answers for a road view whose home is re-aimed: the home it first
 * locates (or `firstBox`), the re-aimed view, the home in it and the framed view of that home.
 */
function reaimedRoad(heading: number, firstBox?: NormalizedBox) {
  const road = roadView(heading);
  const first = firstBox ?? fixtureRoadHome(fixturePanoramaGeometry(road)!).home;
  if (!first) throw new Error('the road frame shows no home');
  const reaimed: StreetViewView = { ...road, heading: aimAt(road, first).heading };
  const second = fixturePanoramaGeometry(reaimed)?.targetFacade;
  if (!second) throw new Error('the re-aimed frame shows no home');
  const zoomed = frameView(reaimed, second, PARAMS);
  const framed: StreetViewView = {
    ...reaimed,
    heading: zoomed.heading,
    pitch: zoomed.pitch,
    fov: zoomed.fov,
  };
  return { road, first, reaimed, second, framed, zoom: Math.round(zoomed.zoom * 1000) / 1000 };
}

/** Locate answers in call order; a null entry (or none) leaves the fixture's own answer. */
function answers(...scripted: (LocateHomeResult | null)[]) {
  let call = 0;
  return async (input: LocateHomeInput, inner: VisionModel) => {
    const answer = await inner.locateHome(input);
    const result = scripted[call] ?? null;
    call += 1;
    return result ? { ...answer, result } : answer;
  };
}

/** The checksum of the fixture frame of a view. */
async function frameChecksum(view: StreetViewView): Promise<string> {
  return (await renderFixturePanorama(view))!.checksum;
}

/** The framing charges of a job as `[sku, kind, reservationId]`, by SKU. */
async function framingLines(jobId: string) {
  return (await framingCharges(jobId)).map((line) => [line.sku, line.kind, line.reservationId]);
}

/** The scene a fixture call was given for a view. */
function sceneOf(view: StreetViewView) {
  return {
    kind: 'street_view',
    panoId: view.panoId,
    heading: view.heading,
    fov: view.fov,
    pitch: view.pitch,
  };
}

/** Expects a job refused at once in `preparing`, with nothing recorded and the source ready. */
async function expectRefusedAtOnce(
  made: Made,
  result: Awaited<ReturnType<typeof look>>,
  calls: { locate: number; fetches: number },
) {
  expect(result.state).toBe('failed');
  expect(result.job).toMatchObject({
    failureKind: 'source_rejected',
    failureDetail: 'facade_not_in_frame',
    subStage: null,
    sceneAnalysisId: null,
    workingObjectKey: null,
  });
  expect(result.seen.locate).toBe(calls.locate);
  expect(result.seen.fetches).toHaveLength(calls.fetches);
  // No working image, no analysis, no attempt, no enhancement.
  expect(result.seen.analyzed).toEqual([]);
  expect(await analysesOf(made.source.id)).toEqual([]);
  expect(
    await base.storage.head('private', keys.working(result.job!.id, 'working.png')),
  ).toBeNull();
  expect(
    await base.db
      .selectFrom('renderAttempts')
      .select('id')
      .where('jobId', '=', result.job!.id)
      .execute(),
  ).toEqual([]);
  expect(
    await base.db
      .selectFrom('sourceEnhancements')
      .select('id')
      .where('sourceAssetId', '=', made.source.id)
      .execute(),
  ).toEqual([]);
  expect(await openReservations(base.db, result.job!.id)).toEqual([]);
  // The source is not declined and records nothing: the same view can be asked for again.
  const row = await sourceRow(made.source.id);
  expect(row.state).toBe('ready');
  expect(row.declinedCode).toBeNull();
  expect(row.viewpoint?.framing).toBeUndefined();
  expect(await looksOf(made.source.id)).toEqual([]);
}

describe('framing a view taken from the road', { timeout: 120_000 }, () => {
  it('frames a home in the middle without a re-aim', async () => {
    const made = await roadSource(152);
    const road = roadView(152);
    const box = fixtureRoadHome(fixturePanoramaGeometry(road)!).home!;
    const zoomed = frameView(road, box, PARAMS);
    const framed = { ...road, heading: zoomed.heading, pitch: zoomed.pitch, fov: zoomed.fov };
    const result = await look(made);
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    expect(result.seen.located[0]?.target).toBe('road');
    expect(result.seen.fetches).toEqual([road, framed]);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'framed',
      heading: framed.heading,
      pitch: framed.pitch,
      fov: framed.fov,
      box,
      promptVersion: 'frame-road-2026.11.0',
    });
    expect(row.viewpoint?.framing).not.toHaveProperty('reaim');
    expect(row.viewpoint?.framing).not.toHaveProperty('reason');
    expect(await storedChecksum(made.source.id)).toBe(await frameChecksum(framed));
    expect(await framingLines(result.job!.id)).toEqual([
      ['street_view_static_fetch', 'charge', null],
      ['vision_call', 'charge', null],
    ]);
  });

  it('turns to a home off to one side, then frames it', async () => {
    const made = await roadSource(123);
    const expected = reaimedRoad(123);
    const result = await look(made);
    expect(result.state).toBe('succeeded');

    // The first call asks for the home anywhere in the road frame; the second, with the
    // ordinary prompt, for the home in the re-aimed frame.
    expect(result.seen.located).toHaveLength(2);
    const [first, second] = result.seen.located;
    expect(first?.target).toBe('road');
    expect(sha256Hex(Buffer.from(first!.image.bytes))).toBe(await frameChecksum(expected.road));
    expect(first?.fixture?.scene).toEqual(sceneOf(expected.road));
    expect(second).not.toHaveProperty('target');
    expect(sha256Hex(Buffer.from(second!.image.bytes))).toBe(await frameChecksum(expected.reaimed));
    expect(second?.fixture?.scene).toEqual(sceneOf(expected.reaimed));

    // The road view, the re-aimed view (same panorama, pitch and fov), then the framed view.
    expect(result.seen.fetches).toEqual([expected.road, expected.reaimed, expected.framed]);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toEqual({
      status: 'framed',
      heading: expected.framed.heading,
      pitch: expected.framed.pitch,
      fov: expected.framed.fov,
      box: expected.second,
      zoom: expected.zoom,
      promptVersion: 'frame-2026.11.0',
      model: expect.any(String),
      framedAt: expect.any(String),
      reaim: {
        heading: expected.reaimed.heading,
        box: expected.first,
        promptVersion: 'frame-road-2026.11.0',
      },
    });
    // The viewpoint's identity stays the candidate's.
    expect(row.viewpoint).toMatchObject({ heading: 123, pitch: 3.8, fov: 90, headingMode: 'road' });
    expect(row.viewpointKey).toBe(made.source.viewpointKey);

    // The stored frame and the working image are the framed view's, analyzed once.
    const framedFrame = (await renderFixturePanorama(expected.framed))!;
    expect(await storedChecksum(made.source.id)).toBe(framedFrame.checksum);
    expect(row.checksumSha256).toBe(framedFrame.checksum);
    const working = await prepareWorkingImage(framedFrame.image, 'street_view');
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
    expect(result.seen.analyzed.map((input) => input.fixture?.scene)).toEqual([
      sceneOf(expected.framed),
    ]);

    // Two fetches and two calls, each charged directly on the framing stage.
    expect(await framingLines(result.job!.id)).toEqual([
      ['street_view_static_fetch', 'charge', null],
      ['street_view_static_fetch', 'charge', null],
      ['vision_call', 'charge', null],
      ['vision_call', 'charge', null],
    ]);

    // A later look reuses the framed frame: no call, no fetch.
    const next = await look(made, { holidayId: 'halloween' });
    expect(next.state).toBe('succeeded');
    expect(next.seen.locate).toBe(0);
    expect(next.seen.fetches).toEqual([]);
    expect(await framingCharges(next.job!.id)).toEqual([]);
  });

  it('turns to a home the edge cuts, then frames it', async () => {
    const made = await roadSource(109.9);
    const expected = reaimedRoad(109.9);
    expect(expected.first[2]).toBe(1);
    expect(Math.abs(expected.reaimed.heading - 149.6)).toBeLessThan(1);
    const result = await look(made);
    expect(result.state).toBe('succeeded');
    expect(result.seen.located.map((input) => input.target ?? null)).toEqual(['road', null]);
    expect(result.seen.fetches).toEqual([expected.road, expected.reaimed, expected.framed]);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toMatchObject({
      status: 'framed',
      heading: expected.framed.heading,
      fov: expected.framed.fov,
      box: expected.second,
      promptVersion: 'frame-2026.11.0',
      reaim: { heading: expected.reaimed.heading, box: expected.first },
    });
  });

  it('turns to a home the edge cuts although it reaches the middle third', async () => {
    const made = await roadSource(152);
    const cut: NormalizedBox = [0.45, 0.3, 1, 0.7];
    const expected = reaimedRoad(152, cut);
    const result = await look(made, {
      locate: answers({ home: cut, ambiguous: false, confidence: 0.9 }),
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(2);
    expect(result.seen.fetches.slice(0, 2)).toEqual([expected.road, expected.reaimed]);
    expect(expected.reaimed.heading).toBe(aimAt(expected.road, cut).heading);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toMatchObject({
      status: 'framed',
      reaim: { heading: expected.reaimed.heading, box: cut },
    });
  });

  it('ends at once in a view without a home, and declines nothing', async () => {
    const made = await roadSource(332);
    expect(fixturePanoramaGeometry(roadView(332))?.targetFacade).toBeUndefined();
    const first = await look(made);
    await expectRefusedAtOnce(made, first, { locate: 1, fetches: 1 });
    expect(first.seen.located[0]?.target).toBe('road');
    expect(first.seen.fetches).toEqual([roadView(332)]);
    expect(await framingLines(first.job!.id)).toEqual([['vision_call', 'charge', null]]);

    // The road frame stays the stored frame.
    expect(await storedChecksum(made.source.id)).toBe(await frameChecksum(roadView(332)));

    // The same view asked for again runs the step again on the stored frame and ends the same
    // way.
    const again = await look(made, { holidayId: 'halloween' });
    await expectRefusedAtOnce(made, again, { locate: 1, fetches: 0 });
    expect(again.seen.located[0]?.target).toBe('road');
    expect(await framingLines(again.job!.id)).toEqual([['vision_call', 'charge', null]]);
  });

  it('frames the home at a later look of a source whose view was refused', async () => {
    // The first look is answered no home and refused; the next look gets the fixture's own
    // answer (the home in the middle) and frames it.
    const made = await roadSource(152);
    const refused = await look(made, {
      locate: answers({ home: null, ambiguous: false, confidence: 0.9 }),
    });
    await expectRefusedAtOnce(made, refused, { locate: 1, fetches: 1 });
    const next = await look(made, { holidayId: 'halloween' });
    expect(next.state).toBe('succeeded');
    expect(next.seen.locate).toBe(1);
    expect((await sourceRow(made.source.id)).viewpoint?.framing?.status).toBe('framed');
  });

  it('ends at once for two equal homes', async () => {
    const made = await roadSource(192.3, { panoId: ROAD_P2 });
    const result = await look(made);
    await expectRefusedAtOnce(made, result, { locate: 1, fetches: 1 });
    expect(await framingLines(result.job!.id)).toEqual([['vision_call', 'charge', null]]);
  });

  it('ends at once for a home in the middle located with too little confidence', async () => {
    const made = await roadSource(152);
    const box = fixtureRoadHome(fixturePanoramaGeometry(roadView(152))!).home!;
    const result = await look(made, {
      locate: answers({ home: box, ambiguous: false, confidence: 0.3 }),
    });
    await expectRefusedAtOnce(made, result, { locate: 1, fetches: 1 });
  });

  it('keeps the road frame of a home in the middle that already fills it', async () => {
    const made = await roadSource(152);
    const filling: NormalizedBox = [0.05, 0.1, 0.95, 0.9];
    const result = await look(made, {
      locate: answers({ home: filling, ambiguous: false, confidence: 0.9 }),
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    expect(result.seen.fetches).toEqual([roadView(152)]);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toMatchObject({
      status: 'kept',
      reason: 'small_gain',
      box: filling,
      promptVersion: 'frame-road-2026.11.0',
    });
  });

  it('makes the re-aimed frame the source frame when zooming in gains too little', async () => {
    const made = await roadSource(109.9);
    const expected = reaimedRoad(109.9);
    const filling: NormalizedBox = [0.05, 0.1, 0.95, 0.9];
    const result = await look(made, {
      locate: answers(null, { home: filling, ambiguous: false, confidence: 0.9 }),
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(2);
    // No third fetch: the re-aimed frame is the source's frame.
    expect(result.seen.fetches).toEqual([expected.road, expected.reaimed]);
    const row = await sourceRow(made.source.id);
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'framed',
      heading: expected.reaimed.heading,
      pitch: 3.8,
      fov: 90,
      box: filling,
      zoom: 1,
      reason: 'small_gain',
      promptVersion: 'frame-2026.11.0',
      reaim: {
        heading: expected.reaimed.heading,
        box: expected.first,
        promptVersion: 'frame-road-2026.11.0',
      },
    });
    const reaimedFrame = (await renderFixturePanorama(expected.reaimed))!;
    expect(await storedChecksum(made.source.id)).toBe(reaimedFrame.checksum);
    expect(result.seen.analyzed.map((input) => input.fixture?.scene)).toEqual([
      sceneOf(expected.reaimed),
    ]);
    const working = await prepareWorkingImage(reaimedFrame.image, 'street_view');
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
    expect(await framingLines(result.job!.id)).toEqual([
      ['street_view_static_fetch', 'charge', null],
      ['vision_call', 'charge', null],
      ['vision_call', 'charge', null],
    ]);
  });

  const disagreeing: [string, LocateHomeResult][] = [
    ['no home', { home: null, ambiguous: false, confidence: 0.9 }],
    ['an ambiguous frame', { home: null, ambiguous: true, confidence: 0.9 }],
    ['a home off to one side', { home: [0.7, 0.3, 0.95, 0.7], ambiguous: false, confidence: 0.9 }],
    [
      'a home located with too little confidence',
      { home: [0.4, 0.4, 0.65, 0.65], ambiguous: false, confidence: 0.3 },
    ],
  ];
  for (const [name, second] of disagreeing) {
    it(`ends at once when the re-aimed frame shows ${name}`, async () => {
      const made = await roadSource(109.9);
      const expected = reaimedRoad(109.9);
      const result = await look(made, { locate: answers(null, second) });
      // One re-aim at most: two calls and two fetches, then the refusal.
      await expectRefusedAtOnce(made, result, { locate: 2, fetches: 2 });
      expect(result.seen.fetches).toEqual([expected.road, expected.reaimed]);
      expect(await framingLines(result.job!.id)).toEqual([
        ['street_view_static_fetch', 'charge', null],
        ['vision_call', 'charge', null],
        ['vision_call', 'charge', null],
      ]);
    });
  }

  it('records the framing of a transient road source and counts one display load', async () => {
    const made = await roadSource(109.9, { mode: 'transient' });
    const expected = reaimedRoad(109.9);
    const result = await look(made);
    expect(result.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.objectKey).toBeNull();
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'framed',
      fov: expected.framed.fov,
      reaim: { heading: expected.reaimed.heading },
      displayIssuedAt: row.viewpoint?.framing?.framedAt,
    });
    expect(await framingLines(result.job!.id)).toEqual([
      ['street_view_static_display', 'charge', null],
      ['street_view_static_fetch', 'charge', null],
      ['street_view_static_fetch', 'charge', null],
      ['vision_call', 'charge', null],
      ['vision_call', 'charge', null],
    ]);
    expect(await displayLoadsOf(made.projectId)).toBe(1);
  });
});

describe('what stops a road re-aim', { timeout: 120_000 }, () => {
  /**
   * Settings whose `nth` provider pause check after the first locate answer is paused: the
   * Street View check before the re-aim fetch is the first, the vision check before the second
   * call the second.
   */
  function pausedAfterFirstAnswer(nth: number) {
    let counting = false;
    let checks = 0;
    const settings = {
      ...base.settings,
      async isProviderPaused(provider: string) {
        if (counting) {
          checks += 1;
          if (checks === nth) return true;
        }
        return base.settings.isProviderPaused(provider);
      },
    };
    const locate = async (input: LocateHomeInput, inner: VisionModel) => {
      const answer = await inner.locateHome(input);
      counting = true;
      return answer;
    };
    return { deps: { ...base, settings }, locate };
  }

  const failure = () =>
    new ProviderError('fixture-street-view', 'provider_error', 'down', { retryable: false });

  const cases: [
    string,
    (expected: ReturnType<typeof reaimedRoad>) => Parameters<typeof look>[1],
    string[],
  ][] = [
    [
      'Street View paused before the re-aim fetch',
      () => pausedAfterFirstAnswer(1),
      ['vision_call'],
    ],
    [
      'the re-aim fetch fails',
      (expected) => ({
        fetch: async (view) => {
          if (view.heading === expected.reaimed.heading) throw failure();
        },
      }),
      ['vision_call'],
    ],
    [
      'the re-aimed frame does not decode',
      (expected) => ({
        fetched: (view, fetched) =>
          view.heading === expected.reaimed.heading
            ? { ...fetched, bytes: Buffer.from('not a picture') }
            : fetched,
      }),
      ['street_view_static_fetch', 'vision_call'],
    ],
    [
      'vision paused before the second call',
      () => pausedAfterFirstAnswer(2),
      ['street_view_static_fetch', 'vision_call'],
    ],
    [
      'the second call fails',
      () => {
        let calls = 0;
        return {
          locate: async (input, inner) => {
            calls += 1;
            if (calls === 2) throw failure();
            return inner.locateHome(input);
          },
        };
      },
      ['street_view_static_fetch', 'vision_call'],
    ],
    [
      'the framed fetch fails',
      (expected) => ({
        fetch: async (view) => {
          if (view.fov === expected.framed.fov) throw failure();
        },
      }),
      ['street_view_static_fetch', 'vision_call', 'vision_call'],
    ],
    [
      'the first call fails',
      () => ({
        locate: async () => {
          throw failure();
        },
      }),
      [],
    ],
  ];
  for (const [name, options, charged] of cases) {
    it(`ends the look as a provider failure, declining and recording nothing, when ${name}`, async () => {
      const made = await roadSource(109.9);
      const expected = reaimedRoad(109.9);
      const result = await look(made, options(expected));
      expect(result.state).toBe('failed');
      expect(result.job).toMatchObject({
        failureKind: 'provider_error',
        failureDetail: null,
        sceneAnalysisId: null,
      });
      expect(result.seen.analyzed).toEqual([]);
      const row = await sourceRow(made.source.id);
      expect(row.state).toBe('ready');
      expect(row.declinedCode).toBeNull();
      expect(row.viewpoint?.framing).toBeUndefined();
      expect(await storedChecksum(made.source.id)).toBe(await frameChecksum(expected.road));
      expect(await openReservations(base.db, result.job!.id)).toEqual([]);
      // The calls and fetches that were made stay charged.
      expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual(charged);
    });
  }

  it('goes on with the road frame when only the framed fetch fails and no re-aim was needed', async () => {
    const made = await roadSource(152);
    const road = roadView(152);
    const result = await look(made, {
      fetch: async (view) => {
        if (view.fov !== road.fov) throw failure();
      },
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    expect(result.seen.fetches).toHaveLength(2);
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(await storedChecksum(made.source.id)).toBe(await frameChecksum(road));
    const working = await prepareWorkingImage(
      (await renderFixturePanorama(road))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual(['vision_call']);
  });

  /** A persist road source whose first look was made from its road frame, with no framing. */
  async function roadSourceWithLook(heading: number) {
    const made = await roadSource(heading);
    const off = {
      ...base,
      config: { ...base.config, streetView: { ...base.config.streetView, framing: false } },
    };
    expect((await look(made, { deps: off })).state).toBe('succeeded');
    expect(await looksOf(made.source.id)).toHaveLength(1);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toBeUndefined();
    return made;
  }

  /** Expects a later look of a road source with a look made from its road frame, recording nothing. */
  async function expectWentOnWithRoadFrame(
    made: Made,
    result: Awaited<ReturnType<typeof look>>,
    heading: number,
  ) {
    expect(result.state).toBe('succeeded');
    expect(result.seen.locate).toBe(1);
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.declinedCode).toBeNull();
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(await storedChecksum(made.source.id)).toBe(await frameChecksum(roadView(heading)));
    const working = await prepareWorkingImage(
      (await renderFixturePanorama(roadView(heading)))!.image,
      'street_view',
    );
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
    expect(await looksOf(made.source.id)).toHaveLength(2);
  }

  it('goes on with the road frame of a source that has a look when no single home is settled', async () => {
    const made = await roadSourceWithLook(109.9);
    const result = await look(made, {
      holidayId: 'halloween',
      locate: answers({ home: null, ambiguous: true, confidence: 0.9 }),
    });
    await expectWentOnWithRoadFrame(made, result, 109.9);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual(['vision_call']);
  });

  it('goes on with the road frame of a source that has a look when the first call fails', async () => {
    const made = await roadSourceWithLook(109.9);
    const result = await look(made, {
      holidayId: 'halloween',
      locate: async () => {
        throw failure();
      },
    });
    await expectWentOnWithRoadFrame(made, result, 109.9);
    expect(await framingCharges(result.job!.id)).toEqual([]);
  });

  it('declines nothing for a run canceled while it located no home', async () => {
    const made = await roadSource(332);
    const result = await look(made, {
      locate: async (input, inner) => {
        const answer = await inner.locateHome(input);
        const job = await base.db
          .selectFrom('renderJobs')
          .select('id')
          .where('projectId', '=', made.projectId)
          .executeTakeFirstOrThrow();
        await terminateRenderJob(base, { jobId: job.id, to: 'canceled' });
        return answer;
      },
    });
    expect(result.state).toBe('canceled');
    expect(result.job).toMatchObject({ state: 'canceled', failureKind: null });
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.viewpoint?.framing).toBeUndefined();
    expect(await openReservations(base.db, result.job!.id)).toEqual([]);
  });
});

describe('a re-aimed frame the analysis refuses', { timeout: 120_000 }, () => {
  /** An analysis that refuses only the zoomed frame of a re-aimed road view. */
  function refusingZoomed(expected: ReturnType<typeof reaimedRoad>) {
    return (input: AnalyzeSceneInput, answer: AnalysisAnswer): AnalysisAnswer =>
      input.fixture?.scene?.kind === 'street_view' &&
      input.fixture.scene.fov === expected.framed.fov
        ? noHome(answer)
        : answer;
  }

  it('goes back to the re-aimed frame, not the road frame', async () => {
    const made = await roadSource(109.9);
    const expected = reaimedRoad(109.9);
    const result = await look(made, { analysis: refusingZoomed(expected) });
    expect(result.state).toBe('succeeded');
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('ready');
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'framed',
      heading: expected.reaimed.heading,
      pitch: 3.8,
      fov: 90,
      box: expected.second,
      zoom: 1,
      reason: 'refused_framed',
      reaim: {
        heading: expected.reaimed.heading,
        box: expected.first,
        promptVersion: 'frame-road-2026.11.0',
      },
    });
    expect(row.viewpoint?.framing).not.toHaveProperty('displayIssuedAt');
    expect(result.seen.fetches).toEqual([
      expected.road,
      expected.reaimed,
      expected.framed,
      expected.reaimed,
    ]);
    const reaimedFrame = (await renderFixturePanorama(expected.reaimed))!;
    expect(await storedChecksum(made.source.id)).toBe(reaimedFrame.checksum);
    expect(result.seen.analyzed.map((input) => input.fixture?.scene)).toEqual([
      sceneOf(expected.framed),
      sceneOf(expected.reaimed),
    ]);
    const working = await prepareWorkingImage(reaimedFrame.image, 'street_view');
    expect(result.job?.workingChecksumSha256).toBe(working.checksum);
    expect((await framingCharges(result.job!.id)).map((line) => line.sku)).toEqual([
      'street_view_static_fetch',
      'street_view_static_fetch',
      'street_view_static_fetch',
      'vision_call',
      'vision_call',
    ]);
  });

  it('declines the source when the re-aimed frame is refused too', async () => {
    const made = await roadSource(109.9);
    const expected = reaimedRoad(109.9);
    const result = await look(made, { analysis: (_input, answer) => noHome(answer) });
    expect(result.state).toBe('failed');
    expect(result.job).toMatchObject({
      failureKind: 'source_rejected',
      failureDetail: 'facade_not_in_frame',
    });
    expect(result.seen.analyzed).toHaveLength(2);
    // One take-back fetch, of the re-aimed view.
    expect(result.seen.fetches).toEqual([
      expected.road,
      expected.reaimed,
      expected.framed,
      expected.reaimed,
    ]);
    const row = await sourceRow(made.source.id);
    expect(row.state).toBe('declined');
    expect(row.viewpoint?.framing).toMatchObject({
      status: 'framed',
      heading: expected.reaimed.heading,
      zoom: 1,
      reason: 'refused_framed',
    });
  });

  it('declines a re-aimed frame at zoom 1 the analysis refuses, with nothing to take back', async () => {
    const made = await roadSource(109.9);
    const expected = reaimedRoad(109.9);
    const result = await look(made, {
      locate: answers(null, { home: [0.05, 0.1, 0.95, 0.9], ambiguous: false, confidence: 0.9 }),
      analysis: (_input, answer) => noHome(answer),
    });
    expect(result.state).toBe('failed');
    expect(result.job?.failureDetail).toBe('facade_not_in_frame');
    expect(result.seen.fetches).toEqual([expected.road, expected.reaimed]);
    expect(result.seen.analyzed).toHaveLength(1);
    expect((await sourceRow(made.source.id)).state).toBe('declined');
  });

  it('takes a road framing without a re-aim back to the road frame', async () => {
    const made = await roadSource(152);
    const road = roadView(152);
    const box = fixtureRoadHome(fixturePanoramaGeometry(road)!).home!;
    const zoomed = frameView(road, box, PARAMS);
    const result = await look(made, {
      analysis: (input, answer) =>
        input.fixture?.scene?.kind === 'street_view' && input.fixture.scene.fov === zoomed.fov
          ? noHome(answer)
          : answer,
    });
    expect(result.state).toBe('succeeded');
    expect(result.seen.fetches.map((view) => [view.heading, view.fov])).toEqual([
      [152, 90],
      [zoomed.heading, zoomed.fov],
      [152, 90],
    ]);
    expect((await sourceRow(made.source.id)).viewpoint?.framing).toMatchObject({
      status: 'kept',
      reason: 'refused_framed',
      promptVersion: 'frame-road-2026.11.0',
    });
  });
});

describe('views aimed at the place keep their rules', { timeout: 120_000 }, () => {
  for (const headingMode of ['point', 'geometry'] as const) {
    async function aimedSource() {
      const primary = await primaryViewpoint(base, fixturePlace(FRAMED_PLACE));
      const { panoId, heading, pitch, fov } = primary.viewpoint;
      return createStreetViewSource(base, {
        placeId: FRAMED_PLACE,
        streetViewMode: 'persist',
        view: { panoId, heading, pitch, fov, headingMode },
      });
    }

    it(`keeps a ${headingMode} frame whose home is off to one side, without a re-aim`, async () => {
      const made = await aimedSource();
      expect(made.source.viewpoint?.headingMode).toBe(headingMode);
      const side: NormalizedBox = [0.7, 0.3, 0.95, 0.7];
      const result = await look(made, {
        locate: answers({ home: side, ambiguous: false, confidence: 0.9 }),
      });
      expect(result.state).toBe('succeeded');
      expect(result.seen.locate).toBe(1);
      expect(result.seen.located[0]).not.toHaveProperty('target');
      expect(result.seen.fetches).toHaveLength(1);
      expect((await sourceRow(made.source.id)).viewpoint?.framing).toEqual({
        status: 'kept',
        reason: 'ambiguous',
        box: side,
        promptVersion: 'frame-2026.11.0',
        model: expect.any(String),
        framedAt: expect.any(String),
      });
    });

    it(`keeps a ${headingMode} frame without a home and goes on`, async () => {
      const made = await aimedSource();
      const result = await look(made, {
        locate: answers({ home: null, ambiguous: false, confidence: 0.9 }),
      });
      expect(result.state).toBe('succeeded');
      expect(result.seen.analyzed).toHaveLength(1);
      expect((await sourceRow(made.source.id)).viewpoint?.framing).toMatchObject({
        status: 'kept',
        reason: 'no_home',
      });
    });

    it(`goes on with a ${headingMode} frame when the first locate call fails`, async () => {
      const made = await aimedSource();
      const result = await look(made, {
        locate: async () => {
          throw new ProviderError('fixture-vision', 'provider_error', 'down', { retryable: false });
        },
      });
      expect(result.state).toBe('succeeded');
      expect(result.seen.locate).toBe(1);
      expect(result.seen.analyzed).toHaveLength(1);
      const row = await sourceRow(made.source.id);
      expect(row.state).toBe('ready');
      expect(row.viewpoint?.framing).toBeUndefined();
      expect(await storedChecksum(made.source.id)).toBe(await wideChecksum(made));
    });
  }
});
