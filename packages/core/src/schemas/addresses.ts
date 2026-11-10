import { z } from 'zod';
import { HolidayIdSchema } from '../types/content.js';
import { PrecisionSchema } from '../types/source.js';
import { IsoDateTimeSchema } from './common.js';
import { ProjectSchema } from './projects.js';

/** Autocomplete session tokens are UUID v4 minted by the server. */
export const SessionTokenSchema = z.uuid();

/** `GET /v1/addresses/suggestions` query. */
export const AddressSuggestionsQuerySchema = z.strictObject({
  q: z.string().trim().min(1).max(200),
  sessionToken: SessionTokenSchema.optional(),
});
export type AddressSuggestionsQuery = z.infer<typeof AddressSuggestionsQuerySchema>;

export const AddressSuggestionSchema = z.strictObject({
  placeId: z.string().min(1),
  primaryText: z.string(),
  secondaryText: z.string(),
});
export type AddressSuggestion = z.infer<typeof AddressSuggestionSchema>;

/** `GET /v1/addresses/suggestions` 200 response. */
export const AddressSuggestionsResponseSchema = z.strictObject({
  sessionToken: SessionTokenSchema,
  suggestions: z.array(AddressSuggestionSchema),
});
export type AddressSuggestionsResponse = z.infer<typeof AddressSuggestionsResponseSchema>;

/** `POST /v1/addresses/resolve` body, autocomplete path. */
export const ResolveAutocompleteRequestSchema = z.strictObject({
  placeId: z.string().min(1).max(512),
  sessionToken: SessionTokenSchema,
  holidayId: HolidayIdSchema.optional(),
});

/** `POST /v1/addresses/resolve` body, manual path. */
export const ResolveManualRequestSchema = z.strictObject({
  candidateId: z.string().min(1).max(4096),
  holidayId: HolidayIdSchema.optional(),
});

export const ResolveAddressRequestSchema = z.union([
  ResolveAutocompleteRequestSchema,
  ResolveManualRequestSchema,
]);
export type ResolveAddressRequest = z.infer<typeof ResolveAddressRequestSchema>;

export function isManualResolveRequest(
  body: ResolveAddressRequest,
): body is z.infer<typeof ResolveManualRequestSchema> {
  return 'candidateId' in body;
}

/** `POST /v1/addresses/resolve` 201 response. */
export const ResolveAddressResponseSchema = z.strictObject({ project: ProjectSchema });
export type ResolveAddressResponse = z.infer<typeof ResolveAddressResponseSchema>;

/** `POST /v1/addresses/geocode` body (manual entry). */
export const GeocodeRequestSchema = z.strictObject({
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(2).max(50),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}(-\d{4})?$/, 'Expected a US ZIP code'),
});
export type GeocodeRequest = z.infer<typeof GeocodeRequestSchema>;

export const GeocodeCandidateSchema = z.strictObject({
  candidateId: z.string().min(1),
  formattedAddress: z.string(),
  precision: PrecisionSchema,
  partialMatch: z.boolean(),
  multiUnit: z.boolean(),
  expiresAt: IsoDateTimeSchema,
});
export type GeocodeCandidate = z.infer<typeof GeocodeCandidateSchema>;

/** `POST /v1/addresses/geocode` 200 response. */
export const GeocodeResponseSchema = z.strictObject({
  candidates: z.array(GeocodeCandidateSchema),
});
export type GeocodeResponse = z.infer<typeof GeocodeResponseSchema>;
