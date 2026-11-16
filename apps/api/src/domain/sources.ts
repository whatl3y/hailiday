import type { ActivationState, BaseCapabilityKey, SourceKind } from '@hailiday/core';
import {
  capabilityMode,
  defaultCapabilityState,
  type Audience,
  type CapabilityMode,
} from '@hailiday/server/capabilities';
import {
  sql,
  type AssetPolicy,
  type DbOrTx,
  type SourceAsset,
  type ViewpointJson,
} from '@hailiday/server/db';
import { providerUnavailable } from '@hailiday/server/errors';
import { consumeDisplayLoads, displayLoadsRemaining } from '@hailiday/server/limits';
import { attributionLine, dropStoredStreetViewFrame } from '@hailiday/server/pipeline';
import {
  defaultPolicyTemplate,
  evaluatePermission,
  permissionSettingsOf,
  policyAllowsStore,
  recordPermissionEvaluation,
  refreshStreetViewPolicy,
  streetViewSourceMode,
  streetViewTemplateUsePolicyOf,
  type AssetPermission,
  type PolicyInput,
  type PolicyTemplate,
} from '@hailiday/server/policy';
import {
  framedViewOf,
  framingOf,
  type AddressProvider,
  type StreetViewProvider,
  type StreetViewView,
} from '@hailiday/server/providers';
import type { AuthState } from '../auth/session.js';
import type { ApiDeps } from '../deps.js';
import { chargeCall, spendAllowed } from './spend.js';

/**
 * The activation state of a capability. A missing row takes the environment's default locally
 * (as the worker does) and is absent elsewhere.
 */
export async function capabilityState(
  deps: Pick<ApiDeps, 'capabilities' | 'config'>,
  capability: BaseCapabilityKey,
): Promise<ActivationState | null> {
  const state = await deps.capabilities.state('US', capability);
  if (state) return state;
  return deps.config.isLocal ? defaultCapabilityState(deps.config, capability) : null;
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
 * The capability states a Street View evaluation reads: the `street_view_ai` state (the local
 * default for a missing row in local environments, null for a missing row elsewhere) and the
 * Street View display mode for the audience.
 */
export interface StreetViewCapabilityStates {
  aiState: ActivationState | null;
  displayMode: CapabilityMode;
}

/**
 * Reads the capability states of a Street View evaluation once, so a caller can read them before
 * a transaction and evaluate inside it without waiting on the pool.
 */
export async function streetViewCapabilityStates(
  deps: Pick<ApiDeps, 'capabilities' | 'config'>,
  audience: Audience,
): Promise<StreetViewCapabilityStates> {
  return {
    aiState: await capabilityState(deps, 'street_view_ai'),
    displayMode: await capabilityModeFor(deps, 'street_view_display', audience),
  };
}

/**
 * Evaluates a source's asset policy for an audience: the policy under the AI capability's state,
 * with storage, AI processing and editing forced off when that capability is unavailable to the
 * audience and display forced off when Street View display is unavailable. A capability with no
 * row (outside local environments) also permits no distribution or commerce adjacency; the policy
 * is then evaluated, and recorded, as for live traffic. For Street View, `copyright` is the
 * imagery's copyright line: anything but a fixture stand-in's (or none) is live provider imagery,
 * which a `fixture` capability never stores, processes or edits. `streetViewCapabilities` supplies
 * the Street View capability states already read (`streetViewCapabilityStates`); with it and a
 * `policy`, the evaluation reads nothing from the database.
 */
export async function evaluateFor(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock'>,
  input: {
    policyId: string | null;
    /** An unsaved policy to evaluate instead of a stored one (a discovery candidate). */
    policy?: PolicyInput | null;
    kind: SourceKind;
    isGoogleImagery: boolean | null;
    copyright?: string | null;
    audience: Audience;
    streetViewCapabilities?: StreetViewCapabilityStates;
  },
): Promise<{ permission: AssetPermission; capabilityState: ActivationState }> {
  const capability = aiCapabilityOf(input.kind);
  const precomputed = input.kind === 'street_view' ? input.streetViewCapabilities : undefined;
  const rowState = precomputed ? precomputed.aiState : await capabilityState(deps, capability);
  const state = rowState ?? 'live_public';
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
    ...permissionSettingsOf(deps.config),
    now: deps.clock.now(),
    sourceKind: input.kind,
    isGoogleImagery: input.isGoogleImagery,
    copyright: input.copyright ?? null,
  });
  if (capabilityMode(rowState, input.audience, deps.config.appEnv) === 'unavailable') {
    permission.store = false;
    permission.aiProcess = false;
    permission.edit = false;
  }
  if (rowState === null) {
    permission.distributeDerivative = false;
    permission.commerceAdjacent = false;
  }
  if (input.kind === 'street_view') {
    const display = precomputed
      ? precomputed.displayMode
      : await capabilityModeFor(deps, 'street_view_display', input.audience);
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
      copyright: source.copyright,
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

/**
 * What the current use policy still allows for a Street View source's renderings and stored
 * frame. Its template-derived policy is brought up to the current use policy first, so a tightened
 * `STREET_VIEW_USE_POLICY` (`display_only` or `decorate`) reaches renderings made under an earlier
 * one. `distribute` is the policy evaluated for the audience (`distributeDerivative`); `store` is
 * whether the policy itself still allows keeping the frame (`policyAllowsStore`, as render
 * admission decides it), so a stored frame the policy no longer allows is not served as a before
 * image while it waits for admission or revalidation to delete it.
 */
export async function streetViewSourcePermissions(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock'>,
  audience: Audience,
  source: { policyId: string | null; isGoogleImagery: boolean | null; copyright: string | null },
): Promise<{ distribute: boolean; store: boolean }> {
  const policy = await refreshStreetViewPolicyOf(deps, deps.db, source.policyId);
  const { permission, capabilityState } = await evaluateFor(deps, {
    policyId: null,
    policy,
    kind: 'street_view',
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
    audience,
  });
  const store = policyAllowsStore({
    policy,
    capabilityState,
    ...permissionSettingsOf(deps.config),
    now: deps.clock.now(),
    sourceKind: 'street_view',
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
  });
  return { distribute: permission.distributeDerivative, store };
}

/**
 * A display URL for a stored Street View viewpoint (identical URL each time, so the browser caches
 * it): the framed view once the source was zoomed in on its home, else the viewpoint's own view.
 */
export async function displayUrlForViewpoint(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'providers'>,
  audience: Audience,
  viewpoint: ViewpointJson | null,
): Promise<string | null> {
  if (!viewpoint) return null;
  const provider = await streetViewProviderFor(deps, audience);
  return provider ? provider.buildDisplayUrl(framedViewOf(viewpoint)) : null;
}

/**
 * The provider's display URL of a framed Street View source's framed view, for a picture that
 * falls back to it because no stored frame may be shown (the policy no longer allows storing the
 * frame, or the stored copy was deleted). The browser loads that view from the provider, so it is
 * counted against the property's display budget and ledgered (`street_view_static_display`) once
 * per source, the first time it is shown: `framing.displayIssuedAt` records that (the worker sets
 * it when it records the framing of a source without a stored frame). That first load is issued
 * only while spend is allowed, as every display issuance checks it: the global pause, the Street
 * View provider's pause and the spend ceilings (`spendAllowed`) are read before the transaction.
 * The count, the ledger line and the mark are written in one transaction, under the property's
 * lock, taken after the project row (`FOR KEY SHARE`) and the source row, the order every framing
 * write uses. When spend is blocked or the budget has no room the picture is null, as a candidate
 * whose display URL could not be issued shows none; a later read tries again. Null also when
 * Street View display is unavailable to the audience or the source's framing changed meanwhile. A
 * source that is not framed gets `displayUrlForViewpoint`, as before.
 */
export async function framedDisplayUrlOf(
  deps: ApiDeps,
  auth: Pick<AuthState, 'audience' | 'ownerId' | 'session'>,
  source: SourceAsset,
): Promise<string | null> {
  const framing = framingOf(source.viewpoint);
  if (source.kind !== 'street_view' || framing?.status !== 'framed' || !source.viewpoint) {
    return displayUrlForViewpoint(deps, auth.audience, source.viewpoint);
  }
  const provider = await streetViewProviderFor(deps, auth.audience);
  if (!provider) return null;
  const url = provider.buildDisplayUrl(framedViewOf(source.viewpoint));
  if (framing.displayIssuedAt) return url;
  const isFixture = provider.mode === 'fixture';
  // The spend check reads through the pool, so it runs before the locks are taken.
  if (await deps.settings.isProviderPaused(isFixture ? 'fixture' : 'google')) return null;
  if (!(await spendAllowed(deps, ['street_view_static_display'], isFixture))) return null;
  const limit = await deps.settings.get('rate.static_display_loads_per_address');
  const issued = await deps.db.transaction().execute(async (trx): Promise<boolean> => {
    const project = await trx
      .selectFrom('projects')
      .select('propertyId')
      .where('id', '=', source.projectId)
      .forKeyShare()
      .executeTakeFirst();
    const row = await trx
      .selectFrom('sourceAssets')
      .select('viewpoint')
      .where('id', '=', source.id)
      .forUpdate()
      .executeTakeFirst();
    const current = framingOf(row?.viewpoint);
    if (current?.status !== 'framed' || current.framedAt !== framing.framedAt) return false;
    if (current.displayIssuedAt) return true;
    if (!project?.propertyId) return false;
    const now = deps.clock.now();
    const property = await trx
      .selectFrom('properties')
      .select(['displayLoadsIssued', 'displayLoadsWindowStartedAt'])
      .where('id', '=', project.propertyId)
      .forUpdate()
      .executeTakeFirst();
    if (!property || displayLoadsRemaining(property, limit, now) < 1) return false;
    await consumeDisplayLoads(trx, { propertyId: project.propertyId, limit, now });
    await chargeCall(deps, trx, {
      sku: 'street_view_static_display',
      provider: isFixture ? 'fixture-street-view' : 'google',
      isFixture,
      ownerId: auth.ownerId,
      sessionId: auth.session.id,
      projectId: source.projectId,
      stage: 'display',
    });
    await trx
      .updateTable('sourceAssets')
      .set({
        viewpoint: sql<string>`jsonb_set(viewpoint, '{framing,displayIssuedAt}', to_jsonb(${now.toISOString()}::text))`,
      })
      .where('id', '=', source.id)
      .execute();
    return true;
  });
  return issued ? url : null;
}

/**
 * Whether a look was made before its Street View source was zoomed in on its home: the source's
 * viewpoint records a `framed` framing and the look was created before the framing's `framedAt`.
 * Such a look was made from the wide frame of the candidate's own view, which the stored frame no
 * longer is, so its "Before" is that view's display URL (`wideDisplayUrlForViewpoint`) and never
 * the stored or framed frame. A look created at or after `framedAt`, a `kept` framing and a source
 * with no framing answer false.
 */
export function lookPredatesFraming(
  viewpoint: Pick<ViewpointJson, 'framing'> | null | undefined,
  lookCreatedAt: Date,
): boolean {
  const framing = framingOf(viewpoint);
  if (framing?.status !== 'framed') return false;
  const framedAt = Date.parse(framing.framedAt);
  return Number.isFinite(framedAt) && lookCreatedAt.getTime() < framedAt;
}

/**
 * The provider's display URL of a stored viewpoint's own view (the candidate's, never the framed
 * view): the picture the confirmation screen showed, identical each time so the browser caches it.
 */
export async function wideDisplayUrlForViewpoint(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'providers'>,
  audience: Audience,
  viewpoint: ViewpointJson | null,
): Promise<string | null> {
  if (!viewpoint) return null;
  const provider = await streetViewProviderFor(deps, audience);
  return provider ? provider.buildDisplayUrl(viewOf(viewpoint)) : null;
}

/**
 * The policy template a new Street View source or discovery gets: the configured use policy
 * (`STREET_VIEW_USE_POLICY`) for this process's Street View imagery, attributed to Google Maps.
 */
export function streetViewPolicyTemplate(deps: Pick<ApiDeps, 'config'>): PolicyTemplate {
  return defaultPolicyTemplate('street_view', {
    attributionText: 'Google Maps',
    usePolicy: deps.config.streetView.usePolicy,
    imagery: deps.config.providers.streetView === 'google' ? 'live' : 'fixture',
  });
}

/**
 * Brings the template-derived asset policy of a Street View source or discovery up to the current
 * template (a policy recorded or edited deliberately is never changed). Returns the policy row as
 * it stands afterwards, or null when there is none.
 */
export async function refreshStreetViewPolicyOf(
  deps: Pick<ApiDeps, 'config'>,
  db: DbOrTx,
  policyId: string | null,
): Promise<AssetPolicy | null> {
  if (!policyId) return null;
  return refreshStreetViewPolicy(db, policyId, streetViewPolicyTemplate(deps));
}

/**
 * A bound Street View source as a render request sees it: its template-derived policy brought up
 * to the current template; its stored frame deleted (object and key, unless a preservation hold
 * covers the source) when that policy no longer allows storage; and its stored mode updated when
 * the evaluated permission now allows decoration in another mode (a source recorded under an
 * earlier template becomes decoratable without being recreated). A source recorded as `transient`
 * becomes `persist` only when its policy is the unchanged `full` template; a source that may not
 * be decorated keeps its stored mode. Other kinds and sources that are not `ready` are returned
 * as loaded.
 */
export async function admissionSourceOf(
  deps: Pick<ApiDeps, 'capabilities' | 'config' | 'db' | 'clock' | 'storage'>,
  source: SourceAsset | null,
  audience: Audience,
): Promise<SourceAsset | null> {
  if (!source || source.kind !== 'street_view' || source.state !== 'ready') return source;
  const policy = await refreshStreetViewPolicyOf(deps, deps.db, source.assetPolicyId);
  const { permission, capabilityState: state } = await evaluateFor(deps, {
    policyId: null,
    policy,
    kind: source.kind,
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
    audience,
  });
  let current = source;
  const storable = policyAllowsStore({
    policy,
    capabilityState: state,
    ...permissionSettingsOf(deps.config),
    now: deps.clock.now(),
    sourceKind: 'street_view',
    isGoogleImagery: source.isGoogleImagery,
    copyright: source.copyright,
  });
  if (current.objectKey && !storable) current = await dropStoredStreetViewFrame(deps, current);
  const derived = streetViewSourceMode(permission);
  if (derived !== 'persist' && derived !== 'transient') return current;
  const mode =
    derived === 'persist' &&
    current.streetViewMode === 'transient' &&
    (!policy || streetViewTemplateUsePolicyOf(policy) !== 'full')
      ? 'transient'
      : derived;
  if (mode === current.streetViewMode) return current;
  return deps.db
    .updateTable('sourceAssets')
    .set({ streetViewMode: mode })
    .where('id', '=', current.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * The credit shown with a Street View-origin rendering: the line recorded on the rendering, or,
 * for one recorded without a line, the line its source's own copyright gives (`attributionLine`:
 * the copyright holder after the Google Maps name, or a fixture photo's credit alone), so a frame
 * Google does not own is never credited to Google alone.
 */
export function streetViewCreditOf(
  recorded: string | null,
  source: Pick<SourceAsset, 'copyright'> | null,
): string {
  if (recorded?.trim()) return recorded;
  return (
    attributionLine(
      { kind: 'street_view', copyright: source?.copyright ?? null },
      { attribution: null },
    ) ?? 'Google Maps'
  );
}

/** The default Street View policy as an unsaved policy (evaluating a candidate before binding). */
export function streetViewCandidatePolicy(deps: Pick<ApiDeps, 'config'>): PolicyInput {
  const template = streetViewPolicyTemplate(deps);
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
