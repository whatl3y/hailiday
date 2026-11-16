import { describe, expect, it } from 'vitest';
import type { Capabilities } from '@hailiday/server/capabilities';
import { parseConfig } from '@hailiday/server/config';
import type { ApiDeps } from '../deps.js';
import { capabilityState, streetViewCandidatePolicy, streetViewPolicyTemplate } from './sources.js';

const keys = {
  GOOGLE_MAPS_SERVER_KEY: 'maps-server-key',
  GOOGLE_STREET_VIEW_BROWSER_KEY: 'maps-browser-key',
  GOOGLE_STREET_VIEW_SIGNING_SECRET: 'signing-secret',
  OPENAI_API_KEY: 'sk-test-123456',
};

function depsWith(config: ApiDeps['config']): Pick<ApiDeps, 'capabilities' | 'config'> {
  const capabilities = { state: async () => null } as unknown as Capabilities;
  return { capabilities, config };
}

describe('capabilityState', () => {
  it('assumes the environment default for a missing row locally, as the worker does', async () => {
    const live = depsWith(parseConfig(keys));
    expect(await capabilityState(live, 'street_view_ai')).toBe('live_public');
    expect(await capabilityState(live, 'image_editing')).toBe('live_public');
    expect(await capabilityState(live, 'uploads')).toBe('fixture');
    const fixture = depsWith(parseConfig({}));
    expect(await capabilityState(fixture, 'street_view_ai')).toBe('fixture');
    const staging = depsWith({ ...parseConfig(keys), appEnv: 'staging', isLocal: false });
    expect(await capabilityState(staging, 'street_view_ai')).toBeNull();
  });
});

describe('streetViewPolicyTemplate', () => {
  it('follows the configured use policy and the configured imagery', () => {
    expect(streetViewPolicyTemplate({ config: parseConfig(keys) })).toMatchObject({
      aiProcess: 'allowed',
      store: 'allowed',
      evidenceRef: 'owner-decision:2026-11-10',
      attributionText: 'Google Maps',
    });
    const displayOnly = parseConfig({ ...keys, STREET_VIEW_USE_POLICY: 'display_only' });
    expect(streetViewPolicyTemplate({ config: displayOnly })).toMatchObject({
      aiProcess: 'unknown',
      evidenceRef: 'google-maps-platform:standard-terms',
    });
    expect(
      streetViewPolicyTemplate({ config: parseConfig({ STREET_VIEW_USE_POLICY: 'display_only' }) })
        .evidenceRef,
    ).toBe('fixture:street-view-stand-in');
    const decorate = parseConfig({ ...keys, STREET_VIEW_USE_POLICY: 'decorate' });
    expect(streetViewCandidatePolicy({ config: decorate })).toMatchObject({
      display: 'allowed',
      store: 'denied',
      aiProcess: 'allowed',
      edit: 'allowed',
      distributeDerivative: 'denied',
      commerceAdjacent: 'denied',
      revokedAt: null,
      expiresAt: null,
    });
  });
});
