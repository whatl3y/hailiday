import { describe, expect, it } from 'vitest';
import { parseConfig, testConfig } from '../config/index.js';
import {
  capabilityKeysFor,
  capabilityMode,
  defaultCapabilityState,
  projectPublicCapabilities,
} from './index.js';

describe('capability audience projection', () => {
  it('serves live_public to everyone and live_private only to pilot roles', () => {
    expect(capabilityMode('live_public', { roles: [] }, 'production')).toBe('live');
    expect(capabilityMode('live_private', { roles: [] }, 'production')).toBe('unavailable');
    expect(capabilityMode('live_private', { roles: ['user'] }, 'staging')).toBe('unavailable');
    expect(capabilityMode('live_private', { roles: ['user', 'pilot'] }, 'staging')).toBe('live');
    expect(capabilityMode('live_private', { roles: ['operator'] }, 'production')).toBe('live');
  });

  it('serves fixture only outside production', () => {
    expect(capabilityMode('fixture', { roles: [] }, 'development')).toBe('fixture');
    expect(capabilityMode('fixture', { roles: ['operator'] }, 'production')).toBe('unavailable');
    expect(capabilityMode(null, { roles: [] }, 'development')).toBe('unavailable');
  });

  it('projects the public flags, with commerce on when any program is available', () => {
    const rows = [
      { capability: 'address_lookup', state: 'fixture' as const },
      { capability: 'street_view_ai', state: 'live_private' as const },
      { capability: 'uploads', state: 'live_public' as const },
      { capability: 'commerce:fixture_decor_us', state: 'fixture' as const },
    ];
    expect(projectPublicCapabilities(rows, { roles: [] }, 'development')).toEqual({
      addressLookup: true,
      streetViewAi: false,
      uploads: true,
      sharing: false,
      commerce: true,
    });
    expect(projectPublicCapabilities(rows, { roles: [] }, 'production').commerce).toBe(false);
  });

  it('lists base keys plus one commerce key per program', () => {
    const keys = capabilityKeysFor(['fixture_decor_us']);
    expect(keys).toContain('street_view_ai');
    expect(keys).toContain('commerce:fixture_decor_us');
    expect(keys).toHaveLength(9);
  });
});

describe('capability defaults', () => {
  const keys = {
    GOOGLE_MAPS_SERVER_KEY: 'maps-server-key',
    GOOGLE_STREET_VIEW_BROWSER_KEY: 'maps-browser-key',
    GOOGLE_STREET_VIEW_SIGNING_SECRET: 'signing-secret',
    OPENAI_API_KEY: 'sk-test-123456',
    ANTHROPIC_API_KEY: 'sk-ant-test-123456',
  };

  it('follows the resolved live providers in development, Street View AI included', () => {
    const config = parseConfig(keys);
    expect(config.streetView.usePolicy).toBe('full');
    expect(defaultCapabilityState(config, 'image_editing')).toBe('live_public');
    expect(defaultCapabilityState(config, 'vision_analysis')).toBe('live_public');
    expect(defaultCapabilityState(config, 'address_lookup')).toBe('live_public');
    expect(defaultCapabilityState(config, 'street_view_display')).toBe('live_public');
    expect(defaultCapabilityState(config, 'street_view_ai')).toBe('live_public');
    expect(defaultCapabilityState(config, 'uploads')).toBe('fixture');
    expect(defaultCapabilityState(config, 'commerce:fixture_decor_us')).toBe('fixture');
  });

  it('keeps Street View AI in fixture unless Street View and the editor are live and decoration is allowed', () => {
    const decorate = parseConfig({ ...keys, STREET_VIEW_USE_POLICY: 'decorate' });
    expect(defaultCapabilityState(decorate, 'street_view_ai')).toBe('live_public');
    const displayOnly = parseConfig({ ...keys, STREET_VIEW_USE_POLICY: 'display_only' });
    expect(defaultCapabilityState(displayOnly, 'street_view_ai')).toBe('fixture');
    expect(defaultCapabilityState(displayOnly, 'street_view_display')).toBe('live_public');
    const noEditor = parseConfig({ ...keys, IMAGE_EDITOR_PROVIDER: 'fixture' });
    expect(defaultCapabilityState(noEditor, 'street_view_ai')).toBe('fixture');
    const noStreetView = parseConfig({ ...keys, STREET_VIEW_PROVIDER: 'fixture' });
    expect(defaultCapabilityState(noStreetView, 'street_view_ai')).toBe('fixture');
    // A configuration without the Street View section reads the default use policy.
    expect(
      defaultCapabilityState(
        { appEnv: 'development', providers: parseConfig(keys).providers },
        'street_view_ai',
      ),
    ).toBe('live_public');
    const staging = { ...parseConfig(keys), appEnv: 'staging' as const };
    expect(defaultCapabilityState(staging, 'street_view_ai')).toBe('fixture');
  });

  it('serves a real program live in development only while the real programs are served', () => {
    const real = ['walmart_us', 'amazon_us'];
    const development = parseConfig({});
    expect(development.providers.commerce).toBe('real');
    expect(defaultCapabilityState(development, 'commerce:walmart_us', real)).toBe('live_public');
    expect(defaultCapabilityState(development, 'commerce:amazon_us', real)).toBe('live_public');
    expect(defaultCapabilityState(development, 'commerce:fixture_decor_us', real)).toBe('fixture');
    // Without the real program keys every commerce capability stays in fixture.
    expect(defaultCapabilityState(development, 'commerce:walmart_us')).toBe('fixture');
    const fixturePrograms = parseConfig({ COMMERCE_PROGRAMS: 'fixture' });
    expect(defaultCapabilityState(fixturePrograms, 'commerce:walmart_us', real)).toBe('fixture');
    for (const appEnv of ['staging', 'production'] as const) {
      const deployed = { ...parseConfig({ COMMERCE_PROGRAMS: 'real' }), appEnv };
      expect(defaultCapabilityState(deployed, 'commerce:walmart_us', real), appEnv).toBe('fixture');
    }
    expect(defaultCapabilityState(testConfig(), 'commerce:walmart_us', real)).toBe('fixture');
  });

  it('stays fixture without keys and outside development', () => {
    const fixture = parseConfig({});
    for (const key of capabilityKeysFor([])) {
      expect(defaultCapabilityState(fixture, key)).toBe('fixture');
    }
    const staging = { ...parseConfig(keys), appEnv: 'staging' as const };
    expect(defaultCapabilityState(staging, 'image_editing')).toBe('fixture');
    const production = { ...parseConfig(keys), appEnv: 'production' as const };
    expect(defaultCapabilityState(production, 'vision_analysis')).toBe('fixture');
  });
});
