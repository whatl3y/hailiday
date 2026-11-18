import { describe, expect, it } from 'vitest';
import type { ActivationState, AppEnv, CommerceMode, ProgramKind, UserRole } from '@hailiday/core';
import { projectPublicCapabilities, type Capabilities } from '@hailiday/server/capabilities';
import type { CountryCapability, MerchantProgram } from '@hailiday/server/db';
import type { ApiDeps } from '../deps.js';
import { experienceCapabilities, fixtureCapabilitiesFor } from './experience.js';

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

/** Deps whose database holds the given programs and whose capabilities hold the given states. */
function commerceDeps(input: {
  appEnv: AppEnv;
  commerce: CommerceMode;
  programs: { programKey: string; kind: ProgramKind; state: ActivationState | null }[];
}) {
  const rows = input.programs
    .filter((program) => program.state !== null)
    .map(
      (program) =>
        ({
          countryCode: 'US',
          capability: `commerce:${program.programKey}`,
          state: program.state,
        }) as CountryCapability,
    );
  const capabilities = {
    list: async () => rows,
    state: async (_country: string, capability: string) =>
      rows.find((row) => row.capability === capability)?.state ?? null,
    publicProjection: async (_country: string, audience: { roles: readonly UserRole[] }) =>
      projectPublicCapabilities(rows, audience, input.appEnv),
  } as unknown as Capabilities;
  const programs = input.programs.map(
    ({ programKey, kind }) => ({ id: programKey, programKey, kind }) as MerchantProgram,
  );
  const db = {
    selectFrom: () => ({ selectAll: () => ({ execute: async () => programs }) }),
  } as unknown as ApiDeps['db'];
  return {
    config: {
      appEnv: input.appEnv,
      isProduction: input.appEnv === 'production',
      providers: { commerce: input.commerce },
    } as ApiDeps['config'],
    capabilities,
    db,
  };
}

describe('experienceCapabilities', () => {
  const anonymous = { roles: [] as UserRole[] };

  it('offers commerce in fixture mode only for a fixture program in fixture state', async () => {
    const fixture = commerceDeps({
      appEnv: 'development',
      commerce: 'fixture',
      programs: [
        { programKey: 'fixture_decor_us', kind: 'fixture', state: 'fixture' },
        { programKey: 'walmart_us', kind: 'real', state: 'live_public' },
      ],
    });
    expect((await experienceCapabilities(fixture, anonymous)).commerce).toBe(true);
    const realOnly = commerceDeps({
      appEnv: 'development',
      commerce: 'fixture',
      programs: [{ programKey: 'walmart_us', kind: 'real', state: 'live_public' }],
    });
    expect((await experienceCapabilities(realOnly, anonymous)).commerce).toBe(false);
  });

  it('offers commerce in real mode only for a real program live to the viewer', async () => {
    const fixtureOnly = commerceDeps({
      appEnv: 'development',
      commerce: 'real',
      programs: [{ programKey: 'fixture_decor_us', kind: 'fixture', state: 'fixture' }],
    });
    expect((await experienceCapabilities(fixtureOnly, anonymous)).commerce).toBe(false);
    const fixtureState = commerceDeps({
      appEnv: 'development',
      commerce: 'real',
      programs: [{ programKey: 'walmart_us', kind: 'real', state: 'fixture' }],
    });
    expect((await experienceCapabilities(fixtureState, anonymous)).commerce).toBe(false);
    const privateLive = commerceDeps({
      appEnv: 'staging',
      commerce: 'real',
      programs: [{ programKey: 'walmart_us', kind: 'real', state: 'live_private' }],
    });
    expect((await experienceCapabilities(privateLive, anonymous)).commerce).toBe(false);
    expect((await experienceCapabilities(privateLive, { roles: ['pilot'] })).commerce).toBe(true);
  });

  it('offers no commerce for a fixture program in production', async () => {
    const production = commerceDeps({
      appEnv: 'production',
      commerce: 'fixture',
      programs: [{ programKey: 'fixture_decor_us', kind: 'fixture', state: 'fixture' }],
    });
    expect((await experienceCapabilities(production, anonymous)).commerce).toBe(false);
  });

  it('keeps the other flags as projected', async () => {
    const deps = commerceDeps({ appEnv: 'test', commerce: 'fixture', programs: [] });
    expect(await experienceCapabilities(deps, anonymous)).toEqual({
      addressLookup: false,
      streetViewAi: false,
      uploads: false,
      sharing: false,
      commerce: false,
    });
  });
});
