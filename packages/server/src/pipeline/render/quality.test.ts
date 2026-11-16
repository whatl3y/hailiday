import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  type DecorationPlan,
  type NormalizedBox,
  type SceneAnalysis,
} from '@hailiday/core';
import { buildCompositeMask, type CompositeMask } from '../imaging/mask.js';
import { toRect, type Raster } from '../imaging/raster.js';
import { warpRaster, type SimilarityTransform } from '../imaging/registration.js';
import { prepareWorkingImage, type WorkingImage } from '../imaging/working.js';
import {
  compositeAndCheck,
  decideAttempt,
  keptShare,
  restoredChangeHints,
  UNCERTAIN_DELIVERABLE_CODES,
  uncertainDeliverable,
} from './quality.js';

const PHOTO = new URL('../../../content/photos/samples/sample-front-porch.jpg', import.meta.url);
const REGION: NormalizedBox = [0.4, 0.3, 0.6, 0.5];

let working: WorkingImage;
let decorated: Raster;
let mask: CompositeMask;

const analysis = (): SceneAnalysis => ({
  schemaVersion: SCENE_ANALYSIS_SCHEMA_VERSION,
  sourceAssetId: 'sa',
  workingImage: { width: working.width, height: working.height, checksum: working.checksum },
  sceneType: 'house_exterior',
  sceneTypeConfidence: 0.9,
  sceneTypeMismatch: false,
  targetFacade: [0.05, 0.1, 0.95, 0.95],
  targetFacadeAmbiguous: false,
  anchors: [],
  preserveRegions: [],
  accessRegions: [],
  hazards: [],
  existingDecorations: { present: false, density: 'none', boxes: [] },
  peopleBoxes: [],
  protectedBlurRegions: [],
  lighting: { timeOfDay: 'day', isDaylight: true, exposure: 'normal' },
  seasonCues: { snowVisible: false, foliage: 'leafy' },
  qualityFlags: {
    blur: false,
    lowLight: false,
    heavyOcclusion: false,
    multipleBuildings: false,
    embeddedPhoto: false,
    tooClose: false,
    tooFar: false,
  },
  model: { analysisModel: 'test', analysisPromptVersion: 'test' },
  elapsedMs: 0,
});

const plan = (): Pick<
  DecorationPlan,
  'lightingMode' | 'fidelityMode' | 'placements' | 'preserve' | 'compositeMask'
> => ({
  lightingMode: 'source',
  fidelityMode: 'composite_additive',
  placements: [
    {
      id: 'p1',
      kitItemId: 'christmas.house_exterior.wreath_evergreen',
      anchorId: 'a1',
      anchorCategory: 'front_door',
      region: REGION,
      placementRule: 'centered_on',
      count: 1,
      specText: 'a wreath',
      specAttributes: {},
      lit: false,
      priority: 1,
    },
  ],
  preserve: {
    regions: [],
    protectedBlurRegions: [],
    peopleBoxes: [],
    accessRegions: [],
    existingDecorations: [],
    keepSkyAndTimeOfDay: true,
    neighborsUnchanged: true,
    noSnow: true,
  },
  compositeMask: { dilationFraction: 0.04, featherFraction: 0.02 },
});

/** The decorated scene as a provider that reframed it by `t` would deliver it (PNG). */
async function deliveredBy(t: SimilarityTransform): Promise<Buffer> {
  const theta = (-t.rotationDeg * Math.PI) / 180;
  const k = 1 / t.scale;
  const inverse: SimilarityTransform = {
    dx: -k * (Math.cos(theta) * t.dx - Math.sin(theta) * t.dy),
    dy: -k * (Math.sin(theta) * t.dx + Math.cos(theta) * t.dy),
    scale: k,
    rotationDeg: -t.rotationDeg,
    aspect: 1,
  };
  const raster = warpRaster(decorated, inverse, working.width, working.height).raster;
  return sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } })
    .png()
    .toBuffer();
}

beforeAll(async () => {
  working = await prepareWorkingImage(readFileSync(PHOTO), 'upload');
  decorated = { ...working.raster, data: Buffer.from(working.raster.data) };
  const rect = toRect(REGION, working.width, working.height);
  for (let y = rect.y0 + 20; y < rect.y1 - 20; y += 1) {
    for (let x = rect.x0 + 20; x < rect.x1 - 20; x += 1) {
      const p = (y * working.width + x) * 3;
      decorated.data[p] = 200;
      decorated.data[p + 1] = 30;
      decorated.data[p + 2] = 40;
    }
  }
  mask = buildCompositeMask({
    width: working.width,
    height: working.height,
    regions: [REGION],
    dilationFraction: 0.04,
    featherFraction: 0.02,
  });
});

describe('production compositing with registration', () => {
  it('aligns a zoomed and shifted output before paste-back instead of failing camera_changed', async () => {
    const result = await compositeAndCheck({
      working,
      rawBytes: await deliveredBy({ dx: 18, dy: -12, scale: 1.05, rotationDeg: 0, aspect: 1 }),
      requested: { width: working.width, height: working.height },
      plan: plan(),
      analysis: analysis(),
      mask,
      attributionRegion: null,
      glowRegions: [],
    });
    expect(result.deterministic.codes).not.toContain('camera_changed');
    expect(result.alignment).toMatchObject({ accepted: true, applied: true });
    expect(result.alignment.scale).toBeCloseTo(1.05, 2);
    expect(result.deterministic.registration).toMatchObject({ applied: true });
    expect(result.deterministic.checks.seam).toMatchObject({ passed: true });
    // Outside the mask the candidate is the working image byte for byte.
    for (let i = 0; i < mask.alpha.length; i += 97) {
      if (mask.alpha[i]) continue;
      expect(result.candidate.data[i * 3]).toBe(working.raster.data[i * 3]);
    }
    // The decoration survives inside the region.
    const [cx, cy] = [Math.round(0.5 * working.width), Math.round(0.4 * working.height)];
    expect(result.candidate.data[(cy * working.width + cx) * 3]).toBeGreaterThan(150);
  });

  it('reports camera_changed when the reframing exceeds the limits', async () => {
    const result = await compositeAndCheck({
      working,
      rawBytes: await deliveredBy({ dx: 0, dy: 0, scale: 1.14, rotationDeg: 0, aspect: 1 }),
      requested: { width: working.width, height: working.height },
      plan: plan(),
      analysis: analysis(),
      mask,
      attributionRegion: null,
      glowRegions: [],
    });
    expect(result.deterministic.codes).toEqual(['camera_changed']);
    expect(result.alignment.accepted).toBe(false);
    expect(['out_of_range', 'poor_fit']).toContain(result.alignment.reason);
    expect(result.deterministic.checks.alignment).toMatchObject({ passed: false });
  });
});

describe('judge hints for the localizer other changes', () => {
  // A 200 x 100 keep-mask that keeps the left half of the frame.
  const keepMask = (() => {
    const width = 200;
    const height = 100;
    const hard = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) hard.fill(255, y * width, y * width + 100);
    return { width, height, hard };
  })();

  it('names a change outside the keep-mask as restored from the original', () => {
    expect(
      restoredChangeHints([{ description: 'chair moved.', box: [0.7, 0.4, 0.9, 0.9] }], keepMask),
    ).toEqual(['restored from the original: chair moved (on the right side of the image)']);
  });

  it('names a change inside the kept decorations as an unrequested change to inspect', () => {
    expect(
      restoredChangeHints(
        [{ description: 'door repainted red', box: [0.1, 0.1, 0.3, 0.5] }],
        keepMask,
      ),
    ).toEqual([
      'unrequested change inside the kept decorations: door repainted red (in the upper left of the image)',
    ]);
  });

  it('decides by the share of the box inside the keep-mask', () => {
    // 10 of the 50 columns of this box are kept (20%): restored.
    const mostlyOut: NormalizedBox = [0.45, 0.2, 0.7, 0.4];
    // 15 of the 35 columns of this one are kept (about 43%): inside the decorations.
    const partlyIn: NormalizedBox = [0.425, 0.2, 0.6, 0.4];
    expect(keptShare(keepMask, mostlyOut)).toBeCloseTo(0.2, 5);
    expect(keptShare(keepMask, partlyIn)).toBeCloseTo(15 / 35, 5);
    const [out, inside] = restoredChangeHints(
      [
        { description: 'bin moved', box: mostlyOut },
        { description: 'shutter removed', box: partlyIn },
      ],
      keepMask,
    );
    expect(out).toMatch(/^restored from the original: bin moved/);
    expect(inside).toMatch(/^unrequested change inside the kept decorations: shutter removed/);
  });
});

describe('attempt decision', () => {
  it('delivers a doubt about a detail of the home, never one about people, privacy or which home it is', () => {
    for (const code of UNCERTAIN_DELIVERABLE_CODES) expect(uncertainDeliverable([code])).toBe(true);
    expect([...UNCERTAIN_DELIVERABLE_CODES].sort()).toEqual([
      'access_blocked',
      'camera_changed',
      'structure_changed',
      'text_added',
    ]);
    for (const code of [
      'privacy_regression',
      'people_altered',
      'unsafe_or_offensive',
      'attribution_altered',
      'wrong_property',
      'neighbor_decorated',
    ] as const) {
      expect(uncertainDeliverable([code]), code).toBe(false);
      expect(uncertainDeliverable(['structure_changed', code]), code).toBe(false);
    }
    // Confident majors beside the doubt do not change it: they are recorded on the look.
    expect(uncertainDeliverable(['structure_changed', 'implausible_decor'])).toBe(true);
    expect(uncertainDeliverable([])).toBe(true);
  });

  const none = { critical: [], uncertain: [], major: [] };

  it('records majors on a passing second attempt, but a decisive code fails any attempt', () => {
    expect(
      decideAttempt({ attemptNumber: 2, deterministic: ['lighting_implausible'], judge: none }),
    ).toEqual({ verdict: 'pass', codes: [], recordedMajors: ['lighting_implausible'] });
    for (const attemptNumber of [1, 2] as const) {
      expect(
        decideAttempt({
          attemptNumber,
          deterministic: ['lighting_implausible'],
          judge: null,
          decisive: ['lighting_implausible'],
        }),
      ).toEqual({ verdict: 'fail', codes: ['lighting_implausible'], recordedMajors: [] });
    }
    expect(
      decideAttempt({ attemptNumber: 2, deterministic: [], judge: none, decisive: [] }).verdict,
    ).toBe('pass');
  });

  it('fails majors on an attempt that still has a repair after it, records them otherwise', () => {
    const majors = { critical: [], uncertain: [], major: ['implausible_decor' as const] };
    const verdictOf = (attemptNumber: 1 | 2 | 3, repairLeft?: boolean) =>
      decideAttempt({
        attemptNumber,
        deterministic: [],
        judge: majors,
        ...(repairLeft === undefined ? {} : { repairLeft }),
      });
    // Without the repair flag the first attempt is the one that can be repaired.
    expect(verdictOf(1).verdict).toBe('fail');
    expect(verdictOf(2).verdict).toBe('pass');
    // The first relight of a base the job decorated (attempt 2 of 3) can still be repaired.
    expect(verdictOf(2, true)).toEqual({
      verdict: 'fail',
      codes: ['implausible_decor'],
      recordedMajors: [],
    });
    // The relight of a repaired base (attempt 3) has no repair after it.
    expect(verdictOf(3, false)).toEqual({
      verdict: 'pass',
      codes: [],
      recordedMajors: ['implausible_decor'],
    });
    expect(verdictOf(1, false).verdict).toBe('pass');
  });
});
