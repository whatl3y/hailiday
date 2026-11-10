import { DEFAULT_JUDGE_THRESHOLDS } from '@holiday/core';

/**
 * Version of the deterministic planning-and-compilation code as a whole (plan builder, validator
 * and per-provider compiler templates). Any change that alters a compiled request bumps it; the
 * provider name is appended so a provider switch also yields a new variant key.
 */
export const COMPILER_RELEASE = '2026.11.3';

/** The `compilerVersion` stamped on render jobs and plans for an image-edit provider. */
export function compilerVersionFor(provider: string): string {
  return `${COMPILER_RELEASE}-${provider}`;
}

/** Default pipeline thresholds and budgets (render spec; configuration). */
export const PIPELINE_DEFAULTS = {
  /** Per-call timeouts. */
  analysisTimeoutMs: 30_000,
  renderTimeoutMs: 120_000,
  judgeTimeoutMs: 30_000,
  escalationTimeoutMs: 45_000,
  /** Anchor eligibility floors. */
  anchorFloors: { minConfidence: 0.6, maxOcclusion: 0.3 },
  /** Judge decision thresholds. */
  judgeThresholds: { ...DEFAULT_JUDGE_THRESHOLDS },
  /**
   * Composite mask parameters as fractions of the long edge: boxes (wreaths, groups, surface
   * items) dilate by `dilationFraction`; band-shaped shapes (`along` placements: eave, rail and
   * frame bands, sloped gable bands, jambs, column wraps) by the smaller `bandDilationFraction`,
   * because their shapes already carry the drape and lights margins.
   */
  dilationFraction: 0.04,
  bandDilationFraction: 0.0125,
  featherFraction: 0.02,
  /**
   * Localized compositing (`source` mode): each decoration the vision model localized in the
   * aligned output is kept inside its box dilated by `localizedDilationFraction` of the long edge.
   * When the keep-mask would cover more than `localizedMaskCap` of the image before feathering,
   * localized boxes that are not planned items are dropped, largest first, until it does not.
   */
  localizedDilationFraction: 0.01,
  localizedMaskCap: 0.5,
  /**
   * A change the localizer reports outside the decorations reaches the judge as restored from
   * the original only when less than this share of its box lies inside the hard keep-mask;
   * otherwise it is named as an unrequested change inside the kept decorations.
   */
  restoredHintMaxKeptShare: 0.25,
  /** Timeout of the localization call (it sends two images). */
  localizationTimeoutMs: 45_000,
  /**
   * Photometric alignment before paste-back (`source` mode): the provider output's color and
   * brightness are matched to the working image over the unedited ring outside the composite
   * mask, `ringFraction` of the long edge wide. Skipped when the ring already agrees within
   * `toleranceDeltaE` (median ΔE76), so an output that kept the original tones is pasted as is.
   */
  photometric: { ringFraction: 0.03, toleranceDeltaE: 1 },
  /**
   * Compiled instruction caps per lighting mode, for every provider family. Both stay far below
   * the vendors' prompt limits (the OpenAI image edit endpoint accepts prompts up to 32,000
   * characters for its GPT image models) while leaving room for every planned placement of the
   * classic and abundant styles.
   */
  instructionCaps: { source: 4000, evening: 5000 },
  /** Deterministic check thresholds. */
  checks: {
    maxTranslationFraction: 0.003,
    driftTileSsim: 0.85,
    driftTileShare: 0.25,
    edgeF1: 0.85,
    edgeTolerancePx: 2,
    protectedSharpnessRatio: 1.2,
    /**
     * Laplacian variance (gray levels²) treated as noise before the sharpness ratio: rounding a
     * darkened image alone adds about 1, a re-encoded JPEG a few more.
     */
    protectedNoiseFloor: 4,
    /**
     * Evening: share of a people or blur box whose candidate gradients (exposure-compensated)
     * exceed `protectedEdgeGradient` where the working box had no edge within the tolerance.
     */
    protectedNewEdgeShare: 0.02,
    protectedEdgeGradient: 24,
    /**
     * Evening: the deepest strip a registration warp may leave uncovered (filled by reflecting
     * the output at its border), as a fraction of the long edge; deeper strips are
     * `camera_changed` (reason `uncovered`).
     */
    maxUncoveredInsetFraction: 0.01,
    seamDeltaE: 6,
    attributionSsim: 0.98,
    houseNumberSsim: 0.9,
  },
  /** Owner-blurred facade: share of the target facade covered by a whole-house blur region. */
  ownerBlurCoverage: 0.5,
  /** Delivered JPEG quality. */
  deliveredJpegQuality: 90,
  /** Hold window for uploads held for review. */
  uploadHoldWindowMs: 10 * 60_000,
  /** Reconciliation polling window for unknown attempt outcomes. */
  reconciliationWindowMs: 24 * 60 * 60_000,
} as const;

/** IPTC digital source type written on delivered files ("Edited using Generative AI"). */
export const IPTC_DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

/** `photoshop:Credit` written on delivered files. */
export const DELIVERED_CREDIT = 'AI preview by Holiday';
