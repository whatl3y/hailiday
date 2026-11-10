/**
 * Float image buffers in linear light for the fixture compositor: sRGB conversion, separable
 * blurs and small helpers. Everything here is deterministic.
 */

/** sRGB (0–255) to linear light, as a lookup table. */
export const TO_LINEAR = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});

/** Linear light (0–1) to an sRGB byte value (unrounded). */
export function toSrgb(linear: number): number {
  const v = linear <= 0 ? 0 : linear >= 1 ? 1 : linear;
  return v <= 0.0031308 ? v * 12.92 * 255 : (1.055 * v ** (1 / 2.4) - 0.055) * 255;
}

export const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Relative luminance of linear RGB. */
export const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A scene in linear light, three channels per pixel. */
export interface Canvas {
  width: number;
  height: number;
  rgb: Float32Array;
}

/** A pixel rectangle (x1 and y1 exclusive). */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function clipRect(rect: Rect, width: number, height: number): Rect {
  return {
    x0: Math.max(0, Math.floor(rect.x0)),
    y0: Math.max(0, Math.floor(rect.y0)),
    x1: Math.min(width, Math.ceil(rect.x1)),
    y1: Math.min(height, Math.ceil(rect.y1)),
  };
}

/** One box-blur pass along rows or columns (running sum, clamped edges). */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  channels: number,
  radius: number,
  horizontal: boolean,
): void {
  const length = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? channels : w * channels;
  const lineStride = horizontal ? w * channels : channels;
  const norm = 1 / (2 * radius + 1);
  for (let line = 0; line < lines; line += 1) {
    const base = line * lineStride;
    for (let c = 0; c < channels; c += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const i = Math.min(length - 1, Math.max(0, k));
        sum += src[base + i * stride + c] as number;
      }
      for (let i = 0; i < length; i += 1) {
        dst[base + i * stride + c] = sum * norm;
        const out = Math.max(0, i - radius);
        const inn = Math.min(length - 1, i + radius + 1);
        sum += (src[base + inn * stride + c] as number) - (src[base + out * stride + c] as number);
      }
    }
  }
}

/** Approximate Gaussian blur (three box passes per axis) of an interleaved float image. */
export function blurFloat(
  data: Float32Array,
  w: number,
  h: number,
  channels: number,
  sigma: number,
): Float32Array {
  if (sigma < 0.3 || w < 2 || h < 2) return Float32Array.from(data);
  // Box radius for three passes approximating the Gaussian variance.
  const radius = Math.max(1, Math.round(Math.sqrt((12 * sigma * sigma) / 3 + 1) / 2 - 0.5));
  let a = Float32Array.from(data);
  let b = new Float32Array(data.length);
  for (let pass = 0; pass < 3; pass += 1) {
    boxPass(a, b, w, h, channels, radius, true);
    [a, b] = [b, a];
    boxPass(a, b, w, h, channels, radius, false);
    [a, b] = [b, a];
  }
  return a;
}

/** Small exact Gaussian blur for sub-pixel softening (sigma below about 2). */
export function gaussianFloat(
  data: Float32Array,
  w: number,
  h: number,
  channels: number,
  sigma: number,
): Float32Array {
  if (sigma < 0.2) return data;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = Array.from({ length: radius * 2 + 1 }, (_, i) =>
    Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)),
  );
  const total = kernel.reduce((s, v) => s + v, 0);
  for (let i = 0; i < kernel.length; i += 1) kernel[i] = (kernel[i] as number) / total;
  const tmp = new Float32Array(data.length);
  const out = new Float32Array(data.length);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const xx = Math.min(w - 1, Math.max(0, x + k));
          sum += (data[(y * w + xx) * channels + c] as number) * (kernel[k + radius] as number);
        }
        tmp[(y * w + x) * channels + c] = sum;
      }
    }
  }
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        let sum = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const yy = Math.min(h - 1, Math.max(0, y + k));
          sum += (tmp[(yy * w + x) * channels + c] as number) * (kernel[k + radius] as number);
        }
        out[(y * w + x) * channels + c] = sum;
      }
    }
  }
  return out;
}

/** Luminance of a canvas, one float per pixel. */
export function luminancePlane(canvas: Canvas): Float32Array {
  const out = new Float32Array(canvas.width * canvas.height);
  const rgb = canvas.rgb;
  for (let p = 0; p < out.length; p += 1) {
    out[p] = lum(rgb[p * 3] as number, rgb[p * 3 + 1] as number, rgb[p * 3 + 2] as number);
  }
  return out;
}

/** Mean linear RGB of a canvas rectangle (clipped). */
export function meanRgb(canvas: Canvas, rect: Rect): [number, number, number] {
  const r = clipRect(rect, canvas.width, canvas.height);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  const step = Math.max(1, Math.floor(Math.sqrt(((r.x1 - r.x0) * (r.y1 - r.y0)) / 4000)));
  for (let y = r.y0; y < r.y1; y += step) {
    for (let x = r.x0; x < r.x1; x += step) {
      const i = (y * canvas.width + x) * 3;
      sr += canvas.rgb[i] as number;
      sg += canvas.rgb[i + 1] as number;
      sb += canvas.rgb[i + 2] as number;
      n += 1;
    }
  }
  return n === 0 ? [0.18, 0.18, 0.18] : [sr / n, sg / n, sb / n];
}
