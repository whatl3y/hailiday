import { describe, expect, it } from 'vitest';
import { SPEND_CEILING_KEYS, runtimeSettingSchemaFor } from '@holiday/core';
import { parseConfig, testConfig } from '../config/index.js';
import {
  DEFAULT_SKU_DAILY_CEILINGS_MICROS,
  LOCAL_DEVELOPMENT_LIMITS,
  settingDefaults,
  settingEnvName,
} from './index.js';

const STAGING = {
  APP_ENV: 'staging',
  DATABASE_URL: 'postgres://u:p@db/holiday',
  SESSION_SECRET: 'staging-secret-value-that-is-long-enough-123',
  PUBLIC_BASE_URL: 'https://staging.holiday.example',
  S3_ENDPOINT: 'https://s3.example',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret-value',
  S3_PRIVATE_BUCKET: 'holiday-staging-private',
  S3_PUBLIC_BUCKET: 'holiday-staging-public',
  SMTP_URL: 'smtp://mail.example:587',
  EMAIL_PROVIDER: 'smtp',
  TURNSTILE_MODE: 'live',
  TURNSTILE_SITE_KEY: 'turnstile-site-key',
  TURNSTILE_SECRET_KEY: 'turnstile-secret-key',
};

const SPECIFIED_LIMITS = {
  'allowance.variants_per_24h': 3,
  'allowance.addresses_per_24h': 3,
  'quota.attempts_per_owner_24h': 8,
  'quota.render_requests_per_device_24h': 6,
  'quota.render_requests_per_ip_24h': 6,
  'rate.sessions_per_ip_10m': 20,
};

describe('runtime setting defaults', () => {
  it('covers every documented key and validates against the core schemas', () => {
    const defaults = settingDefaults(testConfig());
    for (const key of [
      'allowance.variants_per_24h',
      'allowance.addresses_per_24h',
      'allowance.new_owner_variants_per_24h',
      'quota.attempts_per_owner_24h',
      'quota.render_requests_per_device_24h',
      'quota.render_requests_per_ip_24h',
      'rate.static_display_loads_per_address',
      'spend.daily_micros',
      'spend.monthly_micros',
      'admission.max_queue_depth',
      'admission.max_wait_s',
      'pause.global',
      'discovery.autostart_paused',
      'review.mode',
      'review.audit_sample_rate',
      'idempotency.retention_h',
      'sse.heartbeat_s',
      'poll.render_ms',
      'poll.upload_ms',
      ...SPEND_CEILING_KEYS.map((sku) => `spend.sku_daily_micros.${sku}`),
      'pause.provider.openai',
      'admission.provider_concurrency.openai',
    ]) {
      expect(key in defaults, key).toBe(true);
      expect(runtimeSettingSchemaFor(key)?.safeParse(defaults[key]).success, key).toBe(true);
    }
    expect(defaults['allowance.variants_per_24h']).toBe(3);
    expect(defaults['quota.attempts_per_owner_24h']).toBe(8);
    expect(defaults['quota.render_requests_per_device_24h']).toBe(6);
    expect(defaults['quota.render_requests_per_ip_24h']).toBe(6);
    expect(defaults['spend.daily_micros']).toBe(700_000_000);
    expect(defaults['spend.monthly_micros']).toBe(15_000_000_000);
    expect(DEFAULT_SKU_DAILY_CEILINGS_MICROS.image_edit_attempt).toBe(481_000_000);
    expect(defaults['admission.max_queue_depth']).toBe(36);
    expect(defaults['admission.max_wait_s']).toBe(240);
  });

  it('delivers without review locally and reviews before delivery elsewhere', () => {
    expect(settingDefaults(testConfig())['review.mode']).toMatchObject({
      house_exterior: 'sampled_audit',
    });
    const staging = parseConfig(STAGING);
    expect(settingDefaults(staging)['review.mode']).toMatchObject({ interior: 'pre_delivery' });
  });

  it('applies environment overrides by key name', () => {
    expect(settingEnvName('allowance.variants_per_24h')).toBe('ALLOWANCE_VARIANTS_PER_24H');
    const config = testConfig({ ALLOWANCE_VARIANTS_PER_24H: '5', PAUSE_GLOBAL: 'true' });
    const defaults = settingDefaults(config);
    expect(defaults['allowance.variants_per_24h']).toBe(5);
    expect(defaults['pause.global']).toBe(true);
    expect(() => settingDefaults(testConfig({ ALLOWANCE_VARIANTS_PER_24H: '-1' }))).toThrow();
  });

  it('uses generous owner and per-IP limits in development only', () => {
    expect(LOCAL_DEVELOPMENT_LIMITS).toEqual({
      'allowance.variants_per_24h': 30,
      'allowance.addresses_per_24h': 30,
      'quota.attempts_per_owner_24h': 60,
      'quota.render_requests_per_device_24h': 300,
      'quota.render_requests_per_ip_24h': 300,
      'rate.sessions_per_ip_10m': 200,
    });
    expect(settingDefaults(parseConfig({}))).toMatchObject(LOCAL_DEVELOPMENT_LIMITS);
    expect(settingDefaults(testConfig())).toMatchObject(SPECIFIED_LIMITS);
    expect(settingDefaults(parseConfig(STAGING))).toMatchObject(SPECIFIED_LIMITS);
    expect(settingDefaults(parseConfig({ ...STAGING, APP_ENV: 'production' }))).toMatchObject(
      SPECIFIED_LIMITS,
    );
    // Everything else keeps its specified default in development.
    expect(settingDefaults(parseConfig({}))['spend.daily_micros']).toBe(700_000_000);
  });

  it('lets an explicit environment value win over the development limits', () => {
    const defaults = settingDefaults(
      parseConfig({
        ALLOWANCE_VARIANTS_PER_24H: '3',
        ALLOWANCE_ADDRESSES_PER_24H: '3',
        QUOTA_ATTEMPTS_PER_OWNER_24H: '8',
        QUOTA_RENDER_REQUESTS_PER_DEVICE_24H: '1000',
        QUOTA_RENDER_REQUESTS_PER_IP_24H: '40',
        RATE_SESSIONS_PER_IP_10M: '1000',
      }),
    );
    expect(defaults).toMatchObject({
      'allowance.variants_per_24h': 3,
      'allowance.addresses_per_24h': 3,
      'quota.attempts_per_owner_24h': 8,
      'quota.render_requests_per_device_24h': 1000,
      'quota.render_requests_per_ip_24h': 40,
      'rate.sessions_per_ip_10m': 1000,
    });
  });
});
