import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CapabilityListResponseSchema,
  MeSchema,
  PauseStateSchema,
  VerifyMagicLinkResponseSchema,
  type Project,
} from '@holiday/core';
import {
  createHarness,
  json,
  OPERATOR_EMAIL,
  type Harness,
  type TestClient,
} from './test/harness.js';
import { reauthenticate } from './test/operator.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

function linkToken(email: string): string {
  const message = harness.email.lastTo(email);
  const match = /token=([A-Za-z0-9_%-]+)/.exec(message?.text ?? '');
  if (!match?.[1]) throw new Error(`no link sent to ${email}`);
  return decodeURIComponent(match[1]);
}

async function signIn(client: TestClient, email: string) {
  const requested = await client.post('/v1/auth/magic-link', { email, returnTo: '/places' });
  expect(requested.statusCode).toBe(202);
  const verified = await client.post('/v1/auth/verify', { token: linkToken(email) });
  expect(verified.statusCode).toBe(200);
  return verified;
}

describe('magic-link sign-in', () => {
  it('signs in, re-owns the anonymous projects and saves them', async () => {
    const client = harness.client();
    await client.createSession();
    const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    const project = (created.json() as { project: Project }).project;
    expect(project.saved).toBe(false);
    const before = await harness.context.db
      .selectFrom('projects')
      .select('ownerId')
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow();

    const email = 'Person@Example.com';
    const requested = await client.post('/v1/auth/magic-link', { email, returnTo: '/places' });
    expect(requested.statusCode).toBe(202);
    expect(json(requested)).toEqual({});
    const token = linkToken('person@example.com');
    const outbox = await harness.context.db
      .selectFrom('fixtureEmails')
      .select('tag')
      .where('toAddress', '=', 'person@example.com')
      .execute();
    expect(outbox.map((row) => row.tag)).toContain('magic_link');

    const verified = await client.post('/v1/auth/verify', { token });
    expect(verified.statusCode).toBe(200);
    const body = VerifyMagicLinkResponseSchema.parse(verified.json());
    expect(body).toMatchObject({
      claimedProjects: 1,
      returnTo: '/places',
      user: { email: 'person@example.com', roles: ['user'] },
    });
    expect(verified.headers['x-csrf-token']).toBeTruthy();

    const after = await harness.context.db
      .selectFrom('projects')
      .select(['ownerId', 'savedAt'])
      .where('id', '=', project.id)
      .executeTakeFirstOrThrow();
    expect(after.ownerId).not.toBe(before.ownerId);
    expect(after.savedAt).not.toBeNull();
    const me = MeSchema.parse((await client.get('/v1/me')).json());
    expect(me.user?.email).toBe('person@example.com');
    expect(me.savedProjects).toBe(1);
    const list = json<{ items: Project[] }>(await client.get('/v1/projects'));
    expect(list.items.map((item) => item.id)).toContain(project.id);
    const audit = await harness.context.db
      .selectFrom('auditLog')
      .select('action')
      .where('action', '=', 'session.claim')
      .execute();
    expect(audit.length).toBeGreaterThan(0);

    const reused = await client.post('/v1/auth/verify', { token });
    expect(reused.statusCode).toBe(400);
    expect(json(reused).error).toMatchObject({ details: { reason: 'consumed' } });
    const unknown = await client.post('/v1/auth/verify', { token: 'not-a-real-token' });
    expect(json(unknown).error).toMatchObject({ details: { reason: 'unknown' } });

    const loggedOut = await client.post('/v1/auth/logout', {});
    expect(loggedOut.statusCode).toBe(204);
    // The replacement anonymous session runs the bot check before its first use.
    const unverified = await client.get('/v1/me');
    expect(unverified.statusCode).toBe(403);
    expect(json(unverified).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
    const anonymous = MeSchema.parse(
      (await client.get('/v1/me', { 'x-turnstile-token': 'fixture-pass' })).json(),
    );
    expect(anonymous.user).toBeNull();
    expect((await client.get(`/v1/projects/${project.id}`)).statusCode).toBe(404);
  });

  it('deletes an account and every project it owns', async () => {
    const email = 'leaver@example.com';
    const client = harness.client();
    await client.createSession();
    const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
    const project = (created.json() as { project: Project }).project;
    await signIn(client, email);
    // A second, unused link: every token for the address goes with the account.
    expect((await client.post('/v1/auth/magic-link', { email })).statusCode).toBe(202);
    const tokensFor = async () =>
      Number(
        (
          await harness.context.db
            .selectFrom('authTokens')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('emailNormalized', '=', email)
            .executeTakeFirstOrThrow()
        ).count,
      );
    expect(await tokensFor()).toBe(2);

    const deleted = await client.delete('/v1/me');
    expect(deleted.statusCode).toBe(202);
    expect(json(deleted).deletionRequestId).toBeTruthy();
    const row = await harness.context.db
      .selectFrom('projects')
      .select('id')
      .where('id', '=', project.id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
    expect((await client.get('/v1/me')).statusCode).toBe(403);

    expect(await tokensFor()).toBe(0);
    const users = await harness.context.db
      .selectFrom('users')
      .select('id')
      .where('emailNormalized', '=', email)
      .execute();
    expect(users).toEqual([]);
    const confirmation = harness.email.lastTo(email);
    expect(confirmation).toMatchObject({
      tag: 'account_deleted',
      subject: 'Your Holiday account is being deleted',
    });
    expect(confirmation?.text).not.toContain('token=');
  });
});

describe('reports and the homeowner opt-out', () => {
  it('needs Turnstile without a session and records reasons and priorities', async () => {
    const anonymous = harness.client();
    const target = { kind: 'project', id: '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e' };
    const refused = await anonymous.post('/v1/reports', { target, reason: 'privacy' });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });

    const report = await anonymous.post('/v1/reports', {
      target,
      reason: 'child_pictured',
      turnstileToken: 'fixture-pass',
    });
    expect(report.statusCode).toBe(201);
    expect(json(report)).toMatchObject({ acknowledgementKey: 'report.thanks' });
    const stored = await harness.context.db
      .selectFrom('reports')
      .select(['priority', 'status'])
      .where('id', '=', json(report).reportId as string)
      .executeTakeFirstOrThrow();
    expect(stored).toEqual({ priority: 'urgent', status: 'open' });

    const optOut = await anonymous.post('/v1/reports', {
      target: { kind: 'address', placeId: 'ChIJtestOptOutPlace00000001', addressText: '1 Test Rd' },
      reason: 'this_is_my_home',
      contactEmail: 'owner@example.com',
      requestOptOut: true,
      turnstileToken: 'fixture-pass',
    });
    expect(optOut.statusCode).toBe(201);
    expect(json(optOut)).toMatchObject({ acknowledgementKey: 'optout.thanks' });

    const wrongReason = await anonymous.post('/v1/reports', {
      target: { kind: 'address', placeId: 'ChIJtestOptOutPlace00000001' },
      reason: 'privacy',
      turnstileToken: 'fixture-pass',
    });
    expect(wrongReason.statusCode).toBe(400);
  });
});

describe('internal operations API', () => {
  it('rejects anonymous callers and signed-in non-operators', async () => {
    const anonymous = harness.client();
    const refused = await anonymous.get('/internal/v1/capabilities');
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toMatchObject({ details: { reason: 'operator_required' } });

    const user = harness.client();
    await user.createSession();
    await signIn(user, 'regular@example.com');
    const forbidden = await user.get('/internal/v1/capabilities');
    expect(forbidden.statusCode).toBe(403);
    expect(json(forbidden).error).toMatchObject({ details: { reason: 'operator_required' } });
  });

  it('lets an allowlisted operator read, and change with CSRF and fresh re-authentication', async () => {
    const operator = harness.client();
    await operator.createSession();
    const verified = await signIn(operator, OPERATOR_EMAIL);
    expect(json<{ user: { roles: string[] } }>(verified).user.roles).toContain('operator');
    const csrf = String(verified.headers['x-csrf-token']);
    await reauthenticate(harness, operator, csrf);

    const capabilities = await operator.get('/internal/v1/capabilities');
    expect(capabilities.statusCode).toBe(200);
    expect(CapabilityListResponseSchema.parse(capabilities.json()).items.length).toBeGreaterThan(5);

    const pause = PauseStateSchema.parse((await operator.get('/internal/v1/pause')).json());
    const noCsrf = await operator.put('/internal/v1/pause', {
      ...pause,
      providers: { anthropic: true },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(json(noCsrf).error).toMatchObject({ details: { reason: 'csrf' } });

    const changed = await operator.put(
      '/internal/v1/pause',
      { ...pause, providers: { anthropic: true }, reason: 'test' },
      { 'x-csrf-token': csrf },
    );
    expect(changed.statusCode).toBe(200);
    expect(PauseStateSchema.parse(changed.json()).providers.anthropic).toBe(true);
    const restored = await operator.put(
      '/internal/v1/pause',
      { ...PauseStateSchema.parse(changed.json()), providers: { anthropic: false } },
      { 'x-csrf-token': csrf },
    );
    expect(restored.statusCode).toBe(200);

    const reports = await operator.get('/internal/v1/reports?status=open');
    expect(reports.statusCode).toBe(200);
    const optOut = json<{ items: { id: string; targetPlaceId: string | null }[] }>(
      reports,
    ).items.find((item) => item.targetPlaceId === 'ChIJtestOptOutPlace00000001');
    expect(optOut).toBeDefined();
    if (optOut) {
      const triaged = await operator.post(
        `/internal/v1/reports/${optOut.id}/triage`,
        {
          status: 'actioned',
          resolution: { action: 'block_address', evidenceRef: 'email-confirmed' },
        },
        { 'x-csrf-token': csrf },
      );
      expect(triaged.statusCode).toBe(200);
      const blocked = await harness.context.db
        .selectFrom('blockedAddresses')
        .select(['source', 'removedAt'])
        .where('placeId', '=', 'ChIJtestOptOutPlace00000001')
        .executeTakeFirstOrThrow();
      expect(blocked).toEqual({ source: 'homeowner_request', removedAt: null });
    }

    const setting = await operator.get('/internal/v1/settings/poll.render_ms');
    expect(setting.statusCode).toBe(200);
    const reviews = await operator.get('/internal/v1/reviews');
    expect(reviews.statusCode).toBe(200);
    const audit = await operator.get('/internal/v1/audit-log?action=pause.set');
    expect(json<{ items: unknown[] }>(audit).items.length).toBeGreaterThanOrEqual(2);
    const ledger = await operator.get('/internal/v1/ledger/summary');
    expect(ledger.statusCode).toBe(200);
  });
});
