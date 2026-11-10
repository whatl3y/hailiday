import sharp from 'sharp';
import {
  TO_LINEAR,
  clamp01,
  clipRect,
  gaussianFloat,
  lum,
  smoothstep,
  type Canvas,
  type Rect,
} from './canvas.js';
import { loadPhotoLibrary, type DecorPhoto, type PhotoLibrary } from './photos.js';
import type { Rng } from './svg.js';

/** One resolution level of a cutout: premultiplied linear RGBA plus an emission weight. */
interface SpriteLevel {
  width: number;
  height: number;
  /** Premultiplied linear RGBA. */
  data: Float32Array;
  /** 0–1 per pixel: how much of the pixel is emitted light (carved face, flame). */
  emission: Float32Array;
  /** Sprite pixels per level pixel (1, 2, 4…). */
  factor: number;
}

/** A photographed decoration ready to place: its manifest entry and a mip chain. */
export interface Sprite {
  id: string;
  photo: DecorPhoto;
  width: number;
  height: number;
  levels: SpriteLevel[];
  /** Alpha-weighted mean linear RGB of the cutout. */
  mean: [number, number, number];
}

const cache = new Map<string, Promise<Sprite>>();

async function decodeLevel(
  file: string,
  width: number,
  height: number,
  factor: number,
  emits: boolean,
): Promise<SpriteLevel> {
  const w = Math.max(1, Math.round(width / factor));
  const h = Math.max(1, Math.round(height / factor));
  const pipeline = sharp(file).ensureAlpha();
  const { data } = await (factor === 1 ? pipeline : pipeline.resize(w, h, { kernel: 'lanczos3' }))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = new Float32Array(w * h * 4);
  const emission = new Float32Array(w * h);
  for (let p = 0; p < w * h; p += 1) {
    const a = (data[p * 4 + 3] as number) / 255;
    const r = TO_LINEAR[data[p * 4] as number] as number;
    const g = TO_LINEAR[data[p * 4 + 1] as number] as number;
    const b = TO_LINEAR[data[p * 4 + 2] as number] as number;
    out[p * 4] = r * a;
    out[p * 4 + 1] = g * a;
    out[p * 4 + 2] = b * a;
    out[p * 4 + 3] = a;
    if (emits) {
      // Light shows as bright, warm pixels: flames and candle-lit carvings.
      const warm = smoothstep(0.08, 0.35, r - b);
      emission[p] = smoothstep(0.32, 0.75, lum(r, g, b)) * warm;
    }
  }
  return { width: w, height: h, data: out, emission, factor };
}

/** Loads a decoration cutout from the photo library (cached per process). */
export function loadSprite(
  id: string,
  library: PhotoLibrary = loadPhotoLibrary(),
): Promise<Sprite> {
  const key = `${library.dir}:${id}`;
  let entry = cache.get(key);
  if (!entry) {
    entry = (async () => {
      const photo = library.decor(id);
      if (!photo) throw new Error(`Unknown decoration cutout ${id}`);
      const file = library.pathOf(photo);
      const levels: SpriteLevel[] = [];
      for (let factor = 1; ; factor *= 2) {
        levels.push(
          await decodeLevel(file, photo.width, photo.height, factor, photo.decor.emitsLight),
        );
        if (photo.width / factor < 48 || photo.height / factor < 48 || factor >= 16) break;
      }
      const base = levels[0] as SpriteLevel;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let p = 0; p < base.width * base.height; p += 1) {
        sr += base.data[p * 4] as number;
        sg += base.data[p * 4 + 1] as number;
        sb += base.data[p * 4 + 2] as number;
        sa += base.data[p * 4 + 3] as number;
      }
      const n = Math.max(1e-6, sa);
      return {
        id,
        photo,
        width: photo.width,
        height: photo.height,
        levels,
        mean: [sr / n, sg / n, sb / n] as [number, number, number],
      };
    })();
    entry.catch(() => cache.delete(key));
    cache.set(key, entry);
  }
  return entry;
}

/** A sprite rendered into a local buffer: premultiplied linear RGBA plus emission. */
export interface Rendered {
  rect: Rect;
  width: number;
  height: number;
  data: Float32Array;
  emission: Float32Array;
}

export interface SpriteTransform {
  /** Target pixel of the sprite's attach point. */
  x: number;
  y: number;
  /** Output pixels per sprite pixel. */
  scale: number;
  /** Rotation in radians, clockwise. */
  angle?: number;
  flip?: boolean;
  /** Point in the sprite (normalized) placed at (x, y); defaults to the manifest attach point. */
  pivot?: [number, number];
}

/** Bilinear sample of premultiplied RGBA and emission at sprite-level coordinates. */
function sample(level: SpriteLevel, sx: number, sy: number, out: Float32Array, o: number): number {
  const x = sx - 0.5;
  const y = sy - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let emission = 0;
  for (let k = 0; k < 4; k += 1) out[o + k] = 0;
  for (let j = 0; j < 2; j += 1) {
    const yy = y0 + j;
    if (yy < 0 || yy >= level.height) continue;
    const wy = j === 0 ? 1 - fy : fy;
    for (let i = 0; i < 2; i += 1) {
      const xx = x0 + i;
      if (xx < 0 || xx >= level.width) continue;
      const weight = wy * (i === 0 ? 1 - fx : fx);
      if (weight <= 0) continue;
      const p = yy * level.width + xx;
      for (let k = 0; k < 4; k += 1) out[o + k] += (level.data[p * 4 + k] as number) * weight;
      emission += (level.emission[p] as number) * weight;
    }
  }
  // Rounding in the weights can push coverage a hair over one.
  if ((out[o + 3] as number) > 1) out[o + 3] = 1;
  return emission;
}

/** Renders a sprite with scale, rotation and mirroring into a tight local buffer. */
export function renderSprite(sprite: Sprite, t: SpriteTransform): Rendered | null {
  const scale = Math.max(1e-4, t.scale);
  // The level whose resolution is closest above the target keeps detail without aliasing.
  let level = sprite.levels[0] as SpriteLevel;
  for (const candidate of sprite.levels) if (candidate.factor * scale <= 1.4) level = candidate;
  const s = scale * level.factor;
  const angle = t.angle ?? 0;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [px, py] = t.pivot ?? sprite.photo.decor.attachPoint;
  const pivotX = px * level.width;
  const pivotY = py * level.height;
  const flip = t.flip ? -1 : 1;
  // Forward map of sprite-level point (u, v) to output pixels.
  const fwd = (u: number, v: number): [number, number] => {
    const dx = (u - pivotX) * s * flip;
    const dy = (v - pivotY) * s;
    return [t.x + dx * cos - dy * sin, t.y + dx * sin + dy * cos];
  };
  const corners = [
    fwd(0, 0),
    fwd(level.width, 0),
    fwd(0, level.height),
    fwd(level.width, level.height),
  ];
  const rect: Rect = {
    x0: Math.floor(Math.min(...corners.map((c) => c[0]))) - 1,
    y0: Math.floor(Math.min(...corners.map((c) => c[1]))) - 1,
    x1: Math.ceil(Math.max(...corners.map((c) => c[0]))) + 1,
    y1: Math.ceil(Math.max(...corners.map((c) => c[1]))) + 1,
  };
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  if (width <= 0 || height <= 0 || width * height > 8_000_000) return null;
  const data = new Float32Array(width * height * 4);
  const emission = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Inverse map from the output pixel center to sprite-level coordinates.
      const ox = rect.x0 + x + 0.5 - t.x;
      const oy = rect.y0 + y + 0.5 - t.y;
      const rx = (ox * cos + oy * sin) / s;
      const ry = (-ox * sin + oy * cos) / s;
      const u = pivotX + rx * flip;
      const v = pivotY + ry;
      if (u < -1 || v < -1 || u > level.width + 1 || v > level.height + 1) continue;
      const o = (y * width + x) * 4;
      emission[y * width + x] = sample(level, u, v, data, o);
    }
  }
  return { rect, width, height, data, emission };
}

/** Scene-matching adjustments for a rendered sprite. */
export interface Grade {
  /** Per-channel gain in linear light (exposure times white balance). */
  gain: [number, number, number];
  /** Saturation multiplier (1 keeps it). */
  saturation: number;
  /** Gaussian softening to match the photograph's sharpness, in pixels. */
  blur: number;
  /** Luminance noise standard deviation (linear) to match the photograph's grain. */
  grain: number;
  /** Light the object gives off: emissive pixels keep this brightness whatever the scene light. */
  emissionGain: number;
}

/** Applies the grade in place (blur first, then color, then grain). */
export function gradeRendered(r: Rendered, grade: Grade, rng: Rng): Rendered {
  let data = r.data;
  let emission = r.emission;
  if (grade.blur >= 0.2) {
    data = gaussianFloat(data, r.width, r.height, 4, grade.blur);
    emission = gaussianFloat(emission, r.width, r.height, 1, grade.blur);
  }
  const [gr, gg, gb] = grade.gain;
  for (let p = 0; p < r.width * r.height; p += 1) {
    const a = data[p * 4 + 3] as number;
    if (a <= 0.001) continue;
    let red = data[p * 4] as number;
    let green = data[p * 4 + 1] as number;
    let blue = data[p * 4 + 2] as number;
    const e = clamp01(emission[p] as number);
    // Reflected light follows the scene; emitted light keeps its own brightness.
    const lr = red * (gr * (1 - e) + grade.emissionGain * e);
    const lg = green * (gg * (1 - e) + grade.emissionGain * e);
    const lb = blue * (gb * (1 - e) + grade.emissionGain * e);
    const grey = lum(lr, lg, lb);
    const sat = grade.saturation + (1 - grade.saturation) * e;
    red = grey + (lr - grey) * sat;
    green = grey + (lg - grey) * sat;
    blue = grey + (lb - grey) * sat;
    if (grade.grain > 0) {
      const noise = rng.jitter(grade.grain * 1.7) * a;
      const k = grey > 1e-5 ? 1 + noise / Math.max(grey / a, 0.02) : 1;
      red *= k;
      green *= k;
      blue *= k;
    }
    data[p * 4] = Math.max(0, red);
    data[p * 4 + 1] = Math.max(0, green);
    data[p * 4 + 2] = Math.max(0, blue);
  }
  return { ...r, data, emission };
}

/**
 * Composites a rendered sprite over the canvas (premultiplied "over"). `hide` (0–1 per canvas
 * pixel) removes the object where something stands in front of it.
 */
export function compositeOver(canvas: Canvas, r: Rendered, hide?: Float32Array | null): void {
  const clip = clipRect(r.rect, canvas.width, canvas.height);
  for (let y = clip.y0; y < clip.y1; y += 1) {
    for (let x = clip.x0; x < clip.x1; x += 1) {
      const l = ((y - r.rect.y0) * r.width + (x - r.rect.x0)) * 4;
      let a = r.data[l + 3] as number;
      if (a <= 0.001) continue;
      const p = y * canvas.width + x;
      const keep = hide ? 1 - (hide[p] as number) : 1;
      if (keep <= 0) continue;
      a *= keep;
      const i = p * 3;
      canvas.rgb[i] = (r.data[l] as number) * keep + (canvas.rgb[i] as number) * (1 - a);
      canvas.rgb[i + 1] =
        (r.data[l + 1] as number) * keep + (canvas.rgb[i + 1] as number) * (1 - a);
      canvas.rgb[i + 2] =
        (r.data[l + 2] as number) * keep + (canvas.rgb[i + 2] as number) * (1 - a);
    }
  }
}

/** Darkens the canvas under a shadow mask (0–1 per local pixel) by `strength`. */
export function multiplyShadow(
  canvas: Canvas,
  rect: Rect,
  width: number,
  mask: Float32Array,
  strength: number,
  hide?: Float32Array | null,
): void {
  const clip = clipRect(rect, canvas.width, canvas.height);
  for (let y = clip.y0; y < clip.y1; y += 1) {
    for (let x = clip.x0; x < clip.x1; x += 1) {
      const m = mask[(y - rect.y0) * width + (x - rect.x0)] as number;
      if (m <= 0.002) continue;
      const p = y * canvas.width + x;
      const keep = hide ? 1 - (hide[p] as number) : 1;
      const k = 1 - clamp01(m * strength * keep);
      canvas.rgb[p * 3] = (canvas.rgb[p * 3] as number) * k;
      canvas.rgb[p * 3 + 1] = (canvas.rgb[p * 3 + 1] as number) * k;
      canvas.rgb[p * 3 + 2] = (canvas.rgb[p * 3 + 2] as number) * k;
    }
  }
}

/** Alpha-weighted mean luminance of a rendered sprite. */
export function renderedLuminance(r: Rendered): number {
  let sum = 0;
  let total = 0;
  for (let p = 0; p < r.width * r.height; p += 1) {
    const a = r.data[p * 4 + 3] as number;
    if (a <= 0.01) continue;
    sum += lum(r.data[p * 4] as number, r.data[p * 4 + 1] as number, r.data[p * 4 + 2] as number);
    total += a;
  }
  return total > 0 ? sum / total : 0;
}
