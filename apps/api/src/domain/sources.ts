import type { ActivationState, BaseCapabilityKey, SourceKind } from '@holiday/core';
import { capabilityMode, type Audience, type CapabilityMode } from '@holiday/server/capabilities';
import type { DbOrTx, SourceAsset, ViewpointJson } from '@holiday/server/db';
import { providerUnavailable } from '@holiday/server/errors';
import {
  defaultPolicyTemplate,
  evaluatePermission,
  recordPermissionEvaluation,
  type AssetPermission,
  type PolicyInput,
} from '@holiday/server/policy';
import type {
  AddressProvider,
  StreetViewProvider,
  StreetViewView,
} from '@holiday/server/providers';
import type { ApiDeps } from '../deps.js';

/** The activation state of a capability (a missing row is `fixture` locally, else absent). */
export async function capabilityState(
  deps: Pick<ApiDeps, 'capabilities' | 'config'>,
  capability: BaseCapabilityKey,
): Promise<ActivationState | null> {
  const state = await deps.capabilities.state('US', capability);
  if (state) return state;
  return deps.config.isLocal ? 'fixture' : null;
}

export async function capabilityModeFor(
  deps: Pick<ApiDeps, 'capabilities' | 'config'>,
  capability: BaseCapabilityKey,
  audience: Audience,
): Promise<CapabilityMode> {
  return capabilityMode(await capabilityState(deps, capability), audience, deps.config.appEnv);
}

/** The address provider leg for an audience: fixture or live per the capability row. */
export async function addressProviderFor(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'providers'>,
  audience: Audience,
): Promise<AddressProvider> {
  const mode = await capabilityModeFor(deps, 'address_lookup', audience);
  if (mode === 'unavailable') throw providerUnavailable('address');
  return mode === 'live' ? deps.providers.address : deps.providers.fixtures.address;
}

/** The Street View display leg for an audience, or null when display is unavailable. */
export async function streetViewProviderFor(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'providers'>,
  audience: Audience,
): Promise<StreetViewProvider | null> {
  const mode = await capabilityModeFor(deps, 'street_view_display', audience);
  if (mode === 'unavailable') return null;
  return mode === 'live' ? deps.providers.streetView : deps.providers.fixtures.streetView;
}

/** A frozen view from a stored viewpoint descriptor. */
export function viewOf(
  viewpoint: Pick<ViewpointJson, 'panoId' | 'heading' | 'pitch' | 'fov' | 'width' | 'height'>,
): StreetViewView {
  return {
    panoId: viewpoint.panoId,
    heading: viewpoint.heading,
    pitch: viewpoint.pitch,
    fov: viewpoint.fov,
    width: viewpoint.width,
    height: viewpoint.height,
  };
}

/** The AI capability that governs a source kind. */
export function aiCapabilityOf(kind: SourceKind): 'street_view_ai' | 'image_editing' {
  return kind === 'street_view' ? 'street_view_ai' : 'image_editing';
}

/**
 * Evaluates a source's asset policy for an audience: the policy under the AI capability's state,
 * with storage, AI processing and editing forced off when that capability is unavailable to the
 * audience and display forced off when Street View display is unavailable.
 */
export async function evaluateFor(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock'>,
  input: {
    policyId: string | null;
    /** An unsaved policy to evaluate instead of a stored one (a discovery candidate). */
    policy?: PolicyInput | null;
    kind: SourceKind;
    isGoogleImagery: boolean | null;
    audience: Audience;
  },
): Promise<{ permission: AssetPermission; capabilityState: ActivationState }> {
  const capability = aiCapabilityOf(input.kind);
  const state = (await capabilityState(deps, capability)) ?? 'live_public';
  const policy = input.policy
    ? input.policy
    : input.policyId
      ? ((await deps.db
          .selectFrom('assetPolicies')
          .selectAll()
          .where('id', '=', input.policyId)
          .executeTakeFirst()) ?? null)
      : null;
  const permission = evaluatePermission({
    policy,
    capabilityState: state,
    appEnv: deps.config.appEnv,
    now: deps.clock.now(),
    sourceKind: input.kind,
    isGoogleImagery: input.isGoogleImagery,
  });
  if (capabilityMode(state, input.audience, deps.config.appEnv) === 'unavailable') {
    permission.store = false;
    permission.aiProcess = false;
    permission.edit = false;
  }
  if (input.kind === 'street_view') {
    const display = await capabilityModeFor(deps, 'street_view_display', input.audience);
    if (display === 'unavailable') permission.display = false;
  }
  return { permission, capabilityState: state };
}

/**
 * Evaluates and records the submission-time permission of a bound source. `evaluated` supplies a
 * permission already evaluated for this request, so only the record write uses `db` (a caller
 * holding a lock inside a transaction must not wait on the pool).
 */
export async function evaluateSourceForSubmission(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock'>,
  db: DbOrTx,
  source: SourceAsset,
  audience: Audience,
  evaluated?: { permission: AssetPermission; capabilityState: ActivationState },
): Promise<{ permission: AssetPermission; evaluationId: string | null }> {
  const { permission, capabilityState: state } =
    evaluated ??
    (await evaluateFor(deps, {
      policyId: source.assetPolicyId,
      kind: source.kind,
      isGoogleImagery: source.isGoogleImagery,
      audience,
    }));
  if (!source.assetPolicyId) return { permission, evaluationId: null };
  const evaluationId = await recordPermissionEvaluation(
    db,
    {
      assetPolicyId: source.assetPolicyId,
      sourceAssetId: source.id,
      context: 'submission',
      result: permission,
      capabilityState: state,
      evaluatedAt: deps.clock.now(),
    },
    deps.clock,
  );
  return { permission, evaluationId };
}

/** A display URL for a stored Street View viewpoint (identical URL each time, so the browser caches it). */
export async function displayUrlForViewpoint(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'providers'>,
  audience: Audience,
  viewpoint: ViewpointJson | null,
): Promise<string | null> {
  if (!viewpoint) return null;
  const provider = await streetViewProviderFor(deps, audience);
  return provider ? provider.buildDisplayUrl(viewOf(viewpoint)) : null;
}

/** The default Street View policy as an unsaved policy (evaluating a candidate before binding). */
export function streetViewCandidatePolicy(): PolicyInput {
  const template = defaultPolicyTemplate('street_view', { attributionText: 'Google Maps' });
  return {
    display: template.display,
    store: template.store,
    aiProcess: template.aiProcess,
    edit: template.edit,
    distributeDerivative: template.distributeDerivative,
    commerceAdjacent: template.commerceAdjacent,
    evidenceRef: template.evidenceRef,
    attributionText: template.attributionText ?? null,
    expiresAt: null,
    revokedAt: null,
    territory: template.territory ?? null,
  };
}
