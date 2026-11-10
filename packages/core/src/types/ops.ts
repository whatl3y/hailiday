import { z } from 'zod';

/** Retention classes for stored data. */
export const RETENTION_CLASSES = [
  'owner',
  'project',
  'job',
  'grant',
  'content',
  'ledger',
  'ops',
  'tombstone',
] as const;
export const RetentionClassSchema = z.enum(RETENTION_CLASSES);
export type RetentionClass = z.infer<typeof RetentionClassSchema>;

/** Usage ledger row kinds. */
export const LEDGER_KINDS = ['reservation', 'settlement', 'release', 'charge'] as const;
export const LedgerKindSchema = z.enum(LEDGER_KINDS);
export type LedgerKind = z.infer<typeof LedgerKindSchema>;

/** Usage ledger cost categories. */
export const LEDGER_CATEGORIES = [
  'google',
  'image_edit',
  'vision',
  'safety',
  'email',
  'storage',
] as const;
export const LedgerCategorySchema = z.enum(LEDGER_CATEGORIES);
export type LedgerCategory = z.infer<typeof LedgerCategorySchema>;

/** SKU values written to `usage_ledger.sku`. */
export const LEDGER_SKUS = [
  'places_autocomplete_requests',
  'places_details_essentials',
  'geocoding',
  'geocoding_search_destinations',
  'street_view_static_display',
  'street_view_static_fetch',
  'street_view_metadata',
  'image_edit_attempt',
  'vision_call',
  'screened_upload',
  'email',
] as const;
export const LedgerSkuSchema = z.enum(LEDGER_SKUS);
export type LedgerSku = z.infer<typeof LedgerSkuSchema>;

/** Keys of per-SKU daily spend ceilings. */
export const SPEND_CEILING_KEYS = [
  'places_autocomplete_requests',
  'places_details_essentials',
  'geocoding',
  'street_view_static',
  'image_edit_attempt',
  'vision_call',
  'screened_upload',
  'email',
] as const;
export const SpendCeilingKeySchema = z.enum(SPEND_CEILING_KEYS);
export type SpendCeilingKey = z.infer<typeof SpendCeilingKeySchema>;

/** The ceiling key a ledger SKU counts toward. */
export const LEDGER_SKU_CEILING_KEYS: Readonly<Record<LedgerSku, SpendCeilingKey>> = {
  places_autocomplete_requests: 'places_autocomplete_requests',
  places_details_essentials: 'places_details_essentials',
  geocoding: 'geocoding',
  geocoding_search_destinations: 'geocoding',
  street_view_static_display: 'street_view_static',
  street_view_static_fetch: 'street_view_static',
  street_view_metadata: 'street_view_static',
  image_edit_attempt: 'image_edit_attempt',
  vision_call: 'vision_call',
  screened_upload: 'screened_upload',
  email: 'email',
};

/** Deletion request scopes. */
export const DELETION_SCOPES = ['project', 'account', 'asset', 'expiry_sweep', 'takedown'] as const;
export const DeletionScopeSchema = z.enum(DELETION_SCOPES);
export type DeletionScope = z.infer<typeof DeletionScopeSchema>;

export const DELETION_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'held'] as const;
export const DeletionStatusSchema = z.enum(DELETION_STATUSES);
export type DeletionStatus = z.infer<typeof DeletionStatusSchema>;

export const DELETION_REQUESTERS = ['user', 'system', 'operator'] as const;
export const DeletionRequesterSchema = z.enum(DELETION_REQUESTERS);
export type DeletionRequester = z.infer<typeof DeletionRequesterSchema>;

export const TOMBSTONE_KINDS = [
  'owner',
  'project',
  'source_asset',
  'render_asset',
  'object_key',
  'share_token',
  'declined_checksum',
] as const;
export const TombstoneKindSchema = z.enum(TOMBSTONE_KINDS);
export type TombstoneKind = z.infer<typeof TombstoneKindSchema>;

export const PRESERVATION_HOLD_TARGET_KINDS = [
  'project',
  'source_asset',
  'render_asset',
  'report',
  'owner',
] as const;
export const PreservationHoldTargetKindSchema = z.enum(PRESERVATION_HOLD_TARGET_KINDS);
export type PreservationHoldTargetKind = z.infer<typeof PreservationHoldTargetKindSchema>;

export const PRESERVATION_HOLD_REASONS = [
  'mandatory_report',
  'complaint_investigation',
  'vendor_flag',
  'legal_process',
] as const;
export const PreservationHoldReasonSchema = z.enum(PRESERVATION_HOLD_REASONS);
export type PreservationHoldReason = z.infer<typeof PreservationHoldReasonSchema>;

export const BLOCKED_ADDRESS_SOURCES = [
  'homeowner_request',
  'operator',
  'google_blur_detected',
] as const;
export const BlockedAddressSourceSchema = z.enum(BLOCKED_ADDRESS_SOURCES);
export type BlockedAddressSource = z.infer<typeof BlockedAddressSourceSchema>;

export const AUDIT_ACTOR_KINDS = ['operator', 'reviewer', 'system', 'user'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

/** Runtime environments. */
export const APP_ENVS = ['development', 'test', 'staging', 'production'] as const;
export const AppEnvSchema = z.enum(APP_ENVS);
export type AppEnv = z.infer<typeof AppEnvSchema>;
