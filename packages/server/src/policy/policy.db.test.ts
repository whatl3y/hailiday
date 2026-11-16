import type { Kysely } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import * as templateMark from '../db/migrations/0016_street_view_template_mark.js';
import { createTestDb } from '../db/testing.js';
import { newId } from '../ids/index.js';
import {
  FIXTURE_STREET_VIEW_EVIDENCE,
  STREET_VIEW_OWNER_DECISION_EVIDENCE,
  STREET_VIEW_STANDARD_TERMS_EVIDENCE,
  STREET_VIEW_TEMPLATE_CREATOR,
  createAssetPolicy,
  defaultPolicyTemplate,
  refreshStreetViewPolicy,
} from './index.js';

const db = createTestDb();
afterAll(() => db.destroy());

const uses = [
  'display',
  'store',
  'aiProcess',
  'edit',
  'distributeDerivative',
  'commerceAdjacent',
] as const;

async function streetViewPolicy(template = defaultPolicyTemplate('street_view')) {
  return createAssetPolicy(db, { subjectKind: 'source_asset', subjectId: newId(), template });
}

const standardTerms = defaultPolicyTemplate('street_view', {
  usePolicy: 'display_only',
  imagery: 'live',
  attributionText: 'Google Maps',
});
const full = defaultPolicyTemplate('street_view', { imagery: 'live' });
const decorate = defaultPolicyTemplate('street_view', { usePolicy: 'decorate', imagery: 'live' });

describe('refreshStreetViewPolicy', () => {
  it('brings a standard-terms template row up to the full template', async () => {
    const stored = await streetViewPolicy(standardTerms);
    expect(stored.evidenceRef).toBe(STREET_VIEW_STANDARD_TERMS_EVIDENCE);
    const refreshed = await refreshStreetViewPolicy(db, stored.id, full);
    for (const use of uses) expect(refreshed?.[use]).toBe('allowed');
    expect(refreshed).toMatchObject({
      evidenceRef: STREET_VIEW_OWNER_DECISION_EVIDENCE,
      attributionText: 'Google Maps',
      territory: 'US',
      createdBy: STREET_VIEW_TEMPLATE_CREATOR,
    });
    // Every later template row follows the configured use policy again, both ways.
    const narrowed = await refreshStreetViewPolicy(db, stored.id, decorate);
    expect(narrowed).toMatchObject({ store: 'denied', aiProcess: 'allowed', edit: 'allowed' });
    const restored = await refreshStreetViewPolicy(db, stored.id, standardTerms);
    expect(restored).toMatchObject({
      store: 'unknown',
      aiProcess: 'unknown',
      evidenceRef: STREET_VIEW_STANDARD_TERMS_EVIDENCE,
    });
  });

  it('leaves a recorded or edited policy untouched', async () => {
    const edited = await streetViewPolicy(standardTerms);
    await db
      .updateTable('assetPolicies')
      .set({ store: 'denied' })
      .where('id', '=', edited.id)
      .execute();
    const recorded = await streetViewPolicy({ ...standardTerms, evidenceRef: 'grant:google-1' });
    const licensed = await streetViewPolicy({ ...standardTerms, licenseVersion: 'v1' });
    for (const policy of [edited, recorded, licensed]) {
      const before = await db
        .selectFrom('assetPolicies')
        .selectAll()
        .where('id', '=', policy.id)
        .executeTakeFirstOrThrow();
      const after = await refreshStreetViewPolicy(db, policy.id, full);
      expect(after).toEqual(before);
    }
  });

  it('changes nothing when the row already matches and answers null for a missing row', async () => {
    const current = await streetViewPolicy(full);
    expect(await refreshStreetViewPolicy(db, current.id, full)).toEqual(current);
    expect(await refreshStreetViewPolicy(db, newId(), full)).toBeNull();
  });

  it('never refreshes a row whose created_by records a deliberate edit, even in a template shape', async () => {
    const stored = await streetViewPolicy(full);
    // An operator narrows a full row to the decorate shape and records the edit.
    await db
      .updateTable('assetPolicies')
      .set({
        store: 'denied',
        distributeDerivative: 'denied',
        commerceAdjacent: 'denied',
        createdBy: 'operator:policy-review',
      })
      .where('id', '=', stored.id)
      .execute();
    const after = await refreshStreetViewPolicy(db, stored.id, full);
    expect(after).toMatchObject({
      store: 'denied',
      distributeDerivative: 'denied',
      createdBy: 'operator:policy-review',
    });
  });

  it('keeps the imagery evidence of a display_only row when refreshing between display_only templates', async () => {
    const fixtureDisplayOnly = defaultPolicyTemplate('street_view', {
      usePolicy: 'display_only',
      imagery: 'fixture',
    });
    const liveRow = await streetViewPolicy(standardTerms);
    expect((await refreshStreetViewPolicy(db, liveRow.id, fixtureDisplayOnly))?.evidenceRef).toBe(
      STREET_VIEW_STANDARD_TERMS_EVIDENCE,
    );
    const fixtureRow = await streetViewPolicy(fixtureDisplayOnly);
    expect((await refreshStreetViewPolicy(db, fixtureRow.id, standardTerms))?.evidenceRef).toBe(
      FIXTURE_STREET_VIEW_EVIDENCE,
    );
  });
});

describe('Street View template mark migration', () => {
  it('stamps unchanged template rows written as system and leaves every other row alone', async () => {
    const legacy = await streetViewPolicy({ ...full, createdBy: 'system' });
    const legacyDisplayOnly = await streetViewPolicy({ ...standardTerms, createdBy: 'system' });
    const edited = await streetViewPolicy({ ...full, createdBy: 'system', store: 'denied' });
    const licensed = await streetViewPolicy({ ...full, createdBy: 'system', licenseVersion: 'v1' });
    const procedural = await streetViewPolicy(defaultPolicyTemplate('fixture'));
    await templateMark.up(db.withoutPlugins() as Kysely<unknown>);
    const createdBy = async (id: string) =>
      (
        await db
          .selectFrom('assetPolicies')
          .select('createdBy')
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).createdBy;
    expect(await createdBy(legacy.id)).toBe(STREET_VIEW_TEMPLATE_CREATOR);
    expect(await createdBy(legacyDisplayOnly.id)).toBe(STREET_VIEW_TEMPLATE_CREATOR);
    expect(await createdBy(edited.id)).toBe('system');
    expect(await createdBy(licensed.id)).toBe('system');
    expect(await createdBy(procedural.id)).toBe('system');
    // A stamped row follows the configured template again.
    expect((await refreshStreetViewPolicy(db, legacy.id, decorate))?.store).toBe('denied');
    // Down returns the mark to `system` (checked inside a transaction that is rolled back).
    await db
      .transaction()
      .execute(async (trx) => {
        await templateMark.down(trx.withoutPlugins() as unknown as Kysely<unknown>);
        const row = await trx
          .selectFrom('assetPolicies')
          .select('createdBy')
          .where('id', '=', legacyDisplayOnly.id)
          .executeTakeFirstOrThrow();
        expect(row.createdBy).toBe('system');
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
    expect(await createdBy(legacyDisplayOnly.id)).toBe(STREET_VIEW_TEMPLATE_CREATOR);
  });
});
