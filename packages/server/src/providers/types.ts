import type {
  AddressSuggestion,
  BuildingForm,
  CaptureGranularity,
  CandidateFlag,
  CompiledRequest,
  DecorationPlan,
  GeocodeCandidate,
  GeocodeRequest,
  HeadingMode,
  HolidayId,
  JudgeResult,
  LightingMode,
  NormalizedBox,
  Precision,
  QualityHint,
  RoomType,
  SceneAnalysis,
  SceneType,
  SourceKind,
  Style,
  UploadDeclineReason,
  UploadDeclineReasonClass,
  UploadTriage,
} from '@hailiday/core';
import type { FixturePlacement } from '../fixtures/decor.js';
import type { RenderScenario } from '../fixtures/data.js';
import type { LatLng } from './geo.js';

/** Whether an implementation is a fixture or calls a live vendor. */
export type ProviderImplementationMode = 'fixture' | 'live';

/** Per-call options shared by every provider method. */
export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Fixture-only hints carried alongside a request. Live implementations ignore them; fixture
 * implementations use them to reproduce the testability scenarios (render scenario, exact
 * scene geometry, upload file name).
 */
export interface FixtureHint {
  scenario?: RenderScenario;
  scene?: FixtureSceneRef;
  /** Original upload file name (screening and render triggers). */
  fileName?: string | null;
}

export type FixtureSceneRef =
  | { kind: 'street_view'; panoId: string; heading: number; fov: number; pitch: number }
  | { kind: 'generic_scene'; sceneId: string }
  | { kind: 'upload' };

// ---- address ---------------------------------------------------------------------------------

export interface AddressComponent {
  longText: string;
  shortText: string;
  types: string[];
}

/** Place Details (New) Essentials result. */
export interface ResolvedPlace {
  placeId: string;
  formattedAddress: string;
  addressComponents: AddressComponent[];
  countryCode: string | null;
  location: LatLng;
  viewport: { low: LatLng; high: LatLng } | null;
  types: string[];
}

export type GeocodeLocationType =
  'ROOFTOP' | 'RANGE_INTERPOLATED' | 'GEOMETRIC_CENTER' | 'APPROXIMATE';

/** Geocoding API result signals (by place ID or forward geocode). */
export interface GeocodeSignal {
  placeId: string;
  formattedAddress: string;
  addressComponents: AddressComponent[];
  countryCode: string | null;
  location: LatLng;
  locationType: GeocodeLocationType;
  partialMatch: boolean;
  types: string[];
}

/** Geocoding v4 SearchDestinations derived geometry (the polygon itself is never kept). */
export interface DestinationGeometry {
  structureType: 'BUILDING' | 'GROUNDS' | null;
  hasOutline: boolean;
  targetPoint: LatLng | null;
  facadeWidthM: number | null;
  roadBearingDeg: number | null;
  facadeNormalDeg: number | null;
  entranceOffsetM: number | null;
  attachedFacade: boolean;
}

/** What a signed manual-entry candidate token carries. */
export interface GeocodeCandidatePayload {
  placeId: string;
  formattedAddress: string;
  precision: Precision;
  partialMatch: boolean;
  multiUnit: boolean;
  locationType: GeocodeLocationType;
  location: LatLng;
  types: string[];
  countryCode: string | null;
  unit: string | null;
}

export interface SignedGeocodeCandidate {
  /** The client-facing candidate (`candidateId` is the signed token). */
  candidate: GeocodeCandidate;
  payload: GeocodeCandidatePayload;
}

export interface SuggestResult {
  sessionToken: string;
  suggestions: AddressSuggestion[];
  /** False when the query was below the minimum length and no vendor call was made. */
  called: boolean;
}

export interface AddressProvider {
  readonly providerId: string;
  readonly mode: ProviderImplementationMode;
  /** Places Autocomplete (New): US only, at least 3 characters, server-minted session token. */
  suggest(
    input: { query: string; sessionToken?: string | null },
    options?: CallOptions,
  ): Promise<SuggestResult>;
  /** Place Details (New) with the Essentials field mask; terminates the session. */
  resolve(
    input: { placeId: string; sessionToken: string },
    options?: CallOptions,
  ): Promise<ResolvedPlace | null>;
  /** Geocoding by place ID: `location_type` and `partial_match`. */
  geocodeByPlaceId(placeId: string, options?: CallOptions): Promise<GeocodeSignal | null>;
  /** Manual-entry forward geocode returning signed, session-bound candidates (at most 5). */
  geocode(
    request: GeocodeRequest,
    context: { sessionId: string; now: Date },
    options?: CallOptions,
  ): Promise<SignedGeocodeCandidate[]>;
  /** Verifies a manual-entry candidate token for this session. */
  verifyCandidate(
    token: string,
    context: { sessionId: string; now: Date },
  ): GeocodeCandidatePayload | null;
  /** Geocoding v4 SearchDestinations: building outline, entrances and derived numbers. */
  searchDestinations(placeId: string, options?: CallOptions): Promise<DestinationGeometry | null>;
}

// ---- street view ---------------------------------------------------------------------------------

export const METADATA_STATUSES = [
  'OK',
  'ZERO_RESULTS',
  'NOT_FOUND',
  'OVER_QUERY_LIMIT',
  'REQUEST_DENIED',
  'INVALID_REQUEST',
  'UNKNOWN_ERROR',
] as const;
export type MetadataStatus = (typeof METADATA_STATUSES)[number];

export interface StreetViewMetadata {
  status: MetadataStatus;
  panoId: string | null;
  location: LatLng | null;
  date: string | null;
  copyright: string | null;
}

/** A frozen Street View frame: always requested by panorama ID. */
export interface StreetViewView {
  panoId: string;
  heading: number;
  pitch: number;
  fov: number;
  width: number;
  height: number;
}

export interface DiscoveryInput {
  /** Target point T (entrance or outline centroid, else the resolved location). */
  target: LatLng;
  geometryAvailable: boolean;
  facadeWidthM: number | null;
  roadBearingDeg: number | null;
  facadeNormalDeg: number | null;
  attachedFacade: boolean;
}

/** One candidate viewpoint (the record of the address spec, plus transient fields). */
export interface ViewCandidate {
  panoId: string;
  heading: number;
  headingMode: HeadingMode;
  pitch: number;
  fov: number;
  width: number;
  height: number;
  distanceM: number;
  captureDate: string | null;
  captureGranularity: CaptureGranularity;
  copyright: string | null;
  isGoogleImagery: boolean;
  estimatedFacadePx: number | null;
  flags: CandidateFlag[];
  rank: number;
  isPrimary: boolean;
  /** Panorama location; transient (re-derived from metadata, never persisted). */
  location: LatLng;
  /**
   * Probe that found it: `target`; the signed offset along the road (`offset_+15m`,
   * `offset_-30m`); or, when the target answered `UNKNOWN_ERROR` and the road bearing is unknown,
   * a point of the cross around the target (`cross_<n|e|s|w>_15m` with the default offsets).
   */
  probe: string;
  /**
   * Which view of a target on the road this is: one of the two views across the road, the view
   * along it, or one of the views around a panorama with no known road; transient (never
   * persisted). Absent for a view aimed at the target.
   */
  roadView?: 'side' | 'along' | 'around';
}

/** What discovery found out about the road at a place without building geometry. */
export interface RoadEvidence {
  /** The target lies on the road: the candidates are the roadside views. */
  onRoad: boolean;
  /** Bearing from the lead panorama to the second one, to 0.1 degree; null when none was found. */
  trackBearingDeg: number | null;
  /**
   * How many other panoramas that could give a track lie along the same line through the lead
   * panorama as the one taken; null when none was found.
   */
  trackAgreement: number | null;
  /**
   * Where the second panorama was first seen: in Steps 1 and 2 (`alternates`), or only by the
   * cross around the lead panorama (`cross`); null when none was found.
   */
  trackSource: 'alternates' | 'cross' | null;
  /** Signed offset of the target from the track in meters, to 0.1 (positive: right of the bearing). */
  crossTrackM: number | null;
  /** Metadata calls the cross around the lead panorama made (0 to 4). */
  crossProbes: number;
}

export interface DiscoveryResult {
  status: 'ok' | 'no_imagery' | 'error';
  candidates: ViewCandidate[];
  /** Radius at which the primary was found. */
  probeRadiusM: number | null;
  deepSetback: boolean;
  metadataCalls: number;
  durationMs: number;
  timedOut: boolean;
  /** The on-road test of a place without building geometry; null or absent for a place with it. */
  road?: RoadEvidence | null;
}

export interface FetchedStreetView {
  bytes: Buffer;
  /** SHA-256 hex of the bytes. */
  checksum: string;
  width: number;
  height: number;
  contentType: string;
  providerMode: ProviderImplementationMode;
  fetchedAt: Date;
}

export interface StreetViewProvider {
  readonly providerId: string;
  readonly mode: ProviderImplementationMode;
  metadataByLocation(
    input: { location: LatLng; radiusM: number },
    options?: CallOptions,
  ): Promise<StreetViewMetadata>;
  metadataByPano(panoId: string, options?: CallOptions): Promise<StreetViewMetadata>;
  /**
   * Free metadata probes: radius ladder, alternates at ±15/±30 m, view parameters, ordering and,
   * without building geometry, the on-road test and roadside views.
   */
  discoverCandidates(
    input: DiscoveryInput,
    options?: CallOptions & { budgetMs?: number },
  ): Promise<DiscoveryResult>;
  /** Signed display URL by `pano=` for the browser (never contains an address or coordinates). */
  buildDisplayUrl(view: StreetViewView): string;
  /** Fetches the frame by `pano=` into memory (transient mode); nothing is written to storage. */
  fetchTransient(view: StreetViewView, options?: CallOptions): Promise<FetchedStreetView>;
  /**
   * Revalidates a pinned panorama with free metadata calls. `unchanged`: the pano is still served.
   * `missing`: metadata reports no imagery for the pano (ZERO_RESULTS or NOT_FOUND) and none
   * under another pano ID at the viewpoint's location (removed or blurred). `replaced`: the pano
   * is gone but the location now answers with another pano (newer imagery; `metadata` describes
   * it). `error`: the answer says nothing about the imagery (quota, denied, invalid request,
   * unknown error, network failure or a non-200 response); callers must not treat it as removal.
   */
  refreshPanorama(panoId: string, options?: RefreshPanoramaOptions): Promise<RefreshPanoramaResult>;
}

export interface RefreshPanoramaOptions extends CallOptions {
  /**
   * Where the pinned viewpoint looks from (the panorama's or the target's location). When the
   * pano ID no longer resolves, metadata is probed here to tell newer imagery from a removal;
   * without it a pano that no longer resolves is reported `missing`.
   */
  location?: LatLng | null;
  /**
   * Radius of that location probe (default 15 m, for the panorama's own location). Pass a wider
   * radius when `location` is the target point rather than where the panorama was taken.
   */
  locationRadiusM?: number;
}

export type RefreshPanoramaStatus = 'unchanged' | 'missing' | 'replaced' | 'error';

export interface RefreshPanoramaResult {
  status: RefreshPanoramaStatus;
  /** The metadata answer behind the status (the newer pano's metadata for `replaced`). */
  metadata: StreetViewMetadata;
}

// ---- vision -------------------------------------------------------------------------------------

export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  calls: number;
}

export interface VisionCallResult<T> {
  result: T;
  usage: VisionUsage;
  model: string;
  promptVersion: string;
  elapsedMs: number;
  providerMode: ProviderImplementationMode;
}

export interface ImageInput {
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface ClassifyUploadInput {
  image: ImageInput;
  fixture?: FixtureHint;
}

export interface AnalyzeSceneInput {
  image: ImageInput & { checksum: string };
  sourceAssetId: string;
  sourceKind: SourceKind;
  /** The confirmed scene type and attribute. */
  sceneType: SceneType;
  buildingForm?: BuildingForm | null;
  roomType?: RoomType | null;
  fixture?: FixtureHint;
}

/**
 * What the judge checks. `decorate` (default): the candidate is the original decorated per the
 * plan. `relight`: the candidate is `base` (a decorated daylight image) with only the light
 * changed to the plan's lighting mode.
 */
export type JudgeMode = 'decorate' | 'relight';

export interface JudgeInput {
  renderAttemptId: string;
  original: ImageInput;
  candidate: ImageInput;
  plan: DecorationPlan;
  /** Deterministic-check hints (for example `structure_changed` drift). */
  hints?: string[];
  escalated?: boolean;
  /** Defaults to `decorate`. */
  mode?: JudgeMode;
  /**
   * Relight mode: the decorated daylight image the candidate must match except for light. The
   * judge compares `base` (first image) with `candidate` (second image); without it the
   * `original` is used.
   */
  base?: ImageInput;
  fixture?: FixtureHint;
}

/**
 * What the enhance judge checks: `candidate` must be `original` (the Street View frame on the
 * working grid) with only its image quality improved. `preserve` names the protected spots: the
 * people, blurred areas, house numbers, signs and logos show the frame's own pixels again.
 */
export interface EnhanceJudgeInput {
  /** The enhancement row; recorded as the result's `renderAttemptId`. */
  enhancementId: string;
  original: ImageInput;
  candidate: ImageInput;
  sceneType: SceneType;
  preserve: Pick<
    DecorationPlan['preserve'],
    'regions' | 'protectedBlurRegions' | 'peopleBoxes' | 'attributionRegions'
  >;
  fixture?: FixtureHint;
}

/** One planned placement offered to the localizer as a hint. */
export interface LocalizePlacementHint {
  id: string;
  kitItemId: string;
  /** The planned region, normalized to the working image. */
  region: NormalizedBox;
  /** The plan's description of the item (kind, color, material). */
  specText?: string;
}

export interface LocalizeAdditionsInput {
  renderAttemptId: string;
  /** The working image the editor was given (first image). */
  original: ImageInput;
  /** The editor's output aligned to the working grid (second image). */
  candidate: ImageInput;
  placements: LocalizePlacementHint[];
  fixture?: FixtureHint;
}

export interface LocalizedAddition {
  label: string;
  /** Tight box around the added item, normalized to the candidate. */
  box: NormalizedBox;
  /** The planned placement this item realizes, or null when the editor added it on its own. */
  placementId: string | null;
}

export interface LocalizedChange {
  description: string;
  box: NormalizedBox;
}

export interface LocalizeAdditionsResult {
  /** Every decoration present in the candidate and absent from the original. */
  added: LocalizedAddition[];
  /** Anything else that differs (moved, removed or restyled objects, architecture, framing). */
  otherChanges: LocalizedChange[];
}

/** A Street View frame in which to find the home it is aimed at. */
export interface LocateHomeInput {
  /** The frame as fetched (the provider's JPEG). */
  image: ImageInput;
  sourceAssetId: string;
  fixture?: FixtureHint;
  /**
   * Which home the call looks for. Omitted: the home the frame is aimed at (at or nearest its
   * center). `road`: the frame was taken from the road without being aimed at a building, so the
   * home may be anywhere in it, also cut by the left or right edge.
   */
  target?: 'road';
}

/**
 * The home a Street View frame is aimed at: a tight box around its whole visible building (roof
 * to ground, with its porch and an attached garage), or null when no home is in the frame.
 * `ambiguous` when two homes are equally likely the target (a boundary between attached or close
 * neighbors, or two about equally near and prominent). For a `road` target the box ends at the
 * frame's edge where that edge cuts the home off.
 */
export interface LocateHomeResult {
  home: NormalizedBox | null;
  ambiguous: boolean;
  /** Confidence from 0 to 1 that `home` is the target home and its box covers its visible part. */
  confidence: number;
}

export interface VisionModel {
  readonly providerId: string;
  readonly mode: ProviderImplementationMode;
  /** Upload triage: living-space check, scene type, room type, people boxes, quality hints. */
  classifyUpload(
    input: ClassifyUploadInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<UploadTriage>>;
  /** Scene analysis with normalized boxes, wrapped into the full `SceneAnalysis` record. */
  analyzeScene(
    input: AnalyzeSceneInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<SceneAnalysis>>;
  /** QA judge with critical and major codes and per-placement adherence. */
  judge(input: JudgeInput, options?: CallOptions): Promise<VisionCallResult<JudgeResult>>;
  /**
   * Localizes the decorations the editor added: compares the original with the aligned
   * candidate and returns a tight box per added item (several for items that turn corners) and
   * any other change.
   */
  localizeAdditions(
    input: LocalizeAdditionsInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<LocalizeAdditionsResult>>;
  /**
   * Judges a Street View enhancement: the same place at the same moment with only the image
   * quality improved. The result carries the enhancement ID as `renderAttemptId` and no
   * placements.
   */
  judgeEnhancement(
    input: EnhanceJudgeInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<JudgeResult>>;
  /** Locates the home a Street View frame is aimed at (a small call: one image, one box). */
  locateHome(
    input: LocateHomeInput,
    options?: CallOptions,
  ): Promise<VisionCallResult<LocateHomeResult>>;
}

// ---- image editor -------------------------------------------------------------------------------

export interface ImageEditorCapabilities {
  supportsMask: boolean;
  supportsMarkup: boolean;
  maxReferenceImages: number;
  supportedOutputSizes: { width: number; height: number }[];
  asyncOperations: boolean;
  supportsIdempotencyKey: boolean;
  supportsCancel: boolean;
  qualityLevels?: string[];
  thinkingLevels?: string[];
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Text and image input tokens, when the vendor splits the input (OpenAI). */
  inputTextTokens?: number;
  inputImageTokens?: number;
  /** Thinking tokens the vendor reports apart from the output tokens (Gemini). */
  thoughtsTokens?: number;
  images?: number;
  raw: Record<string, unknown>;
}

export type EditOutcome =
  | {
      status: 'completed';
      operationId: string;
      image: Uint8Array;
      width: number;
      height: number;
      format: 'jpeg' | 'png' | 'webp';
      usage: ProviderUsage;
      modelSnapshot: string;
      provenance: { c2paManifest?: Uint8Array; watermark?: 'synthid' | 'unknown' };
      providerMode: ProviderImplementationMode;
    }
  | { status: 'pending'; operationId: string }
  | {
      status: 'failed';
      operationId?: string;
      kind: 'provider_error' | 'timeout' | 'moderation_blocked' | 'invalid_request';
      providerCode?: string;
      providerCategories?: string[];
      /** The vendor's error message with anything key-like removed (logs and records only). */
      providerMessage?: string;
      /** The request parameter the vendor named as the cause. */
      providerParam?: string;
      /** The vendor's HTTP status, when a response arrived. */
      httpStatus?: number;
      retryable: boolean;
    };

/** What the fixture compositor needs to draw an edit (ignored by live editors). */
export interface FixtureEditContext extends FixtureHint {
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
  sceneType: SceneType;
  placements: readonly FixturePlacement[];
  windows?: readonly NormalizedBox[];
  lightSources?: readonly NormalizedBox[];
  attributionRegion?: NormalizedBox | null;
  /** Regions decorations must never cover (vehicles, existing decor, signs, credits). */
  preserveRegions?: readonly NormalizedBox[];
  /** Walkways and steps that runs along rails must leave open. */
  accessRegions?: readonly NormalizedBox[];
  /** The front door, which sets the scene scale. */
  referenceDoor?: NormalizedBox | null;
  /** The target facade (bounds the sky in the evening relight). */
  targetFacade?: NormalizedBox | null;
  /**
   * Relight requests: the undecorated working image on the input's grid, so the fixture relight
   * can tell the decorations' own bulbs (absent here) from existing bright spots.
   */
  original?: Uint8Array;
}

export interface EditInput {
  image: Uint8Array;
  mask?: Uint8Array;
  fixture?: FixtureEditContext;
}

export interface EditOptions {
  attemptId: string;
  timeoutMs: number;
  signal: AbortSignal;
  /**
   * Called with the operation ID before the adapter awaits the vendor result, so the caller can
   * persist it on the attempt row first (status recovery and reconciliation rely on it).
   */
  onOperation?: (operationId: string) => Promise<void> | void;
}

export interface ImageEditor {
  readonly providerId: string;
  readonly mode: ProviderImplementationMode;
  readonly capabilities: ImageEditorCapabilities;
  edit(request: CompiledRequest, input: EditInput, options: EditOptions): Promise<EditOutcome>;
  getOperation(operationId: string): Promise<EditOutcome>;
  cancel?(operationId: string): Promise<void>;
}

// ---- safety --------------------------------------------------------------------------------------

export type ScreeningCheck = 'hash_match' | 'moderation' | 'living_space' | 'people_detection';

export interface ScreeningResult {
  outcome: 'admitted' | 'declined' | 'held';
  reasonClass: UploadDeclineReasonClass | null;
  reason: UploadDeclineReason | null;
  /** Child-safety signal: decline immediately, never hold, follow the reporting procedure. */
  childSafety: boolean;
  triage: UploadTriage | null;
  peopleDetected: boolean;
  peopleBoxes: NormalizedBox[];
  suggestedCropBox: NormalizedBox | null;
  qualityHints: QualityHint[];
  checks: { check: ScreeningCheck; outcome: 'pass' | 'flag' | 'skipped' }[];
  providerMode: ProviderImplementationMode;
  usage: { visionCalls: number; moderationCalls: number };
  /** The triage call that ran (absent when screening stopped before it). */
  triageCall?: TriageCallRecord | null;
}

/** What a triage call reports about itself, for the screening record and the ledger. */
export interface TriageCallRecord {
  providerId: string;
  providerMode: ProviderImplementationMode;
  model: string;
  promptVersion: string;
  usage: VisionUsage;
  elapsedMs: number;
}

/** The living-space and scene triage call a screening runs after hash matching and moderation. */
export type UploadTriageCall = (
  input: ClassifyUploadInput,
  options?: CallOptions,
) => Promise<VisionCallResult<UploadTriage> & { providerId?: string }>;

export interface ScreenUploadInput {
  image: ImageInput;
  sourceAssetId: string;
  fixture?: FixtureHint;
  /**
   * Runs the triage instead of the screening provider's own vision model (the caller resolves
   * the vision leg). It is called only after hash matching and moderation passed.
   */
  triage?: UploadTriageCall;
}

export interface SafetyProvider {
  readonly providerId: string;
  readonly mode: ProviderImplementationMode;
  /** Content admission in order: hash match, moderation, living-space check, people detection. */
  screenUpload(input: ScreenUploadInput, options?: CallOptions): Promise<ScreeningResult>;
}

export interface Providers {
  address: AddressProvider;
  streetView: StreetViewProvider;
  vision: VisionModel;
  imageEditor: ImageEditor;
  safety: SafetyProvider;
  /** Fixture implementations of every leg, for capability rows in `fixture` state. */
  fixtures: Omit<Providers, 'fixtures'>;
}
