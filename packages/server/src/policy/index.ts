import type {
  ActivationState,
  AppEnv,
  AssetPolicySubjectKind,
  AssetPolicyUseState,
  PermissionEvaluationContext,
  PipelineStage,
  SourceKind,
  StreetViewSourceMode,
} from '@hailiday/core';
import type { Clock } from '../clock/index.js';
import { systemClock } from '../clock/index.js';
import { DEFAULT_STREET_VIEW_USE_POLICY, STREET_VIEW_USE_POLICIES } from '../config/index.js';
import type {
  AppConfig,
  StreetViewContributorImagery,
  StreetViewUsePolicy,
} from '../config/index.js';
import { toJson } from '../db/client.js';
import type { DbOrTx } from '../db/client.js';
import type { AssetPolicy, PermissionResultJson } from '../db/schema.js';
import { isFixturePhotoCopyright } from '../fixtures/copyright.js';
import { newId } from '../ids/index.js';

export * from './blocked.js';

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
  /** Source kind of the asset (see `contributorImagery` for Street View sources). */
  sourceKind?: SourceKind;
  /**
   * For Street View sources: whether the imagery is attributed to Google. Anything but `true`
   * (contributor imagery, or not known) is treated as contributor imagery.
   */
  isGoogleImagery?: boolean | null;
  /**
   * For Street View sources: the imagery's copyright line. Only a fixture stand-in photograph
   * (`Fixture photo: …`) is fixture imagery; any other line, or none, is live provider imagery,
   * which a `fixture` capability may never store, process or edit.
   */
  copyright?: string | null;
  /**
   * How Street View imagery that is not attributed to Google is treated
   * (`STREET_VIEW_CONTRIBUTOR_IMAGERY`): `decorate` gives it every use the policy gives
   * Google-attributed imagery; `display_only` makes it display-only unless
   * `contributorImageryLicensed`. Every evaluation passes the configured value
   * (`permissionSettingsOf`).
   */
  contributorImagery: StreetViewContributorImagery;
  /** Whether a recorded license covers contributor imagery (default false). */
  contributorImageryLicensed?: boolean;
}

/**
 * The configured inputs of every permission evaluation: the environment, and how Street View
 * imagery not attributed to Google is treated. Each call of `evaluatePermission`,
 * `policyAllowsUse`, `policyAllowsStore` and `evaluateAndRecord` spreads it, so none evaluates
 * without the contributor imagery setting.
 */
export function permissionSettingsOf(
  config: Pick<AppConfig, 'appEnv'> & {
    streetView: Pick<AppConfig['streetView'], 'contributorImagery'>;
  },
): Pick<EvaluatePermissionInput, 'appEnv' | 'contributorImagery'> {
  return { appEnv: config.appEnv, contributorImagery: config.streetView.contributorImagery };
}

/** Evidence of the Street View policy template for live provider imagery (standard terms). */
export const STREET_VIEW_STANDARD_TERMS_EVIDENCE = 'google-maps-platform:standard-terms';
/** Evidence of the Street View policy template for fixture stand-in imagery (licensed photos). */
export const FIXTURE_STREET_VIEW_EVIDENCE = 'fixture:street-view-stand-in';
/** Evidence of the Street View policy templates of the `full` and `decorate` use policies. */
export const STREET_VIEW_OWNER_DECISION_EVIDENCE = 'owner-decision:2026-11-10';
/**
 * `created_by` of a Street View policy row written from a template. Only rows carrying it follow
 * the configured use policy; a deliberate edit records another `created_by`.
 */
export const STREET_VIEW_TEMPLATE_CREATOR = 'system:street-view-template';

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

/** A permission that denies every use, carrying the policy's attribution and evidence. */
export function deniedPermission(policy: PolicyInput | null): AssetPermission {
  return {
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
}

/**
 * Whether a Street View source shows live provider imagery: a row recorded under the
 * standard-terms template, or imagery whose copyright is not a fixture stand-in's.
 */
function isLiveStreetViewImagery(
  input: Pick<EvaluatePermissionInput, 'sourceKind' | 'copyright'>,
  policy: Pick<PolicyInput, 'evidenceRef'>,
): boolean {
  return (
    input.sourceKind === 'street_view' &&
    (policy.evidenceRef === STREET_VIEW_STANDARD_TERMS_EVIDENCE ||
      !isFixturePhotoCopyright(input.copyright))
  );
}

/**
 * Evaluates a three-valued policy into booleans:
 * - `allowed` is true and `denied` is false;
 * - `unknown` is false for live traffic (`live_private`, `live_public`) and in production;
 *   in `fixture` activation outside production it evaluates as allowed (fixture evidence only),
 *   except for Street View imagery from the live provider;
 * - a revoked or expired policy denies every use;
 * - a `fixture` capability never grants storage, AI processing or editing in production, nor
 *   anywhere for Street View imagery from the live provider (a fixture leg cannot know a real
 *   panorama, so it must never judge or decorate one);
 * - Street View imagery that is not attributed to Google (or not known to be) is evaluated like
 *   Google-attributed imagery when `contributorImagery` is `decorate`; when it is `display_only`
 *   such imagery is display-only unless a license covers contributor imagery;
 * - `train` is always false.
 */
export function evaluatePermission(input: EvaluatePermissionInput): AssetPermission {
  const { policy, capabilityState, appEnv, now } = input;
  const denied = deniedPermission(policy);
  if (!policy) return denied;
  if (policy.revokedAt && policy.revokedAt.getTime() <= now.getTime()) return denied;
  if (policy.expiresAt && policy.expiresAt.getTime() <= now.getTime()) return denied;

  const liveStreetViewImagery = isLiveStreetViewImagery(input, policy);
  const fixturePermissive =
    capabilityState === 'fixture' && appEnv !== 'production' && !liveStreetViewImagery;
  const resolve = (state: AssetPolicyUseState): boolean =>
    state === 'allowed' || (state === 'unknown' && fixturePermissive);

  const result: AssetPermission = { ...denied };
  for (const use of POLICY_USES) result[use] = resolve(policy[use]);

  if (capabilityState === 'fixture' && (appEnv === 'production' || liveStreetViewImagery)) {
    for (const use of AI_LEG_USES) result[use] = false;
  }
  if (
    input.sourceKind === 'street_view' &&
    input.isGoogleImagery !== true &&
    input.contributorImagery === 'display_only' &&
    !input.contributorImageryLicensed
  ) {
    for (const use of AI_LEG_USES) result[use] = false;
    result.distributeDerivative = false;
  }
  return result;
}

/**
 * Whether the policy itself still allows a use of the source, whatever the capability state: the
 * policy evaluated as for live traffic, except fixture stand-in imagery under a `fixture`
 * capability outside production, which follows the fixture rule. What a policy no longer allows
 * is undone (a stored copy deleted, share links revoked); a capability that is merely not live or
 * missing never undoes anything.
 */
export function policyAllowsUse(input: EvaluatePermissionInput, use: PolicyUse): boolean {
  const fixtureImagery =
    input.capabilityState === 'fixture' &&
    input.appEnv !== 'production' &&
    !(input.policy && isLiveStreetViewImagery(input, input.policy));
  return evaluatePermission({
    ...input,
    capabilityState: fixtureImagery ? 'fixture' : 'live_public',
  })[use];
}

/** Whether the policy itself still allows storing the source (see `policyAllowsUse`). */
export function policyAllowsStore(input: EvaluatePermissionInput): boolean {
  return policyAllowsUse(input, 'store');
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

type PolicyUses = Record<PolicyUse, AssetPolicyUseState>;

/** The uses a new Street View policy records under each use policy. */
const STREET_VIEW_USES: Readonly<Record<StreetViewUsePolicy, Readonly<PolicyUses>>> = {
  full: {
    display: 'allowed',
    store: 'allowed',
    aiProcess: 'allowed',
    edit: 'allowed',
    distributeDerivative: 'allowed',
    commerceAdjacent: 'allowed',
  },
  decorate: {
    display: 'allowed',
    store: 'denied',
    aiProcess: 'allowed',
    edit: 'allowed',
    distributeDerivative: 'denied',
    commerceAdjacent: 'denied',
  },
  display_only: {
    display: 'allowed',
    store: 'unknown',
    aiProcess: 'unknown',
    edit: 'unknown',
    distributeDerivative: 'unknown',
    commerceAdjacent: 'unknown',
  },
};

/** The evidence references a Street View template row may carry under each use policy. */
function streetViewTemplateEvidence(usePolicy: StreetViewUsePolicy): readonly string[] {
  return usePolicy === 'display_only'
    ? [STREET_VIEW_STANDARD_TERMS_EVIDENCE, FIXTURE_STREET_VIEW_EVIDENCE]
    : [STREET_VIEW_OWNER_DECISION_EVIDENCE];
}

/**
 * Default asset policy for a new source asset:
 * - `upload`: the combined age-and-rights attestation allows display, storage, AI processing and
 *   editing; distribution and commerce adjacency are allowed unless the photo is private-only;
 * - `street_view`: follows the Street View use policy (`usePolicy`, default `full`). `full`
 *   allows every use, like an uploaded photo; `decorate` allows display, AI processing and editing
 *   and denies storage, distribution and commerce adjacency; both carry the owner-decision
 *   evidence. `display_only` allows display and leaves every other use unknown (unknown evaluates
 *   as denied for live traffic), with evidence recording whether the imagery comes from the live
 *   provider (standard terms) or is a fixture stand-in (`imagery`, default this process's setting);
 * - `fixture`: procedural fixture imagery allows every use (train stays denied).
 */
export function defaultPolicyTemplate(
  sourceKind: SourceKind,
  options: {
    attestationVersion?: string | null;
    privateOnly?: boolean;
    attributionText?: string | null;
    imagery?: StreetViewImagery;
    usePolicy?: StreetViewUsePolicy;
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
    case 'street_view': {
      const usePolicy = options.usePolicy ?? DEFAULT_STREET_VIEW_USE_POLICY;
      const evidenceRef =
        usePolicy !== 'display_only'
          ? STREET_VIEW_OWNER_DECISION_EVIDENCE
          : (options.imagery ?? processStreetViewImagery) === 'live'
            ? STREET_VIEW_STANDARD_TERMS_EVIDENCE
            : FIXTURE_STREET_VIEW_EVIDENCE;
      return {
        ...STREET_VIEW_USES[usePolicy],
        evidenceRef,
        territory: 'US',
        attributionText: options.attributionText ?? null,
        createdBy: STREET_VIEW_TEMPLATE_CREATOR,
      };
    }
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

/** The template a new Street View source or discovery gets under a configuration. */
export function streetViewPolicyTemplateFor(
  config: Pick<AppConfig, 'providers'> & { streetView: Pick<AppConfig['streetView'], 'usePolicy'> },
): PolicyTemplate {
  return defaultPolicyTemplate('street_view', {
    attributionText: 'Google Maps',
    usePolicy: config.streetView.usePolicy,
    imagery: config.providers.streetView === 'google' ? 'live' : 'fixture',
  });
}

/** The use policy whose template a stored row matches (uses and evidence), or null. */
function templateUsePolicyOf(
  policy: Pick<AssetPolicy, PolicyUse | 'evidenceRef'>,
): StreetViewUsePolicy | null {
  return (
    STREET_VIEW_USE_POLICIES.find(
      (usePolicy) =>
        streetViewTemplateEvidence(usePolicy).includes(policy.evidenceRef) &&
        POLICY_USES.every((use) => policy[use] === STREET_VIEW_USES[usePolicy][use]),
    ) ?? null
  );
}

/**
 * Whether a stored policy is an unchanged Street View template row: written from a template
 * (`created_by` is `STREET_VIEW_TEMPLATE_CREATOR`) with no license version, expiry or revocation,
 * territory `US`, and uses and evidence equal to the template of one of the use policies. A row
 * recorded or edited deliberately carries another `created_by` and is never treated as one.
 */
export function isStreetViewTemplatePolicy(
  policy: Pick<AssetPolicy, PolicyUse | 'evidenceRef' | 'createdBy' | 'licenseVersion'> &
    Pick<AssetPolicy, 'expiresAt' | 'revokedAt' | 'territory'>,
): boolean {
  if (policy.createdBy !== STREET_VIEW_TEMPLATE_CREATOR || policy.licenseVersion !== null) {
    return false;
  }
  if (policy.expiresAt !== null || policy.revokedAt !== null || policy.territory !== 'US') {
    return false;
  }
  return templateUsePolicyOf(policy) !== null;
}

/**
 * The use policy whose template an unchanged Street View template row carries (see
 * `isStreetViewTemplatePolicy`), or null for any other row.
 */
export function streetViewTemplateUsePolicyOf(
  policy: Parameters<typeof isStreetViewTemplatePolicy>[0],
): StreetViewUsePolicy | null {
  return isStreetViewTemplatePolicy(policy) ? templateUsePolicyOf(policy) : null;
}

/**
 * Brings a template-derived Street View policy row up to `template` (the current template for the
 * configured use policy), so sources and discoveries recorded under an earlier template follow the
 * current one at their next use. A row that is not an unchanged template row is never touched.
 * Between two `display_only` templates the row keeps its own imagery evidence (standard terms or
 * fixture stand-in), which describes the source rather than this process. Returns the row as it
 * stands afterwards, or null when it does not exist.
 */
export async function refreshStreetViewPolicy(
  db: DbOrTx,
  policyId: string,
  template: PolicyTemplate,
): Promise<AssetPolicy | null> {
  const row =
    (await db
      .selectFrom('assetPolicies')
      .selectAll()
      .where('id', '=', policyId)
      .executeTakeFirst()) ?? null;
  if (!row || !isStreetViewTemplatePolicy(row)) return row;
  const displayOnly = streetViewTemplateEvidence('display_only');
  const evidenceRef =
    displayOnly.includes(template.evidenceRef) &&
    templateUsePolicyOf(row) === 'display_only' &&
    displayOnly.includes(row.evidenceRef)
      ? row.evidenceRef
      : template.evidenceRef;
  const current =
    row.evidenceRef === evidenceRef && POLICY_USES.every((use) => row[use] === template[use]);
  if (current) return row;
  let update = db
    .updateTable('assetPolicies')
    .set({
      display: template.display,
      store: template.store,
      aiProcess: template.aiProcess,
      edit: template.edit,
      distributeDerivative: template.distributeDerivative,
      commerceAdjacent: template.commerceAdjacent,
      evidenceRef,
    })
    .where('id', '=', row.id)
    .where('evidenceRef', '=', row.evidenceRef)
    .where('createdBy', '=', STREET_VIEW_TEMPLATE_CREATOR)
    .where('licenseVersion', 'is', null)
    .where('revokedAt', 'is', null)
    .where('expiresAt', 'is', null);
  for (const use of POLICY_USES) update = update.where(use, '=', row[use]);
  const updated = await update.returningAll().executeTakeFirst();
  if (updated) return updated;
  return (
    (await db
      .selectFrom('assetPolicies')
      .selectAll()
      .where('id', '=', policyId)
      .executeTakeFirst()) ?? null
  );
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
