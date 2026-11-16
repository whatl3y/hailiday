import { describe, expect, it } from 'vitest';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  attributionStrokes,
  checkAttributionStrokes,
  restoreAttributionRelit,
  type AttributionRestore,
} from './attribution.js';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  lumaAt,
  relitBy,
  type AttributionScene,
} from './attribution.testing.js';
import { restoreProtectedRectangles, restoreRegion } from './composite.js';
import type { PxRect, Raster } from './raster.js';

const DUSK = [0.08, 0.09, 0.19] as const;
const BRIGHT = [1.8, 1.7, 1.5] as const;
const [LOGO, LABEL] = SYNTHETIC_ATTRIBUTION as [
  (typeof SYNTHETIC_ATTRIBUTION)[0],
  (typeof SYNTHETIC_ATTRIBUTION)[1],
];

/** The relit candidate an editor returns: the frame relit, with the logo and label painted over. */
function editorOutput(scene: AttributionScene, gain: readonly [number, number, number]): Raster {
  const relit = relitBy(scene.ground, gain);
  // A yellowish smudge where the label was, as the live editor left.
  const label = scene.rects[1] as PxRect;
  const cx = (label.x0 + label.x1) >> 1;
  const cy = (label.y0 + label.y1) >> 1;
  for (let y = cy - 4; y < cy + 4; y += 1) {
    for (let x = cx - 20; x < cx + 20; x += 1) {
      const p = (y * relit.width + x) * 3;
      relit.data[p] = 150;
      relit.data[p + 1] = 130;
      relit.data[p + 2] = 60;
    }
  }
  return relit;
}

/** Restores both rectangles in turn, each ring leaving the other rectangle out. */
function restoreBoth(candidate: Raster, base: Raster): AttributionRestore[] {
  const results: AttributionRestore[] = [];
  let current = candidate;
  for (const [index, box] of SYNTHETIC_ATTRIBUTION.entries()) {
    const result = restoreAttributionRelit(current, base, box, {
      ringExclude: SYNTHETIC_ATTRIBUTION.filter((_, other) => other !== index),
    });
    results.push(result);
    current = result.raster;
  }
  return results;
}

/** Paints `[x0, x1) x [y0, y1)` of `raster` in one color, clipped to the frame. */
function paint(raster: Raster, x0: number, y0: number, x1: number, y1: number, rgb: number[]) {
  for (let y = Math.max(0, y0); y < Math.min(raster.height, y1); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(raster.width, x1); x += 1) {
      const p = (y * raster.width + x) * 3;
      raster.data[p] = rgb[0] as number;
      raster.data[p + 1] = rgb[1] as number;
      raster.data[p + 2] = rgb[2] as number;
    }
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

/** Median luma of the ring around a rectangle (the relit ground the rectangle must match). */
function ringLuma(raster: Raster, rect: PxRect, width: number): number {
  const values: number[] = [];
  for (let y = Math.max(0, rect.y0 - width); y < rect.y1; y += 1) {
    for (let x = rect.x0; x < Math.min(raster.width, rect.x1 + width); x += 1) {
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0) continue;
      values.push(lumaAt(raster, x, y));
    }
  }
  return median(values);
}

/** Every stroke-core pixel of the scene equals the base, byte for byte. */
function strokesEqualBase(scene: AttributionScene, out: Raster): { core: number; equal: number } {
  let core = 0;
  let equal = 0;
  for (let i = 0; i < scene.strokeCore.length; i += 1) {
    if (!scene.strokeCore[i]) continue;
    core += 1;
    const p = i * 3;
    if (
      out.data[p] === scene.base.data[p] &&
      out.data[p + 1] === scene.base.data[p + 1] &&
      out.data[p + 2] === scene.base.data[p + 2]
    ) {
      equal += 1;
    }
  }
  return { core, equal };
}

describe('attribution strokes of a base frame', () => {
  it('finds the logo and label strokes and ignores gravel speckles', () => {
    const scene = attributionScene(1024);
    for (const [index, box] of SYNTHETIC_ATTRIBUTION.entries()) {
      const { rect, keep, share } = attributionStrokes(scene.base, box);
      expect(rect).toEqual(scene.rects[index]);
      expect(share).toBeGreaterThan(PIPELINE_DEFAULTS.attributionRelight.minShare);
      expect(share).toBeLessThan(PIPELINE_DEFAULTS.attributionRelight.maxShare);
      const width = rect.x1 - rect.x0;
      for (const [x, y] of scene.speckles) {
        if (x < rect.x0 || x >= rect.x1 || y < rect.y0 || y >= rect.y1) continue;
        expect(keep[(y - rect.y0) * width + (x - rect.x0)]).toBe(0);
      }
    }
  });

  it('keeps no ground trapped between a stroke and the frame edge', () => {
    const scene = attributionScene(1024);
    const base: Raster = { ...scene.base, data: Buffer.from(scene.base.data) };
    // Pale ground along the bottom edge, and a descender bar (4 px white stroke with the logo's
    // 2 px dark outline) whose outline ends 3 px above the frame edge, with a stem rising from it.
    paint(base, 0, 1012, 120, 1024, [180, 180, 176]);
    const [x0, x1, y0, y1] = [60, 76, 1015, 1019];
    paint(base, x0 - 2, y0 - 2, x1 + 2, y1 + 2, [36, 36, 40]);
    paint(base, x0, y0, x1, y1, [246, 246, 244]);
    paint(base, x1 - 6, y0 - 20, x1 + 2, y0, [36, 36, 40]);
    paint(base, x1 - 4, y0 - 19, x1, y0, [246, 246, 244]);
    const { rect, keep, share } = attributionStrokes(base, LOGO);
    expect(share).toBeGreaterThan(PIPELINE_DEFAULTS.attributionRelight.minShare);
    const width = rect.x1 - rect.x0;
    const at = (x: number, y: number) => keep[(y - rect.y0) * width + (x - rect.x0)] as number;
    let stroke = 0;
    for (let y = y0; y < y1; y += 1)
      for (let x = x0; x < x1; x += 1) if (at(x, y) >= 0.9) stroke += 1;
    expect(stroke).toBe((x1 - x0) * (y1 - y0));
    // The three rows of ground below the outline stay ground.
    expect(1024 - (y1 + 2)).toBe(3);
    for (let y = y1 + 2; y < 1024; y += 1) {
      for (let x = x0 - 2; x < x1 + 2; x += 1) expect(at(x, y)).toBeLessThan(0.5);
    }
  });

  it('treats a saturated bright stripe (a road marking) as ground, not as a stroke', () => {
    const scene = attributionScene(1024);
    const base: Raster = { ...scene.base, data: Buffer.from(scene.base.data) };
    const label = scene.rects[1] as PxRect;
    // A 3 px yellow marking across the open ground left of the label's dark box.
    const [x0, x1, y0, y1] = [label.x0 + 2, label.x0 + 28, label.y0 + 22, label.y0 + 25];
    paint(base, x0, y0, x1, y1, [236, 204, 64]);
    const { rect, keep, share } = attributionStrokes(base, LABEL);
    expect(share).toBeGreaterThan(PIPELINE_DEFAULTS.attributionRelight.minShare);
    const width = rect.x1 - rect.x0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        expect(keep[(y - rect.y0) * width + (x - rect.x0)]).toBe(0);
      }
    }
    // The label's light grey strokes are still found.
    const unmarked = attributionStrokes(scene.base, LABEL);
    expect(share).toBeCloseTo(unmarked.share, 6);
    // Relit, the marking follows the light like the ground around it.
    const restored = restoreAttributionRelit(relitBy(base, DUSK), base, LABEL, {
      ringExclude: [LOGO],
    });
    expect(restored.mode).toBe('adapted');
    expect(lumaAt(restored.raster, x0 + 10, y0 + 1)).toBeLessThan(0.5);
  });

  it('finds nothing on a washed-out (snow-like) ground', () => {
    const scene = attributionScene(1024, { ground: 'white' });
    expect(attributionStrokes(scene.base, LOGO).share).toBeLessThan(
      PIPELINE_DEFAULTS.attributionRelight.minShare,
    );
  });
});

describe('restoring an attribution rectangle into a relit image', () => {
  const scene = attributionScene(1024);
  const candidate = editorOutput(scene, DUSK);
  const results = restoreBoth(candidate, scene.base);
  const out = (results[1] as AttributionRestore).raster;

  it('keeps every stroke pixel of the base bit for bit', () => {
    expect(results.map((r) => r.mode)).toEqual(['adapted', 'adapted']);
    const { core, equal } = strokesEqualBase(scene, out);
    expect(core).toBeGreaterThan(500);
    expect(equal).toBe(core);
  });

  it('relights the ground behind them to match the ring, with no pale patch and no step', () => {
    const gain = results[0]?.gain as [number, number, number];
    for (const [c, value] of gain.entries()) expect(value).toBeCloseTo(DUSK[c] as number, 2);
    const logo = scene.rects[0] as PxRect;
    const { keep } = attributionStrokes(scene.base, LOGO);
    const width = logo.x1 - logo.x0;
    const ground: number[] = [];
    for (let y = logo.y0; y < logo.y1; y += 1) {
      for (let x = logo.x0; x < logo.x1; x += 1) {
        if ((keep[(y - logo.y0) * width + (x - logo.x0)] as number) === 0) {
          ground.push(lumaAt(out, x, y));
        }
      }
    }
    const ring = ringLuma(out, logo, Math.round(0.03 * 1024));
    expect(Math.abs(median(ground) - ring)).toBeLessThan(0.03);
    // Today's verbatim copy leaves a pale patch.
    const verbatim = restoreRegion(candidate, scene.base, LOGO);
    const pale: number[] = [];
    for (let y = logo.y0; y < logo.y1; y += 1) {
      for (let x = logo.x0; x < logo.x1; x += 1) {
        if ((keep[(y - logo.y0) * width + (x - logo.x0)] as number) === 0) {
          pale.push(lumaAt(verbatim, x, y));
        }
      }
    }
    expect(median(pale) - ring).toBeGreaterThan(0.2);

    // The inner edges (top and right of the logo rectangle) do not step.
    const step = (raster: Raster) => {
      let inside = 0;
      let outside = 0;
      let n = 0;
      for (let x = logo.x0 + 2; x < logo.x1 - 2; x += 1) {
        inside += lumaAt(raster, x, logo.y0);
        outside += lumaAt(raster, x, logo.y0 - 1);
        n += 1;
      }
      for (let y = logo.y0 + 2; y < logo.y1 - 14; y += 1) {
        inside += lumaAt(raster, logo.x1 - 1, y);
        outside += lumaAt(raster, logo.x1, y);
        n += 1;
      }
      return Math.abs(inside - outside) / n;
    };
    expect(step(out)).toBeLessThan(0.02);
    expect(step(verbatim)).toBeGreaterThan(0.2);
  });

  it('relights isolated bright speckles instead of keeping them', () => {
    let inside = 0;
    for (const [x, y] of scene.speckles) {
      inside += 1;
      expect(lumaAt(scene.base, x, y)).toBeGreaterThan(0.85);
      expect(lumaAt(out, x, y)).toBeLessThan(0.5);
    }
    expect(inside).toBe(6);
  });

  it('replaces what the editor painted over the label with the relit dark box', () => {
    const label = scene.rects[1] as PxRect;
    const cx = (label.x0 + label.x1) >> 1;
    const cy = (label.y0 + label.y1) >> 1;
    const { keep } = attributionStrokes(scene.base, LABEL);
    const width = label.x1 - label.x0;
    let checked = 0;
    for (let x = cx - 20; x < cx + 20; x += 1) {
      if ((keep[(cy - label.y0) * width + (x - label.x0)] as number) > 0) continue;
      checked += 1;
      // The dark box relit: far darker than the yellow smudge and than the daylight box.
      expect(lumaAt(out, x, cy)).toBeLessThan(lumaAt(scene.base, x, cy));
      const p = (cy * out.width + x) * 3;
      expect(out.data[p]).toBeLessThan(40);
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('is deterministic', () => {
    const again = restoreBoth(candidate, scene.base);
    expect((again[1] as AttributionRestore).raster.data.equals(out.data)).toBe(true);
  });
});

describe('restoring into other relights and frames', () => {
  it('works for a brighter target (gain above 1)', () => {
    const scene = attributionScene(1024);
    const results = restoreBoth(editorOutput(scene, BRIGHT), scene.base);
    expect(results.map((r) => r.mode)).toEqual(['adapted', 'adapted']);
    expect(results[0]?.gain?.[0]).toBeGreaterThan(1.5);
    const { core, equal } = strokesEqualBase(scene, (results[1] as AttributionRestore).raster);
    expect(equal).toBe(core);
  });

  it('copies the rectangle verbatim when the strokes cannot be found (snow-like ground)', () => {
    const scene = attributionScene(1024, { ground: 'white' });
    const candidate = relitBy(scene.ground, DUSK);
    const result = restoreAttributionRelit(candidate, scene.base, LOGO);
    expect(result).toMatchObject({ mode: 'verbatim', gain: null });
    const rect = scene.rects[0] as PxRect;
    for (let y = rect.y0; y < rect.y1; y += 1) {
      const start = (y * 1024 + rect.x0) * 3;
      const end = (y * 1024 + rect.x1) * 3;
      expect(
        result.raster.data.subarray(start, end).equals(scene.base.data.subarray(start, end)),
      ).toBe(true);
    }
  });

  it.each([640, 1536])('scales its constants to a %i px long edge', (size) => {
    const scene = attributionScene(size);
    const results = restoreBoth(editorOutput(scene, DUSK), scene.base);
    expect(results.map((r) => r.mode)).toEqual(['adapted', 'adapted']);
    const out = (results[1] as AttributionRestore).raster;
    const { core, equal } = strokesEqualBase(scene, out);
    expect(core).toBeGreaterThan(100);
    expect(equal).toBe(core);
    for (const [x, y] of scene.speckles) expect(lumaAt(out, x, y)).toBeLessThan(0.5);
    for (const box of SYNTHETIC_ATTRIBUTION) {
      expect(checkAttributionStrokes(scene.base, out, box)).toMatchObject({
        mode: 'adapted',
        passed: true,
      });
    }
  });
});

describe('restoring the protected rectangles of a composite', () => {
  it('copies verbatim in source mode and keeps strokes over a relit ground in a relight', () => {
    const scene = attributionScene(1024);
    const candidate = editorOutput(scene, DUSK);
    const source = restoreProtectedRectangles({
      candidate,
      working: scene.base,
      lightingMode: 'source',
      attribution: SYNTHETIC_ATTRIBUTION,
    });
    expect(source.attribution).toEqual([
      { mode: 'verbatim', share: null, gain: null },
      { mode: 'verbatim', share: null, gain: null },
    ]);
    const logo = scene.rects[0] as PxRect;
    const p = (logo.y0 * 1024 + logo.x0) * 3;
    expect(
      source.candidate.data.subarray(p, p + 3).equals(scene.base.data.subarray(p, p + 3)),
    ).toBe(true);

    const relit = restoreProtectedRectangles({
      candidate,
      working: scene.base,
      lightingMode: 'evening',
      attribution: SYNTHETIC_ATTRIBUTION,
      padRegions: [[0.4, 0, 0.6, 0.05]],
    });
    expect(relit.attribution.map((record) => record.mode)).toEqual(['adapted', 'adapted']);
    expect(relit.attribution[0]?.share).toBeGreaterThan(0.04);
    const { core, equal } = strokesEqualBase(scene, relit.candidate);
    expect(equal).toBe(core);
    // Padding stays verbatim.
    const q = (10 * 1024 + 500) * 3;
    expect(relit.candidate.data.subarray(q, q + 3).equals(scene.base.data.subarray(q, q + 3))).toBe(
      true,
    );
  });
});
