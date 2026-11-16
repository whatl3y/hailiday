import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CompiledRequest, NormalizedBox } from '@hailiday/core';
import { loadContent, type Content } from '../content/load.js';
import type { EditOutcome, ImageEditor, VisionModel } from '../providers/types.js';
import { ExampleCameraChangedError, renderExamplePair, type ExampleDaylight } from './examples.js';
import { medianDeltaE } from './imaging/checks.js';
import { decodeRaster } from './imaging/raster.js';
import { warpRaster, type SimilarityTransform } from './imaging/registration.js';

let content: Content;
beforeAll(async () => {
  content = await loadContent();
});

/**
 * A live-mode editor stand-in that returns the source photo reframed by `transform` and delivered
 * at `size` (the way an editor that shifts or zooms the framing would), without decorations.
 */
function reframingEditor(
  transform: SimilarityTransform,
  size: { width: number; height: number },
  options: {
    exposure?: number;
    requests?: CompiledRequest[];
    inputs?: Uint8Array[];
    /** A solid square painted onto the output (normalized box, RGB). */
    paint?: { box: NormalizedBox; color: [number, number, number] };
  } = {},
): ImageEditor {
  const edit = async (
    request: CompiledRequest,
    input: { image: Uint8Array },
  ): Promise<EditOutcome> => {
    options.requests?.push(request);
    options.inputs?.push(input.image);
    const source = await decodeRaster(input.image);
    if (options.paint) {
      const { box, color } = options.paint;
      for (
        let y = Math.round(box[1] * source.height);
        y < Math.round(box[3] * source.height);
        y += 1
      ) {
        for (
          let x = Math.round(box[0] * source.width);
          x < Math.round(box[2] * source.width);
          x += 1
        ) {
          for (let c = 0; c < 3; c += 1)
            source.data[(y * source.width + x) * 3 + c] = color[c] as number;
        }
      }
    }
    if (options.exposure !== undefined) {
      const gain = options.exposure;
      source.data = Buffer.from(source.data.map((v) => Math.min(255, Math.round(v * gain + 6))));
    }
    const theta = (-transform.rotationDeg * Math.PI) / 180;
    const k = 1 / transform.scale;
    const inverse: SimilarityTransform = {
      dx: -k * (Math.cos(theta) * transform.dx - Math.sin(theta) * transform.dy),
      dy: -k * (Math.sin(theta) * transform.dx + Math.cos(theta) * transform.dy),
      scale: k,
      rotationDeg: -transform.rotationDeg,
      aspect: 1,
    };
    const moved = warpRaster(source, inverse, source.width, source.height).raster;
    const image = await sharp(moved.data, {
      raw: { width: moved.width, height: moved.height, channels: 3 },
    })
      .resize(size.width, size.height, { fit: 'fill' })
      .png()
      .toBuffer();
    return {
      status: 'completed',
      operationId: 'op',
      image,
      width: size.width,
      height: size.height,
      format: 'png',
      usage: { raw: {} },
      modelSnapshot: 'stand-in',
      provenance: {},
      providerMode: 'live',
    };
  };
  return {
    providerId: 'gemini',
    mode: 'live',
    capabilities: {
      supportsMask: false,
      supportsMarkup: false,
      maxReferenceImages: 0,
      supportedOutputSizes: [{ width: 1024, height: 1024 }],
      asyncOperations: false,
      supportsIdempotencyKey: false,
      supportsCancel: false,
    },
    edit,
    getOperation: () => Promise.reject(new Error('not used')),
  };
}

const manifestVision = { providerId: 'fixture', mode: 'fixture' } as VisionModel;

describe('example renders register the output like the render job', () => {
  it('aligns a shifted, zoomed output of another size before paste-back', async () => {
    const example = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.source.v1',
    );
    if (!example) throw new Error('example');
    const pair = await renderExamplePair(
      {
        content,
        imageEditor: reframingEditor(
          { dx: 12, dy: -8, scale: 1.03, rotationDeg: 0, aspect: 1 },
          { width: 1264, height: 848 },
        ),
        vision: manifestVision,
        styleKitVersionId: 'kit',
        modelSnapshot: 'stand-in',
      },
      example,
    );
    expect(pair.alignment).toMatchObject({
      accepted: true,
      applied: true,
      resampledFrom: { width: 1264, height: 848 },
    });
    expect(pair.alignment.scale).toBeCloseTo(1.03, 2);
    // The stand-in adds nothing, so an aligned composite matches the before image: no seam.
    const before = await decodeRaster(pair.before);
    const after = await decodeRaster(pair.after);
    const all = new Uint8Array(before.width * before.height).fill(1);
    expect(medianDeltaE(before, after, all)).toBeLessThan(1.5);
  });

  it('refuses an output whose framing changed beyond the limits', async () => {
    const example = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.source.v1',
    );
    if (!example) throw new Error('example');
    await expect(
      renderExamplePair(
        {
          content,
          imageEditor: reframingEditor(
            { dx: 0, dy: 0, scale: 1.2, rotationDeg: 0, aspect: 1 },
            { width: 1536, height: 1024 },
          ),
          vision: manifestVision,
          styleKitVersionId: 'kit',
          modelSnapshot: 'stand-in',
        },
        example,
      ),
    ).rejects.toBeInstanceOf(ExampleCameraChangedError);
  });

  it('compiles with the configured budget settings and matches the output tones before paste-back', async () => {
    const example = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.source.v1',
    );
    if (!example) throw new Error('example');
    const requests: CompiledRequest[] = [];
    const pair = await renderExamplePair(
      {
        content,
        // The editor returns the frame brighter, the way live editors often do.
        imageEditor: reframingEditor(
          { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 },
          { width: 1536, height: 1024 },
          { exposure: 1.12, requests },
        ),
        vision: manifestVision,
        styleKitVersionId: 'kit',
        modelSnapshot: 'stand-in',
        imageEdit: { geminiImageSize: '2K', geminiThinkingLevel: 'high' },
      },
      example,
    );
    expect(requests[0]?.parameters).toMatchObject({ image_size: '2K', thinking_level: 'high' });
    expect(pair.photometric).toMatchObject({ applied: true });
    // The stand-in adds nothing, so after tone matching the composite matches the before image
    // inside the mask too: no brighter pasted shapes.
    const before = await decodeRaster(pair.before);
    const after = await decodeRaster(pair.after);
    const values: number[] = [];
    for (let i = 0; i < before.width * before.height; i += 7) {
      let d = 0;
      for (let c = 0; c < 3; c += 1)
        d += Math.abs(before.data[i * 3 + c]! - after.data[i * 3 + c]!);
      values.push(d / 3);
    }
    values.sort((a, b) => a - b);
    // The 95th percentile difference: the masked share of the frame (about a fifth) would sit
    // at the full exposure step without tone matching.
    expect(values[Math.floor(values.length * 0.95)]).toBeLessThan(6);
  });

  it('keeps a decoration the localizer found outside the plan, as the render job does', async () => {
    const example = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.source.v1',
    );
    if (!example) throw new Error('example');
    // Top-left sky: no Christmas placement is planned there.
    const box: NormalizedBox = [0.02, 0.02, 0.1, 0.1];
    const localizing = {
      providerId: 'fixture',
      mode: 'fixture',
      localizeAdditions: async () => ({
        result: { added: [{ label: 'red lantern', box, placementId: null }], otherChanges: [] },
        usage: { inputTokens: 0, outputTokens: 0, calls: 1 },
        model: 'stand-in',
        promptVersion: 'stand-in',
        elapsedMs: 0,
        providerMode: 'fixture' as const,
      }),
    } as unknown as VisionModel;
    const render = (vision: VisionModel) =>
      renderExamplePair(
        {
          content,
          imageEditor: reframingEditor(
            { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 },
            { width: 1536, height: 1024 },
            { paint: { box, color: [220, 20, 20] } },
          ),
          vision,
          styleKitVersionId: 'kit',
          modelSnapshot: 'stand-in',
        },
        example,
      );
    const redness = async (jpeg: Buffer) => {
      const after = await decodeRaster(jpeg);
      const x = Math.round(0.06 * after.width);
      const y = Math.round(0.06 * after.height);
      const p = (y * after.width + x) * 3;
      return (after.data[p] as number) - (after.data[p + 1] as number);
    };
    expect(await redness((await render(localizing)).after)).toBeGreaterThan(120);
    // Without a localization (the call fails), the plan mask restores the original there.
    expect(await redness((await render(manifestVision)).after)).toBeLessThan(60);
  });

  it('renders an evening example as the relight of its daylight composite', async () => {
    const example = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.evening.v1',
    );
    if (!example) throw new Error('example');
    const requests: CompiledRequest[] = [];
    const inputs: Uint8Array[] = [];
    const daylight = new Map<string, ExampleDaylight>();
    const pair = await renderExamplePair(
      {
        content,
        imageEditor: reframingEditor(
          { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 },
          { width: 1536, height: 1024 },
          { requests, inputs },
        ),
        vision: manifestVision,
        styleKitVersionId: 'kit',
        modelSnapshot: 'stand-in',
        daylight,
      },
      example,
    );
    expect(requests.map((request) => request.kind ?? 'decorate')).toEqual(['decorate', 'relight']);
    expect(requests[1]?.mask).toBeUndefined();
    expect(requests[1]?.instructionText).toContain('Relight this exact photograph');
    // The relight's input is the daylight composite on the working grid.
    const [base] = [...daylight.values()];
    const input = await decodeRaster(inputs[1] as Uint8Array);
    expect(input.data.equals(base?.candidate.data as Buffer)).toBe(true);
    expect(pair.alignment.accepted).toBe(true);
    // The daylight example of the same photo reuses the composite: no third edit.
    const source = content.examples.find(
      (e) => e.exampleId === 'example.christmas.house_exterior.classic.source.v1',
    );
    if (!source) throw new Error('example');
    await renderExamplePair(
      {
        content,
        imageEditor: reframingEditor(
          { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 },
          { width: 1536, height: 1024 },
          { requests },
        ),
        vision: manifestVision,
        styleKitVersionId: 'kit',
        modelSnapshot: 'stand-in',
        daylight,
      },
      source,
    );
    expect(requests).toHaveLength(2);
  });

  it('renders a bright example like the render job: a dim photo relit, a bright one kept', async () => {
    const render = async (exampleId: string) => {
      const example = content.examples.find((e) => e.exampleId === exampleId);
      if (!example) throw new Error(exampleId);
      expect(example.lightingMode).toBe('bright');
      const requests: CompiledRequest[] = [];
      const pair = await renderExamplePair(
        {
          content,
          imageEditor: reframingEditor(
            { dx: 0, dy: 0, scale: 1, rotationDeg: 0, aspect: 1 },
            { width: 1536, height: 1024 },
            { requests, exposure: 1.1 },
          ),
          vision: manifestVision,
          styleKitVersionId: 'kit',
          modelSnapshot: 'stand-in',
        },
        example,
      );
      return { pair, requests };
    };
    // The hallway (median luma 0.47) is relit with the bright relight, judged against its base.
    const dim = await render('example.christmas.apartment_entry.classic.bright.v1');
    expect(dim.requests.map((request) => request.kind ?? 'decorate')).toEqual([
      'decorate',
      'relight',
    ]);
    expect(dim.requests[1]?.parameters.relight_target).toBe('bright');
    expect(dim.requests[1]?.instructionText).toContain('bright, airy and cheerful');
    expect(dim.pair.relightBase).toBeDefined();
    // The living room (0.74) is already bright: decorated as photographed, no relight.
    const bright = await render('example.christmas.interior.classic.bright.v1');
    expect(bright.requests.map((request) => request.kind ?? 'decorate')).toEqual(['decorate']);
    expect(bright.pair.relightBase).toBeUndefined();
  });
});
