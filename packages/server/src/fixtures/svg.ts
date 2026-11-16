import sharp from 'sharp';
import type { NormalizedBox } from '@hailiday/core';

/** FNV-1a hash of a string, used to seed deterministic randomness. */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Small deterministic PRNG (mulberry32). Same seed, same sequence, on every platform. */
export class Rng {
  private state: number;
  constructor(seed: string | number) {
    this.state = typeof seed === 'number' ? seed >>> 0 : hashSeed(seed);
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))] as T;
  }
  /** Approximately normal jitter in (−amount, amount). */
  jitter(amount: number): number {
    return (this.next() + this.next() - 1) * amount;
  }
}

/** Formats a number for SVG output: one decimal, no trailing zeros, stable. */
export function n(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Formats an opacity or other unit value with up to three decimals. */
export function u(value: number): string {
  const rounded = Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
  return String(rounded);
}

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean.padEnd(6, '0').slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) || 0) as [number, number, number];
}

export function toHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b]
    .map((c) =>
      Math.round(Math.min(255, Math.max(0, c ?? 0)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** Linear mix of two colors: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(ca.map((c, i) => c + ((cb[i] as number) - c) * t));
}

export const lighten = (color: string, t: number) => mix(color, '#ffffff', t);
export const darken = (color: string, t: number) => mix(color, '#000000', t);

/** Relative luminance (0–1) of a color. */
export function luminance(color: string): number {
  const [r, g, b] = parseHex(color).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Whether a color reads as red or brown brick (warm hue, moderate saturation). */
export function isBrickColor(color: string): boolean {
  const [r, g, b] = parseHex(color);
  return r > g + 30 && r > b + 30 && r < 210;
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Collects SVG definitions and body elements and serializes a document. */
export class SvgBuilder {
  private readonly defs: string[] = [];
  private readonly parts: string[] = [];
  private readonly cache = new Map<string, string>();
  private counter = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly prefix = 'g',
  ) {}

  id(kind: string): string {
    this.counter += 1;
    return `${this.prefix}${kind}${this.counter}`;
  }

  def(markup: string): void {
    this.defs.push(markup);
  }

  add(markup: string): void {
    this.parts.push(markup);
  }

  /** A vertical or arbitrary linear gradient in object bounding-box units. */
  linear(
    stops: readonly (readonly [number, string, number?])[],
    direction: { x1?: number; y1?: number; x2?: number; y2?: number } = {},
  ): string {
    const key = `l:${JSON.stringify(stops)}:${JSON.stringify(direction)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const id = this.id('lg');
    const { x1 = 0, y1 = 0, x2 = 0, y2 = 1 } = direction;
    this.def(
      `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops
        .map(
          ([offset, color, opacity]) =>
            `<stop offset="${u(offset)}" stop-color="${color}"${opacity === undefined ? '' : ` stop-opacity="${u(opacity)}"`}/>`,
        )
        .join('')}</linearGradient>`,
    );
    this.cache.set(key, id);
    return id;
  }

  /** A radial gradient in object bounding-box units. */
  radial(
    stops: readonly (readonly [number, string, number?])[],
    cx = 0.5,
    cy = 0.5,
    r = 0.5,
  ): string {
    const key = `r:${JSON.stringify(stops)}:${cx}:${cy}:${r}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const id = this.id('rg');
    this.def(
      `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops
        .map(
          ([offset, color, opacity]) =>
            `<stop offset="${u(offset)}" stop-color="${color}"${opacity === undefined ? '' : ` stop-opacity="${u(opacity)}"`}/>`,
        )
        .join('')}</radialGradient>`,
    );
    this.cache.set(key, id);
    return id;
  }

  /** A Gaussian blur filter with a generous region. */
  blur(stdDeviation: number): string {
    const key = `b:${n(stdDeviation)}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const id = this.id('bl');
    this.def(
      `<filter id="${id}" x="-60%" y="-60%" width="220%" height="220%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="${n(stdDeviation)}"/></filter>`,
    );
    this.cache.set(key, id);
    return id;
  }

  /** The collected `<defs>` content (gradients and filters), for documents sharing them. */
  definitions(): string {
    return this.defs.join('');
  }

  toString(): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}"><defs>${this.defs.join('')}</defs>${this.parts.join('')}</svg>`;
  }
}

/** A pixel rectangle with `x0 < x1`, `y0 < y1`. */
export interface PxBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function pxBox(x0: number, y0: number, x1: number, y1: number): PxBox {
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

export function unionPx(boxes: readonly PxBox[]): PxBox | null {
  if (boxes.length === 0) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Rounds a normalized coordinate to four decimals. */
const r4 = (value: number) => Math.round(value * 10000) / 10000;

/**
 * Converts a pixel box to a normalized box clamped to the image. Returns null when the visible
 * part is smaller than `minFraction` of the image area.
 */
export function normBox(
  box: PxBox,
  width: number,
  height: number,
  minFraction = 0.00002,
): NormalizedBox | null {
  const x0 = r4(Math.min(1, Math.max(0, box.x0 / width)));
  const y0 = r4(Math.min(1, Math.max(0, box.y0 / height)));
  const x1 = r4(Math.min(1, Math.max(0, box.x1 / width)));
  const y1 = r4(Math.min(1, Math.max(0, box.y1 / height)));
  if (!(x0 < x1 && y0 < y1)) return null;
  if ((x1 - x0) * (y1 - y0) < minFraction) return null;
  return [x0, y0, x1, y1];
}

/** Normalizes several pixel boxes, dropping those that are not visible. */
export function normBoxes(boxes: readonly PxBox[], width: number, height: number): NormalizedBox[] {
  const result: NormalizedBox[] = [];
  for (const box of boxes) {
    const normalized = normBox(box, width, height);
    if (normalized) result.push(normalized);
  }
  return result;
}

/** Share of a pixel box that lies inside the image. */
export function visibleFraction(box: PxBox, width: number, height: number): number {
  const area = Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
  if (area === 0) return 0;
  const vx = Math.max(0, Math.min(width, box.x1) - Math.max(0, box.x0));
  const vy = Math.max(0, Math.min(height, box.y1) - Math.max(0, box.y0));
  return (vx * vy) / area;
}

/** Share of `box` covered by `other`. */
export function overlapPx(box: PxBox, other: PxBox): number {
  const area = Math.max(0, box.x1 - box.x0) * Math.max(0, box.y1 - box.y0);
  if (area === 0) return 0;
  const ox = Math.max(0, Math.min(box.x1, other.x1) - Math.max(box.x0, other.x0));
  const oy = Math.max(0, Math.min(box.y1, other.y1) - Math.max(box.y0, other.y0));
  return (ox * oy) / area;
}

export interface RasterOptions {
  format?: 'jpeg' | 'png';
  quality?: number;
}

/** Rasterizes an SVG document with sharp (librsvg), deterministically. */
export async function rasterize(svg: string, options: RasterOptions = {}): Promise<Buffer> {
  const image = sharp(Buffer.from(svg), { density: 72 }).flatten({ background: '#ffffff' });
  if (options.format === 'png') return image.png({ compressionLevel: 6 }).toBuffer();
  return image
    .jpeg({ quality: options.quality ?? 90, chromaSubsampling: '4:4:4', mozjpeg: false })
    .toBuffer();
}

/** A polygon `points` attribute from pixel coordinates. */
export function points(list: readonly (readonly [number, number])[]): string {
  return list.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
}
