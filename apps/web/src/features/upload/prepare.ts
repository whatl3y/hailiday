import { UPLOAD_ACCEPTED_CONTENT_TYPES } from '@hailiday/core';
import { CLIENT_DEFAULTS } from '../../config/values';

/**
 * The file inputs' accept list. JPEG must stay first and HEIC must not be listed: iOS Safari
 * transcodes HEIC to the first listed type, and listing HEIC makes it pass HEIC through.
 */
export const ACCEPT_ATTRIBUTE = UPLOAD_ACCEPTED_CONTENT_TYPES.join(',');

export interface PreparedImage {
  ok: true;
  blob: Blob;
  contentType: string;
  width: number | null;
  height: number | null;
  /** Whether the browser decoded and re-encoded the file (otherwise the original is sent). */
  clientPrepared: boolean;
}

export type PrepareFailureReason =
  'too_large' | 'image_too_small' | 'heic_unsupported' | 'unsupported_format';

export interface PrepareFailure {
  ok: false;
  reason: PrepareFailureReason;
}

export type PrepareResult = PreparedImage | PrepareFailure;

export interface DecodedBitmap {
  width: number;
  height: number;
  close(): void;
}

export interface PrepareDeps {
  decode: (
    source: Blob | DecodedBitmap,
    options: {
      imageOrientation: 'from-image';
      resizeWidth?: number;
      resizeHeight?: number;
      resizeQuality?: 'high';
    },
  ) => Promise<DecodedBitmap>;
  encode: (bitmap: DecodedBitmap, width: number, height: number, quality: number) => Promise<Blob>;
}

export interface PrepareOptions {
  maxBytes?: number;
  maxLongEdge?: number;
  minShortEdge?: number;
  quality?: number;
  acceptedTypes?: readonly string[];
}

/** Target size with the long edge at most `maxLongEdge`, keeping the aspect ratio, never enlarging. */
export function targetSize(
  width: number,
  height: number,
  maxLongEdge: number = CLIENT_DEFAULTS.maxLongEdgePx,
) {
  const longEdge = Math.max(width, height);
  if (longEdge <= maxLongEdge) return { width, height, resized: false };
  const scale = maxLongEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
  };
}

/** HEIC and HEIF are recognized by type or extension; both are hints only. */
export function isHeicLike(file: Pick<File, 'type' | 'name'>): boolean {
  const type = file.type.toLowerCase();
  if (
    type === 'image/heic' ||
    type === 'image/heif' ||
    type.startsWith('image/heic-') ||
    type.startsWith('image/heif-')
  ) {
    return true;
  }
  return /\.(heic|heif)$/i.test(file.name);
}

/**
 * Prepares a photo in the browser: refuses files over the size cap, decodes with the EXIF
 * orientation applied, refuses images whose short edge is below the minimum, and re-encodes
 * to JPEG with the long edge at most 2,048 px (which also strips metadata such as GPS). When
 * the browser cannot decode the file, a HEIC file gets a specific refusal and other accepted
 * types are sent as they are for the server to decide.
 */
export async function prepareImage(
  file: File,
  deps: PrepareDeps,
  options: PrepareOptions = {},
): Promise<PrepareResult> {
  const maxBytes = options.maxBytes ?? CLIENT_DEFAULTS.uploadMaxBytes;
  const maxLongEdge = options.maxLongEdge ?? CLIENT_DEFAULTS.maxLongEdgePx;
  const minShortEdge = options.minShortEdge ?? CLIENT_DEFAULTS.minShortEdgePx;
  const quality = options.quality ?? CLIENT_DEFAULTS.jpegQuality;
  const accepted: readonly string[] = options.acceptedTypes ?? UPLOAD_ACCEPTED_CONTENT_TYPES;

  if (file.size > maxBytes) return { ok: false, reason: 'too_large' };

  let decoded: DecodedBitmap;
  try {
    decoded = await deps.decode(file, { imageOrientation: 'from-image' });
  } catch {
    if (isHeicLike(file)) return { ok: false, reason: 'heic_unsupported' };
    if (accepted.includes(file.type)) {
      return {
        ok: true,
        blob: file,
        contentType: file.type,
        width: null,
        height: null,
        clientPrepared: false,
      };
    }
    return { ok: false, reason: 'unsupported_format' };
  }

  try {
    if (Math.min(decoded.width, decoded.height) < minShortEdge) {
      return { ok: false, reason: 'image_too_small' };
    }
    const size = targetSize(decoded.width, decoded.height, maxLongEdge);
    let bitmap = decoded;
    if (size.resized) {
      bitmap = await deps.decode(decoded, {
        imageOrientation: 'from-image',
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: 'high',
      });
    }
    try {
      const blob = await deps.encode(bitmap, size.width, size.height, quality);
      return {
        ok: true,
        blob,
        contentType: 'image/jpeg',
        width: size.width,
        height: size.height,
        clientPrepared: true,
      };
    } finally {
      if (bitmap !== decoded) bitmap.close();
    }
  } catch {
    if (accepted.includes(file.type)) {
      return {
        ok: true,
        blob: file,
        contentType: file.type,
        width: null,
        height: null,
        clientPrepared: false,
      };
    }
    return { ok: false, reason: isHeicLike(file) ? 'heic_unsupported' : 'unsupported_format' };
  } finally {
    decoded.close();
  }
}

/** Browser implementations: `createImageBitmap` and an sRGB canvas encoding to JPEG. */
export const browserPrepareDeps: PrepareDeps = {
  decode: (source, options) => createImageBitmap(source as ImageBitmapSource, options),
  async encode(bitmap, width, height, quality) {
    const image = bitmap as unknown as CanvasImageSource;
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!context) throw new Error('canvas');
      context.drawImage(image, 0, 0, width, height);
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { colorSpace: 'srgb' });
    if (!context) throw new Error('canvas');
    context.drawImage(image, 0, 0, width, height);
    return new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('encode'))),
        'image/jpeg',
        quality,
      ),
    );
  },
};
