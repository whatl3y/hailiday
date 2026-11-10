import { sha256Hex } from '../ids/index.js';

/**
 * Object key builders. Keys hold only opaque identifiers (UUIDs, random tokens, content hashes):
 * never an address, place ID, panorama ID, email, file name or other user-supplied text.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HASH_PATTERN = /^[0-9a-f]{16,128}$/;

export const PRIVATE_PREFIXES = {
  quarantine: 'quarantine/',
  originals: 'originals/',
  working: 'working/',
  attempts: 'attempts/',
  outputs: 'outputs/',
  downloads: 'downloads/',
  held: 'held/',
  tombstones: 'tombstones/',
  reviews: 'reviews/',
} as const;

export const PUBLIC_PREFIXES = {
  hero: 'hero/',
  examples: 'examples/',
  shared: 'shared/',
  cards: 'cards/',
} as const;

export class UnsafeKeyError extends Error {
  constructor(part: string, value: string) {
    super(`Unsafe object key ${part}: ${value.length > 24 ? `${value.slice(0, 24)}…` : value}`);
    this.name = 'UnsafeKeyError';
  }
}

function uuid(part: string, value: string): string {
  if (!UUID_PATTERN.test(value)) throw new UnsafeKeyError(part, value);
  return value;
}

function token(part: string, value: string): string {
  if (!TOKEN_PATTERN.test(value)) throw new UnsafeKeyError(part, value);
  return value;
}

function name(part: string, value: string): string {
  if (!NAME_PATTERN.test(value)) throw new UnsafeKeyError(part, value);
  return value;
}

function hash(part: string, value: string): string {
  if (!HASH_PATTERN.test(value)) throw new UnsafeKeyError(part, value);
  return value;
}

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'svg'] as const;
export type ImageExtension = (typeof IMAGE_EXTENSIONS)[number];

function extension(value: string): ImageExtension {
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(value)) {
    throw new UnsafeKeyError('extension', value);
  }
  return value as ImageExtension;
}

export const keys = {
  /** Client bytes exactly as uploaded; deleted at promotion. */
  quarantine: (sourceAssetId: string) =>
    `${PRIVATE_PREFIXES.quarantine}${uuid('sourceAssetId', sourceAssetId)}`,
  /** The normalized original of an upload (or the stand-in of a fixture source). */
  original: (ownerId: string, sourceAssetId: string) =>
    `${PRIVATE_PREFIXES.originals}${uuid('ownerId', ownerId)}/${uuid('sourceAssetId', sourceAssetId)}`,
  workingPrefix: (renderJobId: string) =>
    `${PRIVATE_PREFIXES.working}${uuid('renderJobId', renderJobId)}/`,
  /** Provider-sized input and masks for one job, for example `working.jpg` or `mask.png`. */
  working: (renderJobId: string, fileName: string) =>
    `${keys.workingPrefix(renderJobId)}${name('fileName', fileName)}`,
  attemptPrefix: (renderJobId: string, attemptId: string) =>
    `${PRIVATE_PREFIXES.attempts}${uuid('renderJobId', renderJobId)}/${uuid('attemptId', attemptId)}/`,
  /** Raw or composited candidate of one attempt, for example `raw.png` or `composited.jpg`. */
  attempt: (renderJobId: string, attemptId: string, fileName: string) =>
    `${keys.attemptPrefix(renderJobId, attemptId)}${name('fileName', fileName)}`,
  outputPrefix: (ownerId: string, renderAssetId: string) =>
    `${PRIVATE_PREFIXES.outputs}${uuid('ownerId', ownerId)}/${uuid('renderAssetId', renderAssetId)}/`,
  /** Accepted variant and its display derivatives, for example `full.jpg` or `w1024.webp`. */
  output: (ownerId: string, renderAssetId: string, fileName: string) =>
    `${keys.outputPrefix(ownerId, renderAssetId)}${name('fileName', fileName)}`,
  /** The labeled download file of a downloadable variant. */
  download: (ownerId: string, renderAssetId: string) =>
    `${PRIVATE_PREFIXES.downloads}${uuid('ownerId', ownerId)}/${uuid('renderAssetId', renderAssetId)}`,
  /** Reduced-size copy of an upload held for review, the only image reviewers are shown. */
  review: (sourceAssetId: string) =>
    `${PRIVATE_PREFIXES.reviews}${uuid('sourceAssetId', sourceAssetId)}.jpg`,
  /** An object moved under a preservation hold; the original key is kept only as a hash. */
  held: (holdId: string, originalKey: string) =>
    `${PRIVATE_PREFIXES.held}${uuid('holdId', holdId)}/${sha256Hex(originalKey)}`,
  /**
   * One append-only batch of the tombstone mirror, grouped by UTC day (`YYYY-MM-DD`). Each batch is
   * its own object, so concurrent writers never read-modify-write a shared file.
   */
  tombstoneLog: (day: string, batchId: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UnsafeKeyError('day', day);
    return `${PRIVATE_PREFIXES.tombstones}${day}/${uuid('batchId', batchId)}.jsonl`;
  },

  /** Hero art per responsive crop; `variant` carries the width and content hash. */
  hero: (heroAssetId: string, crop: string, variant: string, ext: string) =>
    `${PUBLIC_PREFIXES.hero}${uuid('heroAssetId', heroAssetId)}/${name('crop', crop)}-${name('variant', variant)}.${extension(ext)}`,
  /** One image of a permissioned example pair. */
  example: (exampleAssetId: string, which: 'before' | 'after', ext: string) =>
    `${PUBLIC_PREFIXES.examples}${uuid('exampleAssetId', exampleAssetId)}/${which}.${extension(ext)}`,
  sharedPrefix: (shareToken: string) =>
    `${PUBLIC_PREFIXES.shared}${token('shareToken', shareToken)}/`,
  /** Copy of the shared derivative made when a grant is created. */
  shared: (shareToken: string, which: 'before' | 'after') =>
    `${keys.sharedPrefix(shareToken)}${which}.jpg`,
  /** 1200×630 share card. */
  card: (shareToken: string) => `${PUBLIC_PREFIXES.cards}${token('shareToken', shareToken)}.jpg`,
} as const;

/** Short content hash used in immutable public keys. */
export function contentHash(bytes: Uint8Array, length = 16): string {
  return hash('contentHash', sha256Hex(bytes).slice(0, length));
}

/** Whether a key lives under a prefix that must never be swept or served (`held/`). */
export function isHeldKey(key: string): boolean {
  return key.startsWith(PRIVATE_PREFIXES.held);
}
