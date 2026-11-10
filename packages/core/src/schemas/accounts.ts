import { z } from 'zod';
import { UserRoleSchema } from '../types/rights.js';
import { AllowanceSchema, CountSchema, RelativePathSchema, UuidSchema } from './common.js';

/** `POST /v1/auth/magic-link` body; 202 `{}` regardless of whether the email exists. */
export const MagicLinkRequestSchema = z.strictObject({
  email: z.email().max(320),
  returnTo: RelativePathSchema.optional(),
});
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkResponseSchema = z.strictObject({});

/**
 * `POST /v1/auth/verify` body. `confirm: true` completes a sign-in that the server answered with
 * `confirmationRequired` (a link opened in a browser other than the one that asked for it).
 */
export const VerifyMagicLinkRequestSchema = z.strictObject({
  token: z.string().min(1).max(512),
  confirm: z.boolean().optional(),
});
export type VerifyMagicLinkRequest = z.infer<typeof VerifyMagicLinkRequestSchema>;

/** The signed-in user. */
export const UserSchema = z.strictObject({
  id: UuidSchema,
  email: z.email(),
  roles: z.array(UserRoleSchema),
});
export type User = z.infer<typeof UserSchema>;

/** `POST /v1/auth/verify` 200 response when the verifying session is now signed in. */
export const VerifyMagicLinkSignedInSchema = z.strictObject({
  user: UserSchema,
  claimedProjects: CountSchema,
  returnTo: RelativePathSchema.nullable(),
});
export type VerifyMagicLinkSignedIn = z.infer<typeof VerifyMagicLinkSignedInSchema>;

/**
 * `POST /v1/auth/verify` 200 response when the link was requested from another browser: nothing
 * changed and the token is still unused. `emailHint` is the account email with everything but the
 * first character of the local part masked (`t•••@example.com`).
 */
export const VerifyMagicLinkConfirmationSchema = z.strictObject({
  confirmationRequired: z.literal(true),
  emailHint: z.string().min(1).max(320),
});
export type VerifyMagicLinkConfirmation = z.infer<typeof VerifyMagicLinkConfirmationSchema>;

/** `POST /v1/auth/verify` 200 response: signed in, or a confirmation is required first. */
export const VerifyMagicLinkResponseSchema = z.union([
  VerifyMagicLinkSignedInSchema,
  VerifyMagicLinkConfirmationSchema,
]);
export type VerifyMagicLinkResponse = z.infer<typeof VerifyMagicLinkResponseSchema>;

/** True when a verify response asks the person to confirm the sign-in. */
export function isVerifyConfirmationRequired(
  response: VerifyMagicLinkResponse,
): response is VerifyMagicLinkConfirmation {
  return 'confirmationRequired' in response && response.confirmationRequired === true;
}

/**
 * The masked email shown when confirming a cross-browser sign-in: the first character of the
 * local part, a run of bullets, then the full domain.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}

/** `GET /v1/me` 200 response. */
export const MeSchema = z.strictObject({
  user: UserSchema.nullable(),
  allowance: AllowanceSchema,
  savedProjects: CountSchema,
});
export type Me = z.infer<typeof MeSchema>;

/** `DELETE /v1/me` 202 response. */
export const DeleteMeResponseSchema = z.strictObject({ deletionRequestId: UuidSchema });
export type DeleteMeResponse = z.infer<typeof DeleteMeResponseSchema>;

/** Normalizes an email the way `users.email_normalized` stores it. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
