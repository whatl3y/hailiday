/**
 * Decoder child process (uploads spec, decoder isolation). It receives the quarantined bytes
 * over IPC, runs the header pre-check, decodes under limits, normalizes and re-encodes, and sends
 * back the normalized JPEG or a decline. It holds no credentials and opens no connections; the
 * parent kills it when the wall-clock limit passes. Self-contained (sharp and Node built-ins
 * only) so it can run directly from source or from the build output.
 */
import sharp, { type Metadata } from 'sharp';

interface DecodeRequest {
  bytes: Uint8Array;
  sniffed: 'jpeg' | 'png' | 'webp';
  maxPixels: number;
  minShortEdge: number;
  maxLongEdge: number;
  quality: number;
}

type Decline = {
  code: 'UPLOAD_UNSUPPORTED_FORMAT' | 'UPLOAD_TOO_LARGE' | 'VALIDATION_FAILED';
  reason: 'unsupported_format' | 'animated' | 'too_many_pixels' | 'image_too_small' | 'unreadable';
};

type DecodeResponse =
  | {
      ok: true;
      bytes: Uint8Array;
      width: number;
      height: number;
      originalWidth: number;
      originalHeight: number;
      orientation: number;
      hasAlpha: boolean;
      space: string | null;
      hasIcc: boolean;
    }
  | { ok: false; decline: Decline };

const SHARP_FORMATS: Record<DecodeRequest['sniffed'], string[]> = {
  jpeg: ['jpeg', 'jpg'],
  png: ['png'],
  webp: ['webp'],
};

sharp.cache(false);
sharp.concurrency(1);

async function decode(request: DecodeRequest): Promise<DecodeResponse> {
  const input = Buffer.from(request.bytes);
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    return { ok: false, decline: { code: 'VALIDATION_FAILED', reason: 'unreadable' } };
  }
  if (!meta.format || !SHARP_FORMATS[request.sniffed].includes(meta.format)) {
    return {
      ok: false,
      decline: { code: 'UPLOAD_UNSUPPORTED_FORMAT', reason: 'unsupported_format' },
    };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width * height > request.maxPixels) {
    return { ok: false, decline: { code: 'UPLOAD_TOO_LARGE', reason: 'too_many_pixels' } };
  }
  if ((meta.pages ?? 1) > 1) {
    return { ok: false, decline: { code: 'UPLOAD_UNSUPPORTED_FORMAT', reason: 'animated' } };
  }
  if (width === 0 || height === 0) {
    return { ok: false, decline: { code: 'VALIDATION_FAILED', reason: 'unreadable' } };
  }
  const orientation =
    meta.orientation && meta.orientation >= 1 && meta.orientation <= 8 ? meta.orientation : 1;
  const rotated = orientation >= 5;
  const orientedShort = Math.min(rotated ? height : width, rotated ? width : height);
  if (orientedShort < request.minShortEdge) {
    return { ok: false, decline: { code: 'VALIDATION_FAILED', reason: 'image_too_small' } };
  }
  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: request.maxPixels,
      failOn: 'warning',
      pages: 1,
      animated: false,
      unlimited: false,
      autoOrient: true,
    })
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .resize({
        width: request.maxLongEdge,
        height: request.maxLongEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: request.quality })
      .toBuffer({ resolveWithObject: true });
    return {
      ok: true,
      bytes: data,
      width: info.width,
      height: info.height,
      originalWidth: width,
      originalHeight: height,
      orientation,
      hasAlpha: meta.hasAlpha ?? false,
      space: meta.space ?? null,
      hasIcc: Boolean(meta.icc),
    };
  } catch {
    return { ok: false, decline: { code: 'VALIDATION_FAILED', reason: 'unreadable' } };
  }
}

process.on('message', (message: DecodeRequest) => {
  decode(message)
    .then((response) => {
      process.send?.(response, () => process.exit(0));
    })
    .catch(() => {
      process.send?.(
        { ok: false, decline: { code: 'VALIDATION_FAILED', reason: 'unreadable' } },
        () => process.exit(0),
      );
    });
});
