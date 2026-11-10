import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MeSchema, VerifyMagicLinkResponseSchema, type Project } from '@holiday/core';
import { sha256Hex } from '@holiday/server/ids';
import { csrfTokenFor } from './auth/session.js';
import {
  createHarness,
  json,
  OPERATOR_EMAIL,
  type Harness,
  type TestClient,
} from './test/harness.js';
import { linkTokenFor, reauthenticate, signInSameSession } from './test/operator.js';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness?.close();
});

async function sessionWithProject(): Promise<{ client: TestClient; project: Project }> {
  const client = harness.client();
  await client.createSession();
  const created = await client.post('/v1/projects', { kind: 'upload', holidayId: 'christmas' });
  expect(created.statusCode).toBe(201);
  return { client, project: (created.json() as { project: Project }).project };
}

async function me(client: TestClient) {
  return MeSchema.parse((await client.get('/v1/me')).json());
}

async function sessionRow(client: TestClient) {
  return harness.context.db
    .selectFrom('anonymousSessions')
    .select(['id', 'ownerId'])
    .where('tokenHash', '=', sha256Hex(client.cookie ?? ''))
    .executeTakeFirstOrThrow();
}

async function tokenRow(token: string) {
  return harness.context.db
    .selectFrom('authTokens')
    .select(['consumedAt', 'ipHash'])
    .where('tokenHash', '=', sha256Hex(token))
    .executeTakeFirstOrThrow();
}

async function projectOwner(projectId: string) {
  const row = await harness.context.db
    .selectFrom('projects')
    .select('ownerId')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  return row.ownerId;
}

async function userOwner(email: string) {
  const row = await harness.context.db
    .selectFrom('users')
    .select('ownerId')
    .where('emailNormalized', '=', email)
    .executeTakeFirst();
  return row?.ownerId ?? null;
}

async function ownerRowCounts(ownerId: string) {
  const projects = await harness.context.db
    .selectFrom('projects')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ownerId', '=', ownerId)
    .executeTakeFirstOrThrow();
  const ledger = await harness.context.db
    .selectFrom('usageLedger')
    .select((eb) => eb.fn.countAll<number>().as('count'))
    .where('ownerId', '=', ownerId)
    .executeTakeFirstOrThrow();
  return { projects: Number(projects.count), ledger: Number(ledger.count) };
}

describe('magic-link verification across browsers', () => {
  it('asks for confirmation, then signs in only the verifying session and claims only its rows', async () => {
    const email = 'traveler@example.com';
    const requesting = await sessionWithProject();
    const verifying = await sessionWithProject();
    const requestingBefore = await sessionRow(requesting.client);
    const verifyingBefore = await sessionRow(verifying.client);
    expect(
      (
        await requesting.client.post('/v1/auth/magic-link', {
          email,
          returnTo: `/p/${requesting.project.id}`,
        })
      ).statusCode,
    ).toBe(202);
    const token = linkTokenFor(harness, email);
    const requesterRows = await ownerRowCounts(requestingBefore.ownerId);
    expect(requesterRows.projects).toBe(1);
    expect(requesterRows.ledger).toBeGreaterThan(0);

    const first = await verifying.client.post('/v1/auth/verify', { token });
    expect(first.statusCode).toBe(200);
    expect(VerifyMagicLinkResponseSchema.parse(first.json())).toEqual({
      confirmationRequired: true,
      emailHint: 't•••@example.com',
    });
    expect(first.headers['x-csrf-token']).toBeUndefined();
    expect(await tokenRow(token)).toEqual({ consumedAt: null, ipHash: expect.any(String) });
    expect(await userOwner(email)).toBeNull();
    expect(await sessionRow(requesting.client)).toEqual(requestingBefore);
    expect(await sessionRow(verifying.client)).toEqual(verifyingBefore);
    expect((await me(requesting.client)).user).toBeNull();
    expect((await me(verifying.client)).user).toBeNull();

    const anonymousCookie = verifying.client.cookie ?? '';
    const confirmed = await verifying.client.post('/v1/auth/verify', { token, confirm: true });
    expect(confirmed.statusCode).toBe(200);
    // The requester's project is not the account's, so its return path falls back to Places.
    expect(VerifyMagicLinkResponseSchema.parse(confirmed.json())).toMatchObject({
      user: { email },
      claimedProjects: 1,
      returnTo: '/places',
    });
    expect(confirmed.headers['x-csrf-token']).toBeTruthy();
    // Consumption clears the hashed IP signal with it.
    expect(await tokenRow(token)).toEqual({ consumedAt: expect.any(Date), ipHash: null });

    const accountOwner = await userOwner(email);
    expect((await me(verifying.client)).user?.email).toBe(email);
    expect((await sessionRow(verifying.client)).ownerId).toBe(accountOwner);
    expect((await me(requesting.client)).user).toBeNull();
    expect(await sessionRow(requesting.client)).toEqual(requestingBefore);
    expect(await projectOwner(verifying.project.id)).toBe(accountOwner);

    // Nothing of the session that asked for the link moves into the account: its projects,
    // ledger lines (and with them its allowance use) stay with its own anonymous owner.
    expect(await projectOwner(requesting.project.id)).toBe(requestingBefore.ownerId);
    expect(await ownerRowCounts(requestingBefore.ownerId)).toEqual(requesterRows);
    expect((await requesting.client.get(`/v1/projects/${requesting.project.id}`)).statusCode).toBe(
      200,
    );
    const listed = json<{ items: Project[] }>(await verifying.client.get('/v1/projects'));
    expect(listed.items.map((item) => item.id)).toEqual([verifying.project.id]);
    const claims = await harness.context.db
      .selectFrom('auditLog')
      .select(['before'])
      .where('action', '=', 'session.claim')
      .where('targetId', '=', accountOwner ?? '')
      .execute();
    expect(claims.map((row) => (row.before as { ownerId: string }).ownerId)).toEqual([
      verifyingBefore.ownerId,
    ]);

    // The session token is rotated at sign-in: same row, new cookie value, and the anonymous
    // value no longer authenticates anything.
    expect(verifying.client.cookie).toBeTruthy();
    expect(verifying.client.cookie).not.toBe(anonymousCookie);
    const rotated = await harness.context.db
      .selectFrom('anonymousSessions')
      .selectAll()
      .where('id', '=', verifyingBefore.id)
      .executeTakeFirstOrThrow();
    expect(rotated.tokenHash).toBe(sha256Hex(verifying.client.cookie ?? ''));
    expect(confirmed.headers['x-csrf-token']).toBe(csrfTokenFor(harness, rotated));
    expect(confirmed.headers['x-csrf-token']).not.toBe(
      csrfTokenFor(harness, { ...rotated, tokenHash: sha256Hex(anonymousCookie) }),
    );
    const stale = harness.client();
    stale.cookie = anonymousCookie;
    const staleMe = await stale.get('/v1/me');
    expect(staleMe.statusCode).toBe(403);
    expect(json(staleMe).error).toMatchObject({ code: 'VERIFICATION_REQUIRED' });
  });

  it('signs in at once when the link is opened in the session that asked for it', async () => {
    const email = 'homebody@example.com';
    const { client, project } = await sessionWithProject();
    await client.post('/v1/auth/magic-link', { email });
    const verified = await client.post('/v1/auth/verify', { token: linkTokenFor(harness, email) });
    expect(verified.statusCode).toBe(200);
    expect(VerifyMagicLinkResponseSchema.parse(verified.json())).toMatchObject({
      user: { email },
      claimedProjects: 1,
    });
    expect(await projectOwner(project.id)).toBe(await userOwner(email));

    const again = harness.client();
    await again.createSession();
    await again.post('/v1/auth/magic-link', { email });
    const confirmed = await again.post('/v1/auth/verify', {
      token: linkTokenFor(harness, email),
      confirm: true,
    });
    expect(VerifyMagicLinkResponseSchema.parse(confirmed.json())).toMatchObject({
      user: { email },
      claimedProjects: 0,
    });
  });

  it('never signs in the session that asked for a link to someone else', async () => {
    const victimEmail = 'victim@example.com';
    const attacker = await sessionWithProject();
    const victim = await sessionWithProject();
    const attackerBefore = await sessionRow(attacker.client);
    await attacker.client.post('/v1/auth/magic-link', { email: victimEmail });
    const token = linkTokenFor(harness, victimEmail);

    const asked = await victim.client.post('/v1/auth/verify', { token });
    expect(json(asked)).toMatchObject({ confirmationRequired: true });
    expect((await me(attacker.client)).user).toBeNull();

    const attackerRows = await ownerRowCounts(attackerBefore.ownerId);
    const confirmed = await victim.client.post('/v1/auth/verify', { token, confirm: true });
    expect(confirmed.statusCode).toBe(200);
    expect(json(confirmed)).toMatchObject({ claimedProjects: 1 });
    expect((await me(victim.client)).user?.email).toBe(victimEmail);
    expect((await me(attacker.client)).user).toBeNull();
    expect(await sessionRow(attacker.client)).toEqual(attackerBefore);
    expect((await attacker.client.get(`/v1/projects/${victim.project.id}`)).statusCode).toBe(404);

    // The attacker's project, ledger lines and allowance use are never planted in the account.
    expect(await projectOwner(attacker.project.id)).toBe(attackerBefore.ownerId);
    expect(await ownerRowCounts(attackerBefore.ownerId)).toEqual(attackerRows);
    const victimProjects = json<{ items: Project[] }>(await victim.client.get('/v1/projects'));
    expect(victimProjects.items.map((item) => item.id)).toEqual([victim.project.id]);
    expect((await me(victim.client)).savedProjects).toBe(1);
    expect((await attacker.client.get('/internal/v1/session')).statusCode).toBe(403);
    expect((await attacker.client.delete('/v1/me')).statusCode).toBe(403);

    const replay = await attacker.client.post('/v1/auth/verify', { token, confirm: true });
    expect(json(replay).error).toMatchObject({ details: { reason: 'consumed' } });
    expect((await me(attacker.client)).user).toBeNull();
  });

  it('signs in two sessions racing to create the same new account', async () => {
    const email = 'racer@example.com';
    const clients = [harness.client(), harness.client()];
    const tokens: string[] = [];
    for (const client of clients) {
      await client.createSession();
      await client.post('/v1/auth/magic-link', { email });
      tokens.push(linkTokenFor(harness, email));
    }
    const verified = await Promise.all(
      clients.map((client, index) => client.post('/v1/auth/verify', { token: tokens[index] })),
    );
    expect(verified.map((response) => response.statusCode)).toEqual([200, 200]);
    const users = await harness.context.db
      .selectFrom('users')
      .select('id')
      .where('emailNormalized', '=', email)
      .execute();
    expect(users).toHaveLength(1);
  });

  it('checks the token before asking for confirmation', async () => {
    const client = harness.client();
    await client.createSession();
    const unknown = await client.post('/v1/auth/verify', { token: 'not-a-real-token' });
    expect(unknown.statusCode).toBe(400);
    expect(json(unknown).error).toMatchObject({ details: { reason: 'unknown' } });
  });

  it('keeps a project return path the account owns', async () => {
    const email = 'returner@example.com';
    const { client, project } = await sessionWithProject();
    await client.post('/v1/auth/magic-link', { email, returnTo: `/p/${project.id}` });
    const verified = await client.post('/v1/auth/verify', { token: linkTokenFor(harness, email) });
    expect(json(verified)).toMatchObject({ claimedProjects: 1, returnTo: `/p/${project.id}` });
  });
});

describe('operator re-authentication', () => {
  it('counts only operator_reauth tokens, never a consumed sign-in link', async () => {
    const operator = harness.client();
    await operator.createSession();
    const { csrf } = await signInSameSession(harness, operator, OPERATOR_EMAIL);
    const consumedSignIn = await harness.context.db
      .selectFrom('authTokens')
      .select(['purpose', 'consumedAt'])
      .where('requestedFromSessionId', '=', (await sessionRow(operator)).id)
      .execute();
    expect(consumedSignIn).toEqual([{ purpose: 'magic_link', consumedAt: expect.any(Date) }]);

    const session = json<{ reauthFresh: boolean }>(await operator.get('/internal/v1/session'));
    expect(session.reauthFresh).toBe(false);
    const pause = (await operator.get('/internal/v1/pause')).json() as Record<string, unknown>;
    const refused = await operator.put('/internal/v1/pause', pause, { 'x-csrf-token': csrf });
    expect(refused.statusCode).toBe(403);
    expect(json(refused).error).toMatchObject({ details: { reason: 'reauth_required' } });

    await reauthenticate(harness, operator, csrf);
    const fresh = json<{ reauthFresh: boolean }>(await operator.get('/internal/v1/session'));
    expect(fresh.reauthFresh).toBe(true);
    const reauthTokens = await harness.context.db
      .selectFrom('authTokens')
      .select(['consumedAt', 'ipHash'])
      .where('purpose', '=', 'operator_reauth')
      .where('requestedFromSessionId', '=', (await sessionRow(operator)).id)
      .execute();
    expect(reauthTokens).toEqual([{ consumedAt: expect.any(Date), ipHash: null }]);
    const audited = await harness.context.db
      .selectFrom('auditLog')
      .innerJoin('users', 'users.id', 'auditLog.actorUserId')
      .select(['auditLog.actorKind', 'auditLog.targetKind'])
      .where('auditLog.action', '=', 'operator.reauth_request')
      .where('users.emailNormalized', '=', OPERATOR_EMAIL)
      .execute();
    expect(audited.length).toBeGreaterThan(0);
    expect(audited[0]).toEqual({ actorKind: 'operator', targetKind: 'user' });
  });
});
