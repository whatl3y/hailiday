import { z } from 'zod';

/** Next steps the client may offer; returned on render status and some errors. */
export const PERMITTED_ACTIONS = [
  'retry',
  'cancel',
  'change_holiday',
  'change_style',
  'change_lighting',
  'view_cached_variants',
  'upload_photo',
  'choose_other_view',
  'confirm_place',
  'save_project',
  'share',
  'download',
  'shop',
  'report',
  'wait_for_reset',
  'crop',
  'keep',
  'replace',
] as const;
export const PermittedActionSchema = z.enum(PERMITTED_ACTIONS);
export type PermittedAction = z.infer<typeof PermittedActionSchema>;

/** The state the interface shows before any tap. */
export const ALLOWANCE_GATES = [
  'none',
  'allowance_variants',
  'allowance_addresses',
  'budget_paused',
  'at_capacity',
] as const;
export const AllowanceGateSchema = z.enum(ALLOWANCE_GATES);
export type AllowanceGate = z.infer<typeof AllowanceGateSchema>;

/** Which allowance ran out. */
export const ALLOWANCE_SCOPES = ['variants', 'addresses'] as const;
export const AllowanceScopeSchema = z.enum(ALLOWANCE_SCOPES);
export type AllowanceScope = z.infer<typeof AllowanceScopeSchema>;

/**
 * `VERIFICATION_REQUIRED` scopes: `device` when the render backstop's device dimension asks for a
 * fresh bot check. Other challenges send no scope.
 */
export const VERIFICATION_SCOPES = ['device'] as const;
export const VerificationScopeSchema = z.enum(VERIFICATION_SCOPES);
export type VerificationScope = z.infer<typeof VerificationScopeSchema>;

/** `RATE_LIMITED` scopes. */
export const RATE_LIMIT_SCOPES = [
  'attempts',
  'device',
  'suggestions',
  'session_tokens',
  'resolve',
  'geocode',
  'viewpoints',
  'sessions',
  'magic_link',
  'auth_verify',
  'reports',
  'shares',
  'uploads',
  'upload_bytes',
  'clicks',
  'analytics',
  'projects',
  'feedback',
] as const;
export const RateLimitScopeSchema = z.enum(RATE_LIMIT_SCOPES);
export type RateLimitScope = z.infer<typeof RateLimitScopeSchema>;

/** `BUDGET_PAUSED` reasons. */
export const BUDGET_PAUSED_REASONS = [
  'daily_ceiling',
  'monthly_ceiling',
  'sku_ceiling',
  'paused',
] as const;
export const BudgetPausedReasonSchema = z.enum(BUDGET_PAUSED_REASONS);
export type BudgetPausedReason = z.infer<typeof BudgetPausedReasonSchema>;

/** `SOURCE_NOT_EDITABLE` reasons. */
export const SOURCE_NOT_EDITABLE_REASONS = [
  'display_only',
  'permission_denied',
  'permission_unknown',
  'stale',
  'declined',
] as const;
export const SourceNotEditableReasonSchema = z.enum(SOURCE_NOT_EDITABLE_REASONS);
export type SourceNotEditableReason = z.infer<typeof SourceNotEditableReasonSchema>;

/** `FORBIDDEN` reasons. */
export const FORBIDDEN_REASONS = [
  'not_owner',
  'distribution_not_permitted',
  'private_only',
  'operator_required',
  'reauth_required',
  'origin_mismatch',
  'csrf',
  'upload_blocked',
] as const;
export const ForbiddenReasonSchema = z.enum(FORBIDDEN_REASONS);
export type ForbiddenReason = z.infer<typeof ForbiddenReasonSchema>;

/** `SHARE_REVOKED` reasons. */
export const SHARE_REVOKED_REASONS = ['revoked', 'expired', 'deleted'] as const;
export const ShareRevokedReasonSchema = z.enum(SHARE_REVOKED_REASONS);
export type ShareRevokedReason = z.infer<typeof ShareRevokedReasonSchema>;

/** `VALIDATION_FAILED` `details.reason` values. */
export const VALIDATION_FAILED_REASONS = [
  'not_ready',
  'scene_type_required',
  'content_cell_not_offered',
  'source_not_exportable',
  'upload_incomplete',
  'image_too_small',
  'unreadable',
  'version_conflict',
  'expired',
  'consumed',
  'unknown',
] as const;
export const ValidationFailedReasonSchema = z.enum(VALIDATION_FAILED_REASONS);
export type ValidationFailedReason = z.infer<typeof ValidationFailedReasonSchema>;

/** Reasons a magic-link verification fails. */
export const MAGIC_LINK_FAILURE_REASONS = ['expired', 'consumed', 'unknown'] as const;
export const MagicLinkFailureReasonSchema = z.enum(MAGIC_LINK_FAILURE_REASONS);
export type MagicLinkFailureReason = z.infer<typeof MagicLinkFailureReasonSchema>;

/** Report reasons. */
export const REPORT_REASONS = [
  'harmful_or_offensive',
  'privacy',
  'this_is_my_home',
  'child_pictured',
  'copyright',
  'other',
] as const;
export const ReportReasonSchema = z.enum(REPORT_REASONS);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

/** Copy keys for report reasons. */
export const REPORT_REASON_LABEL_KEYS: Readonly<Record<ReportReason, string>> = {
  harmful_or_offensive: 'report.harmful',
  privacy: 'report.privacy',
  this_is_my_home: 'report.myHome',
  child_pictured: 'report.child',
  copyright: 'report.copyright',
  other: 'report.other',
};

/** What a report targets. */
export const REPORT_TARGET_KINDS = ['share', 'render', 'project', 'address'] as const;
export const ReportTargetKindSchema = z.enum(REPORT_TARGET_KINDS);
export type ReportTargetKind = z.infer<typeof ReportTargetKindSchema>;

export const REPORT_STATUSES = ['open', 'triaged', 'actioned', 'dismissed'] as const;
export const ReportStatusSchema = z.enum(REPORT_STATUSES);
export type ReportStatus = z.infer<typeof ReportStatusSchema>;

export const REPORT_PRIORITIES = ['normal', 'urgent'] as const;
export const ReportPrioritySchema = z.enum(REPORT_PRIORITIES);
export type ReportPriority = z.infer<typeof ReportPrioritySchema>;

export const REPORT_RESOLUTION_ACTIONS = [
  'takedown',
  'block_address',
  'preservation_hold',
  'escalate_child_safety',
  'dismiss',
] as const;
export const ReportResolutionActionSchema = z.enum(REPORT_RESOLUTION_ACTIONS);
export type ReportResolutionAction = z.infer<typeof ReportResolutionActionSchema>;

/** Report acknowledgement copy keys. */
export const REPORT_ACKNOWLEDGEMENT_KEYS = ['report.thanks', 'optout.thanks'] as const;
export const ReportAcknowledgementKeySchema = z.enum(REPORT_ACKNOWLEDGEMENT_KEYS);
export type ReportAcknowledgementKey = z.infer<typeof ReportAcknowledgementKeySchema>;

/** Thumbs rating on a result. */
export const FEEDBACK_VERDICTS = ['up', 'down'] as const;
export const FeedbackVerdictSchema = z.enum(FEEDBACK_VERDICTS);
export type FeedbackVerdict = z.infer<typeof FeedbackVerdictSchema>;

/** Thumbs-down reason chips. */
export const FEEDBACK_REASONS = [
  'changed_home',
  'decor_wrong',
  'wrong_place',
  'looks_fake',
  'other',
] as const;
export const FeedbackReasonSchema = z.enum(FEEDBACK_REASONS);
export type FeedbackReason = z.infer<typeof FeedbackReasonSchema>;

/** Copy keys for feedback reason chips. */
export const FEEDBACK_REASON_LABEL_KEYS: Readonly<Record<FeedbackReason, string>> = {
  changed_home: 'feedback.changedHome',
  decor_wrong: 'feedback.decorWrong',
  wrong_place: 'feedback.wrongPlace',
  looks_fake: 'feedback.looksFake',
  other: 'feedback.other',
};

/** Attribution logos the client knows how to draw. */
export const ATTRIBUTION_LOGOS = ['google_maps'] as const;
export const AttributionLogoSchema = z.enum(ATTRIBUTION_LOGOS);
export type AttributionLogo = z.infer<typeof AttributionLogoSchema>;

/** API auth levels. */
export const AUTH_LEVELS = ['public', 'session', 'owner', 'user', 'operator'] as const;
export const AuthLevelSchema = z.enum(AUTH_LEVELS);
export type AuthLevel = z.infer<typeof AuthLevelSchema>;
