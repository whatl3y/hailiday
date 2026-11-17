import { z } from 'zod';

/** The kind of a source asset. */
export const SOURCE_KINDS = ['street_view', 'upload', 'fixture'] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/** Where a source asset is in admission and retention. */
export const SOURCE_ASSET_STATES = [
  'pending_upload',
  'quarantined',
  'screening',
  'ready',
  'declined',
  'failed',
  'stale',
  'expired',
  'deleted',
] as const;
export const SourceAssetStateSchema = z.enum(SOURCE_ASSET_STATES);
export type SourceAssetState = z.infer<typeof SourceAssetStateSchema>;

/** Allowed source asset state transitions. */
export const SOURCE_ASSET_TRANSITIONS: Readonly<
  Record<SourceAssetState, readonly SourceAssetState[]>
> = {
  pending_upload: ['quarantined', 'expired', 'deleted'],
  quarantined: ['screening', 'failed', 'deleted'],
  screening: ['ready', 'declined', 'failed', 'deleted'],
  ready: ['declined', 'stale', 'expired', 'deleted'],
  declined: ['deleted'],
  failed: ['deleted'],
  stale: ['deleted'],
  expired: ['deleted'],
  deleted: [],
};

export function canTransitionSourceAsset(from: SourceAssetState, to: SourceAssetState): boolean {
  return SOURCE_ASSET_TRANSITIONS[from].includes(to);
}

/** How Street View imagery may be used, derived from the evaluated AssetPermission. */
export const STREET_VIEW_SOURCE_MODES = [
  'persist',
  'transient',
  'display_only',
  'unavailable',
] as const;
export const StreetViewSourceModeSchema = z.enum(STREET_VIEW_SOURCE_MODES);
export type StreetViewSourceMode = z.infer<typeof StreetViewSourceModeSchema>;

/** Outcome class of source discovery. */
export const MATCH_CLASSES = ['auto_start', 'confirm', 'skip_to_upload'] as const;
export const MatchClassSchema = z.enum(MATCH_CLASSES);
export type MatchClass = z.infer<typeof MatchClassSchema>;

/**
 * Stored `skip_to_upload` reasons, in the precedence order used when several red signals
 * apply at once.
 */
export const SKIP_REASONS = [
  'out_of_scope',
  'blocked_address',
  'multi_unit',
  'low_precision',
  'no_imagery',
  'error',
] as const;
export const SkipReasonSchema = z.enum(SKIP_REASONS);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

/**
 * `skip_to_upload` reasons as a client sees them: `blocked_address` is projected to
 * `unavailable`, a value that exists only in this projection.
 */
export const CLIENT_SKIP_REASONS = [
  'out_of_scope',
  'unavailable',
  'multi_unit',
  'low_precision',
  'no_imagery',
  'error',
] as const;
export const ClientSkipReasonSchema = z.enum(CLIENT_SKIP_REASONS);
export type ClientSkipReason = z.infer<typeof ClientSkipReasonSchema>;

/** Projects a stored discovery reason to the value a client may see. */
export function projectSkipReason(reason: SkipReason): ClientSkipReason;
export function projectSkipReason(reason: SkipReason | null): ClientSkipReason | null;
export function projectSkipReason(reason: SkipReason | null): ClientSkipReason | null {
  if (reason === null) return null;
  return reason === 'blocked_address' ? 'unavailable' : reason;
}

/** The first reason by precedence among several red signals. */
export function firstSkipReason(reasons: Iterable<SkipReason>): SkipReason | null {
  const present = new Set(reasons);
  return SKIP_REASONS.find((reason) => present.has(reason)) ?? null;
}

/** What the client does after discovery. */
export const DISCOVERY_NEXT_ACTIONS = ['render', 'confirm_place', 'upload_photo'] as const;
export const DiscoveryNextActionSchema = z.enum(DISCOVERY_NEXT_ACTIONS);
export type DiscoveryNextAction = z.infer<typeof DiscoveryNextActionSchema>;

/**
 * What a candidate's explicit heading was aimed at: `geometry` the building geometry target;
 * `point` the resolved point; `road` the target lies on the road, the view looks across or along
 * it and its centre is not aimed at the home.
 */
export const HEADING_MODES = ['geometry', 'point', 'road'] as const;
export const HeadingModeSchema = z.enum(HEADING_MODES);
export type HeadingMode = z.infer<typeof HeadingModeSchema>;

/** Street View capture date granularity. */
export const CAPTURE_GRANULARITIES = ['month', 'year', 'none'] as const;
export const CaptureGranularitySchema = z.enum(CAPTURE_GRANULARITIES);
export type CaptureGranularity = z.infer<typeof CaptureGranularitySchema>;

/** Flags recorded per candidate viewpoint. */
export const CANDIDATE_FLAGS = [
  'deepSetback',
  'contributorImagery',
  'undated',
  'farFromTarget',
  'headingDivergence',
  'attachedFacade',
] as const;
export const CandidateFlagSchema = z.enum(CANDIDATE_FLAGS);
export type CandidateFlag = z.infer<typeof CandidateFlagSchema>;

/** Imagery copyright class recorded on discovery. */
export const COPYRIGHT_CLASSES = ['google', 'contributor', 'unknown'] as const;
export const CopyrightClassSchema = z.enum(COPYRIGHT_CLASSES);
export type CopyrightClass = z.infer<typeof CopyrightClassSchema>;

/** Property precision class. */
export const PRECISIONS = ['rooftop_equivalent', 'interpolated', 'low'] as const;
export const PrecisionSchema = z.enum(PRECISIONS);
export type Precision = z.infer<typeof PrecisionSchema>;

/** Where the precision class came from. */
export const PRECISION_SOURCES = ['geocoding', 'search_destinations', 'places_types'] as const;
export const PrecisionSourceSchema = z.enum(PRECISION_SOURCES);
export type PrecisionSource = z.infer<typeof PrecisionSourceSchema>;

/** How an address was entered. */
export const ENTRY_METHODS = ['autocomplete', 'manual'] as const;
export const EntryMethodSchema = z.enum(ENTRY_METHODS);
export type EntryMethod = z.infer<typeof EntryMethodSchema>;

/** Basis of a stored display address. */
export const DISPLAY_ADDRESS_BASES = [
  'manual_entry',
  'autocomplete_transient',
  'geocoding_place_id',
] as const;
export const DisplayAddressBasisSchema = z.enum(DISPLAY_ADDRESS_BASES);
export type DisplayAddressBasis = z.infer<typeof DisplayAddressBasisSchema>;

/** Where stored target coordinates came from. */
export const COORDS_SOURCES = ['places', 'geocoding'] as const;
export const CoordsSourceSchema = z.enum(COORDS_SOURCES);
export type CoordsSource = z.infer<typeof CoordsSourceSchema>;

/** Project kinds. */
export const PROJECT_KINDS = ['address', 'upload'] as const;
export const ProjectKindSchema = z.enum(PROJECT_KINDS);
export type ProjectKind = z.infer<typeof ProjectKindSchema>;

/** Content types the upload path accepts. */
export const UPLOAD_ACCEPTED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const UploadContentTypeSchema = z.enum(UPLOAD_ACCEPTED_CONTENT_TYPES);
export type UploadContentType = z.infer<typeof UploadContentTypeSchema>;

/** Formats detected by magic bytes at upload validation. */
export const DETECTED_FORMATS = [
  'jpeg',
  'png',
  'webp',
  'heic',
  'avif',
  'gif',
  'tiff',
  'bmp',
  'svg',
  'pdf',
  'unknown',
] as const;
export const DetectedFormatSchema = z.enum(DETECTED_FORMATS);
export type DetectedFormat = z.infer<typeof DetectedFormatSchema>;

/** Non-blocking photo quality hints. */
export const QUALITY_HINTS = [
  'blurry',
  'dark',
  'too_close',
  'heavy_occlusion',
  'cluttered',
  'screenshot',
] as const;
export const QualityHintSchema = z.enum(QUALITY_HINTS);
export type QualityHint = z.infer<typeof QualityHintSchema>;

/** How a people detection was resolved on an upload. */
export const PEOPLE_RESOLUTIONS = ['none', 'cropped', 'kept'] as const;
export const PeopleResolutionSchema = z.enum(PEOPLE_RESOLUTIONS);
export type PeopleResolution = z.infer<typeof PeopleResolutionSchema>;

/** Actions a client may send to resolve `PEOPLE_DETECTED`. */
export const PEOPLE_RESOLUTION_ACTIONS = ['crop', 'keep'] as const;
export const PeopleResolutionActionSchema = z.enum(PEOPLE_RESOLUTION_ACTIONS);
export type PeopleResolutionAction = z.infer<typeof PeopleResolutionActionSchema>;

/** Content admission outcome. */
export const SCREENING_OUTCOMES = ['admitted', 'declined', 'held'] as const;
export const ScreeningOutcomeSchema = z.enum(SCREENING_OUTCOMES);
export type ScreeningOutcome = z.infer<typeof ScreeningOutcomeSchema>;

/** Upload decline classes. */
export const UPLOAD_DECLINE_REASON_CLASSES = ['guidance', 'safety'] as const;
export const UploadDeclineReasonClassSchema = z.enum(UPLOAD_DECLINE_REASON_CLASSES);
export type UploadDeclineReasonClass = z.infer<typeof UploadDeclineReasonClassSchema>;

/** Decline reasons shown to the user. */
export const UPLOAD_GUIDANCE_REASONS = [
  'unsupported_format',
  'animated',
  'file_too_large',
  'too_many_pixels',
  'image_too_small',
  'unreadable',
  'not_a_living_space',
  'subject_is_people',
  'document_or_screen',
  'multi_unit_facade',
] as const;
export const UploadGuidanceReasonSchema = z.enum(UPLOAD_GUIDANCE_REASONS);
export type UploadGuidanceReason = z.infer<typeof UploadGuidanceReasonSchema>;

/** Decline reasons recorded internally only; the user sees neutral copy. */
export const UPLOAD_SAFETY_REASONS = [
  'hash_match',
  'classifier',
  'child_safety',
  'provider_refused',
  'review_declined',
  'hold_timeout',
  'checksum_blocklisted',
] as const;
export const UploadSafetyReasonSchema = z.enum(UPLOAD_SAFETY_REASONS);
export type UploadSafetyReason = z.infer<typeof UploadSafetyReasonSchema>;

export const UPLOAD_DECLINE_REASONS = [
  ...UPLOAD_GUIDANCE_REASONS,
  ...UPLOAD_SAFETY_REASONS,
] as const;
export const UploadDeclineReasonSchema = z.enum(UPLOAD_DECLINE_REASONS);
export type UploadDeclineReason = z.infer<typeof UploadDeclineReasonSchema>;

/** Error codes a declined upload carries. */
export const UPLOAD_DECLINE_CODES = [
  'UPLOAD_DECLINED',
  'UPLOAD_UNSUPPORTED_FORMAT',
  'UPLOAD_TOO_LARGE',
  'VALIDATION_FAILED',
] as const;
export const UploadDeclineCodeSchema = z.enum(UPLOAD_DECLINE_CODES);
export type UploadDeclineCode = z.infer<typeof UploadDeclineCodeSchema>;

/** Subject classes returned by upload triage. */
export const UPLOAD_SUBJECT_CLASSES = [
  'living_space',
  'people',
  'document_or_screen',
  'other',
] as const;
export const UploadSubjectClassSchema = z.enum(UPLOAD_SUBJECT_CLASSES);
export type UploadSubjectClass = z.infer<typeof UploadSubjectClassSchema>;

/** Season cues returned by upload triage. */
export const UPLOAD_SEASON_CUES = ['snow_visible', 'bare_trees', 'leafy', 'unknown'] as const;
export const UploadSeasonCueSchema = z.enum(UPLOAD_SEASON_CUES);
export type UploadSeasonCue = z.infer<typeof UploadSeasonCueSchema>;

/** Where an upload was captured, reported by the client. */
export const CAPTURE_METHODS = ['camera', 'library', 'desktop'] as const;
export const CaptureMethodSchema = z.enum(CAPTURE_METHODS);
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>;
