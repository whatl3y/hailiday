import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import type { AssetPermission } from '../../policy/index.js';
import type { Raster } from '../imaging/raster.js';
import { buildDeliverables, newestPerVariantKey } from './publish.js';

/** The size the app requests Street View frames at, so the measured rectangles apply. */
const SIZE = 640;

/** A flat light-gray candidate, so the dark "AI preview" badge stands out wherever it is. */
function flatCandidate(): Raster {
  return { data: Buffer.alloc(SIZE * SIZE * 3, 200), width: SIZE, height: SIZE };
}

const permission: AssetPermission = {
  display: true,
  store: true,
  aiProcess: true,
  edit: true,
  distributeDerivative: true,
  commerceAdjacent: true,
  train: false,
  attribution: 'Google Maps',
  expiresAt: null,
  territory: null,
  evidenceId: 'test',
};

interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Gray levels of a region of the download's image area. */
async function grayOf(download: Buffer, box: PixelBox): Promise<Buffer> {
  return sharp(download).extract(box).greyscale().raw().toBuffer();
}

async function meanOf(download: Buffer, box: PixelBox): Promise<number> {
  const pixels = await grayOf(download, box);
  return pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
}

/** The measured attribution rectangles of a 640x640 frame, in pixels of the image area. */
function attributionBoxes(): PixelBox[] {
  return DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640']!.map(([x0, y0, x1, y1]) => {
    const left = Math.floor(x0 * SIZE);
    const top = Math.floor(y0 * SIZE);
    return {
      left,
      top,
      width: Math.ceil(x1 * SIZE) - left,
      height: Math.ceil(y1 * SIZE) - top,
    };
  });
}

const box = Math.round(SIZE * 0.25);
const corners = {
  upperLeft: { left: 0, top: 0, width: box, height: box },
  upperRight: { left: SIZE - box, top: 0, width: box, height: box },
  lowerLeft: { left: 0, top: SIZE - box, width: box, height: box },
  lowerRight: { left: SIZE - box, top: SIZE - box, width: box, height: box },
};

async function downloadFor(kind: 'street_view' | 'upload'): Promise<Buffer> {
  const deliverables = await buildDeliverables({
    candidate: flatCandidate(),
    contentBox: null,
    source: {
      kind,
      copyright: kind === 'street_view' ? '© 2025 Google' : null,
      privateOnly: false,
    },
    permission,
    quality: 90,
    downloadMark: true,
  });
  expect(deliverables.download).not.toBeNull();
  expect(deliverables.labelApplied).toBe(true);
  return deliverables.download as Buffer;
}

describe('download file mark corner', () => {
  it('puts the mark upper left on a Street View-origin download, off both attribution boxes', async () => {
    const download = await downloadFor('street_view');
    const meta = await sharp(download).metadata();
    // The attribution band sits below the image.
    expect(meta.height).toBeGreaterThan(SIZE);
    expect(await meanOf(download, corners.upperLeft)).toBeLessThan(195);
    for (const corner of [corners.upperRight, corners.lowerLeft, corners.lowerRight]) {
      expect(await meanOf(download, corner)).toBeGreaterThan(197);
    }
    // The Google logo and copyright rectangles keep the frame's pixels.
    for (const region of attributionBoxes()) {
      const pixels = await grayOf(download, region);
      expect(Math.min(...pixels)).toBeGreaterThan(190);
      expect(Math.max(...pixels)).toBeLessThan(210);
    }
  });

  it('puts the mark lower right on an upload download', async () => {
    const download = await downloadFor('upload');
    const meta = await sharp(download).metadata();
    expect(meta.height).toBe(SIZE);
    expect(await meanOf(download, corners.lowerRight)).toBeLessThan(195);
    for (const corner of [corners.upperLeft, corners.upperRight, corners.lowerLeft]) {
      expect(await meanOf(download, corner)).toBeGreaterThan(197);
    }
  });
});

describe('newestPerVariantKey', () => {
  it('keeps the newest rendering of each key, newest first, ties broken by id', () => {
    const at = (iso: string) => new Date(iso);
    const assets = [
      { id: 'a1', variantKey: 'k1', createdAt: at('2026-11-01T10:00:00Z') },
      { id: 'b1', variantKey: 'k2', createdAt: at('2026-11-02T10:00:00Z') },
      { id: 'a2', variantKey: 'k1', createdAt: at('2026-11-03T10:00:00Z') },
      { id: 'a4', variantKey: 'k3', createdAt: at('2026-11-04T10:00:00Z') },
      { id: 'a3', variantKey: 'k3', createdAt: at('2026-11-04T10:00:00Z') },
    ];
    expect(newestPerVariantKey(assets).map((asset) => asset.id)).toEqual(['a4', 'a2', 'b1']);
    expect(assets.map((asset) => asset.id)).toEqual(['a1', 'b1', 'a2', 'a4', 'a3']);
  });
});
