import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS } from '../../config/index.js';
import { renderFixturePanorama } from '../../fixtures/street-view.js';
import { IPTC_DIGITAL_SOURCE_TYPE } from '../versions.js';
import { runDeterministicChecks } from './checks.js';
import { pasteBack, photometricAlign } from './composite.js';
import {
  burnPreviewMark,
  composeShareCard,
  deliveredXmp,
  encodeDelivered,
  previewMarkCorner,
} from './label.js';
import { buildCompositeMask, featherBand } from './mask.js';
import { decodeRaster, shiftRaster, type Raster } from './raster.js';
import { nativeBoxesOnWorkingGrid, prepareWorkingImage } from './working.js';

interface PixelBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A normalized `[x0, y0, x1, y1]` box in whole pixels of a `width` × `height` image. */
function toPixelBox(box: readonly number[], width: number, height: number): PixelBox {
  const left = Math.floor(box[0]! * width);
  const top = Math.floor(box[1]! * height);
  return {
    left,
    top,
    width: Math.ceil(box[2]! * width) - left,
    height: Math.ceil(box[3]! * height) - top,
  };
}

async function grayRegion(image: Uint8Array, box: PixelBox): Promise<Buffer> {
  return sharp(image).extract(box).greyscale().raw().toBuffer();
}

async function regionMean(image: Uint8Array, box: PixelBox): Promise<number> {
  const pixels = await grayRegion(image, box);
  return pixels.reduce((sum, value) => sum + value, 0) / pixels.length;
}

async function regionMin(image: Uint8Array, box: PixelBox): Promise<number> {
  const pixels = await grayRegion(image, box);
  return pixels.reduce((min, value) => Math.min(min, value), 255);
}

/** The largest per-pixel gray difference between two images inside `box`. */
async function regionDifference(a: Uint8Array, b: Uint8Array, box: PixelBox): Promise<number> {
  const [first, second] = await Promise.all([grayRegion(a, box), grayRegion(b, box)]);
  let max = 0;
  for (let i = 0; i < first.length; i += 1) max = Math.max(max, Math.abs(first[i]! - second[i]!));
  return max;
}

async function fixtureWorking() {
  const frame = await renderFixturePanorama({
    panoId: 'fxSvLanternHillC01p1Sv',
    heading: 0,
    fov: 80,
    pitch: 2,
    width: 640,
    height: 640,
  });
  if (!frame) throw new Error('fixture frame missing');
  return prepareWorkingImage(frame.image, 'street_view');
}

const REGIONS: [number, number, number, number][] = [[0.44, 0.48, 0.56, 0.62]];

function brighten(raster: Raster, delta: number): Raster {
  const data = Buffer.from(raster.data);
  for (let i = 0; i < data.length; i += 1) data[i] = Math.min(255, (data[i] as number) + delta);
  return { ...raster, data };
}

describe('compositing', () => {
  it('pastes back original pixels byte for byte outside the mask', async () => {
    const working = await fixtureWorking();
    const raw = brighten(working.raster, 60);
    const mask = buildCompositeMask({
      width: working.width,
      height: working.height,
      regions: REGIONS,
      dilationFraction: 0.04,
      featherFraction: 0.02,
      exclusions: [[0.5, 0.5, 0.52, 0.52]],
    });
    const candidate = pasteBack(working.raster, raw, mask);
    let outside = 0;
    for (let i = 0; i < mask.alpha.length; i += 1) {
      if (mask.alpha[i] !== 0) continue;
      outside += 1;
      for (let c = 0; c < 3; c += 1) {
        expect(candidate.data[i * 3 + c]).toBe(working.raster.data[i * 3 + c]);
      }
    }
    expect(outside).toBeGreaterThan(working.width * working.height * 0.9);
    // Excluded (protected) pixels inside the dilated area are restored too.
    const p = Math.round(0.51 * working.height) * working.width + Math.round(0.51 * working.width);
    expect(mask.alpha[p]).toBe(0);
    // Inside the region the raw output is used.
    const q = Math.round(0.55 * working.height) * working.width + Math.round(0.47 * working.width);
    expect(candidate.data[q * 3]).toBe(raw.data[q * 3]);
  });

  it('rejects a synthetic 3 px shift and accepts an aligned output', async () => {
    const working = await fixtureWorking();
    const base = {
      working: working.raster,
      requested: { width: 1024, height: 1024 },
      lightingMode: 'evening' as const,
      placementRegions: REGIONS,
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      mask: null,
    };
    const shifted = shiftRaster(working.raster, 3, 0);
    const bad = runDeterministicChecks({ ...base, raw: shifted, candidate: shifted });
    expect(bad.codes).toContain('camera_changed');
    expect(bad.registration).toMatchObject({ dx: 3, dy: 0 });
    const good = runDeterministicChecks({
      ...base,
      raw: working.raster,
      candidate: working.raster,
    });
    expect(good.codes).toEqual([]);
    expect(good.registration).toMatchObject({ dx: 0, dy: 0 });
    const resized = await decodeRaster(
      await sharp(working.png).resize(1000, 1000).png().toBuffer(),
    );
    expect(runDeterministicChecks({ ...base, raw: resized, candidate: resized }).codes).toEqual([
      'camera_changed',
    ]);
  });

  it('trips the seam check on a mismatched exposure, and passes after photometric alignment', async () => {
    const working = await fixtureWorking();
    const mask = buildCompositeMask({
      width: working.width,
      height: working.height,
      regions: REGIONS,
      dilationFraction: 0.04,
      featherFraction: 0.02,
    });
    expect(featherBand(mask).some((v) => v === 1)).toBe(true);
    const raw = brighten(working.raster, 70);
    const base = {
      working: working.raster,
      raw,
      requested: { width: 1024, height: 1024 },
      lightingMode: 'source' as const,
      placementRegions: REGIONS,
      peopleBoxes: [],
      blurRegions: [],
      houseNumberRegions: [],
      glowRegions: [],
      mask,
    };
    const seam = runDeterministicChecks({
      ...base,
      candidate: pasteBack(working.raster, raw, mask),
    });
    expect(seam.codes).toContain('implausible_decor');
    const aligned = photometricAlign(working.raster, raw, mask, { ringPx: 31, toleranceDeltaE: 1 });
    expect(aligned.record.applied).toBe(true);
    const matched = pasteBack(working.raster, aligned.raster, mask);
    expect(runDeterministicChecks({ ...base, candidate: matched }).codes).not.toContain(
      'implausible_decor',
    );
  });
});

describe('working grid', () => {
  it('resamples Street View frames to 1024×1024', async () => {
    const working = await fixtureWorking();
    expect(working).toMatchObject({
      width: 1024,
      height: 1024,
      nativeWidth: 640,
      scaleFactor: 1.6,
      cropBox: null,
    });
  });

  it('center-crops by at most 10% and pads beyond that', async () => {
    const make = (w: number, h: number) =>
      sharp({ create: { width: w, height: h, channels: 3, background: '#88aacc' } })
        .jpeg()
        .toBuffer();
    const cropped = await prepareWorkingImage(await make(1600, 1000), 'upload');
    expect(cropped).toMatchObject({ width: 1536, height: 1024, contentBox: null });
    expect(cropped.cropBox?.[0]).toBeGreaterThan(0);
    const padded = await prepareWorkingImage(await make(1200, 900), 'upload');
    expect(padded).toMatchObject({ width: 1536, height: 1024, cropBox: null });
    expect(padded.contentBox).not.toBeNull();
    expect(padded.padRegions).toHaveLength(2);
    const portrait = await prepareWorkingImage(await make(1000, 1500), 'upload');
    expect(portrait).toMatchObject({ width: 1024, height: 1536 });
  });

  it('maps native-image boxes (configured attribution rectangles) onto the working grid', () => {
    // A Street View frame is resampled whole: the boxes keep their normalized coordinates.
    expect(
      nativeBoxesOnWorkingGrid([[0.01, 0.95, 0.15, 0.99]], { cropBox: null, contentBox: null }),
    ).toEqual([[0.01, 0.95, 0.15, 0.99]]);
    // Through an aspect crop (the left and right 5% cut away) and into a padded content area.
    expect(
      nativeBoxesOnWorkingGrid(
        [
          [0, 0.9, 0.2, 1],
          [0.96, 0.9, 1, 1],
        ],
        { cropBox: [0.05, 0, 0.95, 1], contentBox: null },
      ),
    ).toEqual([[0, 0.9, 0.1667, 1]]);
    expect(
      nativeBoxesOnWorkingGrid([[0.8, 0.9, 1, 1]], {
        cropBox: null,
        contentBox: [0, 0.125, 1, 0.875],
      }),
    ).toEqual([[0.8, 0.8, 1, 0.875]]);
  });
});

describe('labels and provenance', () => {
  it('writes the IPTC digital source type and burns the AI preview mark', async () => {
    expect(deliveredXmp()).toContain(IPTC_DIGITAL_SOURCE_TYPE);
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const delivered = await encodeDelivered(image);
    const meta = await sharp(delivered).metadata();
    expect(meta.xmp?.toString()).toContain('AI preview by Hailiday');
    expect(meta.exif).toBeUndefined();
    const marked = await burnPreviewMark(delivered);
    const corner = { left: 700, top: 560, width: 80, height: 30 };
    const before = await sharp(await sharp(delivered).extract(corner).toBuffer()).stats();
    const after = await sharp(await sharp(marked).extract(corner).toBuffer()).stats();
    expect(after.channels[0]?.mean).toBeLessThan((before.channels[0]?.mean ?? 255) - 20);
  });

  it('burns the mark upper left on Street View-origin images, off both attribution boxes', async () => {
    expect(previewMarkCorner('street_view')).toBe('upper-left');
    expect(previewMarkCorner('upload')).toBe('lower-right');
    expect(previewMarkCorner('fixture')).toBe('lower-right');
    // A live-size 640x640 frame; PNG in and out, so untouched pixels stay identical.
    const size = 640;
    const image = await sharp({
      create: { width: size, height: size, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    const marked = await burnPreviewMark(image, { corner: 'upper-left' });
    const boxes = DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640']!;
    for (const box of boxes) {
      expect(await regionDifference(image, marked, toPixelBox(box, size, size))).toBe(0);
    }
    const upperLeft = { left: 13, top: 13, width: 60, height: 18 };
    expect(await regionMean(marked, upperLeft)).toBeLessThan(200);
    expect(await regionMean(image, upperLeft)).toBe(255);
    // The lower-right default mark covers the copyright box; the upper-left one never does.
    const right = await burnPreviewMark(image);
    expect(await regionDifference(image, right, toPixelBox(boxes[1]!, size, size))).toBeGreaterThan(
      0,
    );
    expect(await regionMean(right, { left: 13, top: 13, width: 60, height: 18 })).toBe(255);
  });

  it('places the share card mark inside the image, upper left for Street View-origin images', async () => {
    // A square Street View frame is shown centered (pillarboxed) in the card's image area.
    const after = await sharp({
      create: { width: 640, height: 640, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const card = await composeShareCard(after, {
      attribution: 'Google Maps · © 2025 Google',
      markCorner: 'upper-left',
    });
    // Image area 1200 × 586; the square shows 586 × 586 from x = 307, y = 0.
    const shown = { left: 307, top: 0, width: 586, height: 586 };
    const inShown = (box: readonly number[]) => {
      const pixel = toPixelBox(box, shown.width, shown.height);
      return { ...pixel, left: pixel.left + shown.left, top: pixel.top + shown.top };
    };
    expect(await regionMean(card, { left: 330, top: 16, width: 60, height: 20 })).toBeLessThan(200);
    for (const box of DEFAULT_STREET_VIEW_ATTRIBUTION_REGIONS['640x640']!) {
      expect(await regionMin(card, inShown(box))).toBeGreaterThan(180);
    }
    // Nothing of the mark at the lower corners of the shown image.
    expect(await regionMean(card, { left: 330, top: 548, width: 60, height: 20 })).toBeGreaterThan(
      240,
    );
    expect(await regionMean(card, { left: 820, top: 548, width: 60, height: 20 })).toBeGreaterThan(
      240,
    );
    const upload = await composeShareCard(after);
    expect(await regionMean(upload, { left: 820, top: 548, width: 60, height: 20 })).toBeLessThan(
      200,
    );
    expect(await regionMean(upload, { left: 330, top: 16, width: 60, height: 20 })).toBeGreaterThan(
      240,
    );
  });

  it('composes a 1200×630 share card under 5 MB', async () => {
    const after = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#335577' },
    })
      .jpeg()
      .toBuffer();
    const card = await composeShareCard(after, { attribution: 'Google Maps · © 2025 Google' });
    const meta = await sharp(card).metadata();
    expect(meta).toMatchObject({ width: 1200, height: 630, format: 'jpeg' });
    expect(card.length).toBeLessThan(5 * 1024 * 1024);
  });
});
