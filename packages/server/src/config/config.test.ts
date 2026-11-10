import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SESSION_SECRET, parseConfig, testConfig } from './index.js';

const PRODUCTION = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db/holiday',
  SESSION_SECRET: 'production-session-secret-0123456789abcdef',
  PUBLIC_BASE_URL: 'https://holiday.example',
  S3_ENDPOINT: 'https://s3.example',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret-value',
  S3_PRIVATE_BUCKET: 'holiday-prod-private',
  S3_PUBLIC_BUCKET: 'holiday-prod-public',
  SMTP_URL: 'smtp://mail.example:587',
  EMAIL_PROVIDER: 'smtp',
  TURNSTILE_MODE: 'live',
  TURNSTILE_SITE_KEY: 'turnstile-site-key',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-key',
};

const ALL_KEYS = {
  GOOGLE_MAPS_SERVER_KEY: 'maps-server-key',
  GOOGLE_STREET_VIEW_BROWSER_KEY: 'maps-browser-key',
  GOOGLE_STREET_VIEW_SIGNING_SECRET: 'signing-secret',
  OPENAI_API_KEY: 'sk-test-123456',
  GEMINI_API_KEY: 'gemini-test-123456',
  ANTHROPIC_API_KEY: 'sk-ant-test-123456',
};

const ALL_FIXTURE = {
  address: 'fixture',
  streetView: 'fixture',
  imageEditor: 'fixture',
  vision: 'fixture',
  safety: 'fixture',
};

describe('parseConfig', () => {
  it('applies local defaults in development without any variables', () => {
    const config = parseConfig({});
    expect(config.appEnv).toBe('development');
    expect(config.isLocal).toBe(true);
    expect(config.database.url).toBe('postgres://postgres:postgres@localhost:5434/holiday');
    expect(config.storage.endpoint).toBe('http://localhost:9000');
    expect(config.storage.publicEndpoint).toBe('http://localhost:9000');
    expect(config.storage.publicAssetBaseUrl).toBe('http://localhost:9000/holiday-public');
    expect(config.storage.corsOrigins).toEqual(['http://localhost:8080', 'http://localhost:5173']);
    expect(config.providers).toEqual({
      address: 'fixture',
      streetView: 'fixture',
      imageEditor: 'fixture',
      vision: 'fixture',
      safety: 'fixture',
    });
    expect(config.providerSelection).toEqual({
      address: 'auto',
      streetView: 'auto',
      imageEditor: 'auto',
      vision: 'auto',
    });
    expect(config.email.provider).toBe('fixture');
    expect(config.turnstile.mode).toBe('fixture');
    expect(config.sessionSecret).toBe(DEV_SESSION_SECRET);
    expect(config.queue.renderMaxJobDurationSeconds).toBe(180);
    expect(Object.isFrozen(config.storage)).toBe(true);
  });

  it('derives the public asset base URL from the public endpoint', () => {
    const config = parseConfig({
      S3_ENDPOINT: 'http://storage:9000',
      S3_PUBLIC_ENDPOINT: 'http://localhost:9000/',
      S3_PUBLIC_BUCKET: 'holiday-public',
    });
    expect(config.storage.endpoint).toBe('http://storage:9000');
    expect(config.storage.publicAssetBaseUrl).toBe('http://localhost:9000/holiday-public');
  });

  it('requires explicit values outside development and test', () => {
    expect(() => parseConfig({ APP_ENV: 'production' })).toThrow(ConfigError);
    try {
      parseConfig({ APP_ENV: 'staging' });
    } catch (error) {
      expect((error as ConfigError).issues.join('\n')).toContain('DATABASE_URL is required');
      expect((error as ConfigError).issues.join('\n')).toContain('SESSION_SECRET is required');
    }
  });

  it('refuses the development session secret in production', () => {
    expect(() => parseConfig({ ...PRODUCTION, SESSION_SECRET: DEV_SESSION_SECRET })).toThrow(
      /development default/,
    );
  });

  it('refuses the fixture bot check and fixture email in staging and production', () => {
    for (const appEnv of ['staging', 'production']) {
      const deployed = { ...PRODUCTION, APP_ENV: appEnv };
      expect(parseConfig(deployed).turnstile.mode).toBe('live');
      expect(parseConfig(deployed).email.provider).toBe('smtp');

      // Left unset, both fall back to their fixtures, which a deployed environment refuses.
      const unset: Record<string, string | undefined> = { ...deployed };
      delete unset.TURNSTILE_MODE;
      delete unset.EMAIL_PROVIDER;
      let issues: string[] = [];
      try {
        parseConfig(unset);
      } catch (error) {
        issues = (error as ConfigError).issues;
      }
      expect(issues).toEqual([
        `TURNSTILE_MODE must be live when APP_ENV=${appEnv}`,
        `EMAIL_PROVIDER must be smtp when APP_ENV=${appEnv}`,
      ]);

      expect(() => parseConfig({ ...deployed, TURNSTILE_MODE: 'fixture' })).toThrow(
        /TURNSTILE_MODE must be live/,
      );
      expect(() => parseConfig({ ...deployed, EMAIL_PROVIDER: 'fixture' })).toThrow(
        /EMAIL_PROVIDER must be smtp/,
      );
      // Live Turnstile still needs both keys.
      expect(() => parseConfig({ ...deployed, TURNSTILE_SECRET_KEY: '' })).toThrow(
        /TURNSTILE_SECRET_KEY/,
      );
    }
    // Development and test keep the fixtures as their defaults.
    expect(parseConfig({}).turnstile.mode).toBe('fixture');
    expect(testConfig().email.provider).toBe('fixture');
  });

  it('refuses the Anthropic SDK redirect and credential variables', () => {
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS']) {
      expect(() => parseConfig({ ...PRODUCTION, [name]: 'https://gateway.example' })).toThrow(
        new RegExp(`${name} must not be set`),
      );
      expect(() => parseConfig({ [name]: 'value' })).toThrow(new RegExp(name));
    }
    expect(() => parseConfig({ ANTHROPIC_BASE_URL: '' })).not.toThrow();
  });

  it('allows the Vite dev origin in bucket CORS only in development and test', () => {
    expect(testConfig().storage.corsOrigins).toEqual([
      'http://localhost:8080',
      'http://localhost:5173',
    ]);
    expect(parseConfig(PRODUCTION).storage.corsOrigins).toEqual(['https://holiday.example']);
    expect(parseConfig({ ...PRODUCTION, APP_ENV: 'staging' }).storage.corsOrigins).toEqual([
      'https://holiday.example',
    ]);
    expect(
      parseConfig({
        ...PRODUCTION,
        STORAGE_CORS_ORIGINS: 'https://holiday.example/, https://www.holiday.example',
      }).storage.corsOrigins,
    ).toEqual(['https://holiday.example', 'https://www.holiday.example']);
  });

  it('fails fast when a live provider has no key', () => {
    expect(() => parseConfig({ IMAGE_EDITOR_PROVIDER: 'openai' })).toThrow(/OPENAI_API_KEY/);
    expect(() => parseConfig({ VISION_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => parseConfig({ STREET_VIEW_PROVIDER: 'google' })).toThrow(
      /GOOGLE_STREET_VIEW_SIGNING_SECRET/,
    );
    expect(() => parseConfig({ TURNSTILE_MODE: 'live' })).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(
      parseConfig({ IMAGE_EDITOR_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-test-123456' }).providers
        .imageEditor,
    ).toBe('openai');
  });

  it('rejects unknown enum values', () => {
    expect(() => parseConfig({ APP_ENV: 'qa' })).toThrow(ConfigError);
    expect(() => parseConfig({ ADDRESS_PROVIDER: 'mapbox' })).toThrow(ConfigError);
  });

  it('collects setting overrides, provider concurrency and secrets', () => {
    const config = parseConfig({
      ALLOWANCE_VARIANTS_PER_24H: '5',
      OPENAI_MAX_CONCURRENCY: '4',
      OPENAI_API_KEY: 'sk-live-abcdef',
      IMAGE_EDITOR_PROVIDER: 'openai',
    });
    expect(config.settingOverrides.ALLOWANCE_VARIANTS_PER_24H).toBe('5');
    expect(config.admission.providerConcurrency.openai).toBe(4);
    expect(config.secrets).toContain('sk-live-abcdef');
    expect(config.secrets).toContain('holiday-dev-secret');
  });

  it('testConfig points the primary database at the test database', () => {
    const config = testConfig();
    expect(config.appEnv).toBe('test');
    expect(config.database.url).toMatch(/\/holiday_test\w*$/);
    expect(config.database.url).toBe(config.database.testUrl);
  });

  it('resolves auto to the live provider when its keys are set and to fixture otherwise', () => {
    const live = parseConfig({
      GOOGLE_MAPS_SERVER_KEY: 'maps-server-key',
      GOOGLE_STREET_VIEW_BROWSER_KEY: 'maps-browser-key',
      GOOGLE_STREET_VIEW_SIGNING_SECRET: 'signing-secret',
      OPENAI_API_KEY: 'sk-test-123456',
      GEMINI_API_KEY: 'gemini-test-123456',
      ANTHROPIC_API_KEY: 'sk-ant-test-123456',
    });
    expect(live.providers).toMatchObject({
      address: 'google',
      streetView: 'google',
      imageEditor: 'openai',
      vision: 'anthropic',
    });
    expect(parseConfig({ OPENAI_API_KEY: 'sk-test-123456' }).providers.imageEditor).toBe('openai');
    expect(parseConfig({ GEMINI_API_KEY: 'gemini-test-123456' }).providers.imageEditor).toBe(
      'gemini',
    );
    // The server key alone enables address lookup but not Street View display.
    const partial = parseConfig({ GOOGLE_MAPS_SERVER_KEY: 'maps-server-key' });
    expect(partial.providers).toMatchObject({ address: 'google', streetView: 'fixture' });
    expect(parseConfig({ ANTHROPIC_API_KEY: 'sk-ant-test-123456' }).providers).toMatchObject({
      imageEditor: 'fixture',
      vision: 'anthropic',
    });
  });

  it('accepts auto explicitly and keeps fixture as the default outside development', () => {
    const explicit = parseConfig({ IMAGE_EDITOR_PROVIDER: 'auto', OPENAI_API_KEY: 'sk-test-1' });
    expect(explicit.providers.imageEditor).toBe('openai');
    expect(explicit.providerSelection.imageEditor).toBe('auto');
    // Tests never reach a live provider by default, even when keys are present.
    const test = testConfig({ OPENAI_API_KEY: 'sk-test-123456', ANTHROPIC_API_KEY: 'sk-ant-1' });
    expect(test.providers).toMatchObject({ imageEditor: 'fixture', vision: 'fixture' });
    expect(test.providerSelection.imageEditor).toBe('fixture');
    // auto never fails startup for a missing key; an explicit live selection still does.
    expect(() => parseConfig({ VISION_PROVIDER: 'auto' })).not.toThrow();
    expect(() => parseConfig({ VISION_PROVIDER: 'anthropic' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it('never resolves auto to a live provider under APP_ENV=test, even with every key present', () => {
    const test = parseConfig({ APP_ENV: 'test', ...ALL_KEYS });
    expect(test.providers).toEqual(ALL_FIXTURE);
    const explicitAuto = parseConfig({
      APP_ENV: 'test',
      ...ALL_KEYS,
      ADDRESS_PROVIDER: 'auto',
      STREET_VIEW_PROVIDER: 'auto',
      IMAGE_EDITOR_PROVIDER: 'auto',
      VISION_PROVIDER: 'auto',
    });
    expect(explicitAuto.providers).toEqual(ALL_FIXTURE);
    expect(explicitAuto.providerSelection.imageEditor).toBe('auto');
    expect(testConfig({ ...ALL_KEYS, IMAGE_EDITOR_PROVIDER: 'auto' }).providers.imageEditor).toBe(
      'fixture',
    );
  });

  it('refuses an explicitly live provider under APP_ENV=test', () => {
    for (const [name, value] of [
      ['ADDRESS_PROVIDER', 'google'],
      ['STREET_VIEW_PROVIDER', 'google'],
      ['IMAGE_EDITOR_PROVIDER', 'openai'],
      ['IMAGE_EDITOR_PROVIDER', 'gemini'],
      ['VISION_PROVIDER', 'anthropic'],
      ['TURNSTILE_MODE', 'live'],
    ] as const) {
      expect(() =>
        parseConfig({
          APP_ENV: 'test',
          ...ALL_KEYS,
          TURNSTILE_SITE_KEY: 'site-key',
          TURNSTILE_SECRET_KEY: 'turnstile-secret',
          [name]: value,
        }),
      ).toThrow(new RegExp(`${name}=${value} is live, but APP_ENV=test`));
    }
    expect(() => parseConfig({ APP_ENV: 'test', IMAGE_EDITOR_PROVIDER: 'fixture' })).not.toThrow();
  });

  it('defaults to auto only in development', () => {
    expect(parseConfig({ ...ALL_KEYS }).providers).toMatchObject({
      imageEditor: 'openai',
      vision: 'anthropic',
    });
    for (const appEnv of ['test', 'staging', 'production']) {
      const config = parseConfig({
        ...PRODUCTION,
        APP_ENV: appEnv,
        ...ALL_KEYS,
        ...(appEnv === 'test' ? { TURNSTILE_MODE: 'fixture' } : {}),
      });
      expect(config.providerSelection).toEqual({
        address: 'fixture',
        streetView: 'fixture',
        imageEditor: 'fixture',
        vision: 'fixture',
      });
      expect(config.providers).toEqual(ALL_FIXTURE);
    }
  });

  it('trusts no proxy hops locally and one hop elsewhere unless configured', () => {
    expect(parseConfig({}).trustProxyHops).toBe(0);
    expect(testConfig().trustProxyHops).toBe(0);
    expect(parseConfig(PRODUCTION).trustProxyHops).toBe(1);
    expect(parseConfig({ ...PRODUCTION, APP_ENV: 'staging' }).trustProxyHops).toBe(1);
    expect(parseConfig({ ...PRODUCTION, TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(parseConfig({ ...PRODUCTION, TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
    expect(parseConfig({ TRUST_PROXY_HOPS: '1' }).trustProxyHops).toBe(1);
    expect(() => parseConfig({ TRUST_PROXY_HOPS: '-1' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => parseConfig({ TRUST_PROXY_HOPS: 'true' })).toThrow(/TRUST_PROXY_HOPS/);
    expect(() => parseConfig({ TRUST_PROXY_HOPS: '1.5' })).toThrow(/TRUST_PROXY_HOPS/);
  });

  it('picks the preferred live image editor for auto when both keys are set', () => {
    const both = { OPENAI_API_KEY: 'sk-test-123456', GEMINI_API_KEY: 'gemini-test-123456' };
    // OpenAI is the default preference; Gemini is chosen explicitly or when it is the only key.
    expect(parseConfig(both).imageEdit.preference).toBe('openai');
    expect(parseConfig(both).providers.imageEditor).toBe('openai');
    expect(parseConfig({ ...both, IMAGE_EDITOR_PREFERENCE: 'gemini' }).providers.imageEditor).toBe(
      'gemini',
    );
    expect(parseConfig({ ...both, IMAGE_EDITOR_PREFERENCE: 'openai' }).providers.imageEditor).toBe(
      'openai',
    );
    // The default OpenAI model and quality are the bake-off's budget settings.
    expect(parseConfig(both).openai.imageModel).toBe('gpt-image-2.5-flare');
    expect(parseConfig(both).imageEdit.openaiQuality).toBe('medium');
    // The preference only breaks a tie: a single key still selects its own editor.
    expect(
      parseConfig({ OPENAI_API_KEY: 'sk-test-123456', IMAGE_EDITOR_PREFERENCE: 'gemini' }).providers
        .imageEditor,
    ).toBe('openai');
    expect(
      parseConfig({ GEMINI_API_KEY: 'gemini-test-123456', IMAGE_EDITOR_PREFERENCE: 'openai' })
        .providers.imageEditor,
    ).toBe('gemini');
    // An explicit selection is never overridden by the preference.
    expect(parseConfig({ ...both, IMAGE_EDITOR_PROVIDER: 'openai' }).providers.imageEditor).toBe(
      'openai',
    );
    expect(() => parseConfig({ IMAGE_EDITOR_PREFERENCE: 'fixture' })).toThrow(
      /IMAGE_EDITOR_PREFERENCE/,
    );
  });

  it('applies the image-edit budget defaults and accepts only the supported values', () => {
    const config = parseConfig({});
    expect(config.openai.imageModel).toBe('gpt-image-2.5-flare');
    expect(config.gemini.imageModel).toBe('gemini-nano-banana-2.1');
    expect(config.imageEdit).toEqual({
      preference: 'openai',
      providerMask: 'none',
      openaiQuality: 'medium',
      geminiImageSize: '1K',
      geminiThinkingLevel: 'minimal',
    });
    const configured = parseConfig({
      OPENAI_IMAGE_QUALITY: 'high',
      GEMINI_IMAGE_SIZE: '2K',
      GEMINI_THINKING_LEVEL: 'medium',
      IMAGE_EDIT_PROVIDER_MASK: 'tight',
    });
    expect(configured.imageEdit).toMatchObject({
      providerMask: 'tight',
      openaiQuality: 'high',
      geminiImageSize: '2K',
      geminiThinkingLevel: 'medium',
    });
    // The Gemini image models reject the `low` thinking level.
    expect(() => parseConfig({ GEMINI_THINKING_LEVEL: 'low' })).toThrow(/GEMINI_THINKING_LEVEL/);
    expect(() => parseConfig({ GEMINI_IMAGE_SIZE: '4K' })).toThrow(/GEMINI_IMAGE_SIZE/);
    expect(() => parseConfig({ OPENAI_IMAGE_QUALITY: 'max' })).toThrow(/OPENAI_IMAGE_QUALITY/);
    expect(() => parseConfig({ IMAGE_EDIT_PROVIDER_MASK: 'full' })).toThrow(
      /IMAGE_EDIT_PROVIDER_MASK/,
    );
  });

  it('reads the Street View attribution rectangles per frame size and refuses invalid JSON', () => {
    expect(parseConfig({}).streetView.attributionRegions).toEqual({});
    expect(parseConfig({ STREET_VIEW_ATTRIBUTION_REGIONS: '' }).streetView).toEqual({
      attributionRegions: {},
    });
    const configured = parseConfig({
      STREET_VIEW_ATTRIBUTION_REGIONS:
        '{"640x640":[[0,0.94,0.14,1],[0.72,0.96,1,1]],"640x427":[[0,0.9,0.15,1]]}',
    });
    expect(configured.streetView.attributionRegions).toEqual({
      '640x640': [
        [0, 0.94, 0.14, 1],
        [0.72, 0.96, 1, 1],
      ],
      '640x427': [[0, 0.9, 0.15, 1]],
    });
    for (const value of [
      'not json',
      '[[0, 0.9, 0.1, 1]]',
      '{"640":[[0,0.9,0.1,1]]}',
      '{"640x640":[[0.5,0.9,0.1,1]]}',
      '{"640x640":[[0,0.9,0.1,1.2]]}',
      '{"640x640":[0,0.9,0.1,1]}',
    ]) {
      expect(() => parseConfig({ STREET_VIEW_ATTRIBUTION_REGIONS: value })).toThrow(
        /STREET_VIEW_ATTRIBUTION_REGIONS/,
      );
    }
  });
});
