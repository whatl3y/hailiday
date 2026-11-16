import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { CompiledRequest } from '@hailiday/core';
import { isRelightRequest } from '../../pipeline/compile/compiler.js';
import {
  SYNTHETIC_ATTRIBUTION,
  attributionScene,
} from '../../pipeline/imaging/attribution.testing.js';
import { decodeRaster, encodeJpeg, encodePng } from '../../pipeline/imaging/raster.js';
import {
  medianLuma,
  relightSourceToEvening,
  relightToBright,
} from '../../pipeline/imaging/relight.js';
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

  it('answers a bright relight with the deterministic bright grade of the input image', async () => {
    const bright: CompiledRequest = {
      ...relight,
      parameters: { ...relight.parameters, relight_target: 'bright' },
    };
    const first = await edit(bright, 'attempt-e', context);
    const second = await edit(bright, 'attempt-f', context);
    expect(Buffer.from(first.image).equals(Buffer.from(second.image))).toBe(true);
    expect([first.width, first.height]).toEqual([96, 64]);
    const expected = relightToBright({ image: await decodeRaster(daylight), restore: [] });
    expect(Buffer.from(first.image).equals(await encodeJpeg(expected, { quality: 92 }))).toBe(true);
    expect(medianLuma(await decodeRaster(first.image))).toBeGreaterThan(
      medianLuma(await decodeRaster(daylight)),
    );
  });
});

describe('fixture image editor relights of a frame with a burned-in attribution', () => {
  const scene = attributionScene(1024);
  const box = SYNTHETIC_ATTRIBUTION[0]!;
  const request: CompiledRequest = {
    ...relight,
    images: [{ role: 'source', width: 1024, height: 1024, checksum: 'abc' }],
    parameters: { size: '1024x1024', relight: true },
  };
  const relightOf = async (target: CompiledRequest) => {
    const outcome = await createFixtureImageEditor().edit(
      target,
      {
        image: await encodePng(scene.base),
        fixture: { ...context, attributionRegion: box },
      },
      { attemptId: 'attempt-attr', timeoutMs: 5000, signal: new AbortController().signal },
    );
    if (outcome.status !== 'completed') throw new Error(`edit ${outcome.status}`);
    return Buffer.from(outcome.image);
  };

  it('keeps the logo strokes over a relit ground in the evening relight', async () => {
    const expected = relightSourceToEvening({
      composite: scene.base,
      working: scene.base,
      interior: false,
      targetFacade: context.targetFacade ?? null,
      windows: context.windows ?? [],
      lightSources: [],
      decorationMask: null,
      seed: 'settings:abc',
      attribution: [box],
    });
    expect(
      (await relightOf(request)).equals(await encodeJpeg(expected.raster, { quality: 92 })),
    ).toBe(true);
  });

  it('keeps the logo strokes over a brightened ground in the bright relight', async () => {
    const bright: CompiledRequest = {
      ...request,
      parameters: { ...request.parameters, relight_target: 'bright' },
    };
    const expected = relightToBright({ image: scene.base, attribution: [box] });
    expect((await relightOf(bright)).equals(await encodeJpeg(expected, { quality: 92 }))).toBe(
      true,
    );
  });
});

describe('fixture image editor enhance requests', () => {
  const enhance: CompiledRequest = {
    ...decorate,
    kind: 'enhance',
    instructionText: 'Re-photograph.',
    parameters: { size: '96x64', enhance: true },
  };

  it('answers with the deterministic sharpening of the input at the requested size', async () => {
    const first = await edit(enhance, 'enhance-a');
    const second = await edit(enhance, 'enhance-b');
    expect([first.width, first.height]).toEqual([96, 64]);
    const raster = await decodeRaster(first.image);
    expect([raster.width, raster.height]).toEqual([96, 64]);
    expect(Buffer.from(second.image).equals(Buffer.from(first.image))).toBe(true);
    const input = await decodeRaster(daylight);
    let different = 0;
    for (let i = 0; i < input.data.length; i += 1) {
      if (Math.abs((input.data[i] as number) - (raster.data[i] as number)) > 3) different += 1;
    }
    expect(different).toBeGreaterThan(0);
  });

  it('ignores every render scenario and answers enhance requests marked by kind only', async () => {
    for (const scenario of ['provider_error', 'moderation', 'slow'] as const) {
      const outcome = await createFixtureImageEditor({ slowDelayMs: 60_000 }).edit(
        enhance,
        { image: daylight, fixture: { ...context, scenario } },
        { attemptId: `enhance-${scenario}`, timeoutMs: 1000, signal: new AbortController().signal },
      );
      expect(outcome.status, scenario).toBe('completed');
    }
    const byKind = await edit({ ...enhance, parameters: { size: '96x64' } }, 'enhance-kind');
    const byMarker = await edit(enhance, 'enhance-marker');
    expect(Buffer.from(byKind.image).equals(Buffer.from(byMarker.image))).toBe(true);
  });

  it('leaves decorate and relight answers unchanged', async () => {
    const plain = await edit(decorate, 'decorate-plain');
    const resized = await sharp(daylight)
      .resize(96, 64, { fit: 'fill' })
      .jpeg({ quality: 92 })
      .toBuffer();
    expect(Buffer.from(plain.image).equals(resized)).toBe(true);
    const relit = await edit(relight, 'relight-plain', context);
    const enhanced = await edit(enhance, 'enhance-plain');
    expect(Buffer.from(relit.image).equals(Buffer.from(enhanced.image))).toBe(false);
  });
});
