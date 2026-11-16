import { DEFAULT_JUDGE_THRESHOLDS } from '@hailiday/core';

/**
 * Version of the deterministic planning-and-compilation code as a whole (plan builder, validator
 * and per-provider compiler templates). Any change that alters a compiled request bumps it; the
 * provider name is appended so a provider switch also yields a new variant key.
 */
export const COMPILER_RELEASE = '2026.11.10';

/** The `compilerVersion` stamped on render jobs and plans for an image-edit provider. */
export function compilerVersionFor(provider: string): string {
  return `${COMPILER_RELEASE}-${provider}`;
}

/** Default pipeline thresholds and budgets (render spec; configuration). */
export const PIPELINE_DEFAULTS = {
  /** Per-call timeouts. */
  analysisTimeoutMs: 30_000,
  renderTimeoutMs: 120_000,
  /**
   * A relight edit's timeout is the smaller of the render timeout and the job's time left minus
   * this guard, so a slow relight ends as an attempt timeout with time left to deliver the base.
   * The edit of a repair is bounded the same way while the job keeps the attempt it repairs as its
   * fallback picture.
   */
  relightDeadlineGuardMs: 15_000,
  /**
   * The shortest timeout a relight edit is given when the job is almost out of time; it applies
   * to an edit already sent (a recorded operation), since a new one is not sent with less than
   * `relightMinDispatchMs` left.
   */
  relightMinTimeoutMs: 1_000,
  /**
   * A relight edit not yet sent is sent only when the job's time left minus
   * `relightDeadlineGuardMs` is at least this (measured relight edits take 17 to 24 s); otherwise
   * the attempt is canceled unsent and the job falls back to its base as a relight timeout. A
   * bounded repair edit (see `relightDeadlineGuardMs`) is held to the same rule and falls back to
   * the attempt the job kept. A bounded edit that failed in a way the transport retries is sent
   * again only while this much is still left after the retry's delay; otherwise the attempt ends
   * with that failure, whatever the retry limit and delays.
   */
  relightMinDispatchMs: 20_000,
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
   * Text marks (house numbers, signs, logos) are restored from the original with a margin: each
   * box grows on every side by the larger of `textMarkMarginFraction` of the long edge and
   * `textMarkMarginShortSideShare` of the box's own short side (clamped to the frame), so a whole
   * plaque is pasted back even when the analysis box is a sliver of it.
   */
  textMarkMarginFraction: 0.01,
  textMarkMarginShortSideShare: 0.5,
  /**
   * Restore on repair: a finding of a restoring code (`text_added`, `people_altered`,
   * `privacy_regression`, `unrequested_change`, `structure_changed`) whose judge box covers at
   * most `restoreBoxMaxArea` of the frame is restored from the original on the repair attempt of
   * a decorate step: its box, grown by `restoreBoxGrowFraction` of the long edge on every side
   * (clamped to the frame), is excluded from the keep-mask whatever the editor draws there.
   */
  restoreBoxMaxArea: 0.03,
  restoreBoxGrowFraction: 0.01,
  /**
   * The job time a relit look needs left to repair an uncertain base and still relight it: one
   * more edit with its checks (45 to 75 s when the judge asks for a second opinion) and the
   * relight with its checks (about 45 s, and as much again when the relight is repaired). With
   * less, the base is relit as it is.
   */
  uncertainRepairWithRelightMs: 150_000,
  /**
   * Putting the judge's spots back from the original (`source` decorate attempts). A rejected
   * attempt with no repair after it whose critical findings each have a box (a confident major
   * with a box is put back too; one without is recorded) is composited again with those boxes
   * restored and goes on as a doubted look when at least `minKeptShare` of the decorations'
   * area lies outside the restored boxes, at least one planned placement keeps
   * `minPlacementShare` of its region, and the deterministic checks of the restored picture pass.
   * A doubted look that is delivered as it stands has the boxes of its doubts restored the same
   * way when that keeps at least `minKeptShareDoubt` of the decorations. The boxes are grown by
   * `growFraction` of the long edge on every side: wider than a repair's restore boxes
   * (`restoreBoxGrowFraction`), because no judge sees the restored picture and the judge's boxes
   * are given to two decimals.
   */
  lastResort: {
    growFraction: 0.03,
    minKeptShare: 0.4,
    minPlacementShare: 0.6,
    minKeptShareDoubt: 0.85,
  },
  /**
   * Protected boxes a decoration covers (`source` mode, after registration): the share of the
   * ring around a text mark or a restore box where the aligned output differs from the working
   * image by more than `changeLevel` (largest channel difference, sRGB levels) decides how the box
   * is composited. The output is first mapped through per-channel tone curves (each output level
   * to the median working level of the samples that have it, a level with at least
   * `minLevelSamples` samples; every `toneStride`-th pixel in x and y outside the edited area,
   * padding, attribution and the boxes being judged, or every pixel when fewer than
   * `minToneSamples` lie outside the edited area); then both images are box-blurred with a
   * window of `2 * blurPx + 1`, `blurPx = max(minBlurPx, round(blurFraction * long edge))`. A
   * text mark's ring lies between its analysis box and its grown box: under `cleanShare` the
   * grown box is pasted back, otherwise the analysis box, except that at or above `coveredShare`
   * with a decoration box holding at least `decoratedShare` of the mark's own box nothing is (a
   * decoration lies on the mark: the editor's pixels stay and the judge guards the text). A
   * decoration that only stands beside the mark leaves the analysis box pasted back. A restore box's ring is `restoreRingFraction` of the long edge (at least
   * `minRingPx`) around its grown box; at or above `coveredShare` it is not applied. A ring of
   * fewer than `minRingPixels` pixels measures 0.
   */
  protectedSurround: {
    changeLevel: 41,
    cleanShare: 0.05,
    coveredShare: 0.25,
    decoratedShare: 0.5,
    restoreRingFraction: 0.01,
    minRingPx: 4,
    minRingPixels: 16,
    toneStride: 4,
    blurFraction: 0.002,
    minBlurPx: 1,
    minLevelSamples: 12,
    minToneSamples: 2000,
  },
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
   * Compiled instruction caps of decorate requests (as photographed, or the legacy combined
   * evening plan), for every provider family. Both stay far below
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
  /**
   * Attribution rectangles in a relit image (`evening`, `bright`): the logo and copyright strokes
   * keep the base's own pixels and the ground behind them follows the new light. Pixel sizes are
   * fractions of the long edge with a floor, or pixels at a 1024 px long edge that scale with it
   * (areas with its square). The stroke rule's constants are validated at a 1024 px long edge
   * only (the Street View working frames); they have not been measured on real marks at other
   * sizes. Each mark has a place (the logo's fixed place, the inside of the label's dark box);
   * only components inside it that pass the stroke validation (contrast, thickness, one fill,
   * one line, one run) are strokes, and when something may be a stroke the rules did not keep,
   * or a look-alike lies beside the place, no stroke is found. A rectangle whose stroke share
   * (pixels kept above 0.5) is outside `[minShare, maxShare]` is restored verbatim from the base
   * instead.
   */
  attributionRelight: {
    /** Morphological opening radius (top-hat of the 3x3 mean luma). */
    radiusFraction: 0.006,
    minRadiusPx: 3,
    /** Top-hat response (luma 0 to 1) of a stroke pixel. */
    strokeThreshold: 0.14,
    /**
     * Largest chroma, (max - min of the base pixel's channels) / 255, of a stroke pixel. The logo
     * and copyright strokes are white or light grey (at most 0.19 measured on six live frames);
     * a saturated bright pixel (a yellow road marking, 0.28 and above) is ground.
     */
    maxStrokeChroma: 0.25,
    /** Smallest stroke component in pixels at a 1024 px long edge, and its floor. */
    minStrokeArea: 24,
    minStrokeAreaFloor: 6,
    /**
     * Largest stroke component in pixels at a 1024 px long edge (scales with the area). The
     * logo measured 765 to 1170 px as one component on ten recorded Street View frames.
     */
    maxStrokeArea: 1600,
    /**
     * The contrast of a set of pixels is its fill (90th percentile of the unblurred luma) minus
     * the median unblurred luma of its surround (the pixels within `surroundPx` at a 1024 px
     * long edge, Chebyshev, in the frame and not of strong top-hat response); a stroke needs at
     * least `max(minContrast, contrastOfFill * fill)`. The logo's outline and the label's box are
     * translucent (they pass about 0.40 and 0.30 of the ground behind them), so the surround of a
     * stroke stays under about half its fill on any ground: modelled marks measured 0.53 to 0.59
     * (logo) and 0.35 to 0.39 (copyright, contrast) over white ground, and the recorded frames
     * 0.61 to 0.96 and 0.42 to 0.55. Sunlit litter on mixed ground passes this often; the
     * thickness, line and all-or-nothing rules below handle it.
     */
    surroundPx: 2,
    minContrast: 0.34,
    contrastOfFill: 0.5,
    /**
     * Thickness: the side of the largest square of a set of pixels whose luma is at least
     * `thicknessLevel` of the way from its surround to its fill. Strokes measured at most 3 px
     * (logo and copyright, ten recorded frames at 1024; 4 px when the frame is overexposed) and
     * painted leaves, pebbles and lines 4 to 9 px. A candidate is at most `maxStrokeThickness`
     * (at a 1024 px long edge), a bright part at most the anchor's thickness plus
     * `thicknessAllowance`, and never more than `maxStrokeThickness`.
     */
    thicknessLevel: 0.7,
    maxStrokeThickness: 4,
    thicknessAllowance: 1,
    /**
     * One mark is one line of strokes of one brightness. A candidate is in a line when its fill
     * is within `max(fillTolerance, fillSpread * (1 - fill))` of the line's anchor (the logo's
     * opaque letters measured 0.975 to 1; the copyright's translucent glyphs vary with the ground
     * under the box by up to about 0.4 of the distance to white), its rows lie within the
     * anchor's rows grown by `lineSlack` of the anchor's height above and `lineSlackBelow` below
     * (at least 2 px; descenders), it is at least `minHeightShare` of the anchor's height tall
     * (a glyph is at least x-height tall; gravel bits beside the copyright measured 6 to 7 px of
     * a 17 to 18 px line), and it is reached from the anchor through such candidates with no
     * horizontal gap wider than `runGap` anchor heights (the copyright's glyph gaps measured 1
     * to 6 px). The run of the largest area is the mark and its largest member the anchor.
     */
    fillTolerance: 0.05,
    fillSpread: 0.4,
    lineSlack: 0.3,
    lineSlackBelow: 0.45,
    minHeightShare: 0.45,
    runGap: 1.5,
    /**
     * All or nothing: something rejected that may be a stroke of the mark makes the strokes not
     * found (share 0, so the rectangle is restored verbatim) rather than restored without it. It
     * is doubtful when its fill is within the fill tolerance plus `doubtfulFillMargin` of the
     * anchor's, it lies in the line and the run, it shares rows with a kept stroke and is not
     * above or below one (a stroke of the line is beside the others), and it is a bright part of
     * an accepted component, or a candidate the contrast rule rejected by less than a share
     * `1 - doubtfulContrastShare` of the contrast needed or the thickness rule at no more than
     * `doubtfulThicknessFactor` times `maxStrokeThickness` (a stroke blurred or overexposed grows
     * by a pixel; a leaf or pebble is a blob of 5 px or more), or the height or fill rule
     * rejected it. The same fill margin and contrast share apply to look-alikes beside the place
     * and to the logo's loose parts.
     */
    doubtfulFillMargin: 0.05,
    doubtfulContrastShare: 0.8,
    doubtfulThicknessFactor: 1.2,
    /**
     * The logo's place, as fractions of the frame: the letters' strong response on ten recorded
     * 640 x 640 Street View frames at 1024 (x 11 to 97, rows 992 down, with ground trapped to the
     * frame edge), with no margin beyond their soft edges (ground of the letters' brightness on
     * the owner's frame starts at x 98). A rectangle that holds it is the logo's.
     */
    logoPlace: [11 / 1024, 992 / 1024, 98 / 1024, 1],
    /**
     * A kept stroke cut by its place's edge: `placeCutPx` pixels of about the mark's fill outside
     * the place joined to it (none on the ten frames). The strokes stop short of a side of the
     * place by at most `markLeadPx` (the label's glyphs start 3 px inside its box, 4 on one frame,
     * and end 2 to 3 px short of the frame's edge; the logo's letters span their place). A loose
     * part counts from `looseMinPx` pixels.
     */
    placeCutPx: 4,
    markLeadPx: 4,
    looseMinPx: 4,
    /**
     * The label's dark box (it passes about 0.30 of the ground; its left edge is 3 px left of the
     * first glyph and its top 3 px above the glyphs on the ten frames). An edge's step is seen at
     * a pixel when the mean of the `boxBandPx` rows or columns inside it is at most `boxStepRatio`
     * of the brightest of the `boxOutsidePx` beyond a `boxGapPx` gap, which must reach
     * `boxMinGround`. The top edge is seen on `boxEdgeShare` of the box's columns (from the
     * `boxProbePx` at the frame's right edge first) and the left edge on `boxEdgeShare` of its
     * rows (0.78 to 1 at the ten frames' edges, 0.48 at most at any other column), on
     * `boxCornerShare` of the `boxCornerRows` rows under the top edge, with the top edge seen on
     * `boxCornerShare` of the `boxCornerPx` columns right of it (0.67 to 1 on the frames) and on
     * less than `boxInsideShare` of those left of it (0 to 0.09 on the frames). The inside starts
     * `boxInsetPx` within the edges (the glyphs start a pixel further in). Inside it, more than
     * `boxStrayPx` glyph-bright pixels that are no stroke (at most 1 on the frames), or a pixel
     * brighter than the anchor's fill by more than `boxPeakMargin` (at most 0.24 on the frames),
     * make the strokes not found; a stroke pixel lies next to one at least `labelGlyphShare` of
     * the anchor's fill.
     */
    boxBandPx: 3,
    boxOutsidePx: 4,
    boxGapPx: 1,
    boxCornerPx: 12,
    boxCornerRows: 3,
    boxCornerShare: 0.6,
    boxInsideShare: 0.4,
    boxProbePx: 48,
    boxStepRatio: 0.55,
    boxMinGround: 0.05,
    boxEdgeShare: 0.75,
    boxInsetPx: 2,
    boxStrayPx: 8,
    boxPeakMargin: 0.3,
    labelGlyphShare: 0.6,
    /**
     * The keep matte is also a smoothstep of the unblurred luma from the anchor's fill minus
     * `fillLow` to its fill minus `fillHigh`: ground merged into a stroke's component is darker
     * than the stroke and follows the relight. The pixels of the accepted components at or above
     * the fill minus `fillLow` form the bright parts, each of which must pass the area,
     * contrast and thickness rules on its own (bright ground joined through the logo's outline
     * measured 3, 12 and 48 px with contrasts of 0.31, 0.41 and 0.28 on recorded frames). In an
     * opaque mark (anchor fill at least `opaqueFill`: the logo's white letters measured 0.975 to
     * 1) a part must also have the anchor's fill; sunlit litter beside the logo measured 0.88 to
     * 0.92. The same level splits a component that is too large, crosses the rectangle or is
     * too thick.
     */
    fillLow: 0.38,
    fillHigh: 0.2,
    opaqueFill: 0.9,
    /** The keep matte: smoothstep of the unblurred top-hat between these values. */
    keepLow: 0.06,
    keepHigh: 0.18,
    minShare: 0.04,
    maxShare: 0.4,
    /** Width of the ring around a rectangle where the relight's per-channel gain is measured. */
    ringFraction: 0.03,
    minGain: 0.02,
    maxGain: 4,
    /** Inner-edge feather of the relit background into the candidate. */
    featherFraction: 0.004,
    minFeatherPx: 2,
    /**
     * A pixel whose keep matte is at least `solidKeep` is a solid stroke pixel: the restore copies
     * it from the base byte for byte. The deterministic check compares exactly these pixels: the
     * candidate's must equal the reference's (mean absolute difference over the channels at most
     * `maxMeanDifference`, and at least `minCloseShare` of them within `closeDifference` on every
     * channel, sRGB levels).
     */
    solidKeep: 0.9,
    maxMeanDifference: 2,
    closeDifference: 6,
    minCloseShare: 0.98,
  },
  /** Owner-blurred facade: share of the target facade covered by a whole-house blur region. */
  ownerBlurCoverage: 0.5,
  /**
   * The bright look: a photo whose median luma (Rec. 709 weights on the encoded values) over its
   * content area, padding excluded, is at or above this is already bright and is not relit; its
   * decoration as photographed is the bright result. Measured on the sample photos: living room
   * 0.74 and dining room 0.63 are bright, the apartment hallway 0.47 and the kitchen 0.57 are dim.
   */
  brightMedianLuma: 0.6,
  /** Delivered JPEG quality. */
  deliveredJpegQuality: 90,
  /** Hold window for uploads held for review. */
  uploadHoldWindowMs: 10 * 60_000,
  /** Reconciliation polling window for unknown attempt outcomes. */
  reconciliationWindowMs: 24 * 60 * 60_000,
  /**
   * The Street View enhancement: the stored frame redrawn sharper and cleaner by the image editor
   * before it is decorated, checked and judged, and used in place of the frame when accepted.
   */
  enhance: {
    /**
     * Timeout of the enhance edit. Measured edits took 19.1, 19.3 and 20.6 s at medium quality
     * (three live frames); twice that with a margin, well under the render timeout, which would
     * use up the job.
     */
    editTimeoutMs: 45_000,
    /**
     * The enhancement starts only with at least this much of the job's time left: about 30 s for
     * itself and room for an evening look that needs its repair (a decorate edit, a repair and
     * the relight, each with its checks: about 140 s). With less, the look comes first and a
     * later job of the address sharpens the frame.
     */
    minJobTimeLeftMs: 170_000,
    /**
     * Edits per (source, frame, release): one decided edit, and one more by a later job when the
     * first ended without a decision (cancel, deadline, provider error, judge unavailable).
     */
    maxEdits: 2,
    /** How long a job waits for another job's pending enhancement before it goes on with the frame. */
    pendingWaitMs: 10_000,
    pendingPollMs: 500,
    /**
     * Protected boxes (people, blurred areas, house numbers, signs, logos) take the frame's
     * pixels back, dilated and feathered by these fractions of the long edge (6 px each at 1024),
     * outside the box.
     */
    protectDilationFraction: 0.006,
    protectFeatherFraction: 0.006,
    /** The ring around a protected box where the frame's tone is matched to the enhanced picture. */
    protectRingFraction: 0.03,
    /**
     * Above this share of protected boxes the result would be a patchwork of soft rectangles; it
     * is decided before the edit. Measured coverage on three live frames: 0 to 0.031.
     */
    maxProtectedCoverage: 0.35,
    /**
     * Structure check: Pearson correlation of the box-averaged luma of the frame and the
     * enhanced picture per tile. The frame's real detail is at 1.6 px and above (640 upscaled to
     * 1024), so a `downscale` box average removes the texture an enhancement adds; tiles are
     * `tileFraction` of the long edge (128 px at 1024) with a stride of half a tile; a tile whose
     * frame luma varies less than `minTileStdDev` (sky, plain wall) carries no structure. Lowest
     * tile on three good enhancements 0.569, 0.715 and 0.869; a replaced porch 0.089 and replaced
     * dormers -0.029.
     */
    structure: {
      downscale: 4,
      tileFraction: 0.125,
      minTileStdDev: 12,
      minTileCorrelation: 0.35,
    },
    /**
     * Rows of another compiler version are removed this long after their last write, so a job in
     * flight across a deploy keeps its picture.
     */
    supersededAfterMs: 24 * 60 * 60_000,
  },
  /**
   * Framing a Street View source on its home at its next look while no framing is recorded: the
   * vision model boxes the home in the fetched frame and the frame is fetched again from the same panorama at the view that
   * fills the picture with it.
   */
  framing: {
    /** Share of the frame left free on each side of the home's larger angular extent. */
    marginFraction: 0.08,
    /** The narrowest field of view: 640 px at 20 degrees is about the panorama's own resolution. */
    minFovDeg: 20,
    /** A smaller gain over the candidate's view keeps the wide frame (`small_gain`). */
    minZoom: 1.15,
    /** Share of the vertical room the home leaves that lies under it (the ground before it). */
    slackBelowShare: 0.6,
    /** A home located with less confidence keeps the wide frame (`ambiguous`). */
    minConfidence: 0.5,
    /** Timeout of the locate call. */
    locateTimeoutMs: 20_000,
  },
} as const;

/** IPTC digital source type written on delivered files ("Edited using Generative AI"). */
export const IPTC_DIGITAL_SOURCE_TYPE =
  'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia';

/** `photoshop:Credit` written on delivered files. */
export const DELIVERED_CREDIT = 'AI preview by Hailiday';
