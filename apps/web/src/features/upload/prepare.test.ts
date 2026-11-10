import { describe, expect, it, vi } from 'vitest';
import {
  ACCEPT_ATTRIBUTE,
  isHeicLike,
  prepareImage,
  targetSize,
  type DecodedBitmap,
  type PrepareDeps,
} from './prepare';
import { minimumCropSpan, moveCorner, cropMeetsMinimum } from './crop';
import { declineMessage, prepareFailureMessage, uploadOutcome } from './uploadState';
import type { UploadStatus } from '@holiday/core';

function file(name: string, type: string, size = 1000): File {
  const blob = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  Object.defineProperty(blob, 'size', { value: size });
  return blob;
}

function bitmap(width: number, height: number): DecodedBitmap {
  return { width, height, close: vi.fn() };
}

function deps(decoded: DecodedBitmap | Error): PrepareDeps & {
  decode: ReturnType<typeof vi.fn>;
  encode: ReturnType<typeof vi.fn>;
} {
  const decode = vi.fn(
    async (_source: unknown, options: { resizeWidth?: number; resizeHeight?: number }) => {
      if (decoded instanceof Error) throw decoded;
      return options.resizeWidth ? bitmap(options.resizeWidth, options.resizeHeight ?? 0) : decoded;
    },
  );
  const encode = vi.fn(async () => new Blob(['jpeg'], { type: 'image/jpeg' }));
  return { decode, encode } as never;
}

describe('accept attribute', () => {
  it('lists JPEG first and never HEIC or image/*', () => {
    expect(ACCEPT_ATTRIBUTE).toBe('image/jpeg,image/png,image/webp');
  });
});

describe('targetSize', () => {
  it('keeps the aspect ratio with the long edge at 2048 and never enlarges', () => {
    expect(targetSize(4032, 3024)).toEqual({ width: 2048, height: 1536, resized: true });
    expect(targetSize(3024, 4032)).toEqual({ width: 1536, height: 2048, resized: true });
    expect(targetSize(1600, 1200)).toEqual({ width: 1600, height: 1200, resized: false });
  });
});

describe('isHeicLike', () => {
  it('recognizes HEIC by type or extension', () => {
    expect(isHeicLike({ type: 'image/heic', name: 'a.bin' })).toBe(true);
    expect(isHeicLike({ type: '', name: 'IMG_0001.HEIC' })).toBe(true);
    expect(isHeicLike({ type: 'image/jpeg', name: 'a.jpg' })).toBe(false);
  });
});

describe('prepareImage', () => {
  it('refuses files over the size cap before decoding', async () => {
    const d = deps(bitmap(4000, 3000));
    const result = await prepareImage(file('big.jpg', 'image/jpeg', 30_000_000), d, {
      maxBytes: 26_214_400,
    });
    expect(result).toEqual({ ok: false, reason: 'too_large' });
    expect(d.decode).not.toHaveBeenCalled();
  });

  it('decodes with orientation, resizes inside createImageBitmap and encodes JPEG at 0.9', async () => {
    const d = deps(bitmap(4032, 3024));
    const result = await prepareImage(file('room.jpg', 'image/jpeg'), d);
    expect(d.decode.mock.calls[0]![1]).toEqual({ imageOrientation: 'from-image' });
    expect(d.decode.mock.calls[1]![1]).toEqual({
      imageOrientation: 'from-image',
      resizeWidth: 2048,
      resizeHeight: 1536,
      resizeQuality: 'high',
    });
    expect(d.encode.mock.calls[0]!.slice(1)).toEqual([2048, 1536, 0.9]);
    expect(result).toMatchObject({
      ok: true,
      contentType: 'image/jpeg',
      width: 2048,
      height: 1536,
      clientPrepared: true,
    });
  });

  it('does not resize photos that are already small enough', async () => {
    const d = deps(bitmap(1200, 900));
    const result = await prepareImage(file('room.png', 'image/png'), d);
    expect(d.decode).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, width: 1200, height: 900 });
  });

  it('refuses photos whose short edge is below 640 px', async () => {
    const result = await prepareImage(file('tiny.jpg', 'image/jpeg'), deps(bitmap(900, 500)));
    expect(result).toEqual({ ok: false, reason: 'image_too_small' });
  });

  it('gives HEIC a specific refusal when the browser cannot decode it', async () => {
    const result = await prepareImage(file('IMG_1.heic', 'image/heic'), deps(new Error('decode')));
    expect(result).toEqual({ ok: false, reason: 'heic_unsupported' });
    expect(prepareFailureMessage('heic_unsupported')).toEqual([
      'error.UPLOAD_UNSUPPORTED_FORMAT',
      'upload.heicHint',
    ]);
  });

  it('sends accepted types unprepared when decoding fails, and refuses others', async () => {
    const original = file('scan.webp', 'image/webp');
    const passthrough = await prepareImage(original, deps(new Error('decode')));
    expect(passthrough).toMatchObject({
      ok: true,
      blob: original,
      clientPrepared: false,
      contentType: 'image/webp',
    });
    const refused = await prepareImage(file('doc.gif', 'image/gif'), deps(new Error('decode')));
    expect(refused).toEqual({ ok: false, reason: 'unsupported_format' });
  });
});

function status(overrides: Partial<UploadStatus>): UploadStatus {
  return {
    sourceAssetId: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e',
    state: 'ready',
    holdForReview: false,
    sceneType: 'interior',
    sceneTypeConfidence: 0.91,
    roomType: 'dining_room',
    buildingForm: null,
    multiUnitFacade: false,
    people: { detected: false, boxes: [], suggestedCropBox: null },
    guidance: [],
    detectedFormat: 'jpeg',
    attestationVersion: 'v',
    declineCode: null,
    declineReasonClass: null,
    declineReason: null,
    width: 2048,
    height: 1536,
    ...overrides,
  };
}

describe('upload outcomes', () => {
  it('classifies screening, holds, ready and declines', () => {
    expect(uploadOutcome(status({ state: 'screening' }))).toEqual({ kind: 'screening' });
    expect(uploadOutcome(status({ state: 'screening', holdForReview: true }))).toEqual({
      kind: 'held',
    });
    expect(uploadOutcome(status({}))).toEqual({
      kind: 'ready',
      needsSceneChoice: false,
      peopleDetected: false,
    });
    expect(uploadOutcome(status({ sceneTypeConfidence: 0.55 }))).toMatchObject({
      needsSceneChoice: true,
    });
    expect(
      uploadOutcome(
        status({
          people: { detected: true, boxes: [[0.1, 0.2, 0.3, 0.9]], suggestedCropBox: null },
        }),
      ),
    ).toMatchObject({ peopleDetected: true });
  });

  it('names guidance reasons and keeps safety declines neutral', () => {
    expect(
      declineMessage({
        declineCode: 'UPLOAD_DECLINED',
        declineReasonClass: 'guidance',
        declineReason: 'not_a_living_space',
      }),
    ).toEqual({ messageKey: 'upload.declined.not_a_living_space', safety: false });
    expect(
      declineMessage({
        declineCode: 'UPLOAD_DECLINED',
        declineReasonClass: 'safety',
        declineReason: null,
      }),
    ).toEqual({ messageKey: 'error.UPLOAD_DECLINED', safety: true });
    expect(
      declineMessage({
        declineCode: 'UPLOAD_UNSUPPORTED_FORMAT',
        declineReasonClass: 'guidance',
        declineReason: 'unsupported_format',
      }),
    ).toEqual({ messageKey: 'error.UPLOAD_UNSUPPORTED_FORMAT', safety: false });
  });
});

describe('crop frame', () => {
  it('keeps the crop inside the image and at the minimum size', () => {
    const span = minimumCropSpan(2048, 1536, 640);
    const moved = moveCorner([0.3, 0, 1, 1], 'topLeft', 0.95, -0.2, span);
    expect(moved[0]).toBeCloseTo(1 - 640 / 2048);
    expect(moved[1]).toBe(0);
    expect(cropMeetsMinimum(moved, 2048, 1536, 640)).toBe(true);
    expect(cropMeetsMinimum([0, 0, 0.2, 0.2], 2048, 1536, 640)).toBe(false);
  });
});
