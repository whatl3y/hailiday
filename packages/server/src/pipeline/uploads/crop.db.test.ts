import sharp, { type OutputInfo } from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { straightenScale, type NormalizedBox } from '@hailiday/core';
import { toJson } from '../../db/client.js';
import type { BoxJson, SourceAsset } from '../../db/schema.js';
import type { PipelineDeps } from '../context.js';
import { createPipelineTestDeps, createUploadSource } from '../testing.js';
import { createCroppedChild } from './crop.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

const TILT = 10;

/**
 * A pale photo with a dark horizon line that rises to the right by `TILT` degrees, which a
 * clockwise straighten of `TILT` degrees makes level.
 */
async function tiltedPhoto(width: number, height: number): Promise<Buffer> {
  const rise = (width / 2) * Math.tan((TILT * Math.PI) / 180);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#e8e2d4"/><line x1="0" y1="${height / 2 + rise}" x2="${width}" y2="${height / 2 - rise}" stroke="#202020" stroke-width="24"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

async function uploadOf(image: Buffer, people: NormalizedBox[] = []): Promise<SourceAsset> {
  const { source } = await createUploadSource(deps, { image, sceneType: 'house_exterior' });
  const meta = await sharp(image).metadata();
  return deps.db
    .updateTable('sourceAssets')
    .set({
      width: meta.width ?? null,
      height: meta.height ?? null,
      peopleDetected: people.length > 0,
      peopleBoxes: people.length > 0 ? toJson(people as BoxJson[]) : null,
    })
    .where('id', '=', source.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function childPixels(child: SourceAsset) {
  const object = await deps.storage.get('private', child.objectKey as string);
  if (!object) throw new Error('child original missing');
  return sharp(object.body).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}

/** Mean row of the dark pixels in a column (the horizon line's position there). */
function lineRow(raw: { data: Buffer; info: OutputInfo }, x: number): number {
  const { width, height, channels } = raw.info;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    if ((raw.data[(y * width + x) * channels] as number) < 100) {
      sum += y;
      count += 1;
    }
  }
  return count === 0 ? Number.NaN : sum / count;
}

describe('people crop with straighten', () => {
  it('crops without rotation exactly as before', async () => {
    const parent = await uploadOf(await tiltedPhoto(1600, 1200));
    const outcome = await createCroppedChild(deps, { parent, box: [0.25, 0, 1, 1] });
    if (outcome.outcome !== 'created') throw new Error(outcome.outcome);
    expect(outcome.child).toMatchObject({ width: 1200, height: 1200, peopleResolution: 'cropped' });
  });

  it('turns the photo clockwise, levels the horizon and leaves no empty corner', async () => {
    const parent = await uploadOf(await tiltedPhoto(1600, 1200));
    const outcome = await createCroppedChild(deps, {
      parent,
      box: [0, 0, 1, 1],
      rotation: TILT,
    });
    if (outcome.outcome !== 'created') throw new Error(outcome.outcome);
    const scale = straightenScale(TILT, 1600, 1200);
    // The straightened view is the photo's frame zoomed by the cover factor.
    expect(Math.abs((outcome.child.width ?? 0) - 1600 / scale)).toBeLessThanOrEqual(6);
    expect(Math.abs((outcome.child.height ?? 0) - 1200 / scale)).toBeLessThanOrEqual(6);
    const raw = await childPixels(outcome.child);
    const { width, height, channels } = raw.info;
    // Level: the line sits at the same row on the left and the right.
    expect(Math.abs(lineRow(raw, 20) - lineRow(raw, width - 20))).toBeLessThanOrEqual(2);
    // No empty (black) background anywhere along the edges, corners included.
    let darkestEdge = 255;
    for (let x = 0; x < width; x += 1) {
      for (const y of [0, 1, height - 2, height - 1]) {
        const i = (y * width + x) * channels;
        const onLine = Math.abs(y - height / 2) < 40;
        if (!onLine) darkestEdge = Math.min(darkestEdge, raw.data[i] as number);
      }
    }
    for (let y = 0; y < height; y += 1) {
      if (Math.abs(y - height / 2) < 40) continue;
      for (const x of [0, 1, width - 2, width - 1]) {
        darkestEdge = Math.min(darkestEdge, raw.data[(y * width + x) * channels] as number);
      }
    }
    expect(darkestEdge).toBeGreaterThan(200);
  });

  it('reads the box on the straightened view and carries people boxes through the rotation', async () => {
    // One person at the far left, one in the middle; the crop keeps the right half.
    const parent = await uploadOf(await tiltedPhoto(2000, 1500), [
      [0.02, 0.4, 0.12, 0.7],
      [0.6, 0.4, 0.7, 0.7],
    ]);
    const outcome = await createCroppedChild(deps, {
      parent,
      box: [0.5, 0, 1, 1],
      rotation: -8,
    });
    if (outcome.outcome !== 'created') throw new Error(outcome.outcome);
    expect(outcome.remainingPeople).toHaveLength(1);
    const [person] = outcome.remainingPeople;
    // The middle person lands in the crop's left half, not where the unrotated box would put it.
    expect(person?.[0]).toBeGreaterThan(0.05);
    expect(person?.[2]).toBeLessThan(0.6);
    expect(outcome.child.cropBox).toEqual([0.5, 0, 1, 1]);
  });

  it('applies the minimum short edge to the straightened pixels', async () => {
    const parent = await uploadOf(await tiltedPhoto(1000, 760));
    const level = await createCroppedChild(deps, { parent, box: [0, 0, 1, 1] });
    expect(level.outcome).toBe('created');
    const turned = await createCroppedChild(deps, { parent, box: [0, 0, 1, 1], rotation: 15 });
    expect(turned.outcome).toBe('too_small');
  });
});
