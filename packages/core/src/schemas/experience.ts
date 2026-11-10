import { z } from 'zod';
import {
  HolidayIdSchema,
  JourneyEmphasisSchema,
  LightingModeSchema,
  SceneTypeSchema,
  StyleSchema,
} from '../types/content.js';
import { CapabilityKeySchema } from '../types/rights.js';
import {
  AllowanceSchema,
  CopyKeySchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  RelativePathSchema,
} from './common.js';

/** `POST /v1/sessions` body. */
export const CreateSessionRequestSchema = z.strictObject({
  turnstileToken: z.string().min(1).max(4096),
  timezone: z.string().min(1).max(64).nullable().optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

/** `POST /v1/sessions` 201 response. */
export const CreateSessionResponseSchema = z.strictObject({
  expiresAt: IsoDateTimeSchema,
});
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

/** `GET /v1/experience` query. The holiday is an untrusted deep link; unknown values are ignored. */
export const ExperienceQuerySchema = z.strictObject({
  holiday: z.string().max(64).optional(),
});
export type ExperienceQuery = z.infer<typeof ExperienceQuerySchema>;

/** Offered styles and lighting modes for one scene type. */
export const OfferedSetSchema = z.strictObject({
  styles: z.array(StyleSchema),
  lightingModes: z.array(LightingModeSchema),
});
export type OfferedSet = z.infer<typeof OfferedSetSchema>;

/** Per-scene-type content offered by a pack, with defaults. */
export const SceneTypeOfferSchema = z.strictObject({
  styles: z.array(StyleSchema),
  defaultStyle: StyleSchema,
  lightingModes: z.array(LightingModeSchema),
  defaultLightingMode: LightingModeSchema,
});
export type SceneTypeOffer = z.infer<typeof SceneTypeOfferSchema>;

/** One holiday in the experience projection. */
export const ExperienceHolidaySchema = z.strictObject({
  id: HolidayIdSchema,
  nameKey: CopyKeySchema,
  isDefault: z.boolean(),
  journeyEmphasis: JourneyEmphasisSchema,
  inWindow: z.boolean(),
  windowStart: IsoDateSchema.nullable(),
  windowEnd: IsoDateSchema.nullable(),
  packVersion: z.string(),
  sceneTypes: z.partialRecord(SceneTypeSchema, SceneTypeOfferSchema),
});
export type ExperienceHoliday = z.infer<typeof ExperienceHolidaySchema>;

/** One enabled occurrence's promotion window. */
export const CalendarEntrySchema = z.strictObject({
  occurrenceKey: z.string(),
  holidayId: HolidayIdSchema,
  promotionStart: IsoDateSchema,
  promotionEnd: IsoDateSchema,
});
export type CalendarEntry = z.infer<typeof CalendarEntrySchema>;

/** One image rendition. */
export const RenditionSchema = z.strictObject({
  url: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
});
export type Rendition = z.infer<typeof RenditionSchema>;

/** The landing hero; `holidayId` null is the off-season neutral hero. */
export const HeroSchema = z.strictObject({
  holidayId: HolidayIdSchema.nullable(),
  sceneType: SceneTypeSchema.nullable(),
  renditions: z.strictObject({
    landscape: z.array(RenditionSchema),
    portrait: z.array(RenditionSchema),
  }),
  altKey: CopyKeySchema,
});
export type Hero = z.infer<typeof HeroSchema>;

/** One permissioned before/after example. */
export const ExampleSchema = z.strictObject({
  holidayId: HolidayIdSchema,
  sceneType: SceneTypeSchema,
  style: StyleSchema,
  lightingMode: LightingModeSchema,
  beforeUrl: z.string(),
  afterUrl: z.string(),
  width: z.int().positive(),
  height: z.int().positive(),
  captionKey: CopyKeySchema,
});
export type Example = z.infer<typeof ExampleSchema>;

/** Public projection of `country_capabilities` for the caller's audience. */
export const PublicCapabilitiesSchema = z.strictObject({
  addressLookup: z.boolean(),
  streetViewAi: z.boolean(),
  uploads: z.boolean(),
  sharing: z.boolean(),
  commerce: z.boolean(),
});
export type PublicCapabilities = z.infer<typeof PublicCapabilitiesSchema>;

/** Values the client must not hard-code. */
export const ClientConfigSchema = z.strictObject({
  autocompleteMinChars: z.int().positive(),
  autocompleteDebounceMs: z.int().nonnegative(),
  uploadMaxBytes: z.int().positive(),
  uploadAcceptedTypes: z.array(z.string()),
  pollRenderMs: z.int().positive(),
  pollUploadMs: z.int().positive(),
});
export type ClientConfig = z.infer<typeof ClientConfigSchema>;

export const LegalInfoSchema = z.strictObject({
  termsVersion: z.string(),
  ageLineKey: CopyKeySchema,
  termsUrl: RelativePathSchema,
  privacyUrl: RelativePathSchema,
});
export type LegalInfo = z.infer<typeof LegalInfoSchema>;

/** `GET /v1/experience` 200 response; also inlined in the landing shell. */
export const ExperienceSchema = z.strictObject({
  defaultHolidayId: HolidayIdSchema.nullable(),
  requestedHolidayId: HolidayIdSchema.nullable(),
  editorialTimezone: z.string(),
  offSeason: z.boolean(),
  holidays: z.array(ExperienceHolidaySchema),
  calendar: z.array(CalendarEntrySchema),
  hero: HeroSchema.nullable(),
  examples: z.array(ExampleSchema),
  capabilities: PublicCapabilitiesSchema,
  /**
   * Outside production only: the capability keys whose evaluated state for the caller is
   * `fixture`, so the client can badge stand-in imagery. Omitted in production.
   */
  fixtureCapabilities: z.array(CapabilityKeySchema).optional(),
  allowance: AllowanceSchema,
  clientConfig: ClientConfigSchema,
  legal: LegalInfoSchema,
});
export type Experience = z.infer<typeof ExperienceSchema>;
