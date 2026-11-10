import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PauseStateSchema } from '@holiday/core';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient } from './test/operator.js';
import type * as Events from './domain/events.js';

const failing = vi.hoisted(() => ({ actions: new Set<string>() }));

vi.mock('./domain/events.js', async (importOriginal) => {
  const original = await importOriginal<typeof Events>();
  return {
    ...original,
    writeAudit: async (...args: Parameters<typeof original.writeAudit>) => {
      if (failing.actions.has(args[1].action)) throw new Error('audit store unavailable');
      return original.writeAudit(...args);
    },
  };
});

let harness: Harness;
let operator: TestClient;
let csrf: string;

beforeAll(async () => {
  harness = await createHarness();
  ({ client: operator, csrf } = await operatorClient(harness));
});

afterAll(async () => {
  failing.actions.clear();
  await harness?.close();
});

describe('a failed audit write', () => {
  it('rolls back the pause change it would have recorded', async () => {
    const before = PauseStateSchema.parse((await operator.get('/internal/v1/pause')).json());
    failing.actions.add('pause.set');
    const response = await operator.put(
      '/internal/v1/pause',
      { ...before, global: !before.global, providers: { anthropic: true }, reason: 'test' },
      { 'x-csrf-token': csrf },
    );
    failing.actions.delete('pause.set');
    expect(response.statusCode).toBe(500);
    const after = PauseStateSchema.parse((await operator.get('/internal/v1/pause')).json());
    expect(after).toEqual(before);
  });

  it('rolls back a blocked-address change', async () => {
    const placeId = 'ChIJtestAuditRollbackPlace01';
    failing.actions.add('blocked_address.add');
    const response = await operator.post(
      '/internal/v1/blocked-addresses',
      { placeId, source: 'operator', evidenceRef: 'test:rollback' },
      { 'x-csrf-token': csrf },
    );
    failing.actions.delete('blocked_address.add');
    expect(response.statusCode).toBe(500);
    const row = await harness.context.db
      .selectFrom('blockedAddresses')
      .select('id')
      .where('placeId', '=', placeId)
      .executeTakeFirst();
    expect(row).toBeUndefined();

    const added = await operator.post(
      '/internal/v1/blocked-addresses',
      { placeId, source: 'operator', evidenceRef: 'test:rollback' },
      { 'x-csrf-token': csrf },
    );
    expect(added.statusCode).toBe(201);
    const audit = await operator.get('/internal/v1/audit-log?action=blocked_address.add');
    expect(
      json<{ items: { targetId: string }[] }>(audit).items.map((item) => item.targetId),
    ).toContain(json<{ id: string }>(added).id);
  });
});
