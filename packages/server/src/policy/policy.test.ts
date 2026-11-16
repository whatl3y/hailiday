import { describe, expect, it } from 'vitest';
import type { AssetPolicyUseState } from '@hailiday/core';
import {
  FIXTURE_STREET_VIEW_EVIDENCE,
  STREET_VIEW_OWNER_DECISION_EVIDENCE,
  STREET_VIEW_STANDARD_TERMS_EVIDENCE,
  defaultPolicyTemplate,
  evaluatePermission,
  isEditable,
  isStreetViewTemplatePolicy,
  permissionSettingsOf,
  policyAllowsStore,
  policyAllowsUse,
  setStreetViewImagery,
  streetViewSourceMode,
} from './index.js';
import type { PolicyInput } from './index.js';

const now = new Date('2026-11-09T12:00:00Z');

function policy(
  uses: Partial<
    Record<
      'display' | 'store' | 'aiProcess' | 'edit' | 'distributeDerivative' | 'commerceAdjacent',
      AssetPolicyUseState
    >
  >,
  extra: Partial<PolicyInput> = {},
): PolicyInput {
  return {
    display: 'unknown',
    store: 'unknown',
    aiProcess: 'unknown',
    edit: 'unknown',
    distributeDerivative: 'unknown',
    commerceAdjacent: 'unknown',
    evidenceRef: 'grant:test',
    attributionText: '© Google',
    expiresAt: null,
    revokedAt: null,
    territory: 'US',
    ...uses,
    ...extra,
  };
}

/** The default contributor imagery setting (`STREET_VIEW_CONTRIBUTOR_IMAGERY=decorate`). */
const contributorImagery = 'decorate' as const;
const live = {
  capabilityState: 'live_public' as const,
  appEnv: 'production' as const,
  contributorImagery,
  now,
};

describe('evaluatePermission', () => {
  it('maps allowed to true and denied to false', () => {
    const result = evaluatePermission({
      ...live,
      policy: policy({
        display: 'allowed',
        store: 'denied',
        aiProcess: 'allowed',
        edit: 'allowed',
      }),
    });
    expect(result).toMatchObject({ display: true, store: false, aiProcess: true, edit: true });
    expect(result.train).toBe(false);
    expect(result.evidenceId).toBe('grant:test');
    expect(result.attribution).toBe('© Google');
  });

  it('evaluates unknown as denied for live traffic', () => {
    for (const capabilityState of ['live_private', 'live_public'] as const) {
      for (const appEnv of ['development', 'staging', 'production'] as const) {
        const result = evaluatePermission({
          capabilityState,
          appEnv,
          contributorImagery,
          now,
          policy: policy({}),
        });
        expect(result.display || result.store || result.aiProcess || result.edit).toBe(false);
        expect(result.distributeDerivative || result.commerceAdjacent).toBe(false);
      }
    }
  });

  it('lets unknown evaluate as allowed only in fixture activation outside production', () => {
    const fixture = evaluatePermission({
      capabilityState: 'fixture',
      appEnv: 'development',
      contributorImagery,
      now,
      policy: policy({ store: 'denied' }),
    });
    expect(fixture).toMatchObject({ display: true, aiProcess: true, edit: true, store: false });
    const production = evaluatePermission({
      capabilityState: 'fixture',
      appEnv: 'production',
      contributorImagery,
      now,
      policy: policy({
        display: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        store: 'allowed',
      }),
    });
    expect(production).toMatchObject({
      display: true,
      aiProcess: false,
      edit: false,
      store: false,
    });
    expect(streetViewSourceMode(production)).toBe('display_only');
  });

  it('denies everything without a policy, after expiry and after revocation', () => {
    const all = policy({
      display: 'allowed',
      store: 'allowed',
      aiProcess: 'allowed',
      edit: 'allowed',
      distributeDerivative: 'allowed',
      commerceAdjacent: 'allowed',
    });
    const none = (p: PolicyInput | null) => {
      const r = evaluatePermission({ ...live, policy: p });
      return !r.display && !r.store && !r.aiProcess && !r.edit && !r.distributeDerivative;
    };
    expect(none(null)).toBe(true);
    expect(none({ ...all, expiresAt: new Date('2026-11-09T11:59:59Z') })).toBe(true);
    expect(none({ ...all, revokedAt: new Date('2026-11-01T00:00:00Z') })).toBe(true);
    expect(none({ ...all, expiresAt: new Date('2026-12-01T00:00:00Z') })).toBe(false);
  });

  it('keeps contributor imagery display-only unless licensed when the setting is display_only', () => {
    const granted = policy({
      display: 'allowed',
      aiProcess: 'allowed',
      edit: 'allowed',
      store: 'allowed',
    });
    const contributor = evaluatePermission({
      ...live,
      contributorImagery: 'display_only',
      policy: granted,
      sourceKind: 'street_view',
      isGoogleImagery: false,
    });
    expect(streetViewSourceMode(contributor)).toBe('display_only');
    const licensed = evaluatePermission({
      ...live,
      contributorImagery: 'display_only',
      policy: granted,
      sourceKind: 'street_view',
      isGoogleImagery: false,
      contributorImageryLicensed: true,
    });
    expect(streetViewSourceMode(licensed)).toBe('persist');
  });

  it('evaluates contributor imagery like Google imagery when the setting is decorate', () => {
    const granted = policy({
      display: 'allowed',
      aiProcess: 'allowed',
      edit: 'allowed',
      store: 'allowed',
    });
    const contributor = evaluatePermission({
      ...live,
      contributorImagery: 'decorate',
      policy: granted,
      sourceKind: 'street_view',
      isGoogleImagery: false,
    });
    expect(streetViewSourceMode(contributor)).toBe('persist');
    expect(contributor).toEqual(
      evaluatePermission({
        ...live,
        policy: granted,
        sourceKind: 'street_view',
        isGoogleImagery: true,
      }),
    );
  });
});

describe('streetViewSourceMode', () => {
  const evaluate = (uses: Parameters<typeof policy>[0]) =>
    streetViewSourceMode(evaluatePermission({ ...live, policy: policy(uses) }));

  it('derives every source mode from the derivation table', () => {
    expect(
      evaluate({ display: 'allowed', aiProcess: 'allowed', edit: 'allowed', store: 'allowed' }),
    ).toBe('persist');
    expect(
      evaluate({ display: 'allowed', aiProcess: 'allowed', edit: 'allowed', store: 'denied' }),
    ).toBe('transient');
    expect(evaluate({ display: 'allowed', aiProcess: 'allowed', edit: 'allowed' })).toBe(
      'transient',
    );
    expect(evaluate({ display: 'allowed' })).toBe('display_only');
    expect(evaluate({ display: 'allowed', aiProcess: 'denied', edit: 'allowed' })).toBe(
      'display_only',
    );
    expect(evaluate({ display: 'allowed', aiProcess: 'allowed', edit: 'denied' })).toBe(
      'display_only',
    );
    expect(evaluate({})).toBe('unavailable');
    expect(
      evaluate({ display: 'denied', aiProcess: 'allowed', edit: 'allowed', store: 'allowed' }),
    ).toBe('unavailable');
  });

  it('maps the display_only Street View template to display_only for live traffic', () => {
    const template = defaultPolicyTemplate('street_view', { usePolicy: 'display_only' });
    const permission = evaluatePermission({ ...live, policy: { ...policy({}), ...template } });
    expect(streetViewSourceMode(permission)).toBe('display_only');
    expect(isEditable(permission)).toBe(false);
  });
});

const copyrightOf = { live: '© 2025 Google', fixture: 'Fixture photo: Test stand-in' } as const;

describe('Street View use policies', () => {
  const imageries = ['live', 'fixture'] as const;
  const evaluateUnder = (
    usePolicy: 'full' | 'decorate' | 'display_only',
    imagery: 'live' | 'fixture',
    context: Partial<Parameters<typeof evaluatePermission>[0]> = {},
  ) =>
    evaluatePermission({
      ...live,
      policy: {
        ...policy({}),
        ...defaultPolicyTemplate('street_view', { usePolicy, imagery, attributionText: 'Maps' }),
      },
      sourceKind: 'street_view',
      isGoogleImagery: true,
      copyright: copyrightOf[imagery],
      ...context,
    });

  it('defaults to full: every use allowed, with the owner-decision evidence', () => {
    for (const imagery of imageries) {
      const template = defaultPolicyTemplate('street_view', { imagery });
      expect(template).toMatchObject({
        display: 'allowed',
        store: 'allowed',
        aiProcess: 'allowed',
        edit: 'allowed',
        distributeDerivative: 'allowed',
        commerceAdjacent: 'allowed',
        evidenceRef: STREET_VIEW_OWNER_DECISION_EVIDENCE,
        territory: 'US',
      });
      const permission = evaluateUnder('full', imagery);
      expect(streetViewSourceMode(permission)).toBe('persist');
      expect(permission).toMatchObject({
        display: true,
        store: true,
        aiProcess: true,
        edit: true,
        distributeDerivative: true,
        commerceAdjacent: true,
        train: false,
        evidenceId: STREET_VIEW_OWNER_DECISION_EVIDENCE,
      });
    }
  });

  it('decorate allows AI processing and editing only: transient, no download, share or commerce', () => {
    for (const imagery of imageries) {
      const template = defaultPolicyTemplate('street_view', { usePolicy: 'decorate', imagery });
      expect(template.evidenceRef).toBe(STREET_VIEW_OWNER_DECISION_EVIDENCE);
      // A fixture capability decorates only fixture stand-ins (see the live-imagery case below).
      const states =
        imagery === 'live' ? (['live_public'] as const) : (['live_public', 'fixture'] as const);
      for (const capabilityState of states) {
        const permission = evaluateUnder('decorate', imagery, {
          capabilityState,
          appEnv: 'development',
        });
        expect(streetViewSourceMode(permission)).toBe('transient');
        expect(permission).toMatchObject({
          display: true,
          store: false,
          aiProcess: true,
          edit: true,
          distributeDerivative: false,
          commerceAdjacent: false,
        });
      }
    }
  });

  it('display_only keeps the standard-terms template for live imagery', () => {
    const template = defaultPolicyTemplate('street_view', {
      usePolicy: 'display_only',
      imagery: 'live',
    });
    expect(template.evidenceRef).toBe(STREET_VIEW_STANDARD_TERMS_EVIDENCE);
    expect(streetViewSourceMode(evaluateUnder('display_only', 'live'))).toBe('display_only');
    expect(
      streetViewSourceMode(
        evaluateUnder('display_only', 'live', { capabilityState: 'fixture', appEnv: 'test' }),
      ),
    ).toBe('display_only');
    expect(
      streetViewSourceMode(
        evaluateUnder('display_only', 'fixture', { capabilityState: 'fixture', appEnv: 'test' }),
      ),
    ).toBe('persist');
  });

  it('never stores, processes or edits live imagery under a fixture capability outside production', () => {
    for (const usePolicy of ['full', 'decorate'] as const) {
      for (const appEnv of ['development', 'test', 'staging'] as const) {
        const permission = evaluateUnder(usePolicy, 'live', { capabilityState: 'fixture', appEnv });
        expect(streetViewSourceMode(permission)).toBe('display_only');
        expect(permission).toMatchObject({ display: true, store: false, aiProcess: false });
        expect(permission.edit).toBe(false);
        // A source whose copyright is not known is treated as live imagery.
        const unknown = evaluateUnder(usePolicy, 'fixture', {
          capabilityState: 'fixture',
          appEnv,
          copyright: null,
        });
        expect(streetViewSourceMode(unknown)).toBe('display_only');
      }
      // The same live frame is decorated once the capability is live.
      expect(
        streetViewSourceMode(evaluateUnder(usePolicy, 'live', { capabilityState: 'live_public' })),
      ).toBe(usePolicy === 'full' ? 'persist' : 'transient');
      // And a fixture stand-in stays decoratable on fixture legs.
      expect(
        isEditable(
          evaluateUnder(usePolicy, 'fixture', { capabilityState: 'fixture', appEnv: 'test' }),
        ),
      ).toBe(true);
    }
  });

  it("treats Street View imagery not known to be Google's as contributor imagery", () => {
    for (const isGoogleImagery of [false, null, undefined]) {
      const permission = evaluateUnder('full', 'live', {
        isGoogleImagery,
        contributorImagery: 'display_only',
      });
      expect(streetViewSourceMode(permission)).toBe('display_only');
      expect(permission.distributeDerivative).toBe(false);
      // Under the default setting the same imagery follows the use policy.
      expect(streetViewSourceMode(evaluateUnder('full', 'live', { isGoogleImagery }))).toBe(
        'persist',
      );
    }
    expect(
      streetViewSourceMode(
        evaluateUnder('full', 'live', {
          isGoogleImagery: true,
          contributorImagery: 'display_only',
        }),
      ),
    ).toBe('persist');
  });

  it('keeps contributor imagery display-only under every use policy when the setting is display_only', () => {
    for (const usePolicy of ['full', 'decorate', 'display_only'] as const) {
      for (const imagery of imageries) {
        for (const capabilityState of ['live_public', 'fixture'] as const) {
          const permission = evaluateUnder(usePolicy, imagery, {
            capabilityState,
            appEnv: 'development',
            isGoogleImagery: false,
            contributorImagery: 'display_only',
          });
          expect(streetViewSourceMode(permission)).toBe('display_only');
          expect(permission).toMatchObject({
            display: true,
            store: false,
            aiProcess: false,
            edit: false,
            distributeDerivative: false,
          });
        }
      }
    }
  });

  it('gives contributor imagery every use the use policy gives Google imagery when the setting is decorate', () => {
    const uses = [
      'display',
      'store',
      'aiProcess',
      'edit',
      'distributeDerivative',
      'commerceAdjacent',
    ] as const;
    const expected = {
      full: { display: true, store: true, aiProcess: true, edit: true, share: true },
      decorate: { display: true, store: false, aiProcess: true, edit: true, share: false },
    } as const;
    for (const usePolicy of ['full', 'decorate', 'display_only'] as const) {
      for (const imagery of imageries) {
        for (const capabilityState of ['live_public', 'fixture'] as const) {
          for (const appEnv of ['development', 'production'] as const) {
            const context = { capabilityState, appEnv, contributorImagery: 'decorate' as const };
            const google = evaluateUnder(usePolicy, imagery, { ...context, isGoogleImagery: true });
            for (const isGoogleImagery of [false, null]) {
              const contributor = evaluateUnder(usePolicy, imagery, {
                ...context,
                isGoogleImagery,
              });
              for (const use of uses) expect(contributor[use]).toBe(google[use]);
            }
          }
        }
      }
      if (usePolicy === 'display_only') continue;
      // Live traffic on live imagery: each use as the use policy gives it.
      const contributor = evaluateUnder(usePolicy, 'live', { isGoogleImagery: false });
      const want = expected[usePolicy];
      expect(contributor).toMatchObject({
        display: want.display,
        store: want.store,
        aiProcess: want.aiProcess,
        edit: want.edit,
        distributeDerivative: want.share,
        commerceAdjacent: want.share,
      });
    }
    expect(
      streetViewSourceMode(evaluateUnder('display_only', 'live', { isGoogleImagery: false })),
    ).toBe('display_only');
  });

  it('never lets a production fixture capability decorate, whatever the use policy', () => {
    for (const usePolicy of ['full', 'decorate'] as const) {
      const permission = evaluateUnder(usePolicy, 'live', {
        capabilityState: 'fixture',
        appEnv: 'production',
      });
      expect(isEditable(permission)).toBe(false);
      expect(permission.store).toBe(false);
      expect(streetViewSourceMode(permission)).toBe('display_only');
    }
  });
});

describe('isStreetViewTemplatePolicy', () => {
  const row = (template: ReturnType<typeof defaultPolicyTemplate>) => ({
    display: template.display,
    store: template.store,
    aiProcess: template.aiProcess,
    edit: template.edit,
    distributeDerivative: template.distributeDerivative,
    commerceAdjacent: template.commerceAdjacent,
    evidenceRef: template.evidenceRef,
    createdBy: template.createdBy,
    licenseVersion: null,
    expiresAt: null,
    revokedAt: null,
    territory: template.territory ?? null,
  });

  it('recognizes an unchanged template row of every use policy and imagery', () => {
    for (const usePolicy of ['full', 'decorate', 'display_only'] as const) {
      for (const imagery of ['live', 'fixture'] as const) {
        const template = defaultPolicyTemplate('street_view', { usePolicy, imagery });
        expect(isStreetViewTemplatePolicy(row(template))).toBe(true);
      }
    }
  });

  it('never treats a recorded or edited policy as a template row', () => {
    const base = row(defaultPolicyTemplate('street_view', { usePolicy: 'display_only' }));
    expect(isStreetViewTemplatePolicy({ ...base, store: 'allowed', aiProcess: 'allowed' })).toBe(
      false,
    );
    expect(isStreetViewTemplatePolicy({ ...base, evidenceRef: 'grant:google-2027' })).toBe(false);
    expect(isStreetViewTemplatePolicy({ ...base, createdBy: 'operator' })).toBe(false);
    expect(isStreetViewTemplatePolicy({ ...base, licenseVersion: 'v2' })).toBe(false);
    expect(isStreetViewTemplatePolicy({ ...base, territory: 'CA' })).toBe(false);
    expect(isStreetViewTemplatePolicy({ ...base, expiresAt: new Date('2027-01-01') })).toBe(false);
    expect(isStreetViewTemplatePolicy({ ...base, revokedAt: new Date('2026-11-01') })).toBe(false);
    const full = row(defaultPolicyTemplate('street_view'));
    expect(isStreetViewTemplatePolicy({ ...full, distributeDerivative: 'denied' })).toBe(false);
    // The display-only uses under the owner-decision evidence were never a template.
    expect(
      isStreetViewTemplatePolicy({ ...base, evidenceRef: STREET_VIEW_OWNER_DECISION_EVIDENCE }),
    ).toBe(false);
    const upload = row(defaultPolicyTemplate('upload', { attestationVersion: 'v1' }));
    expect(isStreetViewTemplatePolicy(upload)).toBe(false);
  });
});

describe('defaultPolicyTemplate', () => {
  it('lets an attested upload be edited and shared unless private-only', () => {
    const upload = defaultPolicyTemplate('upload', { attestationVersion: 'v1' });
    expect(upload).toMatchObject({
      aiProcess: 'allowed',
      edit: 'allowed',
      distributeDerivative: 'allowed',
    });
    expect(upload.evidenceRef).toBe('attestation:v1');
    expect(defaultPolicyTemplate('upload', { privateOnly: true }).distributeDerivative).toBe(
      'denied',
    );
    const permission = evaluatePermission({ ...live, policy: { ...policy({}), ...upload } });
    expect(isEditable(permission)).toBe(true);
  });
});

describe('Street View imagery evidence', () => {
  const fixtureState = {
    capabilityState: 'fixture' as const,
    appEnv: 'development' as const,
    contributorImagery,
    now,
  };

  it('lets fixture stand-in imagery be decorated under a fixture capability', () => {
    const template = defaultPolicyTemplate('street_view', {
      imagery: 'fixture',
      usePolicy: 'display_only',
    });
    expect(template.evidenceRef).toBe(FIXTURE_STREET_VIEW_EVIDENCE);
    const permission = evaluatePermission({
      ...fixtureState,
      policy: { ...policy({}), ...template },
      sourceKind: 'street_view',
      isGoogleImagery: true,
      copyright: copyrightOf.fixture,
    });
    expect(isEditable(permission)).toBe(true);
  });

  it('keeps live Street View imagery display-only under the display_only use policy, even under a fixture capability', () => {
    setStreetViewImagery('live');
    try {
      expect(defaultPolicyTemplate('street_view').evidenceRef).toBe(
        STREET_VIEW_OWNER_DECISION_EVIDENCE,
      );
      const template = defaultPolicyTemplate('street_view', { usePolicy: 'display_only' });
      expect(template.evidenceRef).toBe(STREET_VIEW_STANDARD_TERMS_EVIDENCE);
      const permission = evaluatePermission({
        ...fixtureState,
        policy: { ...policy({}), ...template },
        sourceKind: 'street_view',
        isGoogleImagery: true,
      });
      expect(streetViewSourceMode(permission)).toBe('display_only');
    } finally {
      setStreetViewImagery('fixture');
    }
  });
});

describe('policyAllowsUse', () => {
  const streetView = (
    usePolicy: 'full' | 'decorate' | 'display_only',
    imagery: 'live' | 'fixture',
    capabilityState: 'live_public' | 'live_private' | 'fixture',
  ) => ({
    policy: {
      ...policy({}),
      ...defaultPolicyTemplate('street_view', { usePolicy, imagery, attributionText: 'Maps' }),
    },
    capabilityState,
    appEnv: 'development' as const,
    contributorImagery: contributorImagery as 'decorate' | 'display_only',
    now,
    sourceKind: 'street_view' as const,
    isGoogleImagery: true as boolean | null,
    copyright: copyrightOf[imagery],
  });

  it('answers from the policy whatever the capability state', () => {
    for (const state of ['live_public', 'live_private'] as const) {
      expect(policyAllowsUse(streetView('full', 'live', state), 'distributeDerivative')).toBe(true);
      expect(policyAllowsUse(streetView('decorate', 'live', state), 'distributeDerivative')).toBe(
        false,
      );
      expect(policyAllowsUse(streetView('decorate', 'live', state), 'edit')).toBe(true);
      expect(
        policyAllowsUse(streetView('display_only', 'live', state), 'distributeDerivative'),
      ).toBe(false);
    }
  });

  it('follows the fixture rule for fixture stand-ins under a fixture capability only', () => {
    expect(
      policyAllowsUse(streetView('display_only', 'fixture', 'fixture'), 'distributeDerivative'),
    ).toBe(true);
    expect(
      policyAllowsUse(streetView('display_only', 'fixture', 'live_public'), 'distributeDerivative'),
    ).toBe(false);
    expect(
      policyAllowsUse(streetView('display_only', 'live', 'fixture'), 'distributeDerivative'),
    ).toBe(false);
  });

  it('denies every use of a revoked policy and of none, and stays the store answer for storage', () => {
    const revoked = streetView('full', 'live', 'live_public');
    revoked.policy = { ...revoked.policy, revokedAt: new Date(now.getTime() - 1) };
    expect(policyAllowsUse(revoked, 'distributeDerivative')).toBe(false);
    expect(policyAllowsUse({ ...revoked, policy: null }, 'display')).toBe(false);
    for (const usePolicy of ['full', 'decorate', 'display_only'] as const) {
      const input = streetView(usePolicy, 'live', 'live_public');
      expect(policyAllowsStore(input)).toBe(policyAllowsUse(input, 'store'));
    }
  });

  it('follows the contributor imagery setting for imagery not attributed to Google', () => {
    for (const isGoogleImagery of [false, null]) {
      for (const state of ['live_public', 'fixture'] as const) {
        const imagery = state === 'fixture' ? 'fixture' : 'live';
        const decorate = { ...streetView('full', imagery, state), isGoogleImagery };
        expect(policyAllowsStore(decorate)).toBe(true);
        expect(policyAllowsUse(decorate, 'distributeDerivative')).toBe(true);
        expect(policyAllowsUse(decorate, 'edit')).toBe(true);
        const displayOnly = { ...decorate, contributorImagery: 'display_only' as const };
        expect(policyAllowsStore(displayOnly)).toBe(false);
        expect(policyAllowsUse(displayOnly, 'distributeDerivative')).toBe(false);
        expect(policyAllowsUse(displayOnly, 'edit')).toBe(false);
        expect(policyAllowsUse(displayOnly, 'display')).toBe(true);
      }
    }
  });
});

describe('permissionSettingsOf', () => {
  it('carries the environment and the contributor imagery setting of a configuration', () => {
    for (const value of ['decorate', 'display_only'] as const) {
      expect(
        permissionSettingsOf({ appEnv: 'staging', streetView: { contributorImagery: value } }),
      ).toEqual({ appEnv: 'staging', contributorImagery: value });
    }
  });
});
