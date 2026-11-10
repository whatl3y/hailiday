import sharp from 'sharp';
import type { CompiledRequest, NormalizedBox } from '@holiday/core';
import { FIXTURE_COMPOSITOR_VERSION, decorateImage } from '../../fixtures/compositor.js';
import { isRelightRequest } from '../../pipeline/compile/compiler.js';
import { decodeRaster, encodeJpeg, toRect } from '../../pipeline/imaging/raster.js';
import { relightSourceToEvening } from '../../pipeline/imaging/relight.js';
import type {
  EditInput,
  EditOptions,
  EditOutcome,
  FixtureEditContext,
  ImageEditor,
} from '../types.js';

/** Parses `1024x1024`-style sizes from compiled parameters. */
export function requestedSize(request: CompiledRequest): { width: number; height: number } | null {
  const raw = request.parameters.size ?? request.parameters.image_size;
  if (typeof raw === 'string') {
    const match = /^(\d{2,5})x(\d{2,5})$/.exec(raw);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  const image = request.images[0];
  return image ? { width: image.width, height: image.height } : null;
}

/**
 * Whether the plan's regions come from exact frame geometry. Drawn generic scenes always do;
 * uploads never do (the compositor recognizes a library photo itself and otherwise places
 * nothing). Street View frames and requests without a scene reference keep the compositor's
 * default, which treats a frame carrying a burned-in attribution as a fixture frame.
 */
export function anchoredGeometryFor(context: FixtureEditContext): boolean | undefined {
  const kind = context.scene?.kind;
  if (kind === 'generic_scene') return true;
  if (kind === 'upload') return false;
  return undefined;
}

/** Dilation of the lit placements' regions that bounds where the fixture relight looks for bulbs. */
const LIT_REGION_DILATION = 0.02;

function litDecorationMask(
  context: FixtureEditContext | undefined,
  width: number,
  height: number,
): Uint8Array | null {
  const lit = (context?.placements ?? []).filter((placement) => placement.lit);
  if (lit.length === 0) return null;
  const mask = new Uint8Array(width * height);
  const pad = LIT_REGION_DILATION * Math.max(width, height);
  for (const placement of lit) {
    const [x0, y0, x1, y1] = placement.region;
    const box: NormalizedBox = [
      Math.max(0, x0 - pad / width),
      Math.max(0, y0 - pad / height),
      Math.min(1, x1 + pad / width),
      Math.min(1, y1 + pad / height),
    ];
    const rect = toRect(box, width, height);
    for (let y = rect.y0; y < rect.y1; y += 1)
      mask.fill(255, y * width + rect.x0, y * width + rect.x1);
  }
  return mask;
}

/**
 * The fixture answer to a relight request: the deterministic evening relight of the input image
 * (the decorated daylight variant), at the requested size. Bulbs bloom inside the lit
 * placements' regions when the undecorated original is supplied; the attribution is restored.
 */
async function relightImage(
  request: CompiledRequest,
  input: EditInput,
  size: { width: number; height: number },
): Promise<Buffer> {
  const composite = await decodeRaster(input.image);
  const original = input.fixture?.original ? await decodeRaster(input.fixture.original) : null;
  const working =
    original && original.width === composite.width && original.height === composite.height
      ? original
      : composite;
  const context = input.fixture;
  const relit = relightSourceToEvening({
    composite,
    working,
    interior: context?.sceneType === 'interior',
    targetFacade: context?.targetFacade ?? null,
    windows: context?.windows ?? [],
    lightSources: context?.lightSources ?? [],
    decorationMask: litDecorationMask(context, composite.width, composite.height),
    seed: `${request.settingsHash}:${request.images[0]?.checksum ?? ''}`,
    restore: context?.attributionRegion ? [context.attributionRegion] : [],
  });
  const jpeg = await encodeJpeg(relit.raster, { quality: 92 });
  if (relit.raster.width === size.width && relit.raster.height === size.height) return jpeg;
  return sharp(jpeg)
    .resize(size.width, size.height, { fit: 'fill' })
    .jpeg({ quality: 92 })
    .toBuffer();
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fixture image editor: the deterministic decoration compositor draws the planned placements
 * (and the evening relight) on the input image; a relight request is answered with the
 * deterministic evening relight of the input image. Failure injection follows the render
 * scenario: `provider_error`, `moderation` (vendor refusal) and `slow` (about 20 s).
 */
export function createFixtureImageEditor(options: { slowDelayMs?: number } = {}): ImageEditor {
  const operations = new Map<string, EditOutcome>();
  const remember = (operationId: string, outcome: EditOutcome) => {
    operations.set(operationId, outcome);
    if (operations.size > 200) operations.delete(operations.keys().next().value as string);
  };

  return {
    providerId: 'fixture-editor',
    mode: 'fixture',
    capabilities: {
      supportsMask: true,
      supportsMarkup: false,
      maxReferenceImages: 0,
      supportedOutputSizes: [
        { width: 1024, height: 1024 },
        { width: 1536, height: 1024 },
        { width: 1024, height: 1536 },
      ],
      asyncOperations: false,
      supportsIdempotencyKey: true,
      supportsCancel: false,
    },

    async edit(
      request: CompiledRequest,
      input: EditInput,
      editOptions: EditOptions,
    ): Promise<EditOutcome> {
      const operationId = `fixture:${editOptions.attemptId}`;
      await editOptions.onOperation?.(operationId);
      const previous = operations.get(operationId);
      if (previous) return previous;
      const scenario = input.fixture?.scenario ?? 'pass';
      if (scenario === 'provider_error') {
        return {
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'fixture_provider_error',
          retryable: true,
        };
      }
      if (scenario === 'moderation') {
        const outcome: EditOutcome = {
          status: 'failed',
          operationId,
          kind: 'moderation_blocked',
          providerCode: 'moderation_blocked',
          providerCategories: ['fixture'],
          retryable: false,
        };
        remember(operationId, outcome);
        return outcome;
      }
      if (scenario === 'slow') {
        const completed = await wait(options.slowDelayMs ?? 20_000, editOptions.signal);
        if (!completed) return { status: 'failed', operationId, kind: 'timeout', retryable: true };
      }
      const size = requestedSize(request) ?? { width: 1024, height: 1024 };
      let image: Buffer;
      if (isRelightRequest(request)) {
        image = await relightImage(request, input, size);
      } else if (input.fixture) {
        const anchoredGeometry = anchoredGeometryFor(input.fixture);
        const result = await decorateImage({
          image: input.image,
          holidayId: input.fixture.holidayId,
          style: input.fixture.style,
          lightingMode: input.fixture.lightingMode,
          sceneType: input.fixture.sceneType,
          placements: input.fixture.placements,
          windows: input.fixture.windows ?? [],
          lightSources: input.fixture.lightSources ?? [],
          attributionRegion: input.fixture.attributionRegion ?? null,
          preserveRegions: input.fixture.preserveRegions ?? [],
          accessRegions: input.fixture.accessRegions ?? [],
          referenceDoor: input.fixture.referenceDoor ?? null,
          targetFacade: input.fixture.targetFacade ?? null,
          ...(anchoredGeometry === undefined ? {} : { anchoredGeometry }),
          seed: `${request.settingsHash}:${request.images[0]?.checksum ?? ''}`,
          width: size.width,
          height: size.height,
          format: 'jpeg',
          quality: 92,
        });
        image = result.image;
      } else {
        image = await sharp(input.image)
          .resize(size.width, size.height, { fit: 'fill' })
          .jpeg({ quality: 92 })
          .toBuffer();
      }
      const outcome: EditOutcome = {
        status: 'completed',
        operationId,
        image,
        width: size.width,
        height: size.height,
        format: 'jpeg',
        usage: { images: 1, raw: { fixture: true } },
        modelSnapshot: FIXTURE_COMPOSITOR_VERSION,
        provenance: { watermark: 'unknown' },
        providerMode: 'fixture',
      };
      remember(operationId, outcome);
      return outcome;
    },

    async getOperation(operationId) {
      return (
        operations.get(operationId) ?? {
          status: 'failed',
          operationId,
          kind: 'provider_error',
          providerCode: 'unknown_operation',
          retryable: false,
        }
      );
    },
  };
}
