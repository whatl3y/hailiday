import { describe, expect, it } from 'vitest';
import type { AssetPolicyUseState } from '@holiday/core';
import {
  FIXTURE_STREET_VIEW_EVIDENCE,
  STREET_VIEW_STANDARD_TERMS_EVIDENCE,
  defaultPolicyTemplate,
  evaluatePermission,
  isEditable,
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

const live = { capabilityState: 'live_public' as const, appEnv: 'production' as const, now };

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
        const result = evaluatePermission({ capabilityState, appEnv, now, policy: policy({}) });
        expect(result.display || result.store || result.aiProcess || result.edit).toBe(false);
        expect(result.distributeDerivative || result.commerceAdjacent).toBe(false);
      }
    }
  });

  it('lets unknown evaluate as allowed only in fixture activation outside production', () => {
    const fixture = evaluatePermission({
      capabilityState: 'fixture',
      appEnv: 'development',
      now,
      policy: policy({ store: 'denied' }),
    });
    expect(fixture).toMatchObject({ display: true, aiProcess: true, edit: true, store: false });
    const production = evaluatePermission({
      capabilityState: 'fixture',
      appEnv: 'production',
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

  it('keeps contributor imagery display-only unless licensed', () => {
    const granted = policy({
      display: 'allowed',
      aiProcess: 'allowed',
      edit: 'allowed',
      store: 'allowed',
    });
    const contributor = evaluatePermission({
      ...live,
      policy: granted,
      sourceKind: 'street_view',
      isGoogleImagery: false,
    });
    expect(streetViewSourceMode(contributor)).toBe('display_only');
    const licensed = evaluatePermission({
      ...live,
      policy: granted,
      sourceKind: 'street_view',
      isGoogleImagery: false,
      contributorImageryLicensed: true,
    });
    expect(streetViewSourceMode(licensed)).toBe('persist');
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

  it('maps the default Street View template to display_only for live traffic', () => {
    const template = defaultPolicyTemplate('street_view');
    const permission = evaluatePermission({ ...live, policy: { ...policy({}), ...template } });
    expect(streetViewSourceMode(permission)).toBe('display_only');
    expect(isEditable(permission)).toBe(false);
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
  const fixtureState = { capabilityState: 'fixture' as const, appEnv: 'development' as const, now };

  it('lets fixture stand-in imagery be decorated under a fixture capability', () => {
    const template = defaultPolicyTemplate('street_view', { imagery: 'fixture' });
    expect(template.evidenceRef).toBe(FIXTURE_STREET_VIEW_EVIDENCE);
    const permission = evaluatePermission({
      ...fixtureState,
      policy: { ...policy({}), ...template },
      sourceKind: 'street_view',
      isGoogleImagery: true,
    });
    expect(isEditable(permission)).toBe(true);
  });

  it('keeps live Street View imagery display-only even under a fixture capability', () => {
    setStreetViewImagery('live');
    try {
      const template = defaultPolicyTemplate('street_view');
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
