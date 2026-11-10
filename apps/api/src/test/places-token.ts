import { sha256Hex } from '@holiday/server/ids';
import { mintPlacesSessionToken } from '../auth/places-token.js';
import type { Harness, TestClient } from './harness.js';

/**
 * Mints an autocomplete session token for a test client's session directly, as
 * `GET /v1/addresses/suggestions` would, without counting against the per-session mint limit.
 */
export async function placesTokenForClient(
  harness: Pick<Harness, 'config' | 'context'>,
  client: TestClient,
): Promise<string> {
  if (!client.cookie) throw new Error('the client has no session');
  const session = await harness.context.db
    .selectFrom('anonymousSessions')
    .select('id')
    .where('tokenHash', '=', sha256Hex(client.cookie))
    .executeTakeFirstOrThrow();
  return mintPlacesSessionToken(harness.config.sessionSecret, session.id);
}
