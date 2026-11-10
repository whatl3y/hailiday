import { z } from 'zod';
import { AllowanceGateSchema } from '../types/api.js';

/** Server-generated entity ID (UUID; version 7 in practice). */
export const UuidSchema = z.uuid();
export type Uuid = z.infer<typeof UuidSchema>;

/** UTC ISO 8601 timestamp with a `Z` suffix. */
export const IsoDateTimeSchema = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

/** Calendar date `YYYY-MM-DD`, interpreted in the occurrence's editorial timezone. */
export const IsoDateSchema = z.iso.date();
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** ISO 3166-1 alpha-2 country code. */
export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'Expected ISO 3166-1 alpha-2');
export type CountryCode = z.infer<typeof CountryCodeSchema>;

/** Region of an occurrence or pack: a country code with an optional subdivision suffix. */
export const RegionSchema = z
  .string()
  .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, 'Expected ISO 3166-1 alpha-2 with optional subdivision');
export type Region = z.infer<typeof RegionSchema>;

/** ISO 4217 currency code. */
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Expected ISO 4217');
export type CurrencyCode = z.infer<typeof CurrencyCodeSchema>;

/** Customer-facing money in integer minor units. */
export const MoneySchema = z.strictObject({
  amountMinor: z.int().nonnegative(),
  currency: CurrencyCodeSchema,
});
export type Money = z.infer<typeof MoneySchema>;

/** Street View capture date as returned by the API (`YYYY-MM` or `YYYY`). */
export const CaptureDateSchema = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

/** Copy key owned by the experience copy deck. */
export const CopyKeySchema = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/, 'Expected a dotted copy key');

/** Lower-case slug used for content keys. */
export const SlugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'Expected a slug');

/** Opaque token string. */
export const OpaqueTokenSchema = z.string().min(1).max(512);

/** Absolute http(s) URL. */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** Relative app path for `returnTo` style fields: starts with one slash, never `//`. */
export const RelativePathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[^\s\\]*$/, 'Expected a relative path');

/** Non-negative integer count. */
export const CountSchema = z.int().nonnegative();

/** Default and maximum page sizes for lists. */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

/** Query parameters accepted by every paginated list. */
export const PaginationQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().max(512).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

/** `{ items, nextCursor }` list envelope. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/** One allowance counter. */
export const AllowanceCounterSchema = z.strictObject({
  limit: CountSchema,
  remaining: CountSchema,
  resetsAt: IsoDateTimeSchema.nullable(),
});
export type AllowanceCounter = z.infer<typeof AllowanceCounterSchema>;

/** Allowance object returned on experience, me, projects and renders. */
export const AllowanceSchema = z.strictObject({
  variants: AllowanceCounterSchema,
  addresses: AllowanceCounterSchema,
  gate: AllowanceGateSchema,
});
export type Allowance = z.infer<typeof AllowanceSchema>;

/** Empty JSON object body (`{}`). */
export const EmptyObjectSchema = z.strictObject({});
export type EmptyObject = z.infer<typeof EmptyObjectSchema>;
