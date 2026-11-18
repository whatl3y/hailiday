import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factories, toJson, type MerchantProgram } from '@hailiday/server/db';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';

let harness: Harness;
let operator: TestClient;
let csrf: string;
let program: MerchantProgram;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator, csrf } = await operatorClient(harness));
  program = await factories.merchantProgram(harness.context.db, { displayName: 'Record Test' });
});

afterAll(async () => {
  await harness?.close();
});

async function auditRows(requestId: string) {
  return harness.context.db
    .selectFrom('auditLog')
    .selectAll()
    .where('requestId', '=', requestId)
    .execute();
}

function fieldsOf(response: { json(): unknown }) {
  return (response.json() as { error: { details: { fields: { path: string; reason: string }[] } } })
    .error.details.fields;
}

describe('merchant program records', () => {
  const recordUrl = () => `/internal/v1/merchant-programs/${program.id}/record`;

  it('lists programs with their record fields', async () => {
    const response = await operator.get('/internal/v1/merchant-programs');
    expect(response.statusCode).toBe(200);
    const items = json<{ items: Record<string, unknown>[] }>(response).items;
    expect(items.find((item) => item.id === program.id)).toMatchObject({
      programKey: program.programKey,
      kind: 'fixture',
      placement: 'group',
      searchUrlTemplate: program.searchUrlTemplate,
      trackingLinkTemplate: null,
      displayRights: {},
      refreshTermHours: null,
    });
    const real = items.filter((item) => item.kind === 'real').map((item) => item.programKey);
    expect(real).toEqual(
      expect.arrayContaining(['walmart_us', 'target_us', 'home_depot_us', 'lowes_us', 'amazon_us']),
    );
  });

  it('needs the CSRF token and an operator', async () => {
    const noCsrf = await operator.put(recordUrl(), { notes: 'x' });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).error).toMatchObject({ details: { reason: 'csrf' } });
    const visitor = harness.client();
    await visitor.createSession();
    expect(
      (await visitor.put(recordUrl(), { notes: 'x' }, { 'x-csrf-token': csrf })).statusCode,
    ).toBe(403);
  });

  it('validates the link patterns, the rights and unknown fields', async () => {
    const put = (payload: unknown) => operator.put(recordUrl(), payload, { 'x-csrf-token': csrf });
    const badSearch = await put({ searchUrlTemplate: 'http://example.com/s?q={query}' });
    expect(badSearch.statusCode).toBe(400);
    expect(fieldsOf(badSearch)).toEqual([
      { path: 'body.searchUrlTemplate', reason: 'invalid_search_url_template' },
    ]);
    const noQuery = await put({ searchUrlTemplate: 'https://example.com/s?q=lights' });
    expect(fieldsOf(noQuery)).toEqual([
      { path: 'body.searchUrlTemplate', reason: 'invalid_search_url_template' },
    ]);
    const badTracking = await put({
      trackingLinkTemplate: 'javascript:alert(1)//{destinationUrl}',
    });
    expect(fieldsOf(badTracking)).toEqual([
      { path: 'body.trackingLinkTemplate', reason: 'invalid_tracking_link_template' },
    ]);
    const noEvidence = await put({
      displayRights: { tracked_search_links: { state: 'allowed', evidence: null } },
    });
    expect(noEvidence.statusCode).toBe(400);
    const unknownUse = await put({
      displayRights: { everything: { state: 'allowed', evidence: 'Terms' } },
    });
    expect(unknownUse.statusCode).toBe(400);
    const extra = await put({ kind: 'real' });
    expect(extra.statusCode).toBe(400);
    const recordedAt = await put({
      displayRights: { picture: { state: 'allowed', evidence: 'Terms', recordedAt: null } },
    });
    expect(recordedAt.statusCode).toBe(400);
    const unchanged = await harness.context.db
      .selectFrom('merchantPrograms')
      .selectAll()
      .where('id', '=', program.id)
      .executeTakeFirstOrThrow();
    expect(unchanged).toMatchObject({
      kind: 'fixture',
      searchUrlTemplate: program.searchUrlTemplate,
      displayRights: {},
    });
  });

  it('updates the given fields, replaces each given right and audits the change', async () => {
    const first = await operator.put(
      recordUrl(),
      {
        placement: 'separate',
        searchUrlTemplate: 'https://example.com/record/search?k={query}',
        trackingLinkTemplate: '{destinationUrl}&tag={trackingId}',
        subIdCapability: true,
        trackingIds: [{ holidayId: 'christmas', channel: 'direct', trackingId: 'record-20' }],
        refreshTermHours: 24,
        displayRights: {
          tracked_search_links: { state: 'allowed', evidence: 'Section 4 of the terms' },
          picture: { state: 'unknown', evidence: null },
        },
      },
      { 'x-csrf-token': csrf },
    );
    expect(first.statusCode, first.body).toBe(200);
    const body = json<Record<string, unknown>>(first);
    expect(body).toMatchObject({
      id: program.id,
      placement: 'separate',
      searchUrlTemplate: 'https://example.com/record/search?k={query}',
      trackingLinkTemplate: '{destinationUrl}&tag={trackingId}',
      subIdCapability: true,
      trackingIds: [{ holidayId: 'christmas', channel: 'direct', trackingId: 'record-20' }],
      refreshTermHours: 24,
      notes: null,
      displayRights: {
        tracked_search_links: { state: 'allowed', evidence: 'Section 4 of the terms' },
        picture: { state: 'unknown', evidence: null },
      },
    });
    const rights = body.displayRights as Record<string, { recordedAt: string }>;
    expect(rights.tracked_search_links?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const rows = await auditRows(String(first.headers['x-request-id']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'merchant_program.record_update',
      targetKind: 'merchant_program',
      targetId: program.id,
      before: expect.objectContaining({ placement: 'group', refreshTermHours: null }),
      after: expect.objectContaining({ placement: 'separate', refreshTermHours: 24 }),
    });

    // A later edit of one use keeps the others; null clears a pattern.
    const second = await operator.put(
      recordUrl(),
      {
        searchUrlTemplate: null,
        displayRights: { picture: { state: 'denied', evidence: 'Section 7 of the terms' } },
      },
      { 'x-csrf-token': csrf },
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(json(second)).toMatchObject({
      searchUrlTemplate: null,
      placement: 'separate',
      displayRights: {
        tracked_search_links: {
          state: 'allowed',
          evidence: 'Section 4 of the terms',
          recordedAt: rights.tracked_search_links?.recordedAt,
        },
        picture: { state: 'denied', evidence: 'Section 7 of the terms' },
      },
    });
  });
});

describe('search phrases', () => {
  it('lists the phrases and upserts one of a published kit item', async () => {
    const list = await operator.get('/internal/v1/search-phrases');
    expect(list.statusCode).toBe(200);
    const items = json<{ items: { kitItemKey: string; phrase: string }[] }>(list).items;
    expect(items.length).toBeGreaterThan(0);
    const kitItem = await harness.context.db
      .selectFrom('kitItems')
      .innerJoin('styleKits', 'styleKits.id', 'kitItems.kitId')
      .select('kitItems.kitItemId')
      .where('styleKits.status', '=', 'published')
      .orderBy('kitItems.kitItemId')
      .executeTakeFirstOrThrow();
    const original = await harness.context.db
      .selectFrom('kitItemSearchPhrases')
      .selectAll()
      .where('kitItemKey', '=', kitItem.kitItemId)
      .executeTakeFirst();
    const url = `/internal/v1/search-phrases/${encodeURIComponent(kitItem.kitItemId)}`;
    try {
      const unknown = await operator.put(
        '/internal/v1/search-phrases/christmas.house_exterior.not_a_kit_item',
        { phrase: 'outdoor lights' },
        { 'x-csrf-token': csrf },
      );
      expect(unknown.statusCode).toBe(400);
      expect(fieldsOf(unknown)).toEqual([
        { path: 'params.kitItemKey', reason: 'unknown_kit_item' },
      ]);
      const unknownProgram = await operator.put(
        url,
        { phrase: 'outdoor lights', programOverrides: { no_such_program: 'lights' } },
        { 'x-csrf-token': csrf },
      );
      expect(fieldsOf(unknownProgram)).toEqual([
        { path: 'body.programOverrides.no_such_program', reason: 'unknown_program' },
      ]);
      const tooShort = await operator.put(url, { phrase: 'x' }, { 'x-csrf-token': csrf });
      expect(tooShort.statusCode).toBe(400);
      // A phrase and every override are plain words.
      const notPlain = await operator.put(
        url,
        { phrase: 'lights/garland', programOverrides: { walmart_us: 'net lights...' } },
        { 'x-csrf-token': csrf },
      );
      expect(notPlain.statusCode).toBe(400);
      expect(fieldsOf(notPlain).map((field) => field.path)).toEqual([
        'body.phrase',
        'body.programOverrides.walmart_us',
      ]);

      const saved = await operator.put(
        url,
        { phrase: 'warm white wreath lights', programOverrides: { walmart_us: 'lighted wreath' } },
        { 'x-csrf-token': csrf },
      );
      expect(saved.statusCode, saved.body).toBe(200);
      expect(json(saved)).toMatchObject({
        kitItemKey: kitItem.kitItemId,
        phrase: 'warm white wreath lights',
        programOverrides: { walmart_us: 'lighted wreath' },
      });
      const rows = await auditRows(String(saved.headers['x-request-id']));
      expect(rows.map((row) => [row.action, row.targetKind])).toEqual([
        ['search_phrase.update', 'kit_item_search_phrase'],
      ]);
      const stored = await harness.context.db
        .selectFrom('kitItemSearchPhrases')
        .selectAll()
        .where('kitItemKey', '=', kitItem.kitItemId)
        .execute();
      expect(stored).toHaveLength(1);
      expect(stored[0]?.updatedBy).not.toBeNull();

      // Without `programOverrides` the stored overrides stay.
      const phraseOnly = await operator.put(
        url,
        { phrase: 'lighted evergreen wreath' },
        { 'x-csrf-token': csrf },
      );
      expect(phraseOnly.statusCode, phraseOnly.body).toBe(200);
      expect(json(phraseOnly)).toMatchObject({
        phrase: 'lighted evergreen wreath',
        programOverrides: { walmart_us: 'lighted wreath' },
      });
      const cleared = await operator.put(
        url,
        { phrase: 'lighted evergreen wreath', programOverrides: {} },
        { 'x-csrf-token': csrf },
      );
      expect(json(cleared)).toMatchObject({ programOverrides: {} });
    } finally {
      if (original) {
        await harness.context.db
          .updateTable('kitItemSearchPhrases')
          .set({ phrase: original.phrase, programOverrides: toJson(original.programOverrides) })
          .where('id', '=', original.id)
          .execute();
      } else {
        await harness.context.db
          .deleteFrom('kitItemSearchPhrases')
          .where('kitItemKey', '=', kitItem.kitItemId)
          .execute();
      }
    }
  });
});

describe('look items', () => {
  // A look no panel shows (look items show only for the lavish house exterior).
  const look = { holidayId: 'christmas', sceneType: 'balcony', style: 'subtle' } as const;
  const key = `${look.holidayId}.${look.sceneType}.${look.style}.internal_test_lantern`;

  it('creates, lists and updates a look item with an audit row each', async () => {
    const outside = await operator.post(
      '/internal/v1/look-items',
      {
        ...look,
        lookItemKey: 'halloween.house_exterior.abundant.lantern',
        ourTitle: 'Lantern',
        searchPhrase: 'outdoor lantern',
        sortOrder: 1,
      },
      { 'x-csrf-token': csrf },
    );
    expect(outside.statusCode).toBe(400);
    expect(fieldsOf(outside)).toEqual([{ path: 'body.lookItemKey', reason: 'outside_look' }]);
    const badCategory = await operator.post(
      '/internal/v1/look-items',
      {
        ...look,
        lookItemKey: key,
        ourTitle: 'Lantern',
        anchorCategory: 'not_a_category',
        searchPhrase: 'outdoor lantern',
        sortOrder: 1,
      },
      { 'x-csrf-token': csrf },
    );
    expect(badCategory.statusCode).toBe(400);
    const notPlain = await operator.post(
      '/internal/v1/look-items',
      {
        ...look,
        lookItemKey: key,
        ourTitle: 'Lantern',
        searchPhrase: 'lantern (outdoor)',
        programOverrides: { target_us: 'led/lantern' },
        sortOrder: 1,
      },
      { 'x-csrf-token': csrf },
    );
    expect(notPlain.statusCode).toBe(400);
    expect(fieldsOf(notPlain).map((field) => field.path)).toEqual([
      'body.searchPhrase',
      'body.programOverrides.target_us',
    ]);

    const created = await operator.post(
      '/internal/v1/look-items',
      {
        ...look,
        lookItemKey: key,
        ourTitle: 'Flameless lantern',
        searchPhrase: 'flameless led lantern outdoor',
        programOverrides: { target_us: 'led lantern' },
        sortOrder: 1,
      },
      { 'x-csrf-token': csrf },
    );
    expect(created.statusCode, created.body).toBe(201);
    const item = json<{ id: string; status: string }>(created);
    expect(item).toMatchObject({
      lookItemKey: key,
      ourTitle: 'Flameless lantern',
      anchorCategory: null,
      programOverrides: { target_us: 'led lantern' },
      status: 'active',
    });
    expect(
      (await auditRows(String(created.headers['x-request-id']))).map((row) => row.action),
    ).toEqual(['look_item.create']);

    const duplicate = await operator.post(
      '/internal/v1/look-items',
      { ...look, lookItemKey: key, ourTitle: 'Again', searchPhrase: 'lantern', sortOrder: 2 },
      { 'x-csrf-token': csrf },
    );
    expect(duplicate.statusCode).toBe(400);
    expect(fieldsOf(duplicate)).toEqual([{ path: 'body.lookItemKey', reason: 'duplicate' }]);

    const list = await operator.get('/internal/v1/look-items');
    expect(list.statusCode).toBe(200);
    expect(
      json<{ items: { id: string }[] }>(list).items.some((entry) => entry.id === item.id),
    ).toBe(true);

    const noKeyChange = await operator.put(
      `/internal/v1/look-items/${item.id}`,
      { lookItemKey: `${key}_2` },
      { 'x-csrf-token': csrf },
    );
    expect(noKeyChange.statusCode).toBe(400);
    const notPlainUpdate = await operator.put(
      `/internal/v1/look-items/${item.id}`,
      { searchPhrase: 'lantern; outdoor' },
      { 'x-csrf-token': csrf },
    );
    expect(notPlainUpdate.statusCode).toBe(400);
    expect(fieldsOf(notPlainUpdate).map((field) => field.path)).toEqual(['body.searchPhrase']);
    const updated = await operator.put(
      `/internal/v1/look-items/${item.id}`,
      { status: 'retired', sortOrder: 3, anchorCategory: null },
      { 'x-csrf-token': csrf },
    );
    expect(updated.statusCode, updated.body).toBe(200);
    expect(json(updated)).toMatchObject({ status: 'retired', sortOrder: 3 });
    const rows = await auditRows(String(updated.headers['x-request-id']));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'look_item.update',
      targetId: item.id,
      before: { status: 'active', sortOrder: 1, anchorCategory: null },
      after: { status: 'retired', sortOrder: 3, anchorCategory: null },
    });
    const missing = await operator.put(
      '/internal/v1/look-items/00000000-0000-4000-8000-000000000000',
      { status: 'active' },
      { 'x-csrf-token': csrf },
    );
    expect(missing.statusCode).toBe(404);
  });
});
