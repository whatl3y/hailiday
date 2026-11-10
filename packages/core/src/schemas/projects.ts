import { z } from 'zod';
import { AttributionLogoSchema } from '../types/api.js';
import {
  BuildingFormSchema,
  HolidayIdSchema,
  LightingModeSchema,
  RoomTypeSchema,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import { DeletionStatusSchema } from '../types/ops.js';
import {
  CandidateFlagSchema,
  CaptureGranularitySchema,
  ClientSkipReasonSchema,
  DiscoveryNextActionSchema,
  EntryMethodSchema,
  HeadingModeSchema,
  MatchClassSchema,
  PrecisionSchema,
  ProjectKindSchema,
  SourceAssetStateSchema,
  SourceKindSchema,
  StreetViewSourceModeSchema,
} from '../types/source.js';
import { NormalizedBoxSchema } from './box.js';
import { StraightenDegreesSchema } from './straighten.js';
import {
  AllowanceSchema,
  CaptureDateSchema,
  CountryCodeSchema,
  CountSchema,
  IsoDateTimeSchema,
  PaginationQuerySchema,
  UuidSchema,
  paginated,
} from './common.js';
import { OfferedSetSchema } from './experience.js';

/** Property summary on an address project. */
export const ProjectPropertySchema = z.strictObject({
  id: UuidSchema,
  formattedAddress: z.string().nullable(),
  precision: PrecisionSchema,
  multiUnit: z.boolean(),
  countryCode: CountryCodeSchema,
});
export type ProjectProperty = z.infer<typeof ProjectPropertySchema>;

/** The project's active source. */
export const ActiveSourceSchema = z.strictObject({
  sourceAssetId: UuidSchema,
  kind: SourceKindSchema,
  state: SourceAssetStateSchema,
  sourceMode: StreetViewSourceModeSchema.nullable(),
  displayUrl: z.string().nullable(),
  captureDate: CaptureDateSchema.nullable(),
  copyright: z.string().nullable(),
  isGoogleImagery: z.boolean().nullable(),
  width: z.int().positive().nullable(),
  height: z.int().positive().nullable(),
  peopleDetected: z.boolean(),
  privateOnly: z.boolean(),
});
export type ActiveSource = z.infer<typeof ActiveSourceSchema>;

/** Discovery summary on a project. */
export const ProjectDiscoverySummarySchema = z.strictObject({
  matchClass: MatchClassSchema,
  reason: ClientSkipReasonSchema.nullable(),
  sourceMode: StreetViewSourceModeSchema,
  candidateCount: CountSchema,
  remainingDisplayLoads: CountSchema,
});
export type ProjectDiscoverySummary = z.infer<typeof ProjectDiscoverySummarySchema>;

/** Shared `Project` object. */
export const ProjectSchema = z.strictObject({
  id: UuidSchema,
  kind: ProjectKindSchema,
  projectVersion: z.int().nonnegative(),
  holidayId: HolidayIdSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  sceneType: SceneTypeSchema.nullable(),
  buildingForm: BuildingFormSchema.nullable(),
  roomType: RoomTypeSchema.nullable(),
  property: ProjectPropertySchema.nullable(),
  activeSource: ActiveSourceSchema.nullable(),
  discovery: ProjectDiscoverySummarySchema.nullable(),
  offered: OfferedSetSchema.nullable(),
  activeRenderJobId: UuidSchema.nullable(),
  variantCount: CountSchema,
  saved: z.boolean(),
  expiresAt: IsoDateTimeSchema.nullable(),
  lastActivityAt: IsoDateTimeSchema,
  allowance: AllowanceSchema,
});
export type Project = z.infer<typeof ProjectSchema>;

/** `{ project }` envelope used by several endpoints. */
export const ProjectResponseSchema = z.strictObject({ project: ProjectSchema });
export type ProjectResponse = z.infer<typeof ProjectResponseSchema>;

/** `POST /v1/projects` body (upload-first projects only). */
export const CreateProjectRequestSchema = z.strictObject({
  kind: z.literal('upload'),
  sceneType: SceneTypeSchema.optional(),
  holidayId: HolidayIdSchema.optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/** `GET /v1/projects` query and response. */
export const ProjectListQuerySchema = PaginationQuerySchema;
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;
export const ProjectListResponseSchema = paginated(ProjectSchema);
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;

/** `DELETE /v1/projects/:id` 202 response. */
export const DeleteProjectResponseSchema = z.strictObject({
  deletionRequestId: UuidSchema,
  status: DeletionStatusSchema,
});
export type DeleteProjectResponse = z.infer<typeof DeleteProjectResponseSchema>;

/** Route params with an `:id`. */
export const IdParamsSchema = z.strictObject({ id: UuidSchema });
export type IdParams = z.infer<typeof IdParamsSchema>;

/** One candidate viewpoint. */
export const CandidateSchema = z.strictObject({
  candidateId: z.string().min(1),
  derivedFromCandidateId: z.string().nullable().optional(),
  isPrimary: z.boolean(),
  rank: z.int().positive(),
  displayUrl: z.string().nullable(),
  heading: z.number().min(0).lt(360),
  headingMode: HeadingModeSchema,
  pitch: z.number(),
  fov: z.number().positive(),
  captureDate: CaptureDateSchema.nullable(),
  captureGranularity: CaptureGranularitySchema,
  copyright: z.string().nullable(),
  isGoogleImagery: z.boolean(),
  distanceMeters: z.number().nonnegative(),
  estimatedFacadePx: z.number().nonnegative().nullable(),
  flags: z.array(CandidateFlagSchema),
  width: z.int().positive(),
  height: z.int().positive(),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** Attribution requirements for Street View imagery in discovery. */
export const DiscoveryAttributionSchema = z.strictObject({
  logo: AttributionLogoSchema,
  required: z.boolean(),
});

/** Discovery result as the client sees it (blocked addresses projected to `unavailable`). */
export const DiscoverySchema = z.strictObject({
  discoveryId: UuidSchema,
  projectVersion: z.int().nonnegative(),
  entryMethod: EntryMethodSchema,
  matchClass: MatchClassSchema,
  reason: ClientSkipReasonSchema.nullable(),
  retryable: z.boolean(),
  sourceMode: StreetViewSourceModeSchema,
  thresholdsVersion: z.string(),
  sourceAssetId: UuidSchema.nullable(),
  remainingDisplayLoads: CountSchema,
  candidates: z.array(CandidateSchema).max(3),
  attribution: DiscoveryAttributionSchema.nullable(),
  nextAction: DiscoveryNextActionSchema,
});
export type Discovery = z.infer<typeof DiscoverySchema>;

/** `POST /v1/projects/:id/source-discovery` body and response. */
export const SourceDiscoveryRequestSchema = z.strictObject({
  projectVersion: z.int().nonnegative(),
});
export type SourceDiscoveryRequest = z.infer<typeof SourceDiscoveryRequestSchema>;

export const SourceDiscoveryResponseSchema = z.strictObject({
  discovery: DiscoverySchema,
  project: ProjectSchema,
});
export type SourceDiscoveryResponse = z.infer<typeof SourceDiscoveryResponseSchema>;

/**
 * How a client resolves `PEOPLE_DETECTED`. A crop may straighten the photo first: `rotation` (in
 * degrees, clockwise positive, at most 15 either way) turns it about its center with the zoom
 * that leaves no empty corners, and `box` is normalized on that straightened view.
 */
export const PeopleResolutionInputSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('crop'),
    box: NormalizedBoxSchema,
    rotation: StraightenDegreesSchema.optional(),
  }),
  z.strictObject({ action: z.literal('keep') }),
]);
export type PeopleResolutionInput = z.infer<typeof PeopleResolutionInputSchema>;

/** `PUT /v1/projects/:id/source` body binding a Street View candidate. */
export const PutCandidateSourceRequestSchema = z.strictObject({
  projectVersion: z.int().nonnegative(),
  candidateId: z.string().min(1),
});

/** `PUT /v1/projects/:id/source` body binding an upload. */
export const PutUploadSourceRequestSchema = z.strictObject({
  projectVersion: z.int().nonnegative(),
  sourceAssetId: UuidSchema,
  sceneType: SceneTypeSchema.optional(),
  roomType: RoomTypeSchema.nullable().optional(),
  buildingForm: BuildingFormSchema.nullable().optional(),
  peopleResolution: PeopleResolutionInputSchema.optional(),
});

export const PutSourceRequestSchema = z.union([
  PutCandidateSourceRequestSchema,
  PutUploadSourceRequestSchema,
]);
export type PutSourceRequest = z.infer<typeof PutSourceRequestSchema>;

export function isCandidateSourceRequest(
  body: PutSourceRequest,
): body is z.infer<typeof PutCandidateSourceRequestSchema> {
  return 'candidateId' in body;
}

/** Default nudge grammar; the server reads its configured bounds. */
export const NUDGE_HEADING_STEP_DEGREES = 15;
export const NUDGE_HEADING_MAX_DEGREES = 30;
export const NUDGE_FOV_STEPS: readonly number[] = [60, 75, 90];

export const NudgeSchema = z.strictObject({
  headingDelta: z.number().min(-180).max(180),
  fov: z.number().positive().max(120),
});
export type Nudge = z.infer<typeof NudgeSchema>;

/** Whether a nudge is inside the default bounds. */
export function isNudgeWithinBounds(
  nudge: Nudge,
  bounds: { step: number; max: number; fovSteps: readonly number[] } = {
    step: NUDGE_HEADING_STEP_DEGREES,
    max: NUDGE_HEADING_MAX_DEGREES,
    fovSteps: NUDGE_FOV_STEPS,
  },
): boolean {
  return (
    Math.abs(nudge.headingDelta) <= bounds.max &&
    Number.isInteger(nudge.headingDelta / bounds.step) &&
    bounds.fovSteps.includes(nudge.fov)
  );
}

/** `PUT /v1/projects/:id/viewpoint` body and response. */
export const ViewpointRequestSchema = z.strictObject({
  projectVersion: z.int().nonnegative(),
  candidateId: z.string().min(1),
  nudge: NudgeSchema.optional(),
});
export type ViewpointRequest = z.infer<typeof ViewpointRequestSchema>;

export const ViewpointResponseSchema = z.strictObject({
  candidate: CandidateSchema,
  remainingDisplayLoads: CountSchema,
});
export type ViewpointResponse = z.infer<typeof ViewpointResponseSchema>;
