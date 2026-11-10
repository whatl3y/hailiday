import sharp from 'sharp';
import type { NormalizedBox } from '@holiday/core';
import { sha256Hex } from '../../ids/index.js';

/** An 8-bit sRGB image held in memory without alpha (three interleaved channels). */
export interface Raster {
  data: Buffer;
  width: number;
  height: number;
}

/** An integer pixel rectangle `[x0, y0, x1)` × `[y0, y1)`. */
export interface PxRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Decodes any supported image to an sRGB raster (alpha flattened onto white). */
export async function decodeRaster(bytes: Uint8Array): Promise<Raster> {
  const { data, info } = await sharp(bytes)
    .rotate()
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`Expected 3 channels, got ${info.channels}`);
  return { data, width: info.width, height: info.height };
}

/** Lossless PNG of a raster (deterministic for identical pixels). */
export async function encodePng(raster: Raster): Promise<Buffer> {
  return sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 3 },
  })
    .png({ compressionLevel: 6, adaptiveFiltering: false })
    .toBuffer();
}

/** Baseline JPEG of a raster with no metadata. */
export async function encodeJpeg(
  raster: Raster,
  options: { quality?: number; progressive?: boolean; xmp?: string } = {},
): Promise<Buffer> {
  let pipeline = sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 3 },
  }).jpeg({
    quality: options.quality ?? 90,
    progressive: options.progressive ?? false,
    chromaSubsampling: '4:4:4',
  });
  if (options.xmp) pipeline = pipeline.withXmp(options.xmp);
  return pipeline.toBuffer();
}

/** Encodes a single-channel 8-bit mask as a grayscale PNG. */
export async function encodeMaskPng(mask: Uint8Array, width: number, height: number) {
  return sharp(Buffer.from(mask), { raw: { width, height, channels: 1 } })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** SHA-256 hex of raw bytes. */
export function checksumOf(bytes: Uint8Array): string {
  return sha256Hex(bytes);
}

/** Rec. 601 luma per pixel, 0–255. */
export function toGray(raster: Raster): Float32Array {
  const out = new Float32Array(raster.width * raster.height);
  const d = raster.data;
  for (let i = 0, p = 0; i < out.length; i += 1, p += 3) {
    out[i] = 0.299 * (d[p] as number) + 0.587 * (d[p + 1] as number) + 0.114 * (d[p + 2] as number);
  }
  return out;
}

/** Converts a normalized box to a clamped pixel rectangle (`px = round(x × width)`). */
export function toRect(box: NormalizedBox, width: number, height: number): PxRect {
  const x0 = Math.max(0, Math.min(width, Math.round(box[0] * width)));
  const y0 = Math.max(0, Math.min(height, Math.round(box[1] * height)));
  const x1 = Math.max(x0, Math.min(width, Math.round(box[2] * width)));
  const y1 = Math.max(y0, Math.min(height, Math.round(box[3] * height)));
  return { x0, y0, x1, y1 };
}

/** Resizes a raster with Lanczos3 (exact output size). */
export async function resizeRaster(raster: Raster, width: number, height: number): Promise<Raster> {
  if (raster.width === width && raster.height === height) return raster;
  const data = await sharp(raster.data, {
    raw: { width: raster.width, height: raster.height, channels: 3 },
  })
    .resize(width, height, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  return { data, width, height };
}

/** Copies a rectangle of `source` into `target` (same size rasters). */
export function copyRect(target: Raster, source: Raster, rect: PxRect): void {
  for (let y = rect.y0; y < rect.y1; y += 1) {
    const start = (y * target.width + rect.x0) * 3;
    const end = (y * target.width + rect.x1) * 3;
    source.data.copy(target.data, start, start, end);
  }
}

/** Shifts a raster by whole pixels, filling uncovered pixels by edge replication (tests). */
export function shiftRaster(raster: Raster, dx: number, dy: number): Raster {
  const out = Buffer.alloc(raster.data.length);
  for (let y = 0; y < raster.height; y += 1) {
    const sy = Math.min(raster.height - 1, Math.max(0, y - dy));
    for (let x = 0; x < raster.width; x += 1) {
      const sx = Math.min(raster.width - 1, Math.max(0, x - dx));
      const s = (sy * raster.width + sx) * 3;
      const t = (y * raster.width + x) * 3;
      out[t] = raster.data[s] as number;
      out[t + 1] = raster.data[s + 1] as number;
      out[t + 2] = raster.data[s + 2] as number;
    }
  }
  return { data: out, width: raster.width, height: raster.height };
}
