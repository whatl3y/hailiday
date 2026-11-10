import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { AssetPermission } from '../../policy/index.js';
import type { Raster } from '../imaging/raster.js';
import { buildDeliverables } from './publish.js';

const SIZE = 512;

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

/** Mean gray level of the lower-left and lower-right corner boxes of the original image area. */
async function cornerLuma(download: Buffer): Promise<{ left: number; right: number }> {
  const box = Math.round(SIZE * 0.25);
  const luma = async (left: number) => {
    const pixels = await sharp(download)
      .extract({ left, top: SIZE - box, width: box, height: box })
      .greyscale()
      .raw()
      .toBuffer();
    return pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
  };
  return { left: await luma(0), right: await luma(SIZE - box) };
}

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
  it('puts the mark lower left on a Street View-origin download, clear of the credit', async () => {
    const download = await downloadFor('street_view');
    const meta = await sharp(download).metadata();
    // The attribution band sits below the image.
    expect(meta.height).toBeGreaterThan(SIZE);
    const { left, right } = await cornerLuma(download);
    expect(left).toBeLessThan(right - 5);
    expect(right).toBeGreaterThan(195);
  });

  it('puts the mark lower right on an upload download', async () => {
    const download = await downloadFor('upload');
    const meta = await sharp(download).metadata();
    expect(meta.height).toBe(SIZE);
    const { left, right } = await cornerLuma(download);
    expect(right).toBeLessThan(left - 5);
    expect(left).toBeGreaterThan(195);
  });
});
