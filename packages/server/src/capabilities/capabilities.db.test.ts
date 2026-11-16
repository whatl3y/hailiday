import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../config/index.js';
import { createTestDb } from '../db/testing.js';
import { capabilityKeysFor, defaultCapabilityState, seedCapabilities } from './index.js';

const db = createTestDb();
/** A country code no other test seeds, so the shared `US` rows are never touched. */
const COUNTRY = 'XS';

afterAll(async () => {
  await db.deleteFrom('countryCapabilities').where('countryCode', '=', COUNTRY).execute();
  await db.destroy();
});

const keys = {
  GOOGLE_MAPS_SERVER_KEY: 'maps-server-key',
  GOOGLE_STREET_VIEW_BROWSER_KEY: 'maps-browser-key',
  GOOGLE_STREET_VIEW_SIGNING_SECRET: 'signing-secret',
  OPENAI_API_KEY: 'sk-test-123456',
};

async function stateOf(capability: string) {
  const row = await db
    .selectFrom('countryCapabilities')
    .select(['state', 'version'])
    .where('countryCode', '=', COUNTRY)
    .where('capability', '=', capability)
    .executeTakeFirstOrThrow();
  return row;
}

describe('the development seed profile', () => {
  it('seeds Street View AI live with live Street View and editing keys, and follows the use policy', async () => {
    const seed = (config: ReturnType<typeof parseConfig>, now: Date) =>
      seedCapabilities(db, {
        countryCode: COUNTRY,
        keys: capabilityKeysFor([]),
        state: (key) => defaultCapabilityState(config, key),
        evidenceRef: 'seed:default-profile:development',
        now,
        refreshSeeded: true,
      });

    await seed(parseConfig(keys), new Date('2026-11-10T09:00:00Z'));
    expect(await stateOf('street_view_ai')).toEqual({ state: 'live_public', version: 0 });
    expect(await stateOf('street_view_display')).toEqual({ state: 'live_public', version: 0 });

    // A seeded row follows the default when the use policy stops decoration.
    await seed(
      parseConfig({ ...keys, STREET_VIEW_USE_POLICY: 'display_only' }),
      new Date('2026-11-10T09:01:00Z'),
    );
    expect(await stateOf('street_view_ai')).toEqual({ state: 'fixture', version: 0 });

    // An operator's change (version 1 and above) is never overwritten by the seed.
    await db
      .updateTable('countryCapabilities')
      .set({ state: 'live_private', version: 1 })
      .where('countryCode', '=', COUNTRY)
      .where('capability', '=', 'street_view_ai')
      .execute();
    await seed(parseConfig(keys), new Date('2026-11-10T09:02:00Z'));
    expect(await stateOf('street_view_ai')).toEqual({ state: 'live_private', version: 1 });
  });
});
