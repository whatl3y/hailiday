import type { PreservationHoldReason, PreservationHoldTargetKind } from '@hailiday/core';
import { toJson, type DbOrTx } from '../../db/client.js';
import type { HeldObjectJson } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import { PRIVATE_PREFIXES, keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { reviewObjectKeyOf } from '../uploads/screen.js';

const NO_ID = '00000000-0000-0000-0000-000000000000';

/**
 * The concrete rows covered by open preservation holds, each mapped to one hold that covers it.
 * Every hold kind resolves to rows: `project` to the project, its source assets and variants;
 * `source_asset` to the asset and the variants made from it; `render_asset` to the variant;
 * `report` to the reported variant (and its source) or the reported project; `owner` to every
 * project of the owner. Rows whose `preservation_hold_id` names an open hold are covered too.
 */
export interface HeldSet {
  readonly holdCount: number;
  readonly projects: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, string>;
  readonly assets: ReadonlyMap<string, string>;
  readonly owners: ReadonlyMap<string, string>;
}

export const EMPTY_HELD_SET: HeldSet = {
  holdCount: 0,
  projects: new Map(),
  sources: new Map(),
  assets: new Map(),
  owners: new Map(),
};

interface HoldRow {
  id: string;
  targetKind: PreservationHoldTargetKind;
  targetId: string;
}

async function resolveHolds(db: DbOrTx, holds: readonly HoldRow[]): Promise<HeldSet> {
  if (holds.length === 0) return EMPTY_HELD_SET;
  const projects = new Map<string, string>();
  const sources = new Map<string, string>();
  const assets = new Map<string, string>();
  const owners = new Map<string, string>();
  const put = (map: Map<string, string>, id: string | null | undefined, holdId: string) => {
    if (id && !map.has(id)) map.set(id, holdId);
  };

  for (const hold of holds) {
    switch (hold.targetKind) {
      case 'project':
        put(projects, hold.targetId, hold.id);
        break;
      case 'source_asset':
        put(sources, hold.targetId, hold.id);
        break;
      case 'render_asset':
        put(assets, hold.targetId, hold.id);
        break;
      case 'owner':
        put(owners, hold.targetId, hold.id);
        break;
      case 'report': {
        const report = await db
          .selectFrom('reports')
          .select(['targetKind', 'targetId', 'targetShareTokenHash'])
          .where('id', '=', hold.targetId)
          .executeTakeFirst();
        if (!report) break;
        if (report.targetKind === 'project') {
          put(projects, report.targetId, hold.id);
          break;
        }
        let assetId = report.targetKind === 'address' ? null : report.targetId;
        if (!assetId && report.targetShareTokenHash) {
          const grant = await db
            .selectFrom('shareGrants')
            .select('renderAssetId')
            .where('tokenHash', '=', report.targetShareTokenHash)
            .executeTakeFirst();
          assetId = grant?.renderAssetId ?? null;
        }
        if (!assetId) break;
        const asset = await db
          .selectFrom('renderAssets')
          .select(['id', 'sourceAssetId'])
          .where('id', '=', assetId)
          .executeTakeFirst();
        if (asset) {
          put(assets, asset.id, hold.id);
          put(sources, asset.sourceAssetId, hold.id);
        } else {
          // A report may name a project as its render target in older clients.
          put(projects, assetId, hold.id);
        }
        break;
      }
    }
  }

  const holdIds = holds.map((hold) => hold.id);
  const columnHeld = async (table: 'projects' | 'sourceAssets' | 'renderAssets') =>
    db
      .selectFrom(table)
      .select(['id', 'preservationHoldId'])
      .where('preservationHoldId', 'in', holdIds)
      .execute();
  for (const row of await columnHeld('projects')) put(projects, row.id, row.preservationHoldId!);
  for (const row of await columnHeld('sourceAssets')) put(sources, row.id, row.preservationHoldId!);
  for (const row of await columnHeld('renderAssets')) put(assets, row.id, row.preservationHoldId!);

  if (owners.size > 0) {
    const owned = await db
      .selectFrom('projects')
      .select(['id', 'ownerId'])
      .where('ownerId', 'in', [...owners.keys()])
      .execute();
    for (const row of owned) put(projects, row.id, owners.get(row.ownerId)!);
  }
  if (projects.size > 0) {
    const projectIds = [...projects.keys()];
    const projectSources = await db
      .selectFrom('sourceAssets')
      .select(['id', 'projectId'])
      .where('projectId', 'in', projectIds)
      .execute();
    for (const row of projectSources) put(sources, row.id, projects.get(row.projectId)!);
    const projectAssets = await db
      .selectFrom('renderAssets')
      .select(['id', 'projectId'])
      .where('projectId', 'in', projectIds)
      .execute();
    for (const row of projectAssets) put(assets, row.id, projects.get(row.projectId)!);
  }
  if (sources.size > 0) {
    const derived = await db
      .selectFrom('renderAssets')
      .select(['id', 'sourceAssetId'])
      .where('sourceAssetId', 'in', [...sources.keys()])
      .execute();
    for (const row of derived) put(assets, row.id, sources.get(row.sourceAssetId)!);
  }
  return { holdCount: holds.length, projects, sources, assets, owners };
}

/** Every row covered by an unreleased preservation hold. */
export async function loadHeldSet(deps: Pick<PipelineDeps, 'db'>): Promise<HeldSet> {
  const holds = await deps.db
    .selectFrom('preservationHolds')
    .select(['id', 'targetKind', 'targetId'])
    .where('releasedAt', 'is', null)
    .execute();
  return resolveHolds(deps.db, holds);
}

/** The rows one hold covers (released or not). */
export async function rowsOfHold(db: DbOrTx, holdId: string): Promise<HeldSet> {
  const hold = await db
    .selectFrom('preservationHolds')
    .select(['id', 'targetKind', 'targetId'])
    .where('id', '=', holdId)
    .executeTakeFirst();
  return resolveHolds(db, hold ? [hold] : []);
}

/** The hold covering a project as a whole (a project, owner or project-column hold), if any. */
export function projectHoldOf(
  held: HeldSet,
  project: { id: string; ownerId: string; preservationHoldId: string | null },
): string | null {
  return (
    held.projects.get(project.id) ??
    held.owners.get(project.ownerId) ??
    project.preservationHoldId ??
    null
  );
}

/**
 * Whether anything in a project is held. Returns the project-wide hold, the held source and
 * variant IDs (a project-wide hold covers all of them).
 */
export function heldWithin(
  held: HeldSet,
  project: { id: string; ownerId: string; preservationHoldId: string | null },
  rows: {
    sources: readonly { id: string; preservationHoldId?: string | null }[];
    assets: readonly { id: string; sourceAssetId: string; preservationHoldId?: string | null }[];
  },
): { projectHold: string | null; sources: Set<string>; assets: Set<string>; any: boolean } {
  const projectHold = projectHoldOf(held, project);
  const sources = new Set(
    rows.sources
      .filter((row) => projectHold || held.sources.has(row.id) || row.preservationHoldId)
      .map((row) => row.id),
  );
  const assets = new Set(
    rows.assets
      .filter(
        (row) =>
          projectHold ||
          held.assets.has(row.id) ||
          sources.has(row.sourceAssetId) ||
          row.preservationHoldId,
      )
      .map((row) => row.id),
  );
  return {
    projectHold,
    sources,
    assets,
    any: projectHold !== null || sources.size > 0 || assets.size > 0,
  };
}

export interface PlaceHoldInput {
  targetKind: PreservationHoldTargetKind;
  targetId: string;
  reason: PreservationHoldReason;
  authorityRef: string;
  releaseCondition: string;
  /** The operator placing the hold; null for an automated signal. */
  placedBy: string | null;
}

/**
 * Places a preservation hold in the caller's transaction: the `preservation_holds` row, and
 * `preservation_hold_id` on every row it covers that carries no other hold (and on a reported
 * report). The caller copies the covered objects under `held/` after commit with
 * `copyHeldObjects`.
 */
export async function placePreservationHold(
  db: DbOrTx,
  input: PlaceHoldInput,
): Promise<{ holdId: string; covered: HeldSet }> {
  const holdId = newId();
  await db
    .insertInto('preservationHolds')
    .values({
      id: holdId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      reason: input.reason,
      authorityRef: input.authorityRef,
      releaseCondition: input.releaseCondition,
      placedBy: input.placedBy,
    })
    .execute();
  const covered = await rowsOfHold(db, holdId);
  const mark = async (table: 'projects' | 'sourceAssets' | 'renderAssets', ids: string[]) => {
    if (ids.length === 0) return;
    await db
      .updateTable(table)
      .set({ preservationHoldId: holdId })
      .where('id', 'in', ids)
      .where('preservationHoldId', 'is', null)
      .execute();
  };
  await mark('projects', [...covered.projects.keys()]);
  await mark('sourceAssets', [...covered.sources.keys()]);
  await mark('renderAssets', [...covered.assets.keys()]);
  if (input.targetKind === 'report') {
    await db
      .updateTable('reports')
      .set({ preservationHoldId: holdId })
      .where('id', '=', input.targetId)
      .where('preservationHoldId', 'is', null)
      .execute();
  }
  return { holdId, covered };
}

/**
 * Copies every private object a hold covers to `held/{holdId}/{sha256(originalKey)}` (no
 * lifecycle rule, never swept) and records the copies on the hold: normalized originals, reviewer
 * copies, the enhanced pictures of Street View frames, accepted variants and their derivatives, download files and the candidates of the
 * covered jobs. Street View pixels are not copied (the storage client only writes them under an
 * evaluated permission); they are recorded as protected in place, where every sweep and deletion
 * path skips held rows. Returns the records written.
 */
export async function copyHeldObjects(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'logger'>,
  holdId: string,
): Promise<HeldObjectJson[]> {
  const covered = await rowsOfHold(deps.db, holdId);
  const sourceIds = [...covered.sources.keys()];
  const assetIds = [...covered.assets.keys()];
  const sources = await deps.db
    .selectFrom('sourceAssets')
    .select(['id', 'kind', 'objectKey', 'screening'])
    .where('id', 'in', sourceIds.length > 0 ? sourceIds : [NO_ID])
    .execute();
  const assets = await deps.db
    .selectFrom('renderAssets')
    .select(['id', 'ownerId', 'jobId', 'sourceAssetId', 'downloadObjectKey'])
    .where('id', 'in', assetIds.length > 0 ? assetIds : [NO_ID])
    .execute();
  const kindOf = new Map(sources.map((source) => [source.id, source.kind]));
  const assetSourceKinds = await deps.db
    .selectFrom('sourceAssets')
    .select(['id', 'kind'])
    .where('id', 'in', assets.length > 0 ? assets.map((asset) => asset.sourceAssetId) : [NO_ID])
    .execute();
  for (const row of assetSourceKinds) kindOf.set(row.id, row.kind);
  const jobs = await deps.db
    .selectFrom('renderJobs')
    .select(['id', 'sourceAssetId'])
    .where((eb) =>
      eb.or([
        eb('sourceAssetId', 'in', sourceIds.length > 0 ? sourceIds : [NO_ID]),
        eb('id', 'in', assets.length > 0 ? assets.map((asset) => asset.jobId) : [NO_ID]),
      ]),
    )
    .execute();

  const wanted: { key: string; sourceKind: string | undefined; derivative: boolean }[] = [];
  for (const source of sources) {
    if (source.objectKey) {
      wanted.push({ key: source.objectKey, sourceKind: source.kind, derivative: false });
    }
    const review = reviewObjectKeyOf(source.screening);
    if (review) wanted.push({ key: review, sourceKind: source.kind, derivative: false });
  }
  // A Street View frame's enhanced pictures are kept with it (in place, like the frame).
  const sourceKinds = new Map(sources.map((source) => [source.id, source.kind]));
  const enhanced = await deps.db
    .selectFrom('sourceEnhancements')
    .select(['sourceAssetId', 'objectKey'])
    .where('sourceAssetId', 'in', sourceIds.length > 0 ? sourceIds : [NO_ID])
    .where('objectKey', 'is not', null)
    .orderBy('objectKey')
    .execute();
  for (const row of enhanced) {
    if (!row.objectKey) continue;
    wanted.push({
      key: row.objectKey,
      sourceKind: sourceKinds.get(row.sourceAssetId),
      derivative: false,
    });
  }
  for (const asset of assets) {
    const sourceKind = kindOf.get(asset.sourceAssetId);
    for (const key of await deps.storage.list(
      'private',
      keys.outputPrefix(asset.ownerId, asset.id),
    )) {
      wanted.push({ key, sourceKind, derivative: true });
    }
    if (asset.downloadObjectKey) {
      wanted.push({ key: asset.downloadObjectKey, sourceKind, derivative: true });
    }
  }
  for (const job of jobs) {
    for (const key of await deps.storage.list(
      'private',
      `${PRIVATE_PREFIXES.attempts}${job.id}/`,
    )) {
      wanted.push({ key, sourceKind: kindOf.get(job.sourceAssetId), derivative: true });
    }
  }

  const records: HeldObjectJson[] = [];
  const seen = new Set<string>();
  for (const item of wanted) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    const record: HeldObjectJson = {
      bucket: 'private',
      originalKeyHash: sha256Hex(item.key),
      heldKey: null,
      inPlace: true,
    };
    if (item.sourceKind && item.sourceKind !== 'street_view') {
      const heldKey = keys.held(holdId, item.key);
      try {
        await deps.storage.copy({
          from: { bucket: 'private', key: item.key },
          to: { bucket: 'private', key: heldKey },
          provenance: {
            sourceKind: item.sourceKind as 'upload' | 'fixture',
            derivative: item.derivative,
          },
        });
        record.heldKey = heldKey;
        record.inPlace = false;
      } catch (error) {
        deps.logger.error({ err: error, holdId }, 'held copy failed; object protected in place');
      }
    }
    records.push(record);
  }
  const existing = await deps.db
    .selectFrom('preservationHolds')
    .select('heldObjects')
    .where('id', '=', holdId)
    .executeTakeFirst();
  const merged = [
    ...(existing?.heldObjects ?? []).filter(
      (prior) => !records.some((record) => record.originalKeyHash === prior.originalKeyHash),
    ),
    ...records,
  ];
  await deps.db
    .updateTable('preservationHolds')
    .set({ heldObjects: toJson(merged) })
    .where('id', '=', holdId)
    .execute();
  return records;
}

/** Deletes a released hold's copies under `held/{holdId}/`; returns the count deleted. */
export async function releaseHeldObjects(
  deps: Pick<PipelineDeps, 'db' | 'storage' | 'logger'>,
  holdId: string,
): Promise<number> {
  const hold = await deps.db
    .selectFrom('preservationHolds')
    .select(['heldObjects', 'releasedAt'])
    .where('id', '=', holdId)
    .executeTakeFirst();
  if (!hold?.releasedAt) return 0;
  let deleted = 0;
  const prefix = `${PRIVATE_PREFIXES.held}${holdId}/`;
  for (const record of hold.heldObjects) {
    if (!record.heldKey?.startsWith(prefix)) continue;
    await deps.storage.delete('private', record.heldKey);
    deleted += 1;
  }
  return deleted;
}
