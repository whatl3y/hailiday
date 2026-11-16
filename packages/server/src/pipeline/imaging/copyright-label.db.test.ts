import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivationState, DecorationPlan, NormalizedBox } from '@hailiday/core';
import type { Capabilities } from '../../capabilities/index.js';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import { fixturePanoramaFrame } from '../../fixtures/street-view.js';
import { sha256Hex } from '../../ids/index.js';
import type { Providers, StreetViewProvider } from '../../providers/types.js';
import type { PipelineDeps } from '../context.js';
import { runRenderJob } from '../render/job.js';
import { readJob } from '../render/transitions.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { burnAttribution } from './attribution.testing.js';
import { copyrightLabelRegions } from './embedded-attribution.js';
import { toRect, type Raster } from './raster.js';
import { nativeBoxesOnWorkingGrid } from './working.js';

/** The fixture place whose street photos stand in for contributor imagery. */
const CONTRIBUTOR_PLACE = 'ChIJfxPinonMesaAdobeXXXXX17';
/** A contributor's credit as live Street View metadata reports it (21 characters). */
const CONTRIBUTOR = '© GIS1 Street Imagery';
const LABEL_GLYPHS = 21;
const MEASURED = DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640'] as readonly NormalizedBox[];

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

/**
 * A Static frame of a fixture view carrying a contributor's long copyright label: the fixture
 * photo without its own credit, drawn at 1024 with the synthetic logo and a 21-glyph label (as
 * wide as "© GIS1 Street Imagery" or wider), saved at the requested size as a JPEG.
 */
async function contributorFrame(view: Parameters<StreetViewProvider['fetchTransient']>[0]) {
  const frame = fixturePanoramaFrame(view, { watermark: false });
  if (!frame) throw new Error(`no fixture frame for ${view.panoId}`);
  const { data, info } = await sharp(await frame.render({ format: 'png' }))
    .resize(1024, 1024, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ground: Raster = { data, width: info.width, height: info.height };
  const burned = burnAttribution(ground, { labelGlyphs: LABEL_GLYPHS });
  const bytes = await sharp(burned.base.data, { raw: { width: 1024, height: 1024, channels: 3 } })
    .resize(view.width, view.height, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { bytes, labelBoxX0: burned.labelBox.x0 / 1024 };
}

/**
 * The shared dependencies on live Street View legs: `street_view_ai` live for everyone, a Street
 * View adapter in live mode serving the fixture panoramas as contributor frames, and the fixture
 * editor and vision model.
 */
function contributorDeps(): PipelineDeps {
  const fixture = base.providers.fixtures.streetView;
  const streetView: StreetViewProvider = {
    ...fixture,
    providerId: 'google',
    mode: 'live',
    async fetchTransient(view) {
      const { bytes } = await contributorFrame(view);
      return {
        bytes,
        checksum: sha256Hex(bytes),
        width: view.width,
        height: view.height,
        contentType: 'image/jpeg',
        providerMode: 'live',
        fetchedAt: new Date(),
      };
    },
  };
  const states: Record<string, ActivationState> = {
    street_view_ai: 'live_public',
    vision_analysis: 'fixture',
  };
  const capabilities: Capabilities = {
    ...base.capabilities,
    state: async (country, capability) =>
      capability in states
        ? (states[capability] ?? null)
        : base.capabilities.state(country, capability),
  };
  const providers: Providers = {
    ...base.providers,
    streetView,
    imageEditor: { ...base.providers.fixtures.imageEditor, providerId: 'openai', mode: 'live' },
  };
  return { ...base, capabilities, providers };
}

describe("an evening look of a contributor's Street View frame", () => {
  it('keeps its long copyright label whole: found in its widened rectangle and restored', async () => {
    const deps = contributorDeps();
    expect(deps.config.streetView.contributorImagery).toBe('decorate');
    const made = await createStreetViewSource(deps, { placeId: CONTRIBUTOR_PLACE });
    expect(made.source.isGoogleImagery).toBe(false);
    const source = await deps.db
      .updateTable('sourceAssets')
      .set({ copyright: CONTRIBUTOR })
      .where('id', '=', made.source.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const viewpoint = source.viewpoint as { width: number; height: number };
    expect(`${viewpoint.width}x${viewpoint.height}`).toBe('640x640');
    const job = await createRenderJobRecord(deps, {
      ownerId: made.ownerId,
      projectId: made.projectId,
      source,
      lightingMode: 'evening',
    });
    expect(await runRenderJob(deps, { renderJobId: job.id })).toEqual({
      state: 'succeeded',
      stopped: false,
    });

    // The plan protects the widened label rectangle, which holds the label's whole box.
    const done = await readJob(deps.db, job.id);
    const grid = {
      cropBox: (done?.workingCropBox as NormalizedBox | null) ?? null,
      contentBox: (done?.workingPadBox as NormalizedBox | null) ?? null,
    };
    const fitted = copyrightLabelRegions(MEASURED, {
      frameWidth: 640,
      copyright: CONTRIBUTOR,
      isGoogleImagery: false,
    });
    const expected = nativeBoxesOnWorkingGrid(fitted, grid);
    const measured = nativeBoxesOnWorkingGrid(MEASURED, grid);
    expect(expected).toHaveLength(2);
    expect(expected[1]?.[0]).toBeLessThan(measured[1]?.[0] as number);
    const plans = await deps.db
      .selectFrom('decorationPlans')
      .select(['attemptNo', 'document'])
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(plans.length).toBeGreaterThan(0);
    for (const plan of plans) {
      expect((plan.document as DecorationPlan).preserve.attributionRegions).toEqual(expected);
    }
    const { labelBoxX0 } = await contributorFrame({
      panoId: (source.viewpoint as { panoId: string }).panoId,
      heading: 0,
      pitch: 0,
      fov: 90,
      width: 640,
      height: 640,
    });
    // On the frame, the label's box starts left of the measured rectangle and inside the widened.
    expect(labelBoxX0).toBeLessThan(MEASURED[1]?.[0] as number);
    expect(labelBoxX0).toBeGreaterThan(fitted[1]?.[0] as number);

    // Attempt 1 rendered the daylight base, attempt 2 relit it.
    const attempts = await deps.db
      .selectFrom('renderAttempts')
      .select(['id', 'attemptNo', 'outcome', 'fidelityMode'])
      .where('jobId', '=', job.id)
      .orderBy('attemptNo')
      .execute();
    expect(attempts.map((a) => [a.attemptNo, a.outcome, a.fidelityMode])).toEqual([
      [1, 'succeeded', 'composite_additive'],
      [2, 'succeeded', 'global_relight'],
    ]);
    const relit = await deps.db
      .selectFrom('judgeResults')
      .select('deterministicChecks')
      .where('attemptId', '=', attempts[1]!.id)
      .where('escalated', '=', false)
      .executeTakeFirstOrThrow();
    const checks = relit.deterministicChecks as {
      attribution: {
        passed: boolean;
        regions: {
          mode: string;
          passed: boolean;
          strokeDifference: { mean: number; closeShare: number; pixels: number } | null;
        }[];
      };
      compositing: { attribution: { mode: string }[] };
    };
    // Both marks are found and their strokes kept from the base over the relit ground.
    expect(checks.compositing.attribution.map((entry) => entry.mode)).toEqual([
      'adapted',
      'adapted',
    ]);
    expect(checks.attribution.passed).toBe(true);
    expect(checks.attribution.regions).toHaveLength(2);
    const label = checks.attribution.regions[1];
    expect(label).toMatchObject({ mode: 'adapted', passed: true });
    expect(label?.strokeDifference).toMatchObject({ mean: 0, closeShare: 1 });
    expect(label?.strokeDifference?.pixels).toBeGreaterThan(100);
    // The widened rectangle reaches the frame's right and bottom edges, as the label does.
    const rect = toRect(expected[1] as NormalizedBox, 1024, 1024);
    expect([rect.x1, rect.y1]).toEqual([1024, 1024]);
  });
});
