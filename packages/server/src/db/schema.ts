import type { ColumnType, Insertable, Selectable, Updateable } from 'kysely';
import type {
  ActivationState,
  AdherenceStatus,
  AffiliateConversionStatus,
  AnalyticsEmitter,
  AnalyticsEventName,
  ApiAccessState,
  AssetPolicySubjectKind,
  AssetPolicyUseState,
  AttemptOutcome,
  AuditActorKind,
  AuthTokenPurpose,
  Availability,
  BlockedAddressSource,
  BuildingForm,
  CoordsSource,
  DeletionRequester,
  DeletionScope,
  DeletionStatus,
  DisplayAddressBasis,
  EntryMethod,
  FailureDetail,
  FailureKind,
  FeedbackVerdict,
  FidelityMode,
  FailureCode,
  HeadingMode,
  HolidayId,
  JobEnhancementRecord,
  JudgeDecision,
  KitStatus,
  LedgerCategory,
  LedgerKind,
  LedgerSku,
  LightingMode,
  LinkMethod,
  LinkMode,
  MatchClass,
  MerchantProgramStatus,
  NormalizedBox,
  OfferLifecycleStatus,
  OwnerKind,
  PackVersionStatus,
  PeopleResolution,
  PermissionEvaluationContext,
  PipelineStage,
  Precision,
  PrecisionSource,
  PreservationHoldReason,
  PreservationHoldTargetKind,
  PriceSource,
  ProductRelationship,
  ProjectKind,
  ProviderMode,
  ProviderWatermark,
  RejectionReason,
  RenderJobState,
  RenderSubStage,
  ReportPriority,
  ReportReason,
  ReportStatus,
  ReportTargetKind,
  ReviewDecision,
  ReviewMode,
  ReviewSubjectKind,
  RoomType,
  SceneType,
  SkipReason,
  SourceAssetState,
  SourceKind,
  StreetViewSourceMode,
  Style,
  TombstoneKind,
  UploadDeclineCode,
  UploadDeclineReason,
  UploadDeclineReasonClass,
  UserRole,
  VerificationMethod,
} from '@hailiday/core';
import type { AllowanceResidueKind } from '../limits/residue.js';

/** `timestamptz NOT NULL` without a default. Read as Date; written as Date or ISO string. */
export type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** Nullable `timestamptz`. */
export type NullableTimestamp = ColumnType<Date | null, Date | string | null, Date | string | null>;
/** `created_at` with a database default; never updated. */
export type CreatedAt = ColumnType<Date, Date | string | undefined, never>;
/** `updated_at`, maintained by a trigger. */
export type UpdatedAt = ColumnType<Date, Date | string | undefined, Date | string | undefined>;
/** `date` columns are read and written as `YYYY-MM-DD` strings (no timezone shifting). */
export type DateString = ColumnType<string, string, string>;
export type NullableDateString = ColumnType<string | null, string | null, string | null>;
/** `jsonb NOT NULL`: read as the parsed value; written as a JSON string (see `toJson`). */
export type Json<T> = ColumnType<T, string, string>;
/** `jsonb NOT NULL DEFAULT ...`. */
export type JsonWithDefault<T> = ColumnType<T, string | undefined, string>;
/** Nullable `jsonb`. */
export type NullableJson<T> = ColumnType<T | null, string | null, string | null>;
/** `numeric` columns are parsed to numbers by the pool's type parser. */
export type Numeric = ColumnType<number, number | string, number | string>;
export type NullableNumeric = ColumnType<
  number | null,
  number | string | null,
  number | string | null
>;
/** `bigint` columns are parsed to numbers (values stay within the safe integer range). */
export type Int8 = ColumnType<number, number | bigint | string, number | bigint | string>;
export type NullableInt8 = ColumnType<
  number | null,
  number | bigint | string | null,
  number | bigint | string | null
>;
/** A column with a database default. */
export type WithDefault<T> = ColumnType<T, T | undefined, T>;
/** A generated column: read-only. */
export type GeneratedAlways<T> = ColumnType<T, never, never>;

/** Normalized `[x0, y0, x1, y1]` box in 0–1 image coordinates. */
export type BoxJson = [number, number, number, number];

interface Base {
  id: string;
  createdAt: CreatedAt;
}

interface Mutable extends Base {
  updatedAt: UpdatedAt;
}

export interface OwnersTable extends Mutable {
  kind: OwnerKind;
  deletedAt: NullableTimestamp;
}

export interface UsersTable extends Mutable {
  ownerId: string;
  emailNormalized: string;
  emailVerifiedAt: NullableTimestamp;
  roles: WithDefault<UserRole[]>;
  tosVersion: string | null;
  lastLoginAt: NullableTimestamp;
  deletedAt: NullableTimestamp;
}

export interface AnonymousSessionsTable extends Mutable {
  ownerId: string;
  tokenHash: string;
  turnstileVerifiedAt: NullableTimestamp;
  deviceHash: string | null;
  ipHash: string | null;
  timezone: string | null;
  countryCode: WithDefault<string>;
  lastSeenAt: Timestamp;
  expiresAt: Timestamp;
  /** When the session first arrived with the Global Privacy Control signal (`Sec-GPC: 1`). */
  gpcSignaledAt: NullableTimestamp;
}

export interface AuthTokensTable extends Mutable {
  tokenHash: string;
  emailNormalized: string;
  purpose: AuthTokenPurpose;
  requestedFromSessionId: string | null;
  returnTo: string | null;
  expiresAt: Timestamp;
  consumedAt: NullableTimestamp;
  ipHash: string | null;
}

export interface CountryCapabilitiesTable extends Mutable {
  countryCode: string;
  capability: string;
  state: ActivationState;
  evidenceRef: string;
  reviewedAt: Timestamp;
  reviewedBy: string | null;
  version: WithDefault<number>;
}

export interface RuntimeSettingsTable {
  key: string;
  createdAt: CreatedAt;
  updatedAt: UpdatedAt;
  value: Json<unknown>;
  version: WithDefault<number>;
  updatedBy: string | null;
}

/** One object a preservation hold covers: its held copy, or `inPlace` when it is protected where it is. */
export interface HeldObjectJson {
  bucket: 'private';
  /** SHA-256 of the original key (the key itself is never recorded). */
  originalKeyHash: string;
  heldKey: string | null;
  inPlace: boolean;
}

export interface PreservationHoldsTable extends Mutable {
  targetKind: PreservationHoldTargetKind;
  targetId: string;
  reason: PreservationHoldReason;
  authorityRef: string;
  releaseCondition: string;
  /** Null when an automated signal (a child-safety match) placed the hold. */
  placedBy: string | null;
  /** Copies made under `held/{holdId}/` when the hold was placed. */
  heldObjects: JsonWithDefault<HeldObjectJson[]>;
  releasedBy: string | null;
  releasedAt: NullableTimestamp;
  releaseReason: string | null;
}

export interface AuditLogTable extends Base {
  actorUserId: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetKind: string;
  targetId: string;
  before: NullableJson<Record<string, unknown>>;
  after: NullableJson<Record<string, unknown>>;
  requestId: string;
  ipHash: string | null;
}

export interface PropertiesTable extends Mutable {
  ownerId: string;
  placeId: string;
  placeIdRefreshedAt: Timestamp;
  countryCode: string;
  entryMethod: EntryMethod;
  precision: Precision;
  precisionSource: PrecisionSource;
  partialMatch: boolean;
  placeTypes: string[];
  multiUnit: boolean;
  unitDesignation: string | null;
  geometryAvailable: boolean;
  facadeWidthM: NullableNumeric;
  entranceOffsetM: NullableNumeric;
  roadBearingDeg: NullableNumeric;
  facadeNormalDeg: NullableNumeric;
  attachedFacade: WithDefault<boolean>;
  structureType: 'BUILDING' | 'GROUNDS' | null;
  displayLoadsIssued: WithDefault<number>;
  /** When the current 24-hour display budget window opened; null when none is open. */
  displayLoadsWindowStartedAt: NullableTimestamp;
  ownerBlurDetectedAt: NullableTimestamp;
  targetLat: NullableNumeric;
  targetLng: NullableNumeric;
  coordsSource: CoordsSource | null;
  coordsExpireAt: NullableTimestamp;
  displayAddress: string | null;
  displayAddressBasis: DisplayAddressBasis | null;
  displayAddressStoredAt: NullableTimestamp;
  manualEntry: NullableJson<Record<string, unknown>>;
}

export interface ProjectsTable extends Mutable {
  ownerId: string;
  kind: ProjectKind;
  propertyId: string | null;
  projectVersion: WithDefault<number>;
  activeSourceAssetId: string | null;
  sceneType: SceneType | null;
  buildingForm: BuildingForm | null;
  roomType: RoomType | null;
  holidayId: HolidayId;
  /**
   * The current look; set from the pack defaults when the scene type is set or changes (indoor
   * scene types start in `bright`, which migration 0013 allows).
   */
  style: WithDefault<Style>;
  lightingMode: WithDefault<LightingMode>;
  savedAt: NullableTimestamp;
  lastActivityAt: Timestamp;
  expiresAt: NullableTimestamp;
  preservationHoldId: string | null;
  deletedAt: NullableTimestamp;
}

export interface SourceDiscoveriesTable extends Mutable {
  projectId: string;
  projectVersion: number;
  entryMethod: EntryMethod;
  matchClass: MatchClass;
  reason: SkipReason | null;
  retryable: WithDefault<boolean>;
  sourceMode: StreetViewSourceMode;
  thresholdsVersion: string;
  algorithmVersion: string;
  candidates: JsonWithDefault<Record<string, unknown>[]>;
  signals: JsonWithDefault<Record<string, unknown>>;
  providerCalls: JsonWithDefault<Record<string, number>>;
  durationMs: number;
}

export interface AssetPoliciesTable extends Mutable {
  subjectKind: AssetPolicySubjectKind;
  subjectId: string;
  display: WithDefault<AssetPolicyUseState>;
  store: WithDefault<AssetPolicyUseState>;
  aiProcess: WithDefault<AssetPolicyUseState>;
  edit: WithDefault<AssetPolicyUseState>;
  distributeDerivative: WithDefault<AssetPolicyUseState>;
  commerceAdjacent: WithDefault<AssetPolicyUseState>;
  train: WithDefault<'denied'>;
  evidenceRef: string;
  licenseVersion: string | null;
  territory: string | null;
  attributionText: string | null;
  expiresAt: NullableTimestamp;
  revokedAt: NullableTimestamp;
  createdBy: string;
}

/**
 * How a Street View source's frame was zoomed in on the home at the look that recorded it.
 * `framedAt` is the database's time of the record: a look created before it was made from the
 * wide frame, a look created at or after it from the recorded frame. `framed`: the
 * stored frame is the view `heading`, `pitch` and `fov` from the same panorama, aimed at the home
 * the vision model boxed (`box`, normalized on the wide frame) with `zoom` the gain over the wide
 * view; `displayIssuedAt`, once set, is when the framed view's display URL was first counted
 * against the property's display budget and ledgered (the browser loads it from the provider when
 * no stored frame may be shown), which happens once per source. `kept`: the source keeps its wide
 * frame for good, because no single home was found, the answer was ambiguous or not confident
 * enough, zooming in would gain too little, or the scene analysis refused the framed frame of the
 * look that recorded it (`refused_framed`: the wide frame was fetched and stored again).
 *
 * `reaim` is recorded when a frame taken from the road (heading mode `road`) was turned toward its
 * home before the decision: `reaim.box` is the home as first located on the viewpoint's own frame,
 * `reaim.heading` the heading of the re-aimed frame (the viewpoint's panorama, pitch and fov), and
 * `reaim.promptVersion` the prompt of that first call. With `reaim`, `box` is normalized on the
 * re-aimed frame and `zoom` is the gain over it. A `framed` record with `zoom` 1 and a `reason` is
 * the re-aimed frame itself: zooming in would gain too little (`small_gain`), or the scene analysis
 * refused the zoomed frame and the re-aimed frame was fetched and stored again (`refused_framed`).
 */
export type ViewpointFraming =
  | {
      status: 'framed';
      heading: number;
      pitch: number;
      fov: number;
      box: NormalizedBox;
      zoom: number;
      displayIssuedAt?: string;
      reason?: 'small_gain' | 'refused_framed';
      reaim?: ViewpointReaim;
      promptVersion: string;
      model: string;
      framedAt: string;
    }
  | {
      status: 'kept';
      reason: 'no_home' | 'ambiguous' | 'small_gain' | 'refused_framed';
      box: NormalizedBox | null;
      promptVersion: string;
      model: string;
      framedAt: string;
    };

/** The turn of a frame taken from the road toward its home, recorded with its framing. */
export interface ViewpointReaim {
  heading: number;
  box: NormalizedBox;
  promptVersion: string;
}

/**
 * Street View refetch descriptor stored on a source asset. `heading`, `pitch` and `fov` are the
 * confirmed candidate's view and the viewpoint's identity (`viewpoint_key`); `framing`, once
 * recorded, says which view the stored frame actually shows.
 */
export interface ViewpointJson {
  panoId: string;
  heading: number;
  headingMode: HeadingMode;
  pitch: number;
  fov: number;
  width: number;
  height: number;
  source: 'outdoor';
  captureGranularity: 'month' | 'year' | 'none';
  fetchedAt: string | null;
  sourceCheckedAt: string | null;
  framing?: ViewpointFraming;
}

export interface SourceAssetsTable extends Mutable {
  ownerId: string;
  projectId: string;
  kind: SourceKind;
  state: SourceAssetState;
  derivedFromSourceAssetId: string | null;
  objectKey: string | null;
  checksumSha256: string | null;
  contentType: string | null;
  byteLength: NullableInt8;
  width: number | null;
  height: number | null;
  originalFormat: string | null;
  originalByteLength: NullableInt8;
  originalWidth: number | null;
  originalHeight: number | null;
  orientationApplied: number | null;
  clientPrepared: boolean | null;
  captureDate: string | null;
  copyright: string | null;
  isGoogleImagery: boolean | null;
  streetViewMode: StreetViewSourceMode | null;
  viewpoint: NullableJson<ViewpointJson>;
  viewpointKey: GeneratedAlways<string | null>;
  attestationVersion: string | null;
  attestedAt: NullableTimestamp;
  sceneType: SceneType | null;
  buildingForm: BuildingForm | null;
  roomType: RoomType | null;
  sceneTypeConfidence: NullableNumeric;
  sceneTypeCorrected: WithDefault<boolean>;
  multiUnitFacade: boolean | null;
  peopleDetected: WithDefault<boolean>;
  peopleBoxes: NullableJson<BoxJson[]>;
  suggestedCropBox: NullableJson<BoxJson>;
  peopleResolution: PeopleResolution | null;
  cropBox: NullableJson<BoxJson>;
  privateOnly: WithDefault<boolean>;
  qualityHints: WithDefault<string[]>;
  existingDecorations: NullableJson<unknown>;
  seasonCues: NullableJson<unknown>;
  screening: NullableJson<Record<string, unknown>>;
  holdForReview: WithDefault<boolean>;
  declinedCode: UploadDeclineCode | null;
  declinedReasonClass: UploadDeclineReasonClass | null;
  declinedReason: UploadDeclineReason | null;
  providerRefusedAt: NullableTimestamp;
  readyAt: NullableTimestamp;
  assetPolicyId: string | null;
  revalidatedAt: NullableTimestamp;
  staleAt: NullableTimestamp;
  expiresAt: NullableTimestamp;
  preservationHoldId: string | null;
  deletedAt: NullableTimestamp;
}

/** `permission_evaluations.result`: an evaluated AssetPermission. */
export interface PermissionResultJson {
  display: boolean;
  store: boolean;
  aiProcess: boolean;
  edit: boolean;
  distributeDerivative: boolean;
  commerceAdjacent: boolean;
  train: false;
  attribution: string | null;
  expiresAt: string | null;
  territory: string | null;
  evidenceId: string;
}

export interface PermissionEvaluationsTable extends Base {
  sourceAssetId: string | null;
  assetPolicyId: string;
  context: PermissionEvaluationContext;
  jobId: string | null;
  attemptId: string | null;
  stage: PipelineStage | null;
  result: Json<PermissionResultJson>;
  capabilityState: ActivationState;
  evaluatedAt: Timestamp;
}

export interface BlockedAddressesTable extends Mutable {
  placeId: string;
  normalizedAddressHash: string | null;
  source: BlockedAddressSource;
  reportId: string | null;
  evidenceRef: string;
  createdBy: string | null;
  expiresAt: NullableTimestamp;
  removedAt: NullableTimestamp;
  /** SHA-256 of the requester's normalized email (homeowner opt-out); never the address. */
  requesterContactHash: string | null;
}

export interface HolidayPackVersionsTable extends Mutable {
  holidayId: HolidayId;
  region: string;
  version: string;
  majorMinor: GeneratedAlways<string>;
  status: PackVersionStatus;
  contentRef: string;
  contentSha256: string;
  reviewRecord: NullableJson<Record<string, unknown>>;
  publishedAt: NullableTimestamp;
  retiredAt: NullableTimestamp;
}

/** `hero_assets.renditions`. */
export interface HeroRenditionsJson {
  landscape: HeroCropJson;
  portrait: HeroCropJson;
  [crop: string]: HeroCropJson;
}

export interface HeroCropJson {
  focalPoint: [number, number];
  safeArea: BoxJson;
  renditions: { cdnPath: string; width: number; height: number; format: string }[];
}

export interface HeroAssetsTable extends Mutable {
  assetKey: string;
  holidayId: HolidayId | null;
  sceneType: SceneType | null;
  renditions: Json<HeroRenditionsJson>;
  altTextKey: string;
  rights: Json<Record<string, unknown>>;
  approvedAt: Timestamp;
  approvedBy: string | null;
  approvedCrops: string[];
  active: boolean;
}

export interface HolidayOccurrencesTable extends Mutable {
  occurrenceKey: string;
  holidayId: HolidayId;
  region: string;
  year: number;
  celebrationStart: DateString;
  celebrationEnd: DateString;
  promotionStart: DateString;
  promotionEnd: DateString;
  commerceStart: NullableDateString;
  commerceEnd: NullableDateString;
  catalogRetireAt: NullableDateString;
  editorialPriority: number;
  editorialTimezone: string;
  heroAssetId: string | null;
  packVersionId: string | null;
  enabled: WithDefault<boolean>;
  reviewedAt: Timestamp;
  reviewedBy: string | null;
}

export interface ExampleAssetsTable extends Mutable {
  assetKey: string;
  holidayId: HolidayId;
  sceneType: SceneType;
  style: Style;
  lightingMode: LightingMode;
  sourceAssetId: string | null;
  renderAssetId: string | null;
  packVersion: string;
  beforeCdnPath: string;
  afterCdnPath: string;
  width: number;
  height: number;
  captionKey: string;
  rights: Json<Record<string, unknown>>;
  approvedAt: Timestamp;
  active: boolean;
}

export interface StyleKitsTable extends Mutable {
  kitKey: string;
  holidayId: HolidayId;
  sceneType: SceneType;
  version: string;
  status: KitStatus;
  publishedAt: NullableTimestamp;
}

export interface StyleQuantitiesJson {
  subtle: { min: number; max: number };
  classic: { min: number; max: number };
  abundant: { min: number; max: number };
}

export interface KitItemsTable extends Mutable {
  kitId: string;
  kitItemId: string;
  anchorCategory: string;
  anchorCategories: WithDefault<string[]>;
  specText: string;
  specAttributes: Json<Record<string, unknown>>;
  styleQuantities: Json<StyleQuantitiesJson>;
  sortOrder: number;
  currentProductId: string | null;
}

export interface MerchantProgramsTable extends Mutable {
  programKey: string;
  displayName: string;
  programType: WithDefault<string>;
  network: string;
  status: MerchantProgramStatus;
  statusHistory: JsonWithDefault<{ status: string; at: string; evidenceRef: string | null }[]>;
  appliedAt: NullableTimestamp;
  approvedAt: NullableTimestamp;
  endedAt: NullableTimestamp;
  requiredDisclosureKey: string | null;
  disclosureText: string | null;
  redirectPermitted: WithDefault<boolean>;
  linkMethod: LinkMethod;
  subIdCapability: WithDefault<boolean>;
  subIdParam: string | null;
  trackingIds: JsonWithDefault<{ holidayId: string; channel: string; trackingId: string }[]>;
  apiAccess: ApiAccessState;
  attributionWindowHours: number | null;
  commissionSchedule: JsonWithDefault<
    { category: string; ratePercent: number; effectiveFrom: string }[]
  >;
  policyVersion: string | null;
  reviewedAt: NullableTimestamp;
  logoPermitted: WithDefault<boolean>;
  notes: string | null;
  capabilityKey: GeneratedAlways<string>;
}

export interface ProductsTable extends Mutable {
  productKey: string;
  kitItemId: string | null;
  kitItemKeys: WithDefault<string[]>;
  ourTitle: string;
  ourDescription: string;
  category: string;
  specAttributes: Json<Record<string, unknown>>;
  notes: string | null;
  archivedAt: NullableTimestamp;
}

/** `offers.content_rights`. */
export interface ContentRightsJson {
  imageDisplay: { state: AssetPolicyUseState; evidenceRef: string | null };
  imageAiInput: { state: AssetPolicyUseState; evidenceRef: string | null };
  textUse: { state: AssetPolicyUseState; evidenceRef: string | null };
}

export interface OffersTable extends Mutable {
  offerKey: string;
  productId: string;
  merchantProgramId: string;
  merchantItemId: string;
  destinationCountry: string;
  currency: string;
  priceMinor: number | null;
  priceSource: WithDefault<PriceSource>;
  priceObservedAt: NullableTimestamp;
  availability: Availability | null;
  availabilityCheckedAt: NullableTimestamp;
  destinationUrl: string;
  trackingUrlTemplate: string | null;
  contentRights: Json<ContentRightsJson>;
  status: OfferLifecycleStatus;
  seasonalEligibility: WithDefault<string[]>;
  sponsored: WithDefault<boolean>;
  lastVerifiedAt: NullableTimestamp;
  verificationMethod: VerificationMethod | null;
  verifiedBy: string | null;
  notes: string | null;
}

export interface UsageLedgerTable extends Base {
  ownerId: string | null;
  ownerTombstoneHash: string | null;
  kind: LedgerKind;
  category: LedgerCategory;
  provider: string;
  sku: LedgerSku;
  modelId: string | null;
  stage: string | null;
  units: Numeric;
  unitPriceMicros: Int8;
  amountMicros: Int8;
  currency: string;
  reservationId: string | null;
  jobId: string | null;
  attemptId: string | null;
  projectId: string | null;
  sessionId: string | null;
  isFixture: boolean;
  settledAt: NullableTimestamp;
}

export interface SceneAnalysesTable extends Base {
  sourceAssetId: string;
  analysisModel: string;
  analysisPromptVersion: string;
  schemaVersion: string;
  workingWidth: number;
  workingHeight: number;
  workingChecksumSha256: string;
  document: Json<Record<string, unknown>>;
  sceneTypeMismatch: WithDefault<boolean>;
  firstJobId: string | null;
  ledgerEntryId: string | null;
  /** Token usage the vision model reported for the analysis call. */
  usage: NullableJson<Record<string, unknown>>;
}

export interface RenderJobsTable extends Mutable {
  ownerId: string;
  projectId: string;
  projectVersion: number;
  sourceAssetId: string;
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
  holidayPackVersion: string;
  compilerVersion: string;
  variantKey: GeneratedAlways<string>;
  inputSnapshot: Json<Record<string, unknown>>;
  permissionEvaluationId: string;
  sceneAnalysisId: string | null;
  workingWidth: number | null;
  workingHeight: number | null;
  workingChecksumSha256: string | null;
  resampler: string | null;
  workingCropBox: NullableJson<BoxJson>;
  workingPadBox: NullableJson<BoxJson>;
  scaleFactor: NullableNumeric;
  workingObjectKey: string | null;
  repairConstraints: NullableJson<Record<string, unknown>>;
  state: RenderJobState;
  stateSeq: WithDefault<number>;
  failureKind: FailureKind | null;
  failureDetail: FailureDetail | null;
  rejectionReason: RejectionReason | null;
  failureCodes: string[] | null;
  idempotencyKey: string;
  requestHash: string;
  /**
   * Image-edit attempts made so far: at most 2, or 3 for a relit look that decorates its own base
   * (migration 0014).
   */
  attemptCount: WithDefault<number>;
  /** Whether the job used its one repair. */
  repairUsed: WithDefault<boolean>;
  reviewMode: ReviewMode;
  supersededByJobId: string | null;
  cancelRequestedAt: NullableTimestamp;
  renderAssetId: string | null;
  deviceHash: string | null;
  ipHash: string | null;
  correlationId: string | null;
  requestedAt: Timestamp;
  sourceReadyAt: NullableTimestamp;
  startedAt: NullableTimestamp;
  renderStartedAt: NullableTimestamp;
  renderCompletedAt: NullableTimestamp;
  qaPassedAt: NullableTimestamp;
  reviewCompletedAt: NullableTimestamp;
  succeededAt: NullableTimestamp;
  terminalAt: NullableTimestamp;
  /**
   * What the worker is doing inside the state when the state alone does not say it (migrations
   * 0018 and 0019): `framing` in `preparing`, `enhancing` in `analyzing`, `relight` in `planning`
   * and `rendering` of a relight.
   */
  subStage: RenderSubStage | null;
  /** The outcome of the Street View enhancement step; null for other sources (migration 0018). */
  enhancement: NullableJson<JobEnhancementRecord>;
}

/** Status of a Street View enhancement row. */
export type SourceEnhancementStatus = 'pending' | 'accepted' | 'rejected' | 'failed';

/**
 * One Street View enhancement per (source, stored-frame checksum, compiler version): the image
 * editor's redraw of the frame, its checks and verdict, and the accepted picture (migration 0018).
 */
export interface SourceEnhancementsTable extends Mutable {
  sourceAssetId: string;
  frameChecksumSha256: string;
  compilerVersion: string;
  workingWidth: number;
  workingHeight: number;
  status: SourceEnhancementStatus;
  reason: string | null;
  failureCodes: WithDefault<FailureCode[]>;
  /** Set on `failed`: whether a later job may try once more. */
  retryable: WithDefault<boolean>;
  /** Edits sent to the provider for this row (0 to 2). */
  editCount: WithDefault<number>;
  jobId: string | null;
  provider: string | null;
  providerMode: ProviderMode | null;
  modelSnapshot: string | null;
  settingsHash: string | null;
  request: NullableJson<Record<string, unknown>>;
  providerOperationId: string | null;
  editSentAt: NullableTimestamp;
  editCompletedAt: NullableTimestamp;
  editLatencyMs: number | null;
  providerUsage: NullableJson<Record<string, unknown>>;
  providerWatermark: ProviderWatermark | null;
  /** The provider's output, under the job's attempts prefix. */
  rawObjectKey: string | null;
  editLedgerEntryId: string | null;
  judgeLedgerEntryId: string | null;
  registration: NullableJson<Record<string, unknown>>;
  checks: NullableJson<Record<string, unknown>>;
  judge: NullableJson<Record<string, unknown>>;
  judgeUsage: NullableJson<Record<string, unknown>>;
  /** The accepted picture (PNG on the working grid) under `enhanced/`. */
  objectKey: string | null;
  /** SHA-256 of the accepted PNG bytes: the working checksum of the jobs that use it. */
  enhancedChecksumSha256: string | null;
  byteLength: NullableInt8;
  decidedAt: NullableTimestamp;
}

export interface DecorationPlansTable extends Base {
  jobId: string;
  /** 1 to 3 (`RenderAttemptNumber`). */
  attemptNo: number;
  sceneAnalysisId: string;
  packVersion: string;
  styleKitId: string;
  compilerVersion: string;
  document: Json<Record<string, unknown>>;
  validatorResult: Json<Record<string, unknown>>;
  compiledInstruction: string | null;
}

export interface RenderAttemptsTable extends Mutable {
  jobId: string;
  /** 1 to 3 (`RenderAttemptNumber`); a third attempt is always a relight. */
  attemptNo: number;
  /** Planned with repair constraints: never the first attempt, at most one per job. */
  isRepair: boolean;
  decorationPlanId: string;
  sceneAnalysisId: string;
  permissionEvaluationId: string;
  provider: string;
  modelSnapshot: string;
  promptVersion: string;
  compilerVersion: string;
  settingsHash: string;
  providerMode: ProviderMode;
  providerOperationId: string | null;
  sourceChecksumSha256: string;
  workingChecksumSha256: string;
  fidelityMode: FidelityMode | null;
  requestedWidth: number | null;
  requestedHeight: number | null;
  deliveredWidth: number | null;
  deliveredHeight: number | null;
  compositeMask: NullableJson<Record<string, unknown>>;
  registrationTransform: NullableJson<Record<string, unknown>>;
  dilationFraction: NullableNumeric;
  featherFraction: NullableNumeric;
  providerManifestObjectKey: string | null;
  providerWatermark: ProviderWatermark | null;
  providerCategories: string[] | null;
  requestSentAt: NullableTimestamp;
  completedAt: NullableTimestamp;
  outcome: AttemptOutcome;
  transportRetries: WithDefault<number>;
  candidateObjectKey: string | null;
  latencyMs: number | null;
  reservationEntryId: string | null;
  ledgerEntryId: string | null;
  reconciled: 'settled' | 'assumed_charged' | null;
  errorDetail: NullableJson<Record<string, unknown>>;
  /** Usage the provider reported for the delivered output (tokens, images, request ID). */
  providerUsage: NullableJson<Record<string, unknown>>;
  /** The evening fallback delivered in place of this rejected evening edit, when one was. */
  fallback: NullableJson<Record<string, unknown>>;
}

export interface JudgeResultsTable extends Base {
  attemptId: string;
  escalated: WithDefault<boolean>;
  modelId: string;
  promptVersion: string;
  deterministicChecks: Json<Record<string, unknown>>;
  document: Json<Record<string, unknown>>;
  criticalCodes: WithDefault<string[]>;
  majorCodes: WithDefault<string[]>;
  decision: JudgeDecision;
  ledgerEntryId: string | null;
  /** Token usage the vision model reported for the judge call. */
  usage: NullableJson<Record<string, unknown>>;
}

/** `render_assets.provenance`. */
export interface ProvenanceJson {
  iptcDigitalSourceType: string;
  labelApplied: boolean;
  iptcWritten: boolean;
  providerManifestCaptured: boolean;
  providerWatermark: 'synthid' | 'unknown';
  holidayManifest: string;
  providerMode?: ProviderMode;
}

export interface RenderAssetsTable extends Mutable {
  ownerId: string;
  projectId: string;
  jobId: string;
  sourceAssetId: string;
  variantKey: string;
  holidayId: HolidayId;
  style: Style;
  lightingMode: LightingMode;
  holidayPackVersion: string;
  compilerVersion: string;
  objectKey: string;
  width: number;
  height: number;
  contentType: string;
  byteLength: Int8;
  nativeWidth: number;
  nativeHeight: number;
  scaleFactor: NullableNumeric;
  fidelityMode: FidelityMode;
  provenance: Json<ProvenanceJson>;
  attributionText: string | null;
  distributable: boolean;
  downloadable: boolean;
  downloadObjectKey: string | null;
  existingDecorConflict: WithDefault<boolean>;
  expiresAt: NullableTimestamp;
  pinnedUntil: NullableTimestamp;
  withdrawnAt: NullableTimestamp;
  preservationHoldId: string | null;
  deletedAt: NullableTimestamp;
}

export interface ReviewsTable extends Base {
  subjectKind: ReviewSubjectKind;
  jobId: string | null;
  sourceAssetId: string | null;
  reviewerUserId: string;
  decision: ReviewDecision;
  reasonCodes: WithDefault<string[]>;
  notes: string | null;
  requestedAt: Timestamp;
  decidedAt: Timestamp;
  waitMs: GeneratedAlways<number>;
}

export interface RenderProductLinksTable extends Mutable {
  renderAssetId: string;
  kitItemId: string;
  productId: string;
  placementRef: string | null;
  relationship: ProductRelationship;
  adherenceStatus: AdherenceStatus;
  adherenceCheck: NullableJson<Record<string, unknown>>;
  rankPosition: number;
  chosenOfferId: string | null;
  linkMode: LinkMode | null;
  candidateOfferIds: string[] | null;
  rankingReason: string | null;
  rankedAt: NullableTimestamp;
  sponsored: WithDefault<boolean>;
  hiddenAt: NullableTimestamp;
  hiddenReason: string | null;
}

export interface AffiliateClicksTable extends Base {
  clickToken: string;
  renderProductLinkId: string | null;
  offerId: string;
  merchantProgramId: string;
  linkMode: LinkMode;
  sentSubId: string | null;
  trackingId: string | null;
  relationship: ProductRelationship;
  rankPosition: number;
  holidayId: string;
  occurrenceKey: string;
  sceneType: string;
  sourceKind: string;
  acquisitionChannel: string | null;
  sessionHash: string;
  countryCode: string;
}

export interface AffiliateConversionsTable extends Mutable {
  merchantProgramId: string;
  sentSubId: string | null;
  trackingId: string | null;
  orderAt: Timestamp;
  reportedAt: Timestamp;
  commissionAmountMinor: number;
  currency: string;
  status: AffiliateConversionStatus;
  reportRef: string;
}

export interface ShareGrantsTable extends Mutable {
  ownerId: string;
  renderAssetId: string;
  tokenHash: string;
  includeBefore: WithDefault<boolean>;
  idempotencyKey: string | null;
  expiresAt: Timestamp;
  revokedAt: NullableTimestamp;
  viewCount: WithDefault<number>;
  lastViewedAt: NullableTimestamp;
  shareCardObjectKey: string | null;
}

export interface FeedbackTable extends Base {
  ownerId: string | null;
  renderAssetId: string | null;
  jobId: string | null;
  verdict: FeedbackVerdict;
  reasons: WithDefault<string[]>;
  note: string | null;
  holidayId: string;
  sceneType: string;
  sourceKind: string;
  idempotencyKey: string | null;
}

export interface ReportsTable extends Mutable {
  reporterOwnerId: string | null;
  reporterContactEmail: string | null;
  targetKind: ReportTargetKind;
  targetId: string | null;
  targetShareTokenHash: string | null;
  targetPlaceId: string | null;
  addressText: string | null;
  reason: ReportReason;
  details: string | null;
  requestOptOut: WithDefault<boolean>;
  status: WithDefault<ReportStatus>;
  priority: WithDefault<ReportPriority>;
  assigneeUserId: string | null;
  resolution: NullableJson<Record<string, unknown>>;
  preservationHoldId: string | null;
  acknowledgedAt: NullableTimestamp;
  resolvedAt: NullableTimestamp;
  ipHash: string | null;
}

/** One entry of `deletion_requests.receipt`. */
export interface DeletionReceiptEntry {
  store: string;
  objectsDeleted: number;
  rowsDeleted: number;
  completedAt: string | null;
  verifiedAt: string | null;
  error: string | null;
}

export interface DeletionRequestsTable extends Mutable {
  ownerId: string | null;
  scope: DeletionScope;
  targetId: string;
  requestedBy: DeletionRequester;
  accessRevokedAt: Timestamp;
  status: WithDefault<DeletionStatus>;
  receipt: JsonWithDefault<DeletionReceiptEntry[]>;
  providerDeletion: NullableJson<Record<string, unknown>>;
  completedAt: NullableTimestamp;
  verifiedAt: NullableTimestamp;
}

export interface TombstonesTable extends Base {
  kind: TombstoneKind;
  hashSha256: string;
  deletionRequestId: string | null;
  deletedAt: Timestamp;
  retainUntil: Timestamp;
  /** Attestation of a deleted source asset, kept as the legal record. */
  attestationVersion: string | null;
  attestedAt: NullableTimestamp;
  /** When the row was appended to the `tombstones/` mirror in object storage. */
  mirroredAt: NullableTimestamp;
}

/** One counted allowance or quota unit whose authoritative row a deletion removed. */
export interface AllowanceResidueTable extends Base {
  ownerId: string;
  kind: AllowanceResidueKind;
  countedAt: Timestamp;
  expiresAt: Timestamp;
}

export interface AnalyticsEventsTable extends Base {
  eventName: AnalyticsEventName;
  occurredAt: Timestamp;
  receivedAt: Timestamp;
  sessionHash: string;
  emitter: AnalyticsEmitter;
  properties: Json<Record<string, unknown>>;
  holidayId: string | null;
  sceneType: string | null;
  sourceKind: string | null;
  countryCode: string;
  appVersion: string;
}

export interface FixtureEmailsTable extends Base {
  toAddress: string;
  fromAddress: string;
  subject: string;
  textBody: string;
  htmlBody: string | null;
  tag: string | null;
  messageId: string;
}

/** The typed schema: table name (snake_case in SQL) to row type (camelCase in TypeScript). */
export interface Database {
  owners: OwnersTable;
  users: UsersTable;
  anonymousSessions: AnonymousSessionsTable;
  authTokens: AuthTokensTable;
  countryCapabilities: CountryCapabilitiesTable;
  runtimeSettings: RuntimeSettingsTable;
  preservationHolds: PreservationHoldsTable;
  auditLog: AuditLogTable;
  properties: PropertiesTable;
  projects: ProjectsTable;
  sourceDiscoveries: SourceDiscoveriesTable;
  assetPolicies: AssetPoliciesTable;
  sourceAssets: SourceAssetsTable;
  permissionEvaluations: PermissionEvaluationsTable;
  blockedAddresses: BlockedAddressesTable;
  holidayPackVersions: HolidayPackVersionsTable;
  heroAssets: HeroAssetsTable;
  holidayOccurrences: HolidayOccurrencesTable;
  exampleAssets: ExampleAssetsTable;
  styleKits: StyleKitsTable;
  kitItems: KitItemsTable;
  merchantPrograms: MerchantProgramsTable;
  products: ProductsTable;
  offers: OffersTable;
  usageLedger: UsageLedgerTable;
  sceneAnalyses: SceneAnalysesTable;
  renderJobs: RenderJobsTable;
  sourceEnhancements: SourceEnhancementsTable;
  decorationPlans: DecorationPlansTable;
  renderAttempts: RenderAttemptsTable;
  judgeResults: JudgeResultsTable;
  renderAssets: RenderAssetsTable;
  reviews: ReviewsTable;
  renderProductLinks: RenderProductLinksTable;
  affiliateClicks: AffiliateClicksTable;
  affiliateConversions: AffiliateConversionsTable;
  shareGrants: ShareGrantsTable;
  feedback: FeedbackTable;
  reports: ReportsTable;
  deletionRequests: DeletionRequestsTable;
  tombstones: TombstonesTable;
  allowanceResidue: AllowanceResidueTable;
  analyticsEvents: AnalyticsEventsTable;
  fixtureEmails: FixtureEmailsTable;
}

export type TableName = keyof Database;
export type Row<T extends TableName> = Selectable<Database[T]>;
export type NewRow<T extends TableName> = Insertable<Database[T]>;
export type RowUpdate<T extends TableName> = Updateable<Database[T]>;

export type Owner = Row<'owners'>;
export type User = Row<'users'>;
export type AnonymousSession = Row<'anonymousSessions'>;
export type Project = Row<'projects'>;
export type Property = Row<'properties'>;
export type SourceAsset = Row<'sourceAssets'>;
export type AssetPolicy = Row<'assetPolicies'>;
export type PermissionEvaluation = Row<'permissionEvaluations'>;
export type RenderJob = Row<'renderJobs'>;
export type SourceEnhancement = Row<'sourceEnhancements'>;
export type RenderAttempt = Row<'renderAttempts'>;
export type RenderAsset = Row<'renderAssets'>;
export type UsageLedgerEntry = Row<'usageLedger'>;
export type CountryCapability = Row<'countryCapabilities'>;
export type RuntimeSetting = Row<'runtimeSettings'>;
export type HolidayPackVersion = Row<'holidayPackVersions'>;
export type HolidayOccurrenceRow = Row<'holidayOccurrences'>;
export type HeroAsset = Row<'heroAssets'>;
export type ExampleAsset = Row<'exampleAssets'>;
export type StyleKitRow = Row<'styleKits'>;
export type KitItem = Row<'kitItems'>;
export type MerchantProgram = Row<'merchantPrograms'>;
export type Product = Row<'products'>;
export type Offer = Row<'offers'>;
export type ShareGrant = Row<'shareGrants'>;
