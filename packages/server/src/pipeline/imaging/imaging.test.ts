import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
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
    expect(meta.xmp?.toString()).toContain('AI preview by Holiday');
    expect(meta.exif).toBeUndefined();
    const marked = await burnPreviewMark(delivered);
    const corner = { left: 700, top: 560, width: 80, height: 30 };
    const before = await sharp(await sharp(delivered).extract(corner).toBuffer()).stats();
    const after = await sharp(await sharp(marked).extract(corner).toBuffer()).stats();
    expect(after.channels[0]?.mean).toBeLessThan((before.channels[0]?.mean ?? 255) - 20);
  });

  it('burns the mark lower left on Street View-origin images, whose credit sits lower right', async () => {
    expect(previewMarkCorner('street_view')).toBe('lower-left');
    expect(previewMarkCorner('upload')).toBe('lower-right');
    expect(previewMarkCorner('fixture')).toBe('lower-right');
    const image = await sharp({
      create: { width: 800, height: 600, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const mean = async (bytes: Buffer, left: number) =>
      (
        await sharp(
          await sharp(bytes).extract({ left, top: 560, width: 80, height: 30 }).toBuffer(),
        ).stats()
      ).channels[0]?.mean ?? 255;
    const left = await burnPreviewMark(image, { corner: 'lower-left' });
    expect(await mean(left, 20)).toBeLessThan(200);
    expect(await mean(left, 700)).toBeGreaterThan(245);
    const right = await burnPreviewMark(image);
    expect(await mean(right, 700)).toBeLessThan(200);
    expect(await mean(right, 20)).toBeGreaterThan(245);
  });

  it('places the share card mark inside the image, lower left for Street View-origin images', async () => {
    // A square Street View image is shown centered (pillarboxed) in the card's image area.
    const after = await sharp({
      create: { width: 1024, height: 1024, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    const card = await composeShareCard(after, {
      attribution: 'Google Maps · © 2025 Google',
      markCorner: 'lower-left',
    });
    // Image area 1200 × 586; the square shows 586 wide from x = 307.
    const patchOf = async (bytes: Buffer, left: number) =>
      (
        await sharp(
          await sharp(bytes).extract({ left, top: 548, width: 60, height: 20 }).toBuffer(),
        ).stats()
      ).channels[0]?.mean ?? 0;
    const patch = (left: number) => patchOf(card, left);
    expect(await patch(330)).toBeLessThan(200);
    expect(await patch(820)).toBeGreaterThan(240);
    const upload = await composeShareCard(after);
    const uploadPatch = (left: number) => patchOf(upload, left);
    expect(await uploadPatch(820)).toBeLessThan(200);
    expect(await uploadPatch(330)).toBeGreaterThan(240);
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
