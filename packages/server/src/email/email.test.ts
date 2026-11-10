import { describe, expect, it } from 'vitest';
import { testConfig, type AppConfig } from '../config/index.js';
import { createEmailSender } from './index.js';

/** A deployed environment's configuration with the given email provider. */
function deployed(appEnv: 'staging' | 'production', provider: 'smtp' | 'fixture'): AppConfig {
  const base = testConfig();
  return {
    ...base,
    appEnv,
    isLocal: false,
    isProduction: appEnv === 'production',
    email: { ...base.email, provider },
  };
}

describe('createEmailSender', () => {
  it('uses the fixture sender in development and test', async () => {
    const sender = createEmailSender(testConfig({ EMAIL_PROVIDER: 'fixture' }));
    expect(sender.kind).toBe('fixture');
    await sender.close();
  });

  it('refuses the fixture sender in staging and production', () => {
    for (const appEnv of ['staging', 'production'] as const) {
      expect(() => createEmailSender(deployed(appEnv, 'fixture'))).toThrow(
        `EMAIL_PROVIDER=fixture is refused when APP_ENV=${appEnv}`,
      );
    }
  });

  it('builds the SMTP sender in staging and production', async () => {
    for (const appEnv of ['staging', 'production'] as const) {
      const sender = createEmailSender(deployed(appEnv, 'smtp'));
      expect(sender.kind).toBe('smtp');
      await sender.close();
    }
  });
});
