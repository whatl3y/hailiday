import { describe, expect, it } from 'vitest';
import type { ActivationState, AppEnv } from '@holiday/core';
import type { Capabilities } from '@holiday/server/capabilities';
import type { CountryCapability } from '@holiday/server/db';
import type { ApiDeps } from '../deps.js';
import { fixtureCapabilitiesFor } from './experience.js';

function depsWith(appEnv: AppEnv, states: Record<string, ActivationState>) {
  const rows = Object.entries(states).map(
    ([capability, state]) => ({ countryCode: 'US', capability, state }) as CountryCapability,
  );
  const capabilities = { list: async () => rows } as unknown as Capabilities;
  return {
    config: { appEnv, isProduction: appEnv === 'production' } as ApiDeps['config'],
    capabilities,
  };
}

const STATES: Record<string, ActivationState> = {
  address_lookup: 'live_public',
  street_view_display: 'fixture',
  image_editing: 'fixture',
  vision_analysis: 'live_private',
  'commerce:lumen_home': 'fixture',
};

describe('fixtureCapabilitiesFor', () => {
  it('lists the capabilities in fixture state outside production', async () => {
    for (const appEnv of ['development', 'test', 'staging'] as const) {
      expect(await fixtureCapabilitiesFor(depsWith(appEnv, STATES), { roles: [] })).toEqual([
        'street_view_display',
        'image_editing',
        'commerce:lumen_home',
      ]);
    }
  });

  it('omits the list in production', async () => {
    expect(
      await fixtureCapabilitiesFor(depsWith('production', STATES), { roles: [] }),
    ).toBeUndefined();
  });

  it('never lists live capabilities, whatever the audience', async () => {
    const reviewer = await fixtureCapabilitiesFor(depsWith('staging', STATES), {
      roles: ['reviewer'],
    });
    expect(reviewer).not.toContain('vision_analysis');
    expect(reviewer).not.toContain('address_lookup');
  });
});
