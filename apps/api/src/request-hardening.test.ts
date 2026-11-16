import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AddressSuggestionsResponseSchema, type Project } from '@hailiday/core';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { operatorClient, signInSameSession } from './test/operator.js';
import { placesTokenForClient } from './test/places-token.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

async function sessionClient(): Promise<TestClient> {
  const client = harness.client();
  await client.createSession();
  return client;
}

const crossSite = { 'sec-fetch-site': 'same-site' };
const craftedCursor = Buffer.from(JSON.stringify(['2026-01-01T00:00:00Z', 'x'])).toString(
  'base64url',
);

describe('percent-encoded API paths', () => {
  it('apply the same-origin check to every state-changing request', async () => {
    const client = await sessionClient();
    await signInSameSession(harness, client, 'encoded@example.com');
    const cases = [
      { method: 'POST' as const, url: `/%76%31/renders/${randomUUID()}/cancel`, payload: {} },
      { method: 'DELETE' as const, url: '/%76%31/me' },
      { method: 'POST' as const, url: '/%76%31/auth/logout', payload: {} },
      { method: 'POST' as const, url: '/not-an-api-route', payload: {} },
    ];
    for (const input of cases) {
      const response = await client.request({ ...input, noOrigin: true, headers: crossSite });
      expect(response.statusCode, input.url).toBe(403);
      expect(json(response).error, input.url).toMatchObject({
        code: 'FORBIDDEN',
        details: { reason: 'origin_mismatch' },
      });
    }
    expect((await client.get('/v1/me')).json()).toMatchObject({
      user: { email: 'encoded@example.com' },
    });
  });

  it('mark decoded API paths no-store and answer unknown ones with the JSON 404', async () => {
    const client = await sessionClient();
    const me = await client.get('/%76%31/me');
    expect(me.statusCode).toBe(200);
    expect(me.headers['cache-control']).toBe('no-store');
    const missing = await client.get('/%76%31/does-not-exist');
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['cache-control']).toBe('no-store');
    expect(json(missing).error).toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('pagination cursors', () => {
  it('answer VALIDATION_FAILED for a crafted cursor on the projects list', async () => {
    const client = await sessionClient();
    const response = await client.get(`/v1/projects?cursor=${craftedCursor}`);
    expect(response.statusCode).toBe(400);
    expect(json(response).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [{ path: 'querystring.cursor', reason: 'invalid' }] },
    });
    expect((await client.get('/v1/projects')).statusCode).toBe(200);
  });

  it('answer VALIDATION_FAILED for a crafted cursor on internal lists', async () => {
    const { client } = await operatorClient(harness);
    for (const path of ['/internal/v1/audit-log', '/internal/v1/reports', '/internal/v1/offers']) {
      const response = await client.get(`${path}?cursor=${craftedCursor}`);
      expect(response.statusCode, path).toBe(400);
      expect(json(response).error, path).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('Places autocomplete session tokens', () => {
  const placeId = 'ChIJfxLanternHillColonial01';

  it('accept only tokens the server minted for this session', async () => {
    const client = await sessionClient();
    const invented = await client.get(
      `/v1/addresses/suggestions?q=14%20Lantern&sessionToken=${randomUUID()}`,
    );
    expect(invented.statusCode).toBe(400);
    expect(json(invented).error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: [{ path: 'querystring.sessionToken', reason: 'unknown' }] },
    });
    const neverIssued = await client.post('/v1/addresses/resolve', {
      placeId,
      sessionToken: randomUUID(),
    });
    expect(neverIssued.statusCode).toBe(400);
    expect(json(neverIssued).error).toMatchObject({
      details: { fields: [{ path: 'body.sessionToken', reason: 'unknown' }] },
    });

    const minted = AddressSuggestionsResponseSchema.parse(
      (await client.get('/v1/addresses/suggestions?q=14%20Lantern')).json(),
    ).sessionToken;
    const other = await sessionClient();
    const foreign = await other.get(
      `/v1/addresses/suggestions?q=14%20Lantern&sessionToken=${minted}`,
    );
    expect(foreign.statusCode).toBe(400);
    const foreignResolve = await other.post('/v1/addresses/resolve', {
      placeId,
      sessionToken: minted,
    });
    expect(foreignResolve.statusCode).toBe(400);

    const resolved = await client.post('/v1/addresses/resolve', { placeId, sessionToken: minted });
    expect(resolved.statusCode).toBe(201);
    expect((resolved.json() as { project: Project }).project.id).toBeTruthy();
  });

  it('count every minted token against the per-session mint limit', async () => {
    const client = await sessionClient();
    for (let i = 0; i < 5; i += 1) {
      expect((await client.get('/v1/addresses/suggestions?q=14%20Lantern')).statusCode).toBe(200);
    }
    const sixth = await client.get('/v1/addresses/suggestions?q=14%20Lantern');
    expect(sixth.statusCode).toBe(429);
    expect(json(sixth).error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { scope: 'session_tokens' },
    });
    const invented = await client.get(
      `/v1/addresses/suggestions?q=14%20Lantern&sessionToken=${randomUUID()}`,
    );
    expect(invented.statusCode).toBe(400);
    const helperToken = await placesTokenForClient(harness, client);
    const reused = await client.get(
      `/v1/addresses/suggestions?q=14%20Lantern&sessionToken=${helperToken}`,
    );
    expect(reused.statusCode).toBe(200);
  });
});
