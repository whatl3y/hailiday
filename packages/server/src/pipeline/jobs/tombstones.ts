import { sql } from 'kysely';
import type { TombstoneKind } from '@holiday/core';
import { DAY_MS, addMs } from '../../clock/index.js';
import type { DbOrTx } from '../../db/client.js';
import { newId } from '../../ids/index.js';
import { PRIVATE_PREFIXES, keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';

/** Tombstones are kept for the backup window plus the tombstone period (60 days). */
export const TOMBSTONE_RETENTION_MS = 60 * DAY_MS;

export interface TombstoneEntry {
  kind: TombstoneKind;
  hash: string;
  attestationVersion?: string | null;
  attestedAt?: Date | null;
}

/** Writes tombstones (an existing tombstone of the same kind and hash is kept). */
export async function writeTombstones(
  db: DbOrTx,
  input: { deletionRequestId: string | null; now: Date; entries: readonly TombstoneEntry[] },
): Promise<void> {
  for (const entry of input.entries) {
    await db
      .insertInto('tombstones')
      .values({
        id: newId(),
        kind: entry.kind,
        hashSha256: entry.hash,
        deletionRequestId: input.deletionRequestId,
        deletedAt: input.now,
        retainUntil: addMs(input.now, TOMBSTONE_RETENTION_MS),
        attestationVersion: entry.attestationVersion ?? null,
        attestedAt: entry.attestedAt ?? null,
      })
      .onConflict((oc) => oc.columns(['kind', 'hashSha256']).doNothing())
      .execute();
  }
}

/** One line of the tombstone mirror (opaque hashes and timestamps only). */
export interface TombstoneMirrorLine {
  kind: TombstoneKind;
  hashSha256: string;
  deletionRequestId: string | null;
  deletedAt: string;
  retainUntil: string;
  attestationVersion: string | null;
  attestedAt: string | null;
}

/**
 * Appends tombstones not yet mirrored to the append-only store outside the database: one JSONL
 * object per batch at `tombstones/{YYYY-MM-DD}/{batchId}.jsonl` in the private bucket, then marks
 * the rows mirrored. With `deletionRequestId`, only that request's tombstones. Returns the count.
 */
export async function mirrorTombstones(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'clock'>,
  options: { deletionRequestId?: string; limit?: number } = {},
): Promise<number> {
  let query = deps.db
    .selectFrom('tombstones')
    .selectAll()
    .where('mirroredAt', 'is', null)
    .orderBy('createdAt')
    .limit(options.limit ?? 1000);
  if (options.deletionRequestId) {
    query = query.where('deletionRequestId', '=', options.deletionRequestId);
  }
  const rows = await query.execute();
  if (rows.length === 0) return 0;
  const now = deps.clock.now();
  const lines = rows.map((row): TombstoneMirrorLine => ({
    kind: row.kind,
    hashSha256: row.hashSha256,
    deletionRequestId: row.deletionRequestId,
    deletedAt: row.deletedAt.toISOString(),
    retainUntil: row.retainUntil.toISOString(),
    attestationVersion: row.attestationVersion,
    attestedAt: row.attestedAt ? row.attestedAt.toISOString() : null,
  }));
  await deps.storage.put({
    bucket: 'private',
    key: keys.tombstoneLog(now.toISOString().slice(0, 10), newId()),
    body: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    contentType: 'application/x-ndjson',
    provenance: { sourceKind: 'system' },
  });
  await deps.db
    .updateTable('tombstones')
    .set({ mirroredAt: now })
    .where(
      'id',
      'in',
      rows.map((row) => row.id),
    )
    .execute();
  return rows.length;
}

/** Deletes mirror batches older than the tombstone period; returns the count deleted. */
export async function ageOutTombstoneMirror(
  deps: Pick<PipelineDeps, 'storage' | 'clock'>,
  options: { limit?: number } = {},
): Promise<number> {
  const cutoff = addMs(deps.clock.now(), -TOMBSTONE_RETENTION_MS).toISOString().slice(0, 10);
  const objects = await deps.storage.list('private', PRIVATE_PREFIXES.tombstones, options.limit);
  let deleted = 0;
  for (const key of objects) {
    const day = /^tombstones\/(\d{4}-\d{2}-\d{2})\//.exec(key)?.[1];
    if (!day || day >= cutoff) continue;
    await deps.storage.delete('private', key);
    deleted += 1;
  }
  return deleted;
}

export interface TombstoneReplayResult {
  batches: number;
  lines: number;
  tombstonesRestored: number;
  projectsRedeleted: number;
  sourceAssetsRedeleted: number;
  renderAssetsRedeleted: number;
  sharesRevoked: number;
  ownersRedeleted: number;
}

const idHash = (column: string) =>
  sql<string>`encode(sha256(convert_to(${sql.ref(column)}::text, 'UTF8')), 'hex')`;

/**
 * Restore safety: after a database restore and before traffic resumes, replays every mirrored
 * tombstone. Missing tombstone rows are re-inserted; projects, source assets and variants whose ID
 * hash is tombstoned are marked deleted again (a re-deleted project gets a `pending` deletion
 * request, which the retention sweep's deletion resume completes); share grants of tombstoned
 * tokens are revoked; tombstoned owners lose their account email. Idempotent.
 */
export async function replayTombstoneMirror(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'clock' | 'logger'>,
): Promise<TombstoneReplayResult> {
  const now = deps.clock.now();
  const result: TombstoneReplayResult = {
    batches: 0,
    lines: 0,
    tombstonesRestored: 0,
    projectsRedeleted: 0,
    sourceAssetsRedeleted: 0,
    renderAssetsRedeleted: 0,
    sharesRevoked: 0,
    ownersRedeleted: 0,
  };
  const objects = await deps.storage.list('private', PRIVATE_PREFIXES.tombstones, 1_000_000);
  const seen = new Set<string>();
  for (const key of objects) {
    const object = await deps.storage.get('private', key);
    if (!object) continue;
    result.batches += 1;
    for (const text of object.body.toString('utf8').split('\n')) {
      if (!text.trim()) continue;
      let line: TombstoneMirrorLine;
      try {
        line = JSON.parse(text) as TombstoneMirrorLine;
      } catch {
        deps.logger.warn({ key }, 'unreadable tombstone mirror line skipped');
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(line.hashSha256) || seen.has(`${line.kind}:${line.hashSha256}`)) {
        continue;
      }
      seen.add(`${line.kind}:${line.hashSha256}`);
      result.lines += 1;
      const deletedAt = new Date(line.deletedAt);
      const inserted = await deps.db
        .insertInto('tombstones')
        .values({
          id: newId(),
          kind: line.kind,
          hashSha256: line.hashSha256,
          deletionRequestId: null,
          deletedAt,
          retainUntil: new Date(line.retainUntil),
          attestationVersion: line.attestationVersion,
          attestedAt: line.attestedAt ? new Date(line.attestedAt) : null,
          mirroredAt: now,
        })
        .onConflict((oc) => oc.columns(['kind', 'hashSha256']).doNothing())
        .executeTakeFirst();
      result.tombstonesRestored += Number(inserted.numInsertedOrUpdatedRows ?? 0);

      if (line.kind === 'project') {
        const projects = await deps.db
          .updateTable('projects')
          .set({ deletedAt })
          .where('deletedAt', 'is', null)
          .where(idHash('id'), '=', line.hashSha256)
          .returning(['id', 'ownerId'])
          .execute();
        for (const project of projects) {
          await deps.db
            .insertInto('deletionRequests')
            .values({
              id: newId(),
              ownerId: project.ownerId,
              scope: 'project',
              targetId: project.id,
              requestedBy: 'system',
              accessRevokedAt: now,
              status: 'pending',
            })
            .execute();
        }
        result.projectsRedeleted += projects.length;
      } else if (line.kind === 'source_asset') {
        const rows = await deps.db
          .updateTable('sourceAssets')
          .set({ deletedAt })
          .where('deletedAt', 'is', null)
          .where(idHash('id'), '=', line.hashSha256)
          .executeTakeFirst();
        result.sourceAssetsRedeleted += Number(rows.numUpdatedRows ?? 0);
      } else if (line.kind === 'render_asset') {
        const rows = await deps.db
          .updateTable('renderAssets')
          .set({ deletedAt })
          .where('deletedAt', 'is', null)
          .where(idHash('id'), '=', line.hashSha256)
          .executeTakeFirst();
        result.renderAssetsRedeleted += Number(rows.numUpdatedRows ?? 0);
      } else if (line.kind === 'share_token') {
        const rows = await deps.db
          .updateTable('shareGrants')
          .set({ revokedAt: deletedAt })
          .where('revokedAt', 'is', null)
          .where('tokenHash', '=', line.hashSha256)
          .executeTakeFirst();
        result.sharesRevoked += Number(rows.numUpdatedRows ?? 0);
      } else if (line.kind === 'owner') {
        const owners = await deps.db
          .updateTable('owners')
          .set({ deletedAt })
          .where('deletedAt', 'is', null)
          .where(idHash('id'), '=', line.hashSha256)
          .returning('id')
          .execute();
        for (const owner of owners) {
          await deps.db
            .updateTable('users')
            .set((eb) => ({
              deletedAt,
              emailNormalized: sql<string>`'deleted:' || ${eb.ref('id')}::text`,
            }))
            .where('ownerId', '=', owner.id)
            .where('deletedAt', 'is', null)
            .execute();
        }
        result.ownersRedeleted += owners.length;
      }
    }
  }
  return result;
}
