import { OPERATOR_EMAIL, type Harness, type TestClient } from './harness.js';

/** The token of the last link emailed to `email` by a harness. */
export function linkTokenFor(harness: Pick<Harness, 'email'>, email: string): string {
  const message = harness.email.lastTo(email);
  const match = /token=([A-Za-z0-9_%-]+)/.exec(message?.text ?? '');
  if (!match?.[1]) throw new Error(`no link sent to ${email}`);
  return decodeURIComponent(match[1]);
}

/** Signs a client in through a magic link requested and opened in the same session. */
export async function signInSameSession(
  harness: Pick<Harness, 'email'>,
  client: TestClient,
  email: string,
): Promise<{ csrf: string }> {
  const requested = await client.post('/v1/auth/magic-link', { email });
  if (requested.statusCode !== 202) throw new Error(`magic link: ${requested.statusCode}`);
  const verified = await client.post('/v1/auth/verify', { token: linkTokenFor(harness, email) });
  if (verified.statusCode !== 200) throw new Error(`verify: ${verified.statusCode}`);
  return { csrf: String(verified.headers['x-csrf-token']) };
}

/** Completes an operator re-authentication: requests the email and opens its link. */
export async function reauthenticate(
  harness: Pick<Harness, 'email'>,
  client: TestClient,
  csrf: string,
  email = OPERATOR_EMAIL,
): Promise<void> {
  const requested = await client.post('/internal/v1/reauth', {}, { 'x-csrf-token': csrf });
  if (requested.statusCode !== 202) throw new Error(`reauth: ${requested.statusCode}`);
  const verified = await client.post('/v1/auth/verify', { token: linkTokenFor(harness, email) });
  if (verified.statusCode !== 200) throw new Error(`reauth verify: ${verified.statusCode}`);
}

/** A fresh session signed in as the allowlisted operator, re-authenticated for mutations. */
export async function operatorClient(
  harness: Harness,
): Promise<{ client: TestClient; csrf: string }> {
  const client = harness.client();
  await client.createSession();
  const { csrf } = await signInSameSession(harness, client, OPERATOR_EMAIL);
  await reauthenticate(harness, client, csrf);
  return { client, csrf };
}
