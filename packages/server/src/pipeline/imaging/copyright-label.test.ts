import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { attributionStrokes, attributionStrokesReliable } from './attribution.js';
import { attributionScene, lumaAt, relitBy, type AttributionScene } from './attribution.testing.js';
import { restoreProtectedRectangles } from './composite.js';
import {
  COPYRIGHT_LABEL_CHAR_PX,
  COPYRIGHT_LABEL_MIN_X0,
  COPYRIGHT_LABEL_PAD_PX,
  copyrightLabelRegions,
} from './embedded-attribution.js';
import { toRect, type PxRect, type Raster } from './raster.js';

const SETTINGS = PIPELINE_DEFAULTS.attributionRelight;
const MEASURED = DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640'] as readonly NormalizedBox[];
const [LOGO, LABEL] = MEASURED as [NormalizedBox, NormalizedBox];
/** A contributor's credit as live Street View metadata reports it (21 characters). */
const CONTRIBUTOR = '© GIS1 Street Imagery';
const DUSK = [0.08, 0.09, 0.19] as const;

const labelFor = (copyright: string, isGoogleImagery: boolean | null = false) =>
  copyrightLabelRegions(MEASURED, {
    frameWidth: 640,
    copyright,
    isGoogleImagery,
  })[1] as NormalizedBox;

/** A credit of `length` characters, starting with "© ". */
const creditOf = (length: number) => `© ${'x'.repeat(length - 2)}`;

describe('the copyright label rectangle of a live Street View frame', () => {
  it("keeps the measured rectangles for Google's own imagery, whatever its credit", () => {
    for (const copyright of ['© 2026 Google', creditOf(60), CONTRIBUTOR]) {
      expect(
        copyrightLabelRegions(MEASURED, { frameWidth: 640, copyright, isGoogleImagery: true }),
      ).toEqual(MEASURED);
    }
  });

  it("widens the label rectangle from the length of a contributor's credit", () => {
    const regions = copyrightLabelRegions(MEASURED, {
      frameWidth: 640,
      copyright: CONTRIBUTOR,
      isGoogleImagery: false,
    });
    expect(regions[0]).toEqual(LOGO);
    const widthPx = 21 * COPYRIGHT_LABEL_CHAR_PX + COPYRIGHT_LABEL_PAD_PX;
    expect(regions[1]).toEqual([1 - widthPx / 640, LABEL[1], 1, 1]);
    expect(regions[1]?.[0]).toBeCloseTo(0.68, 2);
    // Imagery of unknown attribution is treated the same way.
    expect(labelFor(CONTRIBUTOR, null)).toEqual(regions[1]);
    // A credit without its "©" counts the two characters it adds on the frame.
    expect(labelFor('GIS1 Street Imagery')).toEqual(regions[1]);
    // The measured rectangles are not changed in place.
    expect(MEASURED[1]).toEqual([0.8, 0.965, 1, 1]);
  });

  it('never narrows the measured rectangle, and keeps it without a credit', () => {
    expect(labelFor('© GIS1')).toEqual(LABEL);
    // 12 characters ask for 124 px, less than the measured 128.
    expect(labelFor(creditOf(12))).toEqual(LABEL);
    expect(labelFor(creditOf(13))[0]).toBeLessThan(LABEL[0]);
    expect(labelFor('')).toEqual(LABEL);
    expect(
      copyrightLabelRegions(MEASURED, { frameWidth: 640, copyright: null, isGoogleImagery: false }),
    ).toEqual(MEASURED);
  });

  it('is capped at half the frame for a very long credit', () => {
    expect(labelFor(creditOf(33))[0]).toBeGreaterThan(COPYRIGHT_LABEL_MIN_X0);
    expect(labelFor(creditOf(34))[0]).toBe(COPYRIGHT_LABEL_MIN_X0);
    expect(labelFor(creditOf(400))[0]).toBe(COPYRIGHT_LABEL_MIN_X0);
    // The logo's rectangle is never reached.
    expect(COPYRIGHT_LABEL_MIN_X0).toBeGreaterThan(LOGO[2]);
  });

  it('scales with the frame width, in frame pixels', () => {
    const at320 = copyrightLabelRegions(MEASURED, {
      frameWidth: 320,
      copyright: CONTRIBUTOR,
      isGoogleImagery: false,
    })[1];
    expect(at320?.[0]).toBe(Math.max(COPYRIGHT_LABEL_MIN_X0, 1 - 205 / 320));
  });
});

/** Every stroke-core pixel of `scene` inside `rect` (frame indices). */
function coresIn(scene: AttributionScene, rect: PxRect): number[] {
  const size = scene.base.width;
  const pixels: number[] = [];
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      if (scene.strokeCore[y * size + x]) pixels.push(y * size + x);
    }
  }
  return pixels;
}

/** How many of `pixels` equal the scene's base in `out`, byte for byte. */
function equalToBase(scene: AttributionScene, out: Raster, pixels: readonly number[]): number {
  let equal = 0;
  for (const i of pixels) {
    const p = i * 3;
    if (out.data.subarray(p, p + 3).equals(scene.base.data.subarray(p, p + 3))) equal += 1;
  }
  return equal;
}

/** Mean luma of the label box's pixels between columns `x0` and `x1` that are no stroke. */
function boxGroundLuma(scene: AttributionScene, raster: Raster, x0: number, x1: number): number {
  const size = scene.base.width;
  let total = 0;
  let count = 0;
  for (let y = scene.labelBox.y0; y < scene.labelBox.y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (scene.strokePaint[y * size + x]) continue;
      total += lumaAt(raster, x, y);
      count += 1;
    }
  }
  return total / count;
}

/**
 * A synthetic Static frame whose label is the contributor's 21-character credit, at the frame's
 * own size (640) and on the 1024 working grid the job decorates it on.
 */
const SCENES = [
  { name: 'a 640 frame', size: 640, options: {} },
  { name: 'the 1024 working grid', size: 1024, options: {} },
  { name: 'flat mid-grey ground at 1024', size: 1024, options: { groundLuma: 0.45 } },
] as const;

describe("a contributor's long copyright label", () => {
  for (const { name, size, options } of SCENES) {
    describe(`on ${name}`, () => {
      const scene = attributionScene(size, { ...options, labelGlyphs: 21 });
      const fitted = labelFor(CONTRIBUTOR);
      const measured = toRect(LABEL, size, size);
      const wide = toRect(fitted, size, size);

      it('reaches left of the measured rectangle and lies inside the widened one', () => {
        expect(scene.labelGlyphs).toHaveLength(21);
        expect(scene.labelBox.x0).toBeLessThan(measured.x0);
        // Ground left of the box, inside the rectangle, shows the box's left edge.
        expect(scene.labelBox.x0 - wide.x0).toBeGreaterThanOrEqual(
          SETTINGS.boxGapPx + SETTINGS.boxOutsidePx,
        );
      });

      it('is found whole in the widened rectangle and not at all in the measured one', () => {
        const strokes = attributionStrokes(scene.base, fitted);
        expect(strokes.components).toHaveLength(21);
        expect(attributionStrokesReliable(strokes.share)).toBe(true);
        const width = strokes.rect.x1 - strokes.rect.x0;
        for (const i of coresIn(scene, strokes.rect)) {
          const x = i % size;
          const y = Math.floor(i / size);
          expect(
            strokes.keep[(y - strokes.rect.y0) * width + (x - strokes.rect.x0)],
          ).toBeGreaterThanOrEqual(SETTINGS.solidKeep);
        }
        // Every glyph of the label lies in the widened rectangle.
        expect(coresIn(scene, strokes.rect)).toHaveLength(
          scene.strokeCore.reduce((sum, v, i) => sum + (i % size >= size / 2 ? v : 0), 0),
        );
        // The measured rectangle cannot see the box's left edge: no strokes, a verbatim restore.
        expect(attributionStrokes(scene.base, LABEL).share).toBe(0);
      });

      it('is kept whole through a decorate composite (source light)', () => {
        // The editor's output lost the label (its ground only).
        const candidate: Raster = { ...scene.ground, data: Buffer.from(scene.ground.data) };
        const labelCores = coresIn(scene, scene.labelBox);
        const restored = restoreProtectedRectangles({
          candidate,
          working: scene.base,
          lightingMode: 'source',
          attribution: [LOGO, fitted],
        });
        expect(equalToBase(scene, restored.candidate, labelCores)).toBe(labelCores.length);
        const box: number[] = [];
        for (let y = scene.labelBox.y0; y < size; y += 1) {
          for (let x = scene.labelBox.x0; x < size; x += 1) box.push(y * size + x);
        }
        expect(equalToBase(scene, restored.candidate, box)).toBe(box.length);

        // The measured rectangle cuts it in half.
        const cut = restoreProtectedRectangles({
          candidate,
          working: scene.base,
          lightingMode: 'source',
          attribution: [LOGO, LABEL],
        });
        expect(equalToBase(scene, cut.candidate, labelCores)).toBeLessThan(labelCores.length);
      });

      it('is restored whole on a relit (evening) picture', () => {
        const candidate = relitBy(scene.ground, DUSK);
        const labelCores = coresIn(scene, scene.labelBox);
        const restored = restoreProtectedRectangles({
          candidate,
          working: scene.base,
          lightingMode: 'evening',
          attribution: [LOGO, fitted],
        });
        const record = restored.attribution[1];
        expect(record?.mode).toBe('adapted');
        expect(equalToBase(scene, restored.candidate, labelCores)).toBe(labelCores.length);
        // The dark box is relit as one: as dark left of the measured rectangle as right of it.
        const left = boxGroundLuma(scene, restored.candidate, scene.labelBox.x0, measured.x0);
        const right = boxGroundLuma(scene, restored.candidate, measured.x0, size);
        expect(Math.abs(left - right)).toBeLessThan(0.03);

        // The measured rectangle is restored verbatim and loses the glyphs left of it.
        const cut = restoreProtectedRectangles({
          candidate,
          working: scene.base,
          lightingMode: 'evening',
          attribution: [LOGO, LABEL],
        });
        expect(cut.attribution[1]?.mode).toBe('verbatim');
        expect(equalToBase(scene, cut.candidate, labelCores)).toBeLessThan(labelCores.length);
      });
    });
  }

  it('fits every credit length up to the cap at the synthetic glyph density', () => {
    for (const glyphs of [13, 17, 25, 30, 33]) {
      const scene = attributionScene(640, { labelGlyphs: glyphs, groundLuma: 0.4 });
      const box = labelFor(creditOf(glyphs));
      const rect = toRect(box, 640, 640);
      expect(scene.labelBox.x0 - rect.x0, `${glyphs} glyphs`).toBeGreaterThanOrEqual(
        SETTINGS.boxGapPx + SETTINGS.boxOutsidePx,
      );
      const strokes = attributionStrokes(scene.base, box);
      expect(strokes.components, `${glyphs} glyphs`).toHaveLength(glyphs);
      expect(attributionStrokesReliable(strokes.share), `${glyphs} glyphs`).toBe(true);
    }
  });
});
