import { z } from 'zod';

/** How far a capability is switched on. */
export const ACTIVATION_STATES = ['fixture', 'live_private', 'live_public'] as const;
export const ActivationStateSchema = z.enum(ACTIVATION_STATES);
export type ActivationState = z.infer<typeof ActivationStateSchema>;

/** Capability keys that are not per merchant program. */
export const BASE_CAPABILITY_KEYS = [
  'address_lookup',
  'street_view_display',
  'street_view_ai',
  'uploads',
  'image_editing',
  'vision_analysis',
  'content_screening',
  'sharing',
] as const;
export const BaseCapabilityKeySchema = z.enum(BASE_CAPABILITY_KEYS);
export type BaseCapabilityKey = z.infer<typeof BaseCapabilityKeySchema>;

export const COMMERCE_CAPABILITY_PREFIX = 'commerce:';

/** Merchant program identifiers inside a commerce capability key: a slug or a UUID. */
export const MERCHANT_PROGRAM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const COMMERCE_CAPABILITY_PATTERN = /^commerce:[a-z0-9][a-z0-9_-]{0,63}$/;

export type CommerceCapabilityKey = `commerce:${string}`;
export const CommerceCapabilityKeySchema = z
  .string()
  .regex(
    COMMERCE_CAPABILITY_PATTERN,
    'Expected commerce:<merchantProgramId>',
  ) as unknown as z.ZodType<CommerceCapabilityKey>;

/** One of the base capability keys or `commerce:<merchantProgramId>`. */
export type CapabilityKey = BaseCapabilityKey | CommerceCapabilityKey;
export const CapabilityKeySchema = z.union([BaseCapabilityKeySchema, CommerceCapabilityKeySchema]);

export function isCapabilityKey(value: string): value is CapabilityKey {
  return (
    (BASE_CAPABILITY_KEYS as readonly string[]).includes(value) ||
    COMMERCE_CAPABILITY_PATTERN.test(value)
  );
}

export function isCommerceCapabilityKey(value: string): value is CommerceCapabilityKey {
  return COMMERCE_CAPABILITY_PATTERN.test(value);
}

export function commerceCapabilityKey(merchantProgramId: string): CommerceCapabilityKey {
  const key = `${COMMERCE_CAPABILITY_PREFIX}${merchantProgramId}`;
  if (!COMMERCE_CAPABILITY_PATTERN.test(key)) {
    throw new RangeError(`Invalid merchant program id for a capability key: ${merchantProgramId}`);
  }
  return key as CommerceCapabilityKey;
}

export function merchantProgramIdFromCapability(key: string): string | null {
  return isCommerceCapabilityKey(key) ? key.slice(COMMERCE_CAPABILITY_PREFIX.length) : null;
}

/** Three-valued state of one use on an asset policy. */
export const ASSET_POLICY_USE_STATES = ['unknown', 'allowed', 'denied'] as const;
export const AssetPolicyUseStateSchema = z.enum(ASSET_POLICY_USE_STATES);
export type AssetPolicyUseState = z.infer<typeof AssetPolicyUseStateSchema>;

/** Uses an asset policy allows or denies; each is an AssetPermission field. */
export const ASSET_USES = [
  'display',
  'store',
  'aiProcess',
  'edit',
  'distributeDerivative',
  'train',
  'commerceAdjacent',
] as const;
export const AssetUseSchema = z.enum(ASSET_USES);
export type AssetUse = z.infer<typeof AssetUseSchema>;

/** Subject of an asset policy. */
export const ASSET_POLICY_SUBJECT_KINDS = ['source_asset', 'product_reference'] as const;
export const AssetPolicySubjectKindSchema = z.enum(ASSET_POLICY_SUBJECT_KINDS);
export type AssetPolicySubjectKind = z.infer<typeof AssetPolicySubjectKindSchema>;

/** When a permission evaluation was made. */
export const PERMISSION_EVALUATION_CONTEXTS = ['discovery', 'submission', 'pre_call'] as const;
export const PermissionEvaluationContextSchema = z.enum(PERMISSION_EVALUATION_CONTEXTS);
export type PermissionEvaluationContext = z.infer<typeof PermissionEvaluationContextSchema>;

/** Account roles. */
export const USER_ROLES = ['user', 'pilot', 'reviewer', 'operator'] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRoleSchema>;

/** Roles that see `live_private` capabilities. */
export const PRIVATE_AUDIENCE_ROLES: readonly UserRole[] = ['pilot', 'reviewer', 'operator'];

/** Owner kinds. */
export const OWNER_KINDS = ['anonymous', 'user'] as const;
export const OwnerKindSchema = z.enum(OWNER_KINDS);
export type OwnerKind = z.infer<typeof OwnerKindSchema>;

/** Single-use auth token purposes. */
export const AUTH_TOKEN_PURPOSES = ['magic_link', 'operator_reauth'] as const;
export const AuthTokenPurposeSchema = z.enum(AUTH_TOKEN_PURPOSES);
export type AuthTokenPurpose = z.infer<typeof AuthTokenPurposeSchema>;

/** Who created an asset policy row (plus operator user IDs). */
export const ASSET_POLICY_CREATORS = ['system', 'attestation'] as const;
