import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CompiledRequest } from '@holiday/core';
import { isRelightRequest } from '../../pipeline/compile/compiler.js';
import { decodeRaster, encodeJpeg } from '../../pipeline/imaging/raster.js';
import { relightSourceToEvening } from '../../pipeline/imaging/relight.js';
import type { EditOutcome, FixtureEditContext } from '../types.js';
import { createFixtureImageEditor } from './fixture.js';

const daylight = await sharp(
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="64"><rect width="96" height="64" fill="#9cc3e6"/><rect x="16" y="20" width="64" height="44" fill="#d8d0c0"/><rect x="40" y="36" width="14" height="28" fill="#7a2a1a"/><circle cx="47" cy="30" r="3" fill="#fff6c0"/></svg>',
  ),
)
  .jpeg({ quality: 95 })
  .toBuffer();

const decorate: CompiledRequest = {
  schemaVersion: '1.0',
  compilerVersion: 'test',
  provider: 'fixture',
  modelSnapshot: 'fixture',
  images: [{ role: 'source', width: 96, height: 64, checksum: 'abc' }],
  instructionText: 'Decorate.',
  parameters: { size: '96x64' },
  settingsHash: 'settings',
};
const relight: CompiledRequest = {
  ...decorate,
  instructionText: 'Relight.',
  parameters: { size: '96x64', relight: true },
};

const context: FixtureEditContext = {
  holidayId: 'christmas',
  style: 'classic',
  lightingMode: 'evening',
  sceneType: 'house_exterior',
  placements: [],
  windows: [[0.2, 0.35, 0.35, 0.5]],
  targetFacade: [0.15, 0.3, 0.85, 1],
};

async function edit(request: CompiledRequest, attemptId: string, fixture?: FixtureEditContext) {
  const outcome: EditOutcome = await createFixtureImageEditor().edit(
    request,
    { image: daylight, ...(fixture ? { fixture } : {}) },
    { attemptId, timeoutMs: 1000, signal: new AbortController().signal },
  );
  if (outcome.status !== 'completed') throw new Error(`edit ${outcome.status}`);
  return outcome;
}

async function meanLuma(bytes: Uint8Array): Promise<number> {
  const stats = await sharp(bytes).greyscale().stats();
  return stats.channels[0]?.mean ?? 0;
}

describe('fixture image editor relight requests', () => {
  it('recognizes a relight by its parameter or its kind', () => {
    expect(isRelightRequest(relight)).toBe(true);
    expect(isRelightRequest({ ...decorate, kind: 'relight' } as CompiledRequest)).toBe(true);
    expect(isRelightRequest(decorate)).toBe(false);
  });

  it("uses the compiler's relight test rather than a copy of its own", async () => {
    expect(Object.keys(await import('./fixture.js'))).not.toContain('isRelightRequest');
  });

  it('answers with the deterministic evening relight of the input image', async () => {
    const first = await edit(relight, 'attempt-a', context);
    const second = await edit(relight, 'attempt-b', context);
    expect(Buffer.from(first.image).equals(Buffer.from(second.image))).toBe(true);
    expect([first.width, first.height]).toEqual([96, 64]);

    const expected = relightSourceToEvening({
      composite: await decodeRaster(daylight),
      working: await decodeRaster(daylight),
      interior: false,
      targetFacade: context.targetFacade ?? null,
      windows: context.windows ?? [],
      lightSources: [],
      decorationMask: null,
      seed: 'settings:abc',
      restore: [],
    });
    const expectedBytes = await encodeJpeg(expected.raster, { quality: 92 });
    expect(Buffer.from(first.image).equals(expectedBytes)).toBe(true);
    expect(await meanLuma(first.image)).toBeLessThan((await meanLuma(daylight)) * 0.6);
  });

  it('relights without a fixture context too, and leaves decoration requests unchanged', async () => {
    const relit = await edit(relight, 'attempt-c');
    expect(await meanLuma(relit.image)).toBeLessThan((await meanLuma(daylight)) * 0.6);

    const plain = await edit(decorate, 'attempt-d');
    const resized = await sharp(daylight)
      .resize(96, 64, { fit: 'fill' })
      .jpeg({ quality: 92 })
      .toBuffer();
    expect(Buffer.from(plain.image).equals(resized)).toBe(true);
  });
});
