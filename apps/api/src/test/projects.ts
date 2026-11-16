import { sha256Hex } from '@hailiday/server/ids';
import { createStreetViewSource, createUploadSource } from '@hailiday/server/pipeline';
import type { Harness, TestClient } from './harness.js';

/** The owner of a test client's session. */
export async function ownerIdOf(
  harness: Pick<Harness, 'context'>,
  client: TestClient,
): Promise<string> {
  if (!client.cookie) throw new Error('the client has no session');
  const session = await harness.context.db
    .selectFrom('anonymousSessions')
    .select('ownerId')
    .where('tokenHash', '=', sha256Hex(client.cookie))
    .executeTakeFirstOrThrow();
  return session.ownerId;
}

/**
 * Creates an address project with a `ready` fixture Street View source directly in the database
 * and gives it to the client's owner, so render tests need no resolve or discovery round trip.
 */
export async function adoptStreetViewProject(
  harness: Pick<Harness, 'context' | 'pipeline'>,
  client: TestClient,
  placeId = 'ChIJfxLanternHillColonial01',
  streetViewMode: 'transient' | 'persist' = 'transient',
): Promise<{ projectId: string; projectVersion: number; sourceAssetId: string }> {
  const ownerId = await ownerIdOf(harness, client);
  const created = await createStreetViewSource(harness.pipeline, { placeId, streetViewMode });
  const db = harness.context.db;
  await db.transaction().execute(async (trx) => {
    for (const table of ['properties', 'projects', 'sourceAssets'] as const) {
      await trx
        .updateTable(table)
        .set({ ownerId })
        .where('ownerId', '=', created.ownerId)
        .execute();
    }
  });
  const project = await db
    .selectFrom('projects')
    .select(['id', 'projectVersion'])
    .where('id', '=', created.projectId)
    .executeTakeFirstOrThrow();
  return {
    projectId: project.id,
    projectVersion: project.projectVersion,
    sourceAssetId: created.source.id,
  };
}

/**
 * Creates an upload project with a `ready` upload source directly in the database and gives it to
 * the client's owner. The stored original is a placeholder: use it only where no worker runs.
 */
export async function adoptUploadProject(
  harness: Pick<Harness, 'context' | 'pipeline'>,
  client: TestClient,
): Promise<{ projectId: string; projectVersion: number; sourceAssetId: string }> {
  const ownerId = await ownerIdOf(harness, client);
  const created = await createUploadSource(harness.pipeline, {
    image: Buffer.from('placeholder original'),
  });
  const db = harness.context.db;
  await db.transaction().execute(async (trx) => {
    for (const table of ['projects', 'sourceAssets'] as const) {
      await trx
        .updateTable(table)
        .set({ ownerId })
        .where('ownerId', '=', created.ownerId)
        .execute();
    }
  });
  const project = await db
    .selectFrom('projects')
    .select(['id', 'projectVersion'])
    .where('id', '=', created.projectId)
    .executeTakeFirstOrThrow();
  return {
    projectId: project.id,
    projectVersion: project.projectVersion,
    sourceAssetId: created.source.id,
  };
}
