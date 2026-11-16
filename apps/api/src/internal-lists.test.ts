import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factories, sql } from '@hailiday/server/db';
import { newId } from '@hailiday/server/ids';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';

let harness: Harness;
let operator: TestClient;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator } = await operatorClient(harness));
});

afterAll(async () => {
  await harness?.close();
});

/** Three creation times inside one millisecond, oldest first. */
function sameMillisecond(prefix: string): string[] {
  return ['100', '200', '300'].map((micros) => `${prefix}.000${micros}Z`);
}

/**
 * Reads the first `pages` pages of a list with `limit=1` and returns the ids in the order they
 * came, following `nextCursor`.
 */
async function pagedIds(path: string, idOf: (item: Record<string, unknown>) => string, pages = 4) {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < pages; index += 1) {
    const separator = path.includes('?') ? '&' : '?';
    const url = `${path}${separator}limit=1${cursor ? `&cursor=${cursor}` : ''}`;
    const response = await operator.get(url);
    expect(response.statusCode, url).toBe(200);
    const body = json<{ items: Record<string, unknown>[]; nextCursor: string | null }>(response);
    ids.push(...body.items.map(idOf));
    expect(body.items.every((item) => !('cursorAt' in item))).toBe(true);
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return ids;
}

describe('internal operator lists paged across rows created in one millisecond', () => {
  it('lists upload holds (oldest first) each once', async () => {
    const owner = await factories.owner(harness.context.db);
    const project = await factories.project(harness.context.db, { ownerId: owner.id });
    const ids: string[] = [];
    // Older than every other row, so these are the first three of the list.
    for (const at of sameMillisecond('2000-01-01T00:00:00')) {
      const source = await factories.sourceAsset(harness.context.db, {
        ownerId: owner.id,
        projectId: project.id,
        kind: 'upload',
      });
      await sql`update source_assets
        set state = 'screening', hold_for_review = true, created_at = ${at}::timestamptz
        where id = ${source.id}`.execute(harness.context.db);
      ids.push(source.id);
    }
    const listed = await pagedIds('/internal/v1/upload-holds', (item) =>
      String(item.sourceAssetId),
    );
    expect(listed.slice(0, 3)).toEqual(ids);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('lists reports (newest first) each once', async () => {
    const ids: string[] = [];
    // Newer than every other row, so these are the first three of the list.
    for (const at of sameMillisecond('2100-01-01T00:00:00')) {
      const id = newId();
      await harness.context.db
        .insertInto('reports')
        .values({
          id,
          targetKind: 'share',
          reason: 'privacy',
          details: 'cursor test',
          status: 'dismissed',
          createdAt: sql<Date>`${at}::timestamptz`,
        })
        .execute();
      ids.push(id);
    }
    const listed = await pagedIds('/internal/v1/reports?status=dismissed', (item) =>
      String(item.id),
    );
    expect(listed.slice(0, 3)).toEqual([...ids].reverse());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('lists audit rows (newest first) each once', async () => {
    const action = 'setting.update';
    const ids: string[] = [];
    // Newer than every other row, so these are the first three of the list.
    for (const at of sameMillisecond('2100-01-01T00:00:00')) {
      const id = newId();
      await harness.context.db
        .insertInto('auditLog')
        .values({
          id,
          actorKind: 'system',
          action,
          targetKind: 'runtime_setting',
          targetId: 'test.cursor',
          requestId: `test-${id}`,
          createdAt: sql<Date>`${at}::timestamptz`,
        })
        .execute();
      ids.push(id);
    }
    const listed = await pagedIds(`/internal/v1/audit-log?action=${action}`, (item) =>
      String(item.id),
    );
    expect(listed.slice(0, 3)).toEqual([...ids].reverse());
    expect(new Set(listed).size).toBe(listed.length);
  });
});
