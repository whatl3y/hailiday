import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  SCENE_ANALYSIS_SCHEMA_VERSION,
  type CriticalFailureCode,
  type DecorationPlan,
  type NormalizedBox,
  type SceneAnalysis,
} from '@hailiday/core';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  burnAttribution,
  relitBy,
} from '../imaging/attribution.testing.js';
import { protectedRestoreLevel, runDeterministicChecks } from '../imaging/checks.js';
import { restoreProtectedRectangles } from '../imaging/composite.js';
import { buildCompositeMask, type CompositeMask } from '../imaging/mask.js';
import { shiftRaster, toRect, type Raster } from '../imaging/raster.js';
import {
  warpRaster,
  type AlignmentRecord,
  type SimilarityTransform,
} from '../imaging/registration.js';
import { prepareWorkingImage, type WorkingImage } from '../imaging/working.js';
import { lavishKeepMask } from './mask.js';
import {
  compositeAndCheck,
  decideAttempt,
  deliverableDoubt,
  keptShare,
  registerOutput,
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

  it('does not deliver a doubted camera that the registration did not measure (a poor fit ignored)', () => {
    const doubting = (...uncertain: CriticalFailureCode[]) => ({
      critical: [],
      uncertain,
      major: [],
    });
    const camera = doubting('camera_changed');
    // Measured and passed: the doubt is deliverable, as before.
    const measured = decideAttempt({ attemptNumber: 1, deterministic: [], judge: camera });
    expect(measured).toEqual({
      verdict: 'uncertain',
      codes: ['camera_changed'],
      recordedMajors: [],
    });
    expect(deliverableDoubt(measured)).toBe(true);
    expect(
      decideAttempt({
        attemptNumber: 1,
        deterministic: [],
        judge: camera,
        poorFitIgnored: false,
      }),
    ).toEqual(measured);
    // Taken unwarped for a poor fit: the same doubt is not deliverable.
    const unmeasured = decideAttempt({
      attemptNumber: 1,
      deterministic: [],
      judge: camera,
      poorFitIgnored: true,
    });
    expect(unmeasured).toEqual({
      verdict: 'uncertain',
      codes: ['camera_changed'],
      recordedMajors: [],
      cameraUnmeasured: true,
    });
    expect(deliverableDoubt(unmeasured)).toBe(false);
    // Beside other doubts, with and without majors.
    const mixed = decideAttempt({
      attemptNumber: 2,
      deterministic: [],
      judge: { ...doubting('structure_changed', 'camera_changed'), major: ['implausible_decor'] },
      poorFitIgnored: true,
    });
    expect(mixed).toMatchObject({
      verdict: 'uncertain',
      codes: ['structure_changed', 'camera_changed', 'implausible_decor'],
      cameraUnmeasured: true,
    });
    expect(deliverableDoubt(mixed)).toBe(false);
    // Without camera_changed among the doubts the fact changes nothing.
    for (const codes of [['structure_changed'], ['text_added', 'access_blocked']] as const) {
      const verdict = decideAttempt({
        attemptNumber: 1,
        deterministic: [],
        judge: doubting(...codes),
        poorFitIgnored: true,
      });
      expect(verdict).not.toHaveProperty('cameraUnmeasured');
      expect(deliverableDoubt(verdict), codes.join(',')).toBe(true);
    }
    const privacy = decideAttempt({
      attemptNumber: 1,
      deterministic: [],
      judge: doubting('privacy_regression'),
      poorFitIgnored: true,
    });
    expect(privacy).not.toHaveProperty('cameraUnmeasured');
    expect(deliverableDoubt(privacy)).toBe(false);
    // A confident camera_changed fails; a pass is no doubt.
    const confident = decideAttempt({
      attemptNumber: 1,
      deterministic: [],
      judge: { critical: ['camera_changed'], uncertain: [], major: [] },
      poorFitIgnored: true,
    });
    expect(confident).toEqual({ verdict: 'fail', codes: ['camera_changed'], recordedMajors: [] });
    expect(deliverableDoubt(confident)).toBe(false);
    const passing = decideAttempt({
      attemptNumber: 1,
      deterministic: [],
      judge: none,
      poorFitIgnored: true,
    });
    expect(passing).toEqual({ verdict: 'pass', codes: [], recordedMajors: [] });
    expect(deliverableDoubt(passing)).toBe(false);
  });
});

/** A raster as the PNG a provider delivers. */
const png = (raster: Raster) =>
  sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } })
    .png()
    .toBuffer();

describe('a lavish attempt', () => {
  const PERSON: NormalizedBox = [0.05, 0.6, 0.15, 0.95];
  const lavishAnalysis = (): SceneAnalysis => ({ ...analysis(), peopleBoxes: [PERSON] });
  const lavishMask = () =>
    lavishKeepMask({
      width: working.width,
      height: working.height,
      analysis: lavishAnalysis(),
      padRegions: working.padRegions,
      featherPx: Math.round(0.02 * Math.max(working.width, working.height)),
    });

  it('a lavish composite is the output outside the restored boxes and the original inside, with no tone matching', async () => {
    const brighter = {
      ...decorated,
      data: Buffer.from(decorated.data.map((v) => Math.min(255, v + 20))),
    };
    const keep = lavishMask();
    const rawBytes = await png(brighter);
    const result = await compositeAndCheck({
      working,
      rawBytes,
      registration: await registerOutput({
        working,
        rawBytes,
        plan: plan(),
        mask,
        glowRegions: [],
        lavish: true,
      }),
      requested: { width: working.width, height: working.height },
      plan: plan(),
      analysis: lavishAnalysis(),
      mask: keep,
      attributionRegion: null,
      glowRegions: [],
      lavish: true,
    });
    expect(result.deterministic.codes).toEqual([]);
    expect(result.photometric).toBeNull();
    expect(result.exposureMatched).toBe(false);
    // Where the keep-mask keeps the output fully, the candidate is the output byte for byte.
    let compared = 0;
    for (let i = 0; i < keep.alpha.length; i += 41) {
      if (keep.alpha[i] !== 255) continue;
      compared += 1;
      expect(result.candidate.data[i * 3]).toBe(brighter.data[i * 3]);
    }
    expect(compared).toBeGreaterThan(30_000);
    // Inside the person's box it is the original.
    const rect = toRect(PERSON, working.width, working.height);
    for (let y = rect.y0; y < rect.y1; y += 7) {
      for (let x = rect.x0; x < rect.x1; x += 7) {
        const p = (y * working.width + x) * 3;
        expect(result.candidate.data[p]).toBe(working.raster.data[p]);
      }
    }
    expect(result.deterministic.checks.seam).toEqual({ passed: true, skipped: 'lavish' });
  });

  it('takes a poor fit unwarped and hints the judge, where any other attempt fails camera_changed', async () => {
    // The output shifted by 12 px under strong noise: within the limits, with a poor fit.
    const shifted = shiftRaster(decorated, 12, 0);
    let seed = 11;
    const noisy = {
      ...shifted,
      data: Buffer.from(
        shifted.data.map((v, i) => {
          if (i % 3 === 0) seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
          return Math.max(0, Math.min(255, Math.round(v + (seed / 0x7fffffff - 0.5) * 160)));
        }),
      ),
    };
    const rawBytes = await png(noisy);
    // As the render job does: registered over the pixels outside the plan mask.
    const run = async (lavish: boolean) =>
      compositeAndCheck({
        working,
        rawBytes,
        registration: await registerOutput({
          working,
          rawBytes,
          plan: plan(),
          mask,
          glowRegions: [],
          ...(lavish ? { lavish: true } : {}),
        }),
        requested: { width: working.width, height: working.height },
        plan: plan(),
        analysis: analysis(),
        mask: lavish ? lavishMask() : mask,
        attributionRegion: null,
        glowRegions: [],
        ...(lavish ? { lavish: true } : {}),
      });
    const plain = await run(false);
    expect(plain.deterministic.codes).toEqual(['camera_changed']);
    expect(plain.alignment).toMatchObject({ accepted: false, reason: 'poor_fit' });
    const lavish = await run(true);
    expect(lavish.deterministic.codes).not.toContain('camera_changed');
    expect(lavish.alignment).toMatchObject({
      accepted: true,
      applied: false,
      reason: 'poor_fit_ignored',
    });
    expect(lavish.deterministic.hints).toContain('camera_changed');
  });

  it('is composited only with a registration made over the plan mask', async () => {
    const rawBytes = await png(decorated);
    const input = {
      working,
      rawBytes,
      requested: { width: working.width, height: working.height },
      plan: plan(),
      analysis: lavishAnalysis(),
      mask: lavishMask(),
      attributionRegion: null,
      glowRegions: [],
    };
    await expect(compositeAndCheck({ ...input, lavish: true })).rejects.toThrow(/registration/);
    // Any other attempt, and the relight of a lavish base, register here as before.
    await expect(compositeAndCheck({ ...input, mask })).resolves.toHaveProperty('candidate');
    await expect(
      compositeAndCheck({
        ...input,
        plan: { ...plan(), lightingMode: 'evening', fidelityMode: 'global_relight' },
        mask: null,
        lavish: true,
      }),
    ).resolves.toHaveProperty('candidate');
  });
});

describe('a lavish attempt over the attribution rectangles', () => {
  const SIZE = 1024;
  const identity: AlignmentRecord = {
    dx: 0,
    dy: 0,
    scale: 1,
    rotationDeg: 0,
    aspect: 1,
    score: 0.9,
    inliers: 1000,
    accepted: true,
    applied: false,
    uncoveredFraction: 0,
  };

  /** A box blur of a rectangle (radius `r`, two passes). */
  function blurRect(raster: Raster, box: NormalizedBox, r: number): Raster {
    const rect = toRect(box, raster.width, raster.height);
    let data = Buffer.from(raster.data);
    for (let pass = 0; pass < 2; pass += 1) {
      const next = Buffer.from(data);
      for (let y = rect.y0; y < rect.y1; y += 1) {
        for (let x = rect.x0; x < rect.x1; x += 1) {
          for (let c = 0; c < 3; c += 1) {
            let sum = 0;
            let n = 0;
            for (let dy = -r; dy <= r; dy += 1) {
              for (let dx = -r; dx <= r; dx += 1) {
                const yy = Math.min(rect.y1 - 1, Math.max(rect.y0, y + dy));
                const xx = Math.min(rect.x1 - 1, Math.max(rect.x0, x + dx));
                sum += data[(yy * raster.width + xx) * 3 + c] as number;
                n += 1;
              }
            }
            next[(y * raster.width + x) * 3 + c] = Math.round(sum / n);
          }
        }
      }
      data = next;
    }
    return { ...raster, data };
  }

  /** A synthetic Street View frame: a plate blurred in it and the attribution burned in over. */
  const frameOf = (blurred: readonly NormalizedBox[]) => {
    let ground = attributionScene(SIZE).ground;
    for (const box of blurred) ground = blurRect(ground, box, 4);
    return burnAttribution(ground).base;
  };
  const workingOf = (raster: Raster): WorkingImage => ({
    raster,
    png: Buffer.alloc(0),
    checksum: 'synthetic',
    width: SIZE,
    height: SIZE,
    nativeWidth: SIZE,
    nativeHeight: SIZE,
    resampler: 'none',
    scaleFactor: 1,
    cropBox: null,
    contentBox: null,
    padRegions: [],
  });
  const sceneAnalysis = (people: NormalizedBox[], blur: NormalizedBox[]): SceneAnalysis => ({
    ...analysis(),
    workingImage: { width: SIZE, height: SIZE, checksum: 'synthetic' },
    peopleBoxes: people,
    protectedBlurRegions: blur.map((box) => ({ kind: 'plate' as const, box })),
  });
  const compose = (frame: Raster, a: SceneAnalysis, lavish: boolean) => {
    // The editor returned the whole frame 1.5 times brighter in linear light.
    const output = relitBy(frame, [1.5, 1.45, 1.4]);
    return compositeAndCheck({
      working: workingOf(frame),
      rawBytes: new Uint8Array(),
      registration: { delivered: output, registered: { aligned: output, record: identity } },
      requested: { width: SIZE, height: SIZE },
      plan: { ...plan(), placements: [] },
      analysis: a,
      mask: lavishKeepMask({
        width: SIZE,
        height: SIZE,
        analysis: a,
        padRegions: [],
        featherPx: 20,
      }),
      attributionRegion: SYNTHETIC_ATTRIBUTION,
      glowRegions: [],
      ...(lavish ? { lavish: true } : {}),
    });
  };
  /** Pixels of `box` where `candidate` differs from `frame` on any channel. */
  const differing = (candidate: Raster, frame: Raster, box: NormalizedBox) => {
    const rect = toRect(box, SIZE, SIZE);
    let n = 0;
    for (let y = rect.y0; y < rect.y1; y += 1) {
      const start = (y * SIZE + rect.x0) * 3;
      const end = (y * SIZE + rect.x1) * 3;
      for (let p = start; p < end; p += 3) {
        if (!candidate.data.subarray(p, p + 3).equals(frame.data.subarray(p, p + 3))) n += 1;
      }
    }
    return n;
  };

  it('keeps the original in a blurred plate that reaches into the copyright strip', async () => {
    const plate: NormalizedBox = [0.86, 0.93, 0.93, 0.971];
    const frame = frameOf([plate]);
    const a = sceneAnalysis([], [plate]);
    const lavish = await compose(frame, a, true);
    expect(differing(lavish.candidate, frame, plate)).toBe(0);
    expect(lavish.deterministic.codes).toEqual([]);
    expect(lavish.deterministic.checks.attribution).toMatchObject({
      passed: true,
      regions: [{ mode: 'adapted' }, { mode: 'adapted' }],
    });
    // The label's ground beside the plate still follows the editor's picture.
    const label = toRect(SYNTHETIC_ATTRIBUTION[1] as NormalizedBox, SIZE, SIZE);
    expect(
      differing(lavish.candidate, frame, [
        label.x0 / SIZE,
        label.y0 / SIZE,
        plate[0] - 0.01,
        label.y1 / SIZE,
      ]),
    ).toBeGreaterThan(0);
    // Any other decorate attempt restores the rectangles verbatim, the plate with them.
    const plain = await compose(frame, a, false);
    expect(differing(plain.candidate, frame, plate)).toBe(0);
  });

  it('keeps the original in a person over the logo', async () => {
    const person: NormalizedBox = [0.03, 0.8, 0.08, 0.99];
    const frame = frameOf([]);
    const a = sceneAnalysis([person], []);
    const lavish = await compose(frame, a, true);
    expect(differing(lavish.candidate, frame, person)).toBe(0);
    expect(lavish.deterministic.codes).toEqual([]);
    const plain = await compose(frame, a, false);
    expect(differing(plain.candidate, frame, person)).toBe(0);
  });

  it('leaves the restoration of any other decorate attempt as it was: the boxes are not read', () => {
    const plate: NormalizedBox = [0.86, 0.93, 0.93, 0.971];
    const frame = frameOf([plate]);
    // An output that was not pasted back, so that a copy of the boxes would show.
    const output = relitBy(frame, [1.5, 1.45, 1.4]);
    const restore = (protectedBoxes?: NormalizedBox[]) =>
      restoreProtectedRectangles({
        candidate: output,
        working: frame,
        lightingMode: 'source',
        attribution: SYNTHETIC_ATTRIBUTION,
        ...(protectedBoxes ? { protectedBoxes } : {}),
      });
    const without = restore();
    const withBoxes = restore([plate, [0.4, 0.4, 0.5, 0.5]]);
    expect(withBoxes.candidate.data.equals(without.candidate.data)).toBe(true);
    expect(withBoxes.attribution).toEqual(without.attribution);
    expect(withBoxes.protectedRestore).toBeNull();
  });
});

describe('the protected restore of every relight', () => {
  const BLUR: NormalizedBox = [0.06, 0.15, 0.2, 0.4];
  const PERSON: NormalizedBox = [0.7, 0.55, 0.8, 0.9];

  /** A box blur of a rectangle (radius `r`, two passes). */
  function blurRect(raster: Raster, box: NormalizedBox, r: number): Raster {
    const rect = toRect(box, raster.width, raster.height);
    let data = Buffer.from(raster.data);
    for (let pass = 0; pass < 2; pass += 1) {
      const next = Buffer.from(data);
      for (let y = rect.y0; y < rect.y1; y += 1) {
        for (let x = rect.x0; x < rect.x1; x += 1) {
          for (let c = 0; c < 3; c += 1) {
            let sum = 0;
            let n = 0;
            for (let dy = -r; dy <= r; dy += 1) {
              for (let dx = -r; dx <= r; dx += 1) {
                const yy = Math.min(rect.y1 - 1, Math.max(rect.y0, y + dy));
                const xx = Math.min(rect.x1 - 1, Math.max(rect.x0, x + dx));
                sum += data[(yy * raster.width + xx) * 3 + c] as number;
                n += 1;
              }
            }
            next[(y * raster.width + x) * 3 + c] = Math.round(sum / n);
          }
        }
      }
      data = next;
    }
    return { ...raster, data };
  }

  const relightPlan = () => ({
    ...plan(),
    lightingMode: 'evening' as const,
    fidelityMode: 'global_relight' as const,
  });
  const relightAnalysis = (): SceneAnalysis => ({
    ...analysis(),
    peopleBoxes: [PERSON],
    protectedBlurRegions: [{ kind: 'plate', box: BLUR }],
  });

  it('delivers the base inside a blur box the editor sharpened and a person it redrew', async () => {
    const base = blurRect(working.raster, BLUR, 4);
    // The editor relit the frame, re-synthesized the blurred area sharp and redrew the person.
    const relit = {
      ...working.raster,
      data: Buffer.from(working.raster.data.map((v) => Math.round(v * 0.4))),
    };
    const person = toRect(PERSON, working.width, working.height);
    for (let y = person.y0; y < person.y1; y += 1) {
      for (let x = person.x0; x < person.x1; x += 1) {
        relit.data.fill(
          ((x >> 1) + (y >> 1)) % 2 ? 20 : 120,
          (y * working.width + x) * 3,
          (y * working.width + x) * 3 + 3,
        );
      }
    }
    // Without the restore the relit output fails both protected regions.
    const unrestored = runDeterministicChecks({
      working: base,
      raw: relit,
      candidate: relit,
      requested: { width: working.width, height: working.height },
      lightingMode: 'evening',
      placementRegions: [REGION],
      peopleBoxes: [PERSON],
      blurRegions: [BLUR],
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
    });
    expect(unrestored.codes).toEqual(
      expect.arrayContaining(['privacy_regression', 'people_altered']),
    );
    const result = await compositeAndCheck({
      working,
      reference: base,
      rawBytes: await png(relit),
      requested: { width: working.width, height: working.height },
      plan: relightPlan(),
      analysis: relightAnalysis(),
      mask: null,
      attributionRegion: null,
      glowRegions: [],
    });
    expect(result.deterministic.codes).not.toContain('privacy_regression');
    expect(result.deterministic.codes).not.toContain('people_altered');
    const regions = (
      result.deterministic.checks.protectedRegions as { regions: Record<string, unknown>[] }
    ).regions;
    expect(regions).toEqual([
      expect.objectContaining({ kind: 'person', restored: true, passed: true }),
      expect.objectContaining({ kind: 'blur', restored: true, passed: true }),
    ]);
    const record = result.deterministic.checks.compositing?.protectedRestore as {
      groups: number;
      boxes: number;
      gains: [number, number, number][];
      modes: string[];
    };
    expect(record).toMatchObject({ groups: 2, boxes: 2, modes: ['adapted', 'adapted'] });
    // The blur box shows the base's pixels under the applied gain.
    const blur = toRect(BLUR, working.width, working.height);
    const gain = record.gains[1] as [number, number, number];
    for (let y = blur.y0; y < blur.y1; y += 5) {
      for (let x = blur.x0; x < blur.x1; x += 5) {
        const p = (y * working.width + x) * 3;
        for (let c = 0; c < 3; c += 1) {
          expect(result.candidate.data[p + c]).toBe(
            protectedRestoreLevel(base.data[p + c] as number, gain[c] as number),
          );
        }
      }
    }
  });

  it('leaves a relight without people and blur regions as it is, with no record', async () => {
    const relit = {
      ...working.raster,
      data: Buffer.from(working.raster.data.map((v) => Math.round(v * 0.4))),
    };
    const result = await compositeAndCheck({
      working,
      reference: working.raster,
      rawBytes: await png(relit),
      requested: { width: working.width, height: working.height },
      plan: relightPlan(),
      analysis: analysis(),
      mask: null,
      attributionRegion: null,
      glowRegions: [],
    });
    expect(result.candidate.data.equals(relit.data)).toBe(true);
    expect(result.deterministic.checks.compositing).not.toHaveProperty('protectedRestore');
  });
});
