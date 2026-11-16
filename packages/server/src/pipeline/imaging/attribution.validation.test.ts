import { describe, expect, it } from 'vitest';
import { PIPELINE_DEFAULTS } from '../versions.js';
import {
  attributionStrokes,
  restoreAttributionRelit,
  type AttributionStrokes,
} from './attribution.js';
import {
  LABEL_BOX_TRANSMISSION,
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  labelStrokeOver,
  lumaAt,
  paintBlob,
  paintRect,
  relitBy,
  type AttributionScene,
} from './attribution.testing.js';
import type { PxRect, Raster } from './raster.js';

/** An evening relight's gain in linear light, as measured on recorded Street View frames. */
const EVENING = [0.08, 0.075, 0.14] as const;
const SETTINGS = PIPELINE_DEFAULTS.attributionRelight;
const [LOGO, LABEL] = SYNTHETIC_ATTRIBUTION as [
  (typeof SYNTHETIC_ATTRIBUTION)[0],
  (typeof SYNTHETIC_ATTRIBUTION)[1],
];
const SIZE = 1024;
/** Sunlit leaf litter and gravel: bright and nearly neutral. */
const LEAF = [238, 236, 230];
const GRAVEL = [232, 231, 226];
const WHITE = [246, 246, 244];
/** The label's strokes over the synthetic scene's grey ground. */
const LABEL_GREY = labelStrokeOver([116, 112, 106]);
const HALO = [36, 36, 40];

const copyOf = (raster: Raster): Raster => ({ ...raster, data: Buffer.from(raster.data) });

const keepAt = (strokes: AttributionStrokes, x: number, y: number): number => {
  const { rect, keep } = strokes;
  if (x < rect.x0 || x >= rect.x1 || y < rect.y0 || y >= rect.y1) return 0;
  return keep[(y - rect.y0) * (rect.x1 - rect.x0) + (x - rect.x0)] as number;
};

/** The largest keep over a set of pixel indices (`y * width + x`). */
const maxKeep = (strokes: AttributionStrokes, pixels: readonly number[]): number =>
  Math.max(0, ...pixels.map((i) => keepAt(strokes, i % SIZE, Math.floor(i / SIZE))));

/** Pixel indices of `[x0, x1) x [y0, y1)`. */
function rectPixels(x0: number, y0: number, x1: number, y1: number): number[] {
  const pixels: number[] = [];
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) pixels.push(y * SIZE + x);
  return pixels;
}

/** Pixel indices of the stroke cores inside one rectangle. */
function coresIn(scene: AttributionScene, rect: PxRect): number[] {
  const pixels: number[] = [];
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1)
      if (scene.strokeCore[y * SIZE + x]) pixels.push(y * SIZE + x);
  }
  return pixels;
}

const minKeep = (strokes: AttributionStrokes, pixels: readonly number[]): number =>
  Math.min(1, ...pixels.map((i) => keepAt(strokes, i % SIZE, Math.floor(i / SIZE))));

/**
 * Paints a hollow glyph (2 px strokes) over `[x0, x1) x [y0, y1)` and returns the cores of its
 * vertical strokes (the pixels a kept glyph keeps solid).
 */
function paintGlyph(
  base: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: readonly number[],
): number[] {
  paintRect(base, x0, y0, x1, y0 + 2, rgb);
  paintRect(base, x0, y1 - 2, x1, y1, rgb);
  paintRect(base, x0, y0, x0 + 2, y1, rgb);
  paintRect(base, x1 - 2, y0, x1, y1, rgb);
  return [...rectPixels(x0, y0 + 3, x0 + 2, y1 - 3), ...rectPixels(x1 - 2, y0 + 3, x1, y1 - 3)];
}

/**
 * A scene whose label has a word gap of `gap` px after its fifth glyph (the label is
 * right-aligned in its box, so there is no room after its last glyph). Returns the scene and the
 * gap's columns.
 */
function gapScene(gap: number): { scene: AttributionScene; x0: number; x1: number } {
  const scene = attributionScene(SIZE, { labelWordEvery: 5, labelWordGap: gap });
  return {
    scene,
    x0: (scene.labelGlyphs[4] as PxRect).x1,
    x1: (scene.labelGlyphs[5] as PxRect).x0,
  };
}

/** Sunlit litter (leaves with a partial shadow) right of, above and below the logo. */
function addLitter(base: Raster, scene: AttributionScene): number[][] {
  const last = scene.logoGlyphs.at(-1) as PxRect;
  const shadow = [70, 66, 60];
  paintBlob(base, last.x1 + 15, 1004, 7, 16, shadow);
  return [
    paintBlob(base, last.x1 + 13, 1001, 7, 16, LEAF),
    paintBlob(base, 20, 982, 5, 2.4, LEAF),
    paintBlob(base, 56, 982, 7, 2.6, LEAF),
    paintBlob(base, 92, 981, 4, 2.4, LEAF),
    paintBlob(base, 80, 1022, 6, 2, LEAF),
  ];
}

/** Gravel above and beside the label's dark box. */
function addGravel(base: Raster): number[][] {
  return [
    paintBlob(base, 830, 1004, 4, 3, GRAVEL),
    paintBlob(base, 839, 1016, 5, 3, GRAVEL),
    paintBlob(base, 824, 995, 3, 3, GRAVEL),
    paintBlob(base, 900, 989, 6, 1.4, GRAVEL),
  ];
}

/**
 * A descender stem of the first glyph running into the frame's bottom edge, with pale ground
 * (luma 0.6) trapped against it at the edge: no outline separates them, so the ground joins the
 * stroke's component. Returns the stem's and the trapped ground's pixels.
 */
function addTrappedGround(base: Raster): { stem: number[]; painted: number[]; trapped: number[] } {
  paintRect(base, 0, 1018, 34, SIZE, [70, 68, 66]);
  paintRect(base, 18, 1016, 26, SIZE, HALO);
  paintRect(base, 20, 1016, 24, SIZE, WHITE);
  paintRect(base, 24, 1020, 30, SIZE, [154, 154, 154]);
  return {
    stem: rectPixels(21, 1016, 23, SIZE),
    painted: rectPixels(20, 1016, 24, SIZE),
    trapped: rectPixels(24, 1020, 30, SIZE),
  };
}

/**
 * Joins the logo's glyphs 1 to 4 and 5 to 6 at the baseline, so the logo is two components.
 * Returns the joints' painted pixels and their cores.
 */
function joinLogo(base: Raster, scene: AttributionScene): { painted: number[]; cores: number[] } {
  const glyphs = scene.logoGlyphs;
  const painted: number[] = [];
  const joints: number[] = [];
  for (const [a, b] of [
    [0, 1],
    [1, 2],
    [2, 3],
    [4, 5],
  ] as const) {
    const left = glyphs[a] as PxRect;
    const right = glyphs[b] as PxRect;
    paintRect(base, left.x1, left.y1 - 4, right.x0, left.y1, WHITE);
    painted.push(...rectPixels(left.x1, left.y1 - 4, right.x0, left.y1));
    joints.push(...rectPixels(left.x1, left.y1 - 3, right.x0, left.y1 - 1));
  }
  return { painted, cores: joints };
}

/** Median and largest luma of the in-frame ring around a rectangle (other rectangles left out). */
function ringStats(raster: Raster, rect: PxRect, others: readonly PxRect[]) {
  const width = Math.round(SETTINGS.ringFraction * SIZE);
  const values: number[] = [];
  for (let y = Math.max(0, rect.y0 - width); y < Math.min(SIZE, rect.y1 + width); y += 1) {
    for (let x = Math.max(0, rect.x0 - width); x < Math.min(SIZE, rect.x1 + width); x += 1) {
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) continue;
      if (others.some((o) => x >= o.x0 && x < o.x1 && y >= o.y0 && y < o.y1)) continue;
      values.push(lumaAt(raster, x, y));
    }
  }
  values.sort((a, b) => a - b);
  return { median: values[values.length >> 1] as number, max: values.at(-1) as number };
}

describe('validating the strokes of an attribution mark', () => {
  it('keeps no sunlit litter around and above the logo, and the logo is still adapted', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const litter = addLitter(base, scene);
    for (const blob of litter) {
      expect(blob.length).toBeGreaterThanOrEqual(30);
      expect(blob.length).toBeLessThanOrEqual(450);
    }
    expect(Math.max(...litter.map((blob) => blob.length))).toBeGreaterThan(300);
    const strokes = attributionStrokes(base, LOGO);
    for (const blob of litter) expect(maxKeep(strokes, blob)).toBe(0);
    expect(strokes.components).toHaveLength(6);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
    const restored = restoreAttributionRelit(relitBy(base, EVENING), base, LOGO, {
      ringExclude: [LABEL],
    });
    expect(restored.mode).toBe('adapted');
  });

  it('keeps no bright gravel above or beside the label', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const gravel = addGravel(base);
    const strokes = attributionStrokes(base, LABEL);
    for (const blob of gravel) {
      expect(blob.length).toBeGreaterThanOrEqual(24);
      expect(maxKeep(strokes, blob)).toBe(0);
    }
    expect(strokes.components).toHaveLength(scene.labelGlyphs.length);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps no neutral white line that crosses the rectangle inner edge', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const logo = scene.rects[0] as PxRect;
    // A white road marking on dark asphalt, in the logo's line, running out of the rectangle.
    paintRect(base, 92, 996, 150, 1006, [44, 44, 46]);
    paintRect(base, 94, 999, 150, 1002, [240, 240, 238]);
    const line = rectPixels(94, 999, logo.x1, 1002);
    const strokes = attributionStrokes(base, LOGO);
    expect(maxKeep(strokes, line)).toBe(0);
    expect(strokes.components).toHaveLength(6);
  });

  it('keeps no ground trapped under the logo at the frame edge, although it joins a stroke', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const { stem, trapped } = addTrappedGround(base);
    const strokes = attributionStrokes(base, LOGO);
    // The trapped ground is part of the first glyph's component, which is kept.
    const first = strokes.components[0];
    expect(first?.box.y1).toBe(SIZE);
    expect(first?.box.x1).toBeGreaterThan(27);
    expect(minKeep(strokes, stem)).toBeGreaterThanOrEqual(SETTINGS.solidKeep);
    expect(maxKeep(strokes, trapped)).toBeLessThan(0.05);
    // Relit, it follows the light.
    const out = restoreAttributionRelit(relitBy(base, EVENING), base, LOGO, {
      ringExclude: [LABEL],
    }).raster;
    const relit = relitBy(base, EVENING);
    for (const i of trapped) {
      const [x, y] = [i % SIZE, Math.floor(i / SIZE)];
      expect(lumaAt(out, x, y) - lumaAt(relit, x, y)).toBeLessThan(0.04);
    }
  });

  it('keeps no bright ground joined to a stroke only through its dark outline', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[3] as PxRect;
    // A pale stalk from the frame edge into the outline under the glyph, ending in a leaf.
    const cx = (glyph.x0 + glyph.x1) >> 1;
    paintRect(base, cx - 1, glyph.y1 + 1, cx + 2, SIZE, [206, 206, 200]);
    const stalk = [
      ...rectPixels(cx - 1, glyph.y1 + 1, cx + 2, SIZE),
      ...paintBlob(base, cx + 3, 1021, 4, 2.5, [206, 206, 200]),
    ];
    const strokes = attributionStrokes(base, LOGO);
    expect(maxKeep(strokes, stalk)).toBe(0);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('finds no strokes for a glyph-like blob beside the label box within the run gap, and keeps none beyond it', () => {
    const scene = attributionScene(SIZE);
    const first = scene.labelGlyphs[0] as PxRect;
    const box = scene.labelBox;
    const strokes0 = attributionStrokes(scene.base, LABEL);
    const anchor = strokes0.components.reduce((a, b) => (b.area > a.area ? b : a));
    const gap = SETTINGS.runGap * (anchor.box.y1 - anchor.box.y0);
    // A blob of the label's brightness and a glyph's shape on dark ground left of the box.
    const blobAt = (x1: number) => {
      const base = copyOf(scene.base);
      paintRect(base, x1 - 13, 960, x1 + 4, SIZE, [30, 30, 30]);
      return {
        pixels: paintGlyph(base, x1 - 9, first.y0 + 2, x1, first.y1 - 2, LABEL_GREY),
        strokes: attributionStrokes(base, LABEL),
      };
    };
    // Beyond the gap: not kept, and the label is found.
    const far = blobAt(first.x0 - Math.ceil(gap) - 3);
    expect(far.pixels.length).toBeGreaterThan(30);
    expect(maxKeep(far.strokes, far.pixels)).toBe(0);
    expect(far.strokes.components).toHaveLength(scene.labelGlyphs.length);
    // Within the gap it is a look-alike beside the mark: the strokes are not found.
    const near = blobAt(box.x0 - 6);
    expect(maxKeep(near.strokes, near.pixels)).toBe(0);
    expect(near.strokes.share).toBe(0);
  });

  it('keeps no component of another brightness beside the label box, and stops at one of its brightness', () => {
    const scene = attributionScene(SIZE);
    const first = scene.labelGlyphs[0] as PxRect;
    const box = scene.labelBox;
    let pixels: number[] = [];
    const blob = (rgb: readonly number[]) => {
      const base = copyOf(scene.base);
      paintRect(base, box.x0 - 19, 960, box.x0 - 6, SIZE, [30, 30, 30]);
      pixels = paintGlyph(base, box.x0 - 17, first.y0 + 2, box.x0 - 8, first.y1 - 2, rgb);
      return attributionStrokes(base, LABEL);
    };
    const white = blob([252, 252, 250]);
    expect(maxKeep(white, pixels)).toBe(0);
    expect(white.components).toHaveLength(scene.labelGlyphs.length);
    const grey = blob(LABEL_GREY);
    expect(maxKeep(grey, pixels)).toBe(0);
    expect(grey.share).toBe(0);
  });

  it('keeps every separated glyph of a longer copyright line', () => {
    const scene = attributionScene(SIZE, {
      labelGlyphs: 13,
      labelWordEvery: 4,
      labelWordGap: 8,
    });
    const strokes = attributionStrokes(scene.base, LABEL);
    expect(strokes.components).toHaveLength(13);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(strokes.share).toBeLessThan(SETTINGS.maxShare);
  });

  it('keeps both components of a logo found as two', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const joints = joinLogo(base, scene).cores;
    const strokes = attributionStrokes(base, LOGO);
    expect(strokes.components).toHaveLength(2);
    expect(minKeep(strokes, [...coresIn(scene, strokes.rect), ...joints])).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('is deterministic and finds nothing in a rectangle without a mark', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    addLitter(base, scene);
    const a = attributionStrokes(base, LOGO);
    const b = attributionStrokes(base, LOGO);
    expect(Buffer.from(a.keep.buffer).equals(Buffer.from(b.keep.buffer))).toBe(true);
    expect(a.components).toEqual(b.components);
    const empty = attributionStrokes(base, [0.3, 0.955, 0.41, 1]);
    expect(empty.components).toEqual([]);
    expect(empty.share).toBe(0);
  });
});

/** Both rectangles restored into the scene relit at the evening gain. */
function restoreScene(base: Raster) {
  let out = relitBy(base, EVENING);
  return SYNTHETIC_ATTRIBUTION.map((box, index) => {
    const result = restoreAttributionRelit(out, base, box, {
      ringExclude: SYNTHETIC_ATTRIBUTION.filter((_, other) => other !== index),
    });
    out = result.raster;
    return { result, strokes: attributionStrokes(base, box) };
  });
}

/**
 * A mark is whole or not restored: an adapted rectangle keeps every stroke core of the scene
 * solid, a verbatim one keeps nothing. Returns the modes.
 */
function expectWholeOrVerbatim(scene: AttributionScene, base: Raster): string[] {
  return restoreScene(base).map(({ result, strokes }) => {
    if (result.mode === 'adapted') {
      expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
        SETTINGS.solidKeep,
      );
    } else {
      expect(strokes.share).toBeLessThan(SETTINGS.minShare);
    }
    return result.mode;
  });
}

/** Paints the pixels of `[x0, x1) x [y0, y1)` whose current luma is below `below`. */
function paintDark(
  base: Raster,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  below: number,
  rgb: readonly number[],
): void {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (lumaAt(base, x, y) < below) paintRect(base, x, y, x + 1, y + 1, rgb);
    }
  }
}

describe('keeping a mark whole on any ground', () => {
  it.each([0.8, 0.85, 0.9, 0.95, 1])(
    'restores both marks whole over flat ground of luma %f',
    (luma) => {
      const scene = attributionScene(SIZE, { groundLuma: luma });
      const modes = expectWholeOrVerbatim(scene, scene.base);
      // The translucent outline and box keep the strokes' contrast on bright ground.
      expect(modes).toEqual(['adapted', 'adapted']);
    },
  );

  it('restores the label whole over ground that runs from dark to white under its box', () => {
    const scene = attributionScene(SIZE);
    const box = scene.labelBox;
    const base = copyOf(scene.ground);
    // Mid grey left of the box; under and above it a ramp from dark grey to white.
    for (let y = 960; y < SIZE; y += 1) {
      for (let x = 780; x < SIZE; x += 1) {
        const ramp = Math.min(1, 0.15 + Math.max(0, (x - box.x0 - 8) / 100));
        const v = Math.round(255 * (x < box.x0 ? 0.5 : ramp));
        paintRect(base, x, y, x + 1, y + 1, [v, v, v]);
      }
    }
    // The label of the scene drawn over the ramp: the box passes its ground, the strokes add.
    for (let y = box.y0; y < SIZE; y += 1) {
      for (let x = box.x0; x < SIZE; x += 1) {
        const p = (y * SIZE + x) * 3;
        const g = base.data[p] as number;
        const v = scene.strokePaint[y * SIZE + x]
          ? (labelStrokeOver([g])[0] as number)
          : Math.round(0.3 * g);
        paintRect(base, x, y, x + 1, y + 1, [v, v, v]);
      }
    }
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('finds no strokes when a glyph misses the contrast by a little, rather than drop it', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[3] as PxRect;
    // The box around one glyph a little brighter: its contrast falls just under the rule's.
    paintDark(base, glyph.x0 - 3, glyph.y0 - 3, glyph.x1 + 3, glyph.y1 + 3, 0.4, [86, 86, 86]);
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.components).toEqual([]);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes when a letter of the logo misses the contrast by a little', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[4] as PxRect;
    paintDark(base, glyph.x0 - 2, glyph.y0 - 2, glyph.x1 + 2, glyph.y1 + 2, 0.5, [140, 140, 140]);
    const strokes = attributionStrokes(base, LOGO);
    expect(strokes.share).toBe(0);
  });

  it('keeps a glyph of the label separate from a bright leaf joined to it', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const first = scene.labelGlyphs[0] as PxRect;
    // A bright leaf left of the first glyph, joined to it through the box's margin.
    const leaf = paintBlob(base, first.x0 - 9, (first.y0 + first.y1) >> 1, 6, 5, LEAF);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, leaf)).toBe(0);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps a thin glyph cut from its neighbours within the line', () => {
    const { scene, x0 } = gapScene(14);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[4] as PxRect;
    // An "i" stem: 2 px wide and shorter than the line, smaller than the minimum stroke area.
    const top = glyph.y1 - 11;
    paintRect(base, x0 + 6, top, x0 + 8, glyph.y1, LABEL_GREY);
    const stem = rectPixels(x0 + 6, top + 1, x0 + 8, glyph.y1 - 1);
    expect(stem.length).toBeLessThan(SETTINGS.minStrokeArea);
    const strokes = attributionStrokes(base, LABEL);
    expect(minKeep(strokes, [...stem, ...coresIn(scene, strokes.rect)])).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps a descender of the logo that reaches below the line of its largest letter', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const bar = scene.logoGlyphs[5] as PxRect;
    const depth = 6;
    const halo = 2;
    paintDark(base, bar.x0 - halo, bar.y1, bar.x1 + halo, bar.y1 + depth + halo, 1, HALO);
    paintRect(base, bar.x0, bar.y1 - 1, bar.x1, bar.y1 + depth, WHITE);
    const descender = rectPixels(bar.x0 + 1, bar.y1, bar.x1 - 1, bar.y1 + depth - 1);
    const strokes = attributionStrokes(base, LOGO);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(
      minKeep(strokes, [...descender, ...coresIn(scene, strokes.rect)]),
    ).toBeGreaterThanOrEqual(SETTINGS.solidKeep);
  });
});

describe('finding no strokes when the rules cannot tell', () => {
  it('finds no strokes when the largest glyph sets a line that leaves taller glyphs out', () => {
    const { scene, x0 } = gapScene(44);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[4] as PxRect;
    // A wide glyph of x-height in the word gap, larger than any other.
    const top = glyph.y1 - 9;
    paintRect(base, x0 + 4, top, x0 + 40, top + 2, LABEL_GREY);
    for (let x = x0 + 4; x < x0 + 40; x += 5) paintRect(base, x, top, x + 2, glyph.y1, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes when a short glyph falls under the height of a tall anchor', () => {
    const { scene, x0 } = gapScene(16);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[1] as PxRect;
    // An ascender of the label's brightness on one glyph makes it the tallest.
    paintRect(base, glyph.x0, scene.labelBox.y0 + 2, glyph.x0 + 2, glyph.y0, LABEL_GREY);
    // A glyph of x-height in the word gap.
    paintGlyph(base, x0 + 4, glyph.y1 - 8, x0 + 12, glyph.y1, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes when a letter joined to the others misses the contrast by a little', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyphs = scene.logoGlyphs;
    // The letters joined through dim bridges: one component, separate bright parts.
    for (const [a, b] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ] as const) {
      const left = glyphs[a] as PxRect;
      const right = glyphs[b] as PxRect;
      paintRect(base, left.x1, left.y1 - 3, right.x0, left.y1 - 1, [120, 120, 120]);
    }
    const glyph = glyphs[4] as PxRect;
    // Its counter and the outline above and below it brighter: its part misses the contrast.
    paintDark(base, glyph.x0, glyph.y0 - 2, glyph.x1, glyph.y1 + 2, 0.4, [140, 140, 140]);
    const strokes = attributionStrokes(base, LOGO);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes when a short bit of glyph brightness inside the box is no stroke', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const tall = scene.labelGlyphs[0] as PxRect;
    const other = scene.labelGlyphs[3] as PxRect;
    // An ascender on the first glyph, and a short bit of the label's brightness above another:
    // the bit is not a stroke (it lies above one), and nothing else inside the box is that bright.
    paintRect(base, tall.x0, tall.y0 - 5, tall.x0 + 2, tall.y0, LABEL_GREY);
    const bit = rectPixels(other.x0 + 2, other.y0 - 5, other.x1 - 2, other.y0 - 3);
    paintRect(base, other.x0 + 2, other.y0 - 5, other.x1 - 2, other.y0 - 3, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, bit)).toBe(0);
    expect(strokes.share).toBe(0);
  });

  it('keeps no white stalk on bright ground joined to a letter through its outline', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[3] as PxRect;
    const cx = (glyph.x0 + glyph.x1) >> 1;
    // Bright ground under the letter, and a stalk as white as the letters from the outline down.
    paintRect(base, glyph.x0 - 6, glyph.y1 + 2, glyph.x1 + 6, SIZE, [170, 170, 170]);
    const stalk = rectPixels(cx - 1, glyph.y1 + 1, cx + 2, SIZE);
    paintRect(base, cx - 1, glyph.y1 + 1, cx + 2, SIZE, WHITE);
    const strokes = attributionStrokes(base, LOGO);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(maxKeep(strokes, stalk)).toBe(0);
  });

  it('keeps the label apart from a white twig left of its box, joined to ground beyond the rectangle', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    const rect = scene.rects[1] as PxRect;
    paintRect(base, box.x0 - 14, rect.y0 - 16, box.x0 - 3, first.y1, [30, 30, 30]);
    // A dim strand from above the rectangle to a white twig beside the box.
    paintRect(base, box.x0 - 10, rect.y0 - 14, box.x0 - 8, first.y0 + 2, [104, 104, 104]);
    const twig = rectPixels(box.x0 - 6, first.y0 + 2, box.x0 - 4, first.y1);
    paintRect(base, box.x0 - 6, first.y0 + 2, box.x0 - 4, first.y1, [240, 240, 236]);
    paintRect(base, box.x0 - 8, first.y0 + 2, box.x0 - 6, first.y0 + 4, [104, 104, 104]);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, twig)).toBe(0);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });
});

describe('keeping no blob beside a mark', () => {
  it('keeps no bright leaf on a shadow patch beside the logo, which passes the contrast rule', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const last = scene.logoGlyphs.at(-1) as PxRect;
    paintRect(base, last.x1 + 3, last.y0 - 4, 113, last.y1 + 4, [34, 32, 30]);
    const leaf = paintBlob(base, last.x1 + 12, (last.y0 + last.y1) >> 1, 5, 4, LEAF);
    const [logo] = restoreScene(base);
    expect(maxKeep(logo!.strokes, leaf)).toBe(0);
    expect(logo!.result.mode).toBe('adapted');
    expect(minKeep(logo!.strokes, coresIn(scene, logo!.strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps no pebble of the label brightness on a dark patch beside the label', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    paintRect(base, 800, 960, box.x0 - 6, SIZE, [20, 20, 20]);
    const pebble = paintBlob(base, box.x0 - 16, (first.y0 + first.y1) >> 1, 4, 3.4, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, pebble)).toBe(0);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps no square knob on a glyph of the label, thicker than its strokes', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[0] as PxRect;
    const knob = rectPixels(glyph.x0 - 4, glyph.y0 + 4, glyph.x0, glyph.y0 + 8);
    paintRect(base, glyph.x0 - 4, glyph.y0 + 4, glyph.x0, glyph.y0 + 8, LABEL_GREY);
    expect(maxKeep(attributionStrokes(base, LABEL), knob)).toBeLessThan(SETTINGS.solidKeep);
  });

  it('keeps no glyph-like blob above the label line beside its box, and stops at one in the line', () => {
    const scene = attributionScene(SIZE);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    const height = first.y1 - first.y0;
    const at = (lift: number) => {
      const base = copyOf(scene.base);
      paintRect(base, box.x0 - 19, 960, box.x0 - 6, SIZE, [30, 30, 30]);
      const pixels = paintGlyph(
        base,
        box.x0 - 17,
        first.y0 - lift,
        box.x0 - 8,
        first.y1 - lift,
        LABEL_GREY,
      );
      return { pixels, strokes: attributionStrokes(base, LABEL) };
    };
    // Raised by more than the line's slack above: not a glyph of the line, and not kept.
    const raised = at(Math.round(SETTINGS.lineSlack * height) + 3);
    expect(maxKeep(raised.strokes, raised.pixels)).toBe(0);
    expect(raised.strokes.components).toHaveLength(scene.labelGlyphs.length);
    // In the line it is a look-alike beside the mark: the strokes are not found.
    const level = at(0);
    expect(maxKeep(level.strokes, level.pixels)).toBe(0);
    expect(level.strokes.share).toBe(0);
  });

  it('keeps no thin bright structure larger than the largest stroke component', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    // A wire netting of 2 px strands on dark ground in a rectangle without a mark.
    const box = [0.3, 0.9, 0.6, 1] as const;
    paintRect(base, 300, 915, 620, SIZE, [24, 24, 24]);
    let painted = 0;
    for (let y = 925; y < 1015; y += 9) {
      paintRect(base, 310, y, 610, y + 2, LABEL_GREY);
      painted += 600;
    }
    for (let x = 310; x < 610; x += 60) paintRect(base, x, 925, x + 2, 1015, LABEL_GREY);
    expect(painted).toBeGreaterThan(SETTINGS.maxStrokeArea);
    const strokes = attributionStrokes(base, [...box]);
    expect(strokes.share).toBe(0);
  });

  it('keeps no gravel shorter than the glyphs beside the label', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const first = scene.labelGlyphs[0] as PxRect;
    paintRect(base, 819, 989, 850, SIZE, [40, 38, 36]);
    const bits = [
      paintGlyph(base, first.x0 - 12, first.y1 - 6, first.x0 - 6, first.y1, LABEL_GREY),
      paintGlyph(base, first.x0 - 26, first.y1 - 5, first.x0 - 20, first.y1 + 1, LABEL_GREY),
    ].flat();
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, bits)).toBe(0);
  });

  it('keeps no tall blob beside the label that would set the line', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const first = scene.labelGlyphs[0] as PxRect;
    paintRect(base, first.x0 - 22, 989, first.x0 - 3, SIZE, [36, 34, 32]);
    const tall = paintGlyph(base, first.x0 - 9, 992, first.x0 - 5, first.y1 + 3, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, tall)).toBe(0);
  });

  it('keeps the label when a thin band of its brightness, larger than any glyph, runs above its box', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const box = scene.labelBox;
    paintRect(base, box.x0 - 40, 975, SIZE, box.y0 - 3, [30, 30, 30]);
    const band = rectPixels(box.x0 - 36, box.y0 - 11, SIZE, box.y0 - 8);
    paintRect(base, box.x0 - 36, box.y0 - 11, SIZE, box.y0 - 8, LABEL_GREY);
    expect(band.length).toBeGreaterThan(300);
    const modes = expectWholeOrVerbatim(scene, base);
    expect(maxKeep(attributionStrokes(base, LABEL), band)).toBe(0);
    expect(modes[1]).toBe('adapted');
  });

  it('keeps no bright bar under letters of the logo, joined to them through their outline', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const a = scene.logoGlyphs[3] as PxRect;
    const b = scene.logoGlyphs[4] as PxRect;
    paintDark(base, a.x0 - 2, a.y1, b.x1 + 2, a.y1 + 8, 1, HALO);
    const bar = rectPixels(a.x0, a.y1 + 1, b.x1, a.y1 + 5);
    paintRect(base, a.x0, a.y1 + 1, b.x1, a.y1 + 5, WHITE);
    const strokes = attributionStrokes(base, LOGO);
    expect(maxKeep(strokes, bar)).toBeLessThan(SETTINGS.solidKeep);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps the logo whole or not at all beside a pale stalk joined to a letter, and never the stalk', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const first = scene.logoGlyphs[0] as PxRect;
    paintRect(base, 0, first.y0, first.x0 - 2, first.y1, [30, 30, 30]);
    const stalk = rectPixels(first.x0 - 5, first.y0 + 6, first.x0 - 2, first.y1 - 2);
    paintRect(base, first.x0 - 5, first.y0 + 6, first.x0 - 2, first.y1 - 2, [216, 216, 212]);
    // Joined to the first letter outside the logo's place, it is a candidate in the letters' run.
    expectWholeOrVerbatim(scene, base);
    expect(maxKeep(attributionStrokes(base, LOGO), stalk)).toBe(0);
  });

  it('keeps the logo when sunlit litter joins it and crosses the rectangle', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[2] as PxRect;
    const rect = scene.rects[0] as PxRect;
    // A leaf from above the rectangle down to the logo's outline.
    paintRect(base, glyph.x0 - 4, rect.y0 - 14, glyph.x1 + 6, glyph.y0 - 2, [64, 62, 58]);
    const leaf = paintBlob(base, glyph.x1, rect.y0 - 2, 3, 9, LEAF);
    const strokes = attributionStrokes(base, LOGO);
    const [logo] = restoreScene(base);
    expect(logo!.result.mode).toBe('adapted');
    expect(maxKeep(strokes, leaf)).toBe(0);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps the label beside ground clutter that misses the contrast by far, and not the clutter', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const first = scene.labelGlyphs[0] as PxRect;
    // Clutter of the label's brightness, 3 px strokes, on mid-grey ground left of the box.
    paintRect(base, 819, 989, 850, SIZE, [100, 100, 100]);
    const clutter = [
      ...rectPixels(first.x0 - 18, first.y0, first.x0 - 15, first.y1),
      ...rectPixels(first.x0 - 11, first.y0, first.x0 - 8, first.y1),
    ];
    paintRect(base, first.x0 - 18, first.y0, first.x0 - 15, first.y1, LABEL_GREY);
    paintRect(base, first.x0 - 11, first.y0, first.x0 - 8, first.y1, LABEL_GREY);
    const [, label] = restoreScene(base);
    expect(label!.result.mode).toBe('adapted');
    expect(maxKeep(label!.strokes, clutter)).toBe(0);
  });
});

describe('restoring a littered frame into an evening relight', () => {
  const scene = attributionScene(SIZE);
  const base = copyOf(scene.base);
  const trap = addTrappedGround(base);
  addLitter(base, scene);
  addGravel(base);
  const joints = joinLogo(base, scene);
  // The same litter and gravel lie on the ground around the rectangles.
  for (const [cx, cy] of [
    [30, 965],
    [80, 958],
    [128, 1000],
    [790, 1006],
    [880, 972],
  ] as const) {
    paintBlob(base, cx, cy, 6, 3, LEAF);
  }
  const relit = relitBy(base, EVENING);
  let out = relit;
  const results = SYNTHETIC_ATTRIBUTION.map((box, index) => {
    const result = restoreAttributionRelit(out, base, box, {
      ringExclude: SYNTHETIC_ATTRIBUTION.filter((_, other) => other !== index),
    });
    out = result.raster;
    return { result, strokes: attributionStrokes(base, box) };
  });
  /** Margin (luma, 0 to 1) a ground pixel may exceed the relit ground by: about 10 levels. */
  const MARGIN = 0.04;

  it('adapts both rectangles at the evening gain', () => {
    for (const { result } of results) {
      expect(result.mode).toBe('adapted');
      for (const [c, value] of (result.gain ?? []).entries()) {
        expect(value).toBeCloseTo(EVENING[c] as number, 2);
      }
    }
  });

  it('copies every solid stroke pixel from the base byte for byte', () => {
    let solid = 0;
    for (const { strokes } of results) {
      const { rect } = strokes;
      for (let y = rect.y0; y < rect.y1; y += 1) {
        for (let x = rect.x0; x < rect.x1; x += 1) {
          if (keepAt(strokes, x, y) < SETTINGS.solidKeep) continue;
          solid += 1;
          const p = (y * SIZE + x) * 3;
          expect(out.data.subarray(p, p + 3).equals(base.data.subarray(p, p + 3))).toBe(true);
        }
      }
      expect(minKeep(strokes, coresIn(scene, rect))).toBeGreaterThanOrEqual(SETTINGS.solidKeep);
    }
    expect(solid).toBeGreaterThan(1000);
  });

  it('leaves no ground pixel brighter than the relit ring or the relit ground beyond a small margin', () => {
    const strokePixels = new Set([...trap.painted, ...joints.painted]);
    for (const [index, { strokes }] of results.entries()) {
      const { rect } = strokes;
      const others = scene.rects.filter((_, other) => other !== index);
      const ring = ringStats(out, rect, others);
      let ground = 0;
      for (let y = rect.y0; y < rect.y1; y += 1) {
        for (let x = rect.x0; x < rect.x1; x += 1) {
          const i = y * SIZE + x;
          if (scene.strokePaint[i] || strokePixels.has(i)) continue;
          ground += 1;
          const value = lumaAt(out, x, y);
          expect(value - ring.max).toBeLessThan(MARGIN);
          expect(value - lumaAt(relit, x, y)).toBeLessThan(MARGIN);
        }
      }
      expect(ground).toBeGreaterThan(2000);
    }
  });
});

/** Paints a line from `(xa, ya)` to `(xb, yb)`, `w` px wide (across its run), clipped. */
function paintLine(
  raster: Raster,
  xa: number,
  ya: number,
  xb: number,
  yb: number,
  w: number,
  rgb: readonly number[],
): number[] {
  const pixels: number[] = [];
  const steep = Math.abs(yb - ya) >= Math.abs(xb - xa);
  const n = Math.max(Math.abs(xb - xa), Math.abs(yb - ya));
  for (let i = 0; i <= n; i += 1) {
    const x = Math.round(xa + ((xb - xa) * i) / n);
    const y = Math.round(ya + ((yb - ya) * i) / n);
    for (let k = 0; k < w; k += 1) {
      const [px, py] = steep ? [x + k, y] : [x, y + k];
      if (px < 0 || py < 0 || px >= raster.width || py >= raster.height) continue;
      paintRect(raster, px, py, px + 1, py + 1, rgb);
      pixels.push(py * raster.width + px);
    }
  }
  return pixels;
}

/**
 * The scene's base with `paint` applied to its ground under the label: the label's box passes
 * LABEL_BOX_TRANSMISSION of what is painted, and its strokes are drawn over it. The logo's
 * rectangle keeps the base.
 */
function underLabel(scene: AttributionScene, paint: (ground: Raster) => void): Raster {
  const ground = copyOf(scene.ground);
  paint(ground);
  const out = copyOf(scene.base);
  const logo = scene.rects[0] as PxRect;
  const box = scene.labelBox;
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (x >= logo.x0 && x < logo.x1 && y >= logo.y0 && y < logo.y1) continue;
      const p = (y * SIZE + x) * 3;
      const g = [0, 1, 2].map((c) => ground.data[p + c] as number);
      let rgb = g;
      if (x >= box.x0 && y >= box.y0) {
        rgb = scene.strokePaint[y * SIZE + x]
          ? labelStrokeOver(g)
          : g.map((v) => Math.round(LABEL_BOX_TRANSMISSION * v));
      }
      paintRect(out, x, y, x + 1, y + 1, rgb);
    }
  }
  return out;
}

/** Pixels of a list that are not within `d` pixels of a painted stroke. */
function awayFromStrokes(scene: AttributionScene, pixels: readonly number[], d: number): number[] {
  return pixels.filter((i) => {
    const x = i % SIZE;
    const y = Math.floor(i / SIZE);
    for (let yy = Math.max(0, y - d); yy <= Math.min(SIZE - 1, y + d); yy += 1) {
      for (let xx = Math.max(0, x - d); xx <= Math.min(SIZE - 1, x + d); xx += 1) {
        if (scene.strokePaint[yy * SIZE + xx]) return false;
      }
    }
    return true;
  });
}

describe('restoring a mark whole or not at all', () => {
  it('keeps the label whole or not at all when a pale line crosses its first glyph on dark ground', () => {
    const scene = attributionScene(SIZE, { groundLuma: 0.05 });
    const first = scene.labelGlyphs[0] as PxRect;
    let line: number[] = [];
    const base = underLabel(scene, (ground) => {
      line = paintLine(ground, first.x0 - 60, SIZE - 1, first.x1, 960, 2, [204, 204, 204]);
    });
    expectWholeOrVerbatim(scene, base);
    expect(maxKeep(attributionStrokes(base, LABEL), awayFromStrokes(scene, line, 2))).toBe(0);
  });

  it('keeps the label whole or not at all when a white line runs between two of its words', () => {
    const { scene, x0, x1 } = gapScene(10);
    const cx = (x0 + x1) >> 1;
    let line: number[] = [];
    const base = underLabel(scene, (ground) => {
      line = paintLine(ground, cx - 1, 940, cx - 1, SIZE - 1, 3, [252, 252, 252]);
    });
    expectWholeOrVerbatim(scene, base);
    expect(maxKeep(attributionStrokes(base, LABEL), awayFromStrokes(scene, line, 2))).toBe(0);
  });

  it('keeps the logo whole or not at all when a letter is joined to a pale ledge above the line', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[3] as PxRect;
    // A pale ledge from above the place down onto the letter's top, across its outline.
    paintRect(base, glyph.x0 - 4, glyph.y0 - 12, glyph.x0 + 8, glyph.y0 - 8, [216, 216, 212]);
    const ledge = rectPixels(glyph.x0 - 4, glyph.y0 - 12, glyph.x0 + 8, glyph.y0 - 8);
    paintRect(base, glyph.x0 + 4, glyph.y0 - 8, glyph.x0 + 7, glyph.y0, [216, 216, 212]);
    expectWholeOrVerbatim(scene, base);
    expect(maxKeep(attributionStrokes(base, LOGO), ledge)).toBe(0);
  });

  it('keeps the label whole or not at all when a glyph is joined to ground of its brightness 5 px thick', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    // Ground of the label's brightness above the box, joined to the first glyph across the box's
    // margin.
    paintRect(base, first.x0 - 6, box.y0 - 14, first.x1 + 4, box.y0 - 2, [30, 30, 30]);
    paintRect(base, first.x0 - 2, box.y0 - 10, first.x0 + 3, box.y0 - 2, LABEL_GREY);
    paintRect(base, first.x0, box.y0 - 2, first.x0 + 2, first.y0, LABEL_GREY);
    expectWholeOrVerbatim(scene, base);
  });

  it('keeps the logo whole or not at all when a letter is joined to a white block 5 px thick', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[3] as PxRect;
    paintRect(base, glyph.x0 + 2, glyph.y1, glyph.x0 + 7, SIZE - 1, WHITE);
    expectWholeOrVerbatim(scene, base);
  });

  it('finds no strokes for a thin pale bar just left of the label box', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    paintRect(base, box.x0 - 14, 960, box.x0 - 1, SIZE, [26, 26, 26]);
    const bar = rectPixels(box.x0 - 6, first.y0, box.x0 - 3, first.y1);
    paintRect(base, box.x0 - 6, first.y0, box.x0 - 3, first.y1, [153, 153, 153]);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, bar)).toBe(0);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes for a thin white twig just right of the logo', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const last = scene.logoGlyphs.at(-1) as PxRect;
    paintRect(base, last.x1 + 3, 960, 113, SIZE, [30, 30, 30]);
    const twig = paintLine(base, last.x1 + 9, last.y1, last.x1 + 6, last.y0, 3, [250, 250, 250]);
    const strokes = attributionStrokes(base, LOGO);
    expect(maxKeep(strokes, twig)).toBe(0);
    expect(strokes.share).toBe(0);
  });

  it('finds no strokes for the label on ground too dark to show its box', () => {
    const scene = attributionScene(SIZE, { groundLuma: 0.03 });
    expect(attributionStrokes(scene.base, LABEL).share).toBe(0);
    // The logo's outline does not need the ground: it is found.
    expect(attributionStrokes(scene.base, LOGO).share).toBeGreaterThan(SETTINGS.minShare);
  });

  it('finds no strokes for a logo shifted out of its place', () => {
    const scene = attributionScene(SIZE);
    const logo = scene.rects[0] as PxRect;
    for (const [dx, dy] of [
      [-4, 0],
      [4, 0],
      [0, -4],
      [0, 6],
    ] as const) {
      const base = copyOf(scene.base);
      for (let y = logo.y0; y < logo.y1; y += 1) {
        for (let x = logo.x0; x < logo.x1; x += 1) {
          const sx = Math.min(logo.x1 - 1, Math.max(0, x - dx));
          const sy = Math.min(logo.y1 - 1, Math.max(0, y - dy));
          const q = (sy * SIZE + sx) * 3;
          paintRect(base, x, y, x + 1, y + 1, [
            scene.base.data[q] as number,
            scene.base.data[q + 1] as number,
            scene.base.data[q + 2] as number,
          ]);
        }
      }
      expect(attributionStrokes(base, LOGO).share).toBe(0);
    }
  });
});

describe('finding the marks in their places', () => {
  it('finds no strokes when something brighter than a glyph lies in the label box', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.labelGlyphs[1] as PxRect;
    paintRect(base, glyph.x0 - 2, glyph.y0 + 6, glyph.x0, glyph.y0 + 8, [252, 252, 252]);
    expect(attributionStrokes(base, LABEL).share).toBe(0);
  });

  it('finds no strokes when the label strokes start far inside its box', () => {
    const scene = attributionScene(SIZE);
    const glyph = scene.labelGlyphs[0] as PxRect;
    // The first glyph missing: the box starts a glyph's width before the strokes.
    const base = underLabel(scene, () => undefined);
    for (let y = glyph.y0; y < glyph.y1; y += 1) {
      for (let x = glyph.x0; x < glyph.x1; x += 1) {
        const p = (y * SIZE + x) * 3;
        const g = scene.ground.data[p + 1] as number;
        const v = Math.round(LABEL_BOX_TRANSMISSION * g);
        paintRect(base, x, y, x + 1, y + 1, [v, v, v]);
      }
    }
    expect(attributionStrokes(base, LABEL).share).toBe(0);
  });

  it('finds no strokes when the first letter of the logo is missing', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[0] as PxRect;
    paintRect(base, glyph.x0 - 2, glyph.y0 - 2, glyph.x1 + 2, glyph.y1 + 2, HALO);
    expect(attributionStrokes(base, LOGO).share).toBe(0);
  });

  it('keeps the logo when a leaf lies below it across a gap between letters', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const a = scene.logoGlyphs[1] as PxRect;
    const b = scene.logoGlyphs[2] as PxRect;
    const leaf = paintBlob(base, (a.x1 + b.x0) >> 1, 1021, 3, 3, LEAF);
    expect(leaf.length).toBeGreaterThanOrEqual(SETTINGS.minStrokeArea);
    const [logo] = restoreScene(base);
    expect(logo!.result.mode).toBe('adapted');
    expect(maxKeep(logo!.strokes, leaf)).toBe(0);
  });

  it('keeps the logo when a pale leaf lies above one of its letters, outside its place', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[3] as PxRect;
    paintRect(base, glyph.x0 - 2, 980, glyph.x1 + 2, glyph.y0 - 2, [30, 30, 30]);
    const leaf = paintBlob(base, (glyph.x0 + glyph.x1) >> 1, glyph.y0 - 5, 5, 1.6, LEAF);
    const [logo] = restoreScene(base);
    expect(logo!.result.mode).toBe('adapted');
    expect(maxKeep(logo!.strokes, leaf)).toBe(0);
  });

  it('finds no strokes when the dark box passes much more than the label box does', () => {
    const scene = attributionScene(SIZE);
    const box = scene.labelBox;
    const base = copyOf(scene.base);
    for (let y = box.y0; y < SIZE; y += 1) {
      for (let x = box.x0; x < SIZE; x += 1) {
        if (scene.strokePaint[y * SIZE + x]) continue;
        const p = (y * SIZE + x) * 3;
        const g = [0, 1, 2].map((c) => Math.round(0.75 * (scene.ground.data[p + c] as number)));
        paintRect(base, x, y, x + 1, y + 1, g);
      }
    }
    expect(attributionStrokes(base, LABEL).share).toBe(0);
  });

  it('keeps the label over ground that steps from bright to dark under its box', () => {
    const scene = attributionScene(SIZE);
    const glyph = scene.labelGlyphs[5] as PxRect;
    const base = underLabel(scene, (ground) => {
      paintRect(ground, glyph.x1 + 1, 940, SIZE, SIZE, [40, 40, 40]);
    });
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('finds no strokes when a dark corner of the ground beside the box looks like the box', () => {
    const scene = attributionScene(SIZE);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    const base = copyOf(scene.base);
    // A dark patch whose top edge runs with the box's, and darker ground from it to the box.
    paintRect(base, box.x0 - 34, box.y0, box.x0, SIZE, [90, 90, 90]);
    paintRect(base, box.x0 - 34, box.y0, box.x0 - 14, SIZE, [36, 34, 32]);
    const blob = paintGlyph(base, box.x0 - 31, first.y0, box.x0 - 22, first.y1, LABEL_GREY);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, blob)).toBe(0);
    expect(strokes.share).toBe(0);
  });

  it('keeps the label when its box has a soft edge over white ground', () => {
    const scene = attributionScene(SIZE, { groundLuma: 1 });
    const box = scene.labelBox;
    const base = copyOf(scene.base);
    // The box's first column and row half way between the ground and the box, as an upscaled
    // frame draws them: brighter than a glyph's fill minus `fillHigh`, so they are no part of it.
    for (let y = box.y0; y < SIZE; y += 1)
      paintRect(base, box.x0, y, box.x0 + 1, y + 1, [166, 166, 166]);
    for (let x = box.x0; x < SIZE; x += 1)
      paintRect(base, x, box.y0, x + 1, box.y0 + 1, [166, 166, 166]);
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });

  it('keeps no bright ground under the box that crosses a glyph', () => {
    const scene = attributionScene(SIZE);
    const glyph = scene.labelGlyphs[3] as PxRect;
    let line: number[] = [];
    // A white line under the box (about 0.30 through it) across a glyph, on darker ground.
    const base = underLabel(scene, (ground) => {
      paintRect(ground, glyph.x0 - 24, scene.labelBox.y0 + 2, glyph.x1 + 24, SIZE, [40, 40, 40]);
      line = paintLine(
        ground,
        glyph.x0 - 18,
        glyph.y0 - 4,
        glyph.x1 + 18,
        glyph.y1 + 4,
        3,
        [255, 255, 255],
      );
    });
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(maxKeep(strokes, awayFromStrokes(scene, line, 2))).toBe(0);
  });

  it('restores a credit strip drawn around its rectangle, and stops at a glyph-bright square in it', () => {
    const scene = attributionScene(SIZE);
    const strip = [0.68, 0.94, 0.84, 0.97] as const;
    const [sx0, sy0, sx1, sy1] = strip.map((v) => Math.round(v * SIZE)) as [
      number,
      number,
      number,
      number,
    ];
    const at = (square: boolean) => {
      const base = copyOf(scene.base);
      paintRect(base, sx0, sy0, sx1, sy1, [32, 34, 36]);
      for (let x = sx0 + 6; x + 10 < sx1 - 4; x += 16) {
        paintGlyph(base, x, sy0 + 8, x + 10, sy1 - 8, [232, 232, 232]);
      }
      if (square) paintRect(base, sx1 - 12, sy0 + 10, sx1 - 6, sy0 + 16, [232, 232, 232]);
      return attributionStrokes(base, [...strip]);
    };
    expect(at(false).share).toBeGreaterThan(SETTINGS.minShare);
    expect(at(true).share).toBe(0);
  });

  it('finds no strokes when a letter of the logo a little dimmer than the others misses the contrast by a little', () => {
    const scene = attributionScene(SIZE);
    const base = copyOf(scene.base);
    const glyph = scene.logoGlyphs[4] as PxRect;
    // The letter a little dimmer than the fill tolerance allows, and its outline brighter.
    paintDark(base, glyph.x0 - 2, glyph.y0 - 2, glyph.x1 + 2, glyph.y1 + 2, 0.5, [120, 120, 120]);
    for (let y = glyph.y0; y < glyph.y1; y += 1) {
      for (let x = glyph.x0; x < glyph.x1; x += 1) {
        if (scene.strokePaint[y * SIZE + x]) paintRect(base, x, y, x + 1, y + 1, [226, 226, 224]);
      }
    }
    expect(attributionStrokes(base, LOGO).share).toBe(0);
  });
});

describe('telling the label box from ground', () => {
  it('finds no strokes for a blob a little brighter than the label beside its box', () => {
    const scene = attributionScene(SIZE);
    const box = scene.labelBox;
    const first = scene.labelGlyphs[0] as PxRect;
    const strokes0 = attributionStrokes(scene.base, LABEL);
    const anchor = strokes0.components.reduce((a, b) => (b.area > a.area ? b : a));
    // Brighter than the fill tolerance allows, within the doubt margin.
    const level = Math.round(255 * (anchor.fill + SETTINGS.fillSpread * (1 - anchor.fill) + 0.03));
    const base = copyOf(scene.base);
    paintRect(base, box.x0 - 19, 960, box.x0 - 6, SIZE, [30, 30, 30]);
    const blob = paintGlyph(base, box.x0 - 17, first.y0 + 2, box.x0 - 8, first.y1 - 2, [
      level,
      level,
      level,
    ]);
    const strokes = attributionStrokes(base, LABEL);
    expect(maxKeep(strokes, blob)).toBe(0);
    expect(strokes.share).toBe(0);
  });

  it('keeps the label when a bright band under its box steps down below the glyph tops', () => {
    const { scene, x0 } = gapScene(24);
    const box = scene.labelBox;
    // Under the box, from below the rows the glyphs leave free under its top edge: a bright band
    // with dark ground right of it (a full-height step in the glyph rows). Above the box, ground
    // too dark to show a step left of the band and bright ground right of it.
    const base = underLabel(scene, (ground) => {
      paintRect(ground, x0 + 6, box.y0 + 4, x0 + 10, SIZE, [255, 255, 255]);
      paintRect(ground, x0 + 10, box.y0 + 4, x0 + 20, SIZE, [26, 26, 26]);
      paintRect(ground, x0 - 6, 960, x0 + 10, box.y0, [10, 10, 10]);
      paintRect(ground, x0 + 10, 960, x0 + 24, box.y0, [230, 230, 230]);
    });
    const strokes = attributionStrokes(base, LABEL);
    expect(strokes.share).toBeGreaterThan(SETTINGS.minShare);
    expect(minKeep(strokes, coresIn(scene, strokes.rect))).toBeGreaterThanOrEqual(
      SETTINGS.solidKeep,
    );
  });
});
