import type { DetectedFormat } from '@hailiday/core';

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/**
 * Determines the format from magic bytes (uploads spec, format contract). The declared type and
 * the file extension are never consulted.
 */
export function sniffFormat(bytes: Uint8Array): DetectedFormat {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 3) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return 'webp';
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') {
    const brands = [ascii(bytes, 8, 4)];
    const boxSize = (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
    for (let offset = 16; offset + 4 <= Math.min(boxSize, bytes.length, 64); offset += 4) {
      brands.push(ascii(bytes, offset, 4));
    }
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'avif';
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return 'heic';
    return 'unknown';
  }
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'GIF8') return 'gif';
  if (
    bytes.length >= 4 &&
    ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
      (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a))
  ) {
    return 'tiff';
  }
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return 'bmp';
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === '%PDF') return 'pdf';
  const head = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, 256))
    .replace(/^\uFEFF/, '')
    .trimStart();
  if (head.startsWith('<')) return 'svg';
  return 'unknown';
}

/** Formats the server accepts. */
export const ACCEPTED_FORMATS: readonly DetectedFormat[] = ['jpeg', 'png', 'webp'];
