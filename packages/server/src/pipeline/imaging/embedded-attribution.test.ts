import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
  burnAttribution,
  paintBlob,
  paintRect,
} from './attribution.testing.js';
import { embeddedAttributionRegions } from './embedded-attribution.js';
import type { Raster } from './raster.js';
import { prepareWorkingImage, type WorkingImage } from './working.js';

const CONFIGURED = DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS;
const FRAME_BOXES = CONFIGURED['640x640'] as readonly NormalizedBox[];

/** Raw RGB of a raster, for sharp. */
const rawOf = (raster: Raster) =>
  sharp(raster.data, { raw: { width: raster.width, height: raster.height, channels: 3 } });

/**
 * A synthetic frame drawn at 1024 and saved as a 640x640 JPEG, the size and format Google serves
 * a Street View Static frame in, as an owner would upload it.
 */
async function frameBytes(raster: Raster, size = 640): Promise<Buffer> {
  return rawOf(raster)
    .resize(size, size, { fit: 'fill', kernel: 'lanczos3' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function uploaded(bytes: Buffer): Promise<WorkingImage> {
  return prepareWorkingImage(bytes, 'upload');
}

const copyOf = (raster: Raster): Raster => ({ ...raster, data: Buffer.from(raster.data) });

describe('embeddedAttributionRegions', () => {
  const scene = attributionScene(1024);
  let marked: Buffer;

  beforeAll(async () => {
    marked = await frameBytes(scene.base);
  });

  it('gives an uploaded 640x640 frame carrying both marks the configured rectangles', async () => {
    // The synthetic rectangles are the configured ones of a 640x640 frame.
    expect(SYNTHETIC_ATTRIBUTION).toEqual(FRAME_BOXES);
    const working = await uploaded(marked);
    expect(working).toMatchObject({
      width: 1024,
      height: 1024,
      nativeWidth: 640,
      nativeHeight: 640,
      cropBox: null,
      contentBox: null,
    });
    expect(embeddedAttributionRegions(working, CONFIGURED)).toEqual(FRAME_BOXES);
    // Decided from the pixels alone: the same bytes decide the same way again.
    expect(embeddedAttributionRegions(await uploaded(marked), CONFIGURED)).toEqual(FRAME_BOXES);
  });

  it('finds both marks over flat grounds from dark to bright', async () => {
    for (const groundLuma of [0.15, 0.5, 0.85]) {
      const flat = attributionScene(1024, { groundLuma });
      const working = await uploaded(await frameBytes(flat.base));
      expect(embeddedAttributionRegions(working, CONFIGURED)).toEqual(FRAME_BOXES);
    }
  });

  it('gives none to a frame without marks or with one mark only', async () => {
    for (const ground of [
      scene.ground,
      burnAttribution(scene.ground, { marks: 'logo' }).base,
      burnAttribution(scene.ground, { marks: 'label' }).base,
    ]) {
      expect(
        embeddedAttributionRegions(await uploaded(await frameBytes(ground)), CONFIGURED),
      ).toEqual([]);
    }
  });

  it('gives none to bright things at the bottom corners: a window frame, snow, white bars', async () => {
    const window = copyOf(scene.ground);
    paintRect(window, 20, 985, 100, 989, [250, 250, 250]);
    for (const x of [20, 58, 96]) paintRect(window, x, 985, x + 4, 1024, [250, 250, 250]);
    paintBlob(window, 930, 1010, 60, 14, [245, 246, 250]);

    const bars = copyOf(scene.ground);
    paintRect(bars, 0, 975, 113, 1024, [40, 40, 40]);
    for (let x = 14; x < 98; x += 12) paintRect(bars, x, 994, x + 4, 1020, [245, 245, 245]);
    paintRect(bars, 820, 990, 1024, 1024, [35, 35, 35]);
    for (let x = 830; x < 1018; x += 9) paintRect(bars, x, 998, x + 2, 1016, [200, 200, 200]);

    // The logo is there; a snow patch lies where the label would be.
    const snow = burnAttribution(scene.ground, { marks: 'logo' }).base;
    paintBlob(snow, 930, 1008, 70, 16, [245, 246, 250]);

    for (const raster of [window, bars, snow]) {
      expect(
        embeddedAttributionRegions(await uploaded(await frameBytes(raster)), CONFIGURED),
      ).toEqual([]);
    }
  });

  it('gives none when the marks are not at their configured places (a mirrored frame)', async () => {
    const mirrored = await sharp(marked).flop().jpeg({ quality: 90 }).toBuffer();
    expect(embeddedAttributionRegions(await uploaded(mirrored), CONFIGURED)).toEqual([]);
  });

  it('gives none to a native size without configured rectangles', async () => {
    const large = await uploaded(await frameBytes(scene.base, 1024));
    expect(large.nativeWidth).toBe(1024);
    expect(embeddedAttributionRegions(large, CONFIGURED)).toEqual([]);
    // The configuration decides the sizes: configured for 1024x1024, the same picture qualifies.
    expect(embeddedAttributionRegions(large, { '1024x1024': FRAME_BOXES })).toEqual(FRAME_BOXES);
    expect(embeddedAttributionRegions(await uploaded(marked), {})).toEqual([]);
  });

  it('gives none when the working image is not the whole frame (cropped or padded)', async () => {
    /** The marked frame with `rows` rows of ground added above it, and its boxes on that size. */
    const taller = async (rows: number) => {
      const bytes = await sharp(marked)
        .extend({ top: rows, bottom: 0, left: 0, right: 0, background: '#707070' })
        .jpeg({ quality: 90 })
        .toBuffer();
      const height = 640 + rows;
      const boxes = FRAME_BOXES.map(([x0, y0, x1, y1]): NormalizedBox => [
        x0,
        (rows + y0 * 640) / height,
        x1,
        (rows + y1 * 640) / height,
      ]);
      return { working: await uploaded(bytes), configured: { [`640x${height}`]: boxes } };
    };
    // 640x680: centre-cropped to a square, which cuts the bottom rows holding the marks.
    const cropped = await taller(40);
    expect(cropped.working.cropBox).not.toBeNull();
    expect(cropped.working.contentBox).toBeNull();
    expect(embeddedAttributionRegions(cropped.working, cropped.configured)).toEqual([]);
    // 640x800: padded to the 2:3 grid.
    const padded = await taller(160);
    expect(padded.working.contentBox).not.toBeNull();
    expect(embeddedAttributionRegions(padded.working, padded.configured)).toEqual([]);
  });
});
