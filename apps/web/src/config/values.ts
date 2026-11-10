/**
 * Display values for copy placeholders that come from configuration owned by other
 * specifications (retention schedule, upload limits, sharing). They are shown to people and
 * kept here in one place so a configuration change touches a single module.
 */
export const DISPLAY_VALUES = {
  anonymousRetention: '24 hours',
  savedRetention: '13 months',
  linkLifetime: '15 minutes',
  shareLifetime: '30 days',
  holdWindow: '10 minutes',
  reportAckTarget: '1 business day',
  formats: 'JPEG, PNG or WebP',
} as const;

/** Behavior defaults used when the experience payload is not available yet. */
export const CLIENT_DEFAULTS = {
  autocompleteMinChars: 3,
  autocompleteDebounceMs: 250,
  uploadMaxBytes: 26_214_400,
  pollRenderMs: 3000,
  pollUploadMs: 2000,
  /** The render poll backs off to this interval after `pollBackoffAfterMs`. */
  pollRenderBackoffMs: 5000,
  pollBackoffAfterMs: 60_000,
  /** Waiting longer than this shows the long-wait line. */
  longWaitMs: 90_000,
  /** Street View captures older than this many years show the "looks different" line. */
  oldCaptureYears: 5,
  minShortEdgePx: 640,
  maxLongEdgePx: 2048,
  jpegQuality: 0.9,
  attestationVersion: 'upload-attestation-2026-11b',
  analyticsFlushMs: 5000,
  analyticsMaxBatch: 20,
} as const;

export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Math.round(mb)} MB`;
}
