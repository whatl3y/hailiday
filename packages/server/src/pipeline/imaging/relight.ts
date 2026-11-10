import type { NormalizedBox } from '@holiday/core';
import { TO_LINEAR, blurFloat, clamp01, lum, smoothstep, toSrgb } from '../../fixtures/canvas.js';
import { Rng } from '../../fixtures/svg.js';
import { copyRect, toRect, type Raster } from './raster.js';

/** Evening grade of exteriors: exposure (linear gain) and white balance per channel. */
export const EVENING_EXTERIOR = { exposure: 0.12, balance: [0.8, 0.92, 1.18] } as const;
/** Interiors dim to lamp and candle light: warm and low. */
export const EVENING_INTERIOR = { exposure: 0.3, balance: [1.04, 0.93, 0.78] } as const;

export interface WindowLight {
  lit: boolean;
  warmth: number;
  level: number;
  hx: number;
  hy: number;
}

/** Which existing windows glow in the evening (about three in four), each a little differently. */
export function eveningWindowLights(seed: string, count: number): WindowLight[] {
  const rng = new Rng(`${seed}:windows`);
  return Array.from({ length: count }, (_, index) => ({
    lit: index === 0 || rng.next() <= 0.78,
    warmth: rng.range(0.88, 1.12),
    level: rng.range(0.1, 0.24),
    hx: rng.range(0.25, 0.75),
    hy: rng.range(0.2, 0.6),
  }));
}

function rectMask(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  feather: number,
) {
  const dx = Math.min(x - x0, x1 - x);
  const dy = Math.min(y - y0, y1 - y);
  return clamp01(Math.min(dx, dy) / feather + 0.5);
}

export interface EveningGradeInput {
  /** Interiors dim warmly and their windows turn to dusk blue; exteriors darken and cool. */
  interior: boolean;
  /** The target facade; its top edge bounds the sky treatment. */
  targetFacade?: NormalizedBox | null;
  /** Existing windows (exterior: warm interior glow; interior: dusk outside). */
  windows?: readonly NormalizedBox[];
  /** Seeds which windows glow and how. */
  seed: string;
  /** A room whose windows are not known keeps more of its light (a warm, candle-lit grade). */
  unknownScene?: boolean;
}

/**
 * The evening relight, done on pixels like a photographer's grade (shared by the fixture
 * compositor and the deterministic evening fallback): exposure lowered about three stops,
 * cooler white balance, more contrast and less saturation; the sky becomes a deep dusk gradient
 * that keeps its cloud texture; existing windows glow warm from inside (mullions stay dark); a
 * gentle vignette. Interiors dim warmly and their windows turn to dusk blue. Returns linear RGB.
 */
export function eveningGradeLinear(
  rgb: Buffer,
  width: number,
  height: number,
  input: EveningGradeInput,
): Float32Array {
  const out = new Float32Array(width * height * 3);
  const interior = input.interior;
  const skyLine = Math.min(
    0.75,
    Math.max(0.15, input.targetFacade ? input.targetFacade[1] + 0.06 : 0.45),
  );
  const { balance } = interior ? EVENING_INTERIOR : EVENING_EXTERIOR;
  const exposure =
    interior && input.unknownScene
      ? 0.45
      : (interior ? EVENING_INTERIOR : EVENING_EXTERIOR).exposure;
  for (let y = 0; y < height; y += 1) {
    const fy = y / height;
    const skyBand = interior ? 0 : smoothstep(skyLine + 0.04, skyLine - 0.12, fy);
    const t = Math.min(1, fy / Math.max(0.05, skyLine));
    const skyR = 0.008 + (0.075 - 0.008) * t ** 1.6;
    const skyG = 0.016 + (0.052 - 0.016) * t ** 1.6;
    const skyB = 0.06 + (0.085 - 0.06) * t ** 1.6;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 3;
      const r = TO_LINEAR[rgb[i] as number] as number;
      const g = TO_LINEAR[rgb[i + 1] as number] as number;
      const b = TO_LINEAR[rgb[i + 2] as number] as number;
      const l = lum(r, g, b);
      let lr = r * exposure * (balance[0] as number);
      let lg = g * exposure * (balance[1] as number);
      let lb = b * exposure * (balance[2] as number);
      if (skyBand > 0) {
        const neutral = b >= r * 0.88 ? 1 : 0.25;
        const w = skyBand * neutral * smoothstep(0.18, 0.55, l);
        if (w > 0) {
          const texture = 0.55 + 0.6 * l;
          lr += (skyR * texture - lr) * w;
          lg += (skyG * texture - lg) * w;
          lb += (skyB * texture - lb) * w;
        }
      }
      const l2 = lum(lr, lg, lb);
      const contrast = l2 > 0 ? (l2 / 0.06) ** 0.14 : 1;
      lr *= contrast;
      lg *= contrast;
      lb *= contrast;
      const grey = lum(lr, lg, lb);
      const sat = 0.8;
      lr = grey + (lr - grey) * sat;
      lg = grey + (lg - grey) * sat;
      lb = grey + (lb - grey) * sat;
      const dx = x / width - 0.5;
      const dy = fy - 0.5;
      const vignette = 1 - 0.38 * Math.min(1, (dx * dx + dy * dy) / 0.5);
      out[i] = lr * vignette;
      out[i + 1] = lg * vignette;
      out[i + 2] = lb * vignette;
    }
  }
  const windows = input.windows ?? [];
  const lights = eveningWindowLights(input.seed, windows.length);
  for (const [index, box] of windows.entries()) {
    const x0 = box[0] * width;
    const y0 = box[1] * height;
    const x1 = box[2] * width;
    const y1 = box[3] * height;
    if (interior) {
      for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y += 1) {
        for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x += 1) {
          const k = rectMask(x, y, x0, y0, x1, y1, 1.5);
          const i = (y * width + x) * 3;
          const v = (y - y0) / Math.max(1, y1 - y0);
          out[i] = (out[i] as number) * (1 - k) + (0.01 + 0.03 * v) * k;
          out[i + 1] = (out[i + 1] as number) * (1 - k) + (0.016 + 0.02 * v) * k;
          out[i + 2] = (out[i + 2] as number) * (1 - k) + (0.06 + 0.02 * v) * k;
        }
      }
      continue;
    }
    const { lit, warmth, level, hx, hy } = lights[index] as WindowLight;
    if (!lit) continue;
    const left = Math.max(0, Math.floor(x0));
    const right = Math.min(width, Math.ceil(x1));
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(height, Math.ceil(y1));
    let mean = 0;
    let samples = 0;
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        const i = (y * width + x) * 3;
        mean +=
          (rgb[i] as number) * 0.3 + (rgb[i + 1] as number) * 0.59 + (rgb[i + 2] as number) * 0.11;
        samples += 1;
      }
    }
    mean = samples > 0 ? Math.max(8, mean / samples) : 128;
    const gx0 = x0 + (x1 - x0) * 0.1;
    const gx1 = x1 - (x1 - x0) * 0.1;
    const gy0 = y0 + (y1 - y0) * 0.08;
    const gy1 = y1 - (y1 - y0) * 0.08;
    const feather = Math.max(0.8, Math.min(gx1 - gx0, gy1 - gy0) * 0.06);
    for (let y = top; y < bottom; y += 1) {
      for (let x = left; x < right; x += 1) {
        let k = rectMask(x, y, gx0, gy0, gx1, gy1, feather) * 0.92;
        if (k <= 0) continue;
        const i = (y * width + x) * 3;
        const r8 = rgb[i] as number;
        const g8 = rgb[i + 1] as number;
        const b8 = rgb[i + 2] as number;
        // Foliage in front of the glass (a tree or shrub) stays dark; only the glass lights up.
        k *= 1 - smoothstep(1.04, 1.25, g8 / (Math.max(r8, b8) + 1));
        if (k <= 0) continue;
        const src = r8 * 0.3 + g8 * 0.59 + b8 * 0.11;
        const mullion = smoothstep(mean * 1.2, mean * 1.6, src);
        const detail = Math.min(1.5, Math.max(0.5, src / mean));
        const u = (x - x0) / Math.max(1, x1 - x0);
        const v = (y - y0) / Math.max(1, y1 - y0);
        const d2 = ((u - hx) / 0.45) ** 2 + ((v - hy) / 0.55) ** 2;
        const hotspot = 0.55 + 0.75 * Math.exp(-d2);
        const light =
          level * hotspot * (1.1 - 0.3 * v) * (0.65 + 0.35 * detail) * (1 - 0.85 * mullion);
        out[i] = (out[i] as number) * (1 - k) + light * k;
        out[i + 1] = (out[i + 1] as number) * (1 - k) + light * 0.52 * warmth * k;
        out[i + 2] = (out[i + 2] as number) * (1 - k) + light * 0.16 * warmth * k;
      }
    }
  }
  return out;
}

/** Adds a soft radial light (falloff `(1 − d)^2.2`) to a linear light buffer. */
function addRadialLight(
  glow: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  color: readonly [number, number, number],
  strength: number,
): void {
  const x0 = Math.max(0, Math.floor(x - radius));
  const y0 = Math.max(0, Math.floor(y - radius));
  const x1 = Math.min(width, Math.ceil(x + radius));
  const y1 = Math.min(height, Math.ceil(y + radius));
  for (let yy = y0; yy < y1; yy += 1) {
    for (let xx = x0; xx < x1; xx += 1) {
      const d = Math.hypot(xx + 0.5 - x, yy + 0.5 - y) / radius;
      if (d >= 1) continue;
      const k = strength * (1 - d) ** 2.2;
      const p = (yy * width + xx) * 3;
      glow[p] = (glow[p] as number) + color[0] * k;
      glow[p + 1] = (glow[p + 1] as number) + color[1] * k;
      glow[p + 2] = (glow[p + 2] as number) + color[2] * k;
    }
  }
}

/** Separable box mean of a single-channel plane (radius in pixels, edges clamped). */
function boxMean(plane: Float32Array, width: number, height: number, radius: number) {
  const tmp = new Float32Array(plane.length);
  const out = new Float32Array(plane.length);
  const size = radius * 2 + 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) {
      sum += plane[row + Math.min(width - 1, Math.max(0, x))] as number;
    }
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / size;
      sum +=
        (plane[row + Math.min(width - 1, x + radius + 1)] as number) -
        (plane[row + Math.max(0, x - radius)] as number);
    }
  }
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) {
      sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x] as number;
    }
    for (let y = 0; y < height; y += 1) {
      out[y * width + x] = sum / size;
      sum +=
        (tmp[Math.min(height - 1, y + radius + 1) * width + x] as number) -
        (tmp[Math.max(0, y - radius) * width + x] as number);
    }
  }
  return out;
}

export interface EveningRelightInput {
  /** The accepted `source`-lighting candidate on the working grid. */
  composite: Raster;
  /** The working image the decorations were added to (same grid). */
  working: Raster;
  /** Interiors dim warmly; exteriors darken and cool, with a dusk sky. */
  interior: boolean;
  /** The target facade; its top edge bounds the sky treatment. */
  targetFacade?: NormalizedBox | null;
  /** Window anchors (exteriors: warm interior glow and spill; interiors: dusk outside). */
  windows?: readonly NormalizedBox[];
  /** Existing light fixtures (sconces, lamps) that glow in the evening. */
  lightSources?: readonly NormalizedBox[];
  /**
   * Where lit decorations may be: a plane on the working grid, non-zero inside (the composite
   * mask of the plan's `lit` placements). Only light sources inside it bloom.
   */
  decorationMask: Uint8Array | null;
  /** Seeds which windows glow. */
  seed: string;
  /** Rectangles copied verbatim from the composite afterwards (attribution, padding). */
  restore?: readonly NormalizedBox[];
}

export interface EveningRelightResult {
  raster: Raster;
  /** Pixels detected as decoration light sources (bulbs) and kept lit. */
  emitterPixels: number;
  /** Existing windows given a warm interior glow (exteriors). */
  litWindows: number;
}

/**
 * Deterministic evening relight of an accepted `source`-lighting composite (the evening
 * fallback; render spec, lighting modes): the shared evening grade (exposure and white-balance
 * shift, dusk sky above the facade, warm glow in existing windows, vignette), warm spill around
 * glowing windows and existing fixtures, and the decorations' own lights kept lit: inside the
 * decoration mask, small sources much brighter than their surroundings that the decorations
 * added (absent from the working image) keep their color at full brightness and bloom with a
 * tight and a wide halo. Structure, materials and the decorations themselves come from the
 * accepted composite, so nothing is added, removed or replaced. Same input, same bytes.
 */
export function relightSourceToEvening(input: EveningRelightInput): EveningRelightResult {
  const { composite, working } = input;
  const { width, height } = composite;
  if (working.width !== width || working.height !== height) {
    throw new RangeError('evening relight needs the working image on the same grid');
  }
  const count = width * height;
  const long = Math.max(width, height);
  const windows = input.windows ?? [];
  const out = eveningGradeLinear(composite.data, width, height, {
    interior: input.interior,
    targetFacade: input.targetFacade ?? null,
    windows,
    seed: input.seed,
  });

  // Ambient light from existing windows and fixtures.
  const ambient = new Float32Array(count * 3);
  let litWindows = 0;
  if (!input.interior) {
    const lights = eveningWindowLights(input.seed, windows.length);
    for (const [index, [x0, y0, x1, y1]] of windows.entries()) {
      if (!lights[index]?.lit) continue;
      litWindows += 1;
      addRadialLight(
        ambient,
        width,
        height,
        ((x0 + x1) / 2) * width,
        ((y0 + y1) / 2) * height,
        Math.max(x1 - x0, y1 - y0) * width * 0.8,
        [1, 0.6, 0.3],
        0.035,
      );
    }
  }
  for (const [x0, y0, x1, y1] of input.lightSources ?? []) {
    const r = Math.max((x1 - x0) * width, (y1 - y0) * height);
    addRadialLight(
      ambient,
      width,
      height,
      ((x0 + x1) / 2) * width,
      ((y0 + y1) / 2) * height,
      r * 2.4,
      [1, 0.72, 0.4],
      0.6,
    );
  }

  // Decoration light sources: bright, compact, added by the decorations.
  const emission = new Float32Array(count * 3);
  let emitterPixels = 0;
  if (input.decorationMask) {
    const lumC = new Float32Array(count);
    for (let i = 0; i < count; i += 1) {
      const p = i * 3;
      lumC[i] = lum(
        TO_LINEAR[composite.data[p] as number] as number,
        TO_LINEAR[composite.data[p + 1] as number] as number,
        TO_LINEAR[composite.data[p + 2] as number] as number,
      );
    }
    const local = boxMean(lumC, width, height, Math.max(2, Math.round(long * 0.004)));
    for (let i = 0; i < count; i += 1) {
      if (!input.decorationMask[i]) continue;
      const l = lumC[i] as number;
      if (l < 0.25) continue;
      const p = i * 3;
      // Pale blue (sky between leaves, a reflection) is never a decoration light; colored bulbs,
      // blue ones included, are saturated.
      const r8 = composite.data[p] as number;
      const b8 = composite.data[p + 2] as number;
      const max = Math.max(r8, composite.data[p + 1] as number, b8);
      const min = Math.min(r8, composite.data[p + 1] as number, b8);
      if (b8 > r8 && (max - min) / Math.max(1, max) < 0.35) continue;
      const lw = lum(
        TO_LINEAR[working.data[p] as number] as number,
        TO_LINEAR[working.data[p + 1] as number] as number,
        TO_LINEAR[working.data[p + 2] as number] as number,
      );
      const e =
        smoothstep(0.25, 0.6, l) *
        smoothstep(1.15, 1.7, l / ((local[i] as number) + 1e-4)) *
        smoothstep(0.05, 0.15, l - lw);
      if (e <= 0) continue;
      emitterPixels += 1;
      for (let c = 0; c < 3; c += 1) {
        const source = TO_LINEAR[composite.data[p + c] as number] as number;
        // A bulb keeps its own color at full brightness.
        out[p + c] = (out[p + c] as number) * (1 - e) + source * 1.6 * e;
        emission[p + c] = source * e;
      }
    }
  }

  // Light adds in linear space: ambient glow with its bloom, and the bulbs' tight and wide halos.
  const ambientBloom = blurFloat(ambient, width, height, 3, Math.max(2, width * 0.01));
  const tight = emitterPixels > 0 ? blurFloat(emission, width, height, 3, long * 0.003) : null;
  const wide = emitterPixels > 0 ? blurFloat(emission, width, height, 3, long * 0.012) : null;
  const raster: Raster = { data: Buffer.alloc(count * 3), width, height };
  for (let i = 0; i < count * 3; i += 1) {
    let v = (out[i] as number) + (ambient[i] as number) * 0.9 + (ambientBloom[i] as number) * 1.1;
    if (tight && wide) v += (tight[i] as number) * 2.2 + (wide[i] as number) * 3;
    raster.data[i] = Math.round(toSrgb(v));
  }
  for (const box of input.restore ?? []) {
    copyRect(raster, composite, toRect(box, width, height));
  }
  return { raster, emitterPixels, litWindows };
}
