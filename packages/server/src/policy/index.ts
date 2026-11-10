import type {
  ActivationState,
  AppEnv,
  AssetPolicySubjectKind,
  AssetPolicyUseState,
  PermissionEvaluationContext,
  PipelineStage,
  SourceKind,
  StreetViewSourceMode,
} from '@holiday/core';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import { toJson } from '../db/client.js';
import type { DbOrTx } from '../db/client.js';
import type { AssetPolicy, PermissionResultJson } from '../db/schema.js';
import { newId } from '../ids/index.js';

/**
 * The evaluated view of an asset policy: one boolean per use plus attribution, expiry, territory
 * and the evidence record. Never persisted as truth; each evaluation is recorded in
 * `permission_evaluations`.
 */
export type AssetPermission = PermissionResultJson;

/** Uses stored on an asset policy row (train is always denied and not listed). */
export const POLICY_USES = [
  'display',
  'store',
  'aiProcess',
  'edit',
  'distributeDerivative',
  'commerceAdjacent',
] as const;
export type PolicyUse = (typeof POLICY_USES)[number];

/** Uses that a production `fixture` capability can never grant (the paid or licensed legs). */
const AI_LEG_USES: readonly PolicyUse[] = ['store', 'aiProcess', 'edit'];

/** The fields of an asset policy the evaluator reads. */
export type PolicyInput = Pick<
  AssetPolicy,
  | 'display'
  | 'store'
  | 'aiProcess'
  | 'edit'
  | 'distributeDerivative'
  | 'commerceAdjacent'
  | 'evidenceRef'
  | 'attributionText'
  | 'expiresAt'
  | 'revokedAt'
  | 'territory'
>;

export interface EvaluatePermissionInput {
  /** The stored policy; null means no policy exists, which denies every use. */
  policy: PolicyInput | null;
  /** The `country_capabilities` state applied to this evaluation. */
  capabilityState: ActivationState;
  appEnv: AppEnv;
  now: Date;
  /** Source kind of the asset; contributor Street View imagery is display-only by default. */
  sourceKind?: SourceKind;
  /** For Street View sources: whether the imagery is attributed to Google. */
  isGoogleImagery?: boolean | null;
  /** Whether a recorded license covers contributor imagery (default false). */
  contributorImageryLicensed?: boolean;
}

/** Evidence of the Street View policy template for live provider imagery (standard terms). */
export const STREET_VIEW_STANDARD_TERMS_EVIDENCE = 'google-maps-platform:standard-terms';
/** Evidence of the Street View policy template for fixture stand-in imagery (licensed photos). */
export const FIXTURE_STREET_VIEW_EVIDENCE = 'fixture:street-view-stand-in';

/** Where new Street View source imagery comes from in this process. */
export type StreetViewImagery = 'fixture' | 'live';

let processStreetViewImagery: StreetViewImagery = 'fixture';

/**
 * Records whether this process serves Street View imagery from the live provider or fixture
 * stand-ins; new Street View policy templates carry the matching evidence. Called once when the
 * server context is created from configuration.
 */
export function setStreetViewImagery(imagery: StreetViewImagery): void {
  processStreetViewImagery = imagery;
}

/**
 * Evaluates a three-valued policy into booleans:
 * - `allowed` is true and `denied` is false;
 * - `unknown` is false for live traffic (`live_private`, `live_public`) and in production;
 *   in `fixture` activation outside production it evaluates as allowed (fixture evidence only),
 *   except for Street View imagery from the live provider, which no fixture state may process;
 * - a revoked or expired policy denies every use;
 * - in production a `fixture` capability never grants storage, AI processing or editing;
 * - contributor Street View imagery is display-only unless a license covers it;
 * - `train` is always false.
 */
export function evaluatePermission(input: EvaluatePermissionInput): AssetPermission {
  const { policy, capabilityState, appEnv, now } = input;
  const denied: AssetPermission = {
    display: false,
    store: false,
    aiProcess: false,
    edit: false,
    distributeDerivative: false,
    commerceAdjacent: false,
    train: false,
    attribution: policy?.attributionText ?? null,
    expiresAt: policy?.expiresAt ? policy.expiresAt.toISOString() : null,
    territory: policy?.territory ?? null,
    evidenceId: policy?.evidenceRef ?? 'none',
  };
  if (!policy) return denied;
  if (policy.revokedAt && policy.revokedAt.getTime() <= now.getTime()) return denied;
  if (policy.expiresAt && policy.expiresAt.getTime() <= now.getTime()) return denied;

  const liveStreetViewImagery =
    input.sourceKind === 'street_view' &&
    policy.evidenceRef === STREET_VIEW_STANDARD_TERMS_EVIDENCE;
  const fixturePermissive =
    capabilityState === 'fixture' && appEnv !== 'production' && !liveStreetViewImagery;
  const resolve = (state: AssetPolicyUseState): boolean =>
    state === 'allowed' || (state === 'unknown' && fixturePermissive);

  const result: AssetPermission = { ...denied };
  for (const use of POLICY_USES) result[use] = resolve(policy[use]);

  if (capabilityState === 'fixture' && appEnv === 'production') {
    for (const use of AI_LEG_USES) result[use] = false;
  }
  if (
    input.sourceKind === 'street_view' &&
    input.isGoogleImagery === false &&
    !input.contributorImageryLicensed
  ) {
    for (const use of AI_LEG_USES) result[use] = false;
    result.distributeDerivative = false;
  }
  return result;
}

/**
 * Derives the Street View source mode from an evaluated permission (address spec derivation
 * table): no display → `unavailable`; display with AI processing and editing → `persist` when
 * storage is allowed, otherwise `transient`; anything else that may be displayed → `display_only`.
 */
export function streetViewSourceMode(
  permission: Pick<AssetPermission, 'display' | 'aiProcess' | 'edit' | 'store'>,
): StreetViewSourceMode {
  if (!permission.display) return 'unavailable';
  if (permission.aiProcess && permission.edit) return permission.store ? 'persist' : 'transient';
  return 'display_only';
}

/** Whether a source may be decorated at all: AI processing and editing are both required. */
export function isEditable(permission: Pick<AssetPermission, 'aiProcess' | 'edit'>): boolean {
  return permission.aiProcess && permission.edit;
}

export type PolicyTemplate = Record<PolicyUse, AssetPolicyUseState> & {
  evidenceRef: string;
  licenseVersion?: string | null;
  territory?: string | null;
  attributionText?: string | null;
  createdBy: string;
};

/**
 * Default asset policy for a new source asset:
 * - `upload`: the combined age-and-rights attestation allows display, storage, AI processing and
 *   editing; distribution and commerce adjacency are allowed unless the photo is private-only;
 * - `street_view`: standard terms allow display only; every other use is unknown until a
 *   licensing outcome is recorded (unknown evaluates as denied for live traffic);
 * - `fixture`: procedural fixture imagery allows every use (train stays denied).
 *
 * Street View evidence records whether the imagery comes from the live provider (standard terms)
 * or is a fixture stand-in; `imagery` defaults to this process's setting.
 */
export function defaultPolicyTemplate(
  sourceKind: SourceKind,
  options: {
    attestationVersion?: string | null;
    privateOnly?: boolean;
    attributionText?: string | null;
    imagery?: StreetViewImagery;
  } = {},
): PolicyTemplate {
  switch (sourceKind) {
    case 'upload':
      return {
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: options.privateOnly ? 'denied' : 'allowed',
        commerceAdjacent: 'allowed',
        evidenceRef: `attestation:${options.attestationVersion ?? 'unversioned'}`,
        createdBy: 'attestation',
      };
    case 'street_view':
      return {
        display: 'allowed',
        store: 'unknown',
        aiProcess: 'unknown',
        edit: 'unknown',
        distributeDerivative: 'unknown',
        commerceAdjacent: 'unknown',
        evidenceRef:
          (options.imagery ?? processStreetViewImagery) === 'live'
            ? STREET_VIEW_STANDARD_TERMS_EVIDENCE
            : FIXTURE_STREET_VIEW_EVIDENCE,
        territory: 'US',
        attributionText: options.attributionText ?? null,
        createdBy: 'system',
      };
    case 'fixture':
      return {
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: options.privateOnly ? 'denied' : 'allowed',
        commerceAdjacent: 'allowed',
        evidenceRef: 'fixture:procedural-art',
        attributionText: options.attributionText ?? null,
        createdBy: 'system',
      };
  }
}

/** Inserts an asset policy row and returns it. */
export async function createAssetPolicy(
  db: DbOrTx,
  input: {
    subjectKind: AssetPolicySubjectKind;
    subjectId: string;
    template: PolicyTemplate;
    expiresAt?: Date | null;
  },
): Promise<AssetPolicy> {
  const { template } = input;
  return db
    .insertInto('assetPolicies')
    .values({
      id: newId(),
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      display: template.display,
      store: template.store,
      aiProcess: template.aiProcess,
      edit: template.edit,
      distributeDerivative: template.distributeDerivative,
      commerceAdjacent: template.commerceAdjacent,
      evidenceRef: template.evidenceRef,
      licenseVersion: template.licenseVersion ?? null,
      territory: template.territory ?? null,
      attributionText: template.attributionText ?? null,
      expiresAt: input.expiresAt ?? null,
      createdBy: template.createdBy,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export interface RecordEvaluationInput {
  assetPolicyId: string;
  sourceAssetId: string | null;
  context: PermissionEvaluationContext;
  result: AssetPermission;
  capabilityState: ActivationState;
  jobId?: string | null;
  attemptId?: string | null;
  stage?: PipelineStage | null;
  evaluatedAt?: Date;
}

/** Stores one evaluation and returns its ID (referenced by render jobs and attempts). */
export async function recordPermissionEvaluation(
  db: DbOrTx,
  input: RecordEvaluationInput,
  clock: Clock = systemClock,
): Promise<string> {
  const id = newId();
  await db
    .insertInto('permissionEvaluations')
    .values({
      id,
      assetPolicyId: input.assetPolicyId,
      sourceAssetId: input.sourceAssetId,
      context: input.context,
      jobId: input.jobId ?? null,
      attemptId: input.attemptId ?? null,
      stage: input.stage ?? null,
      result: toJson(input.result),
      capabilityState: input.capabilityState,
      evaluatedAt: input.evaluatedAt ?? clock.now(),
    })
    .execute();
  return id;
}

/** Loads a policy, evaluates it and records the evaluation in one call. */
export async function evaluateAndRecord(
  db: DbOrTx,
  input: Omit<EvaluatePermissionInput, 'policy' | 'now'> &
    Omit<RecordEvaluationInput, 'result' | 'evaluatedAt'> & { clock?: Clock },
): Promise<{ evaluationId: string; permission: AssetPermission; policy: AssetPolicy | null }> {
  const clock = input.clock ?? systemClock;
  const now = clock.now();
  const policy =
    (await db
      .selectFrom('assetPolicies')
      .selectAll()
      .where('id', '=', input.assetPolicyId)
      .executeTakeFirst()) ?? null;
  const permission = evaluatePermission({ ...input, policy, now });
  const evaluationId = await recordPermissionEvaluation(
    db,
    { ...input, result: permission, evaluatedAt: now },
    clock,
  );
  return { evaluationId, permission, policy };
}
