import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toJson } from '../../db/client.js';
import type { SourceAsset } from '../../db/schema.js';
import { newId, randomToken, sha256Hex } from '../../ids/index.js';
import type { RefreshPanoramaResult, StreetViewProvider } from '../../providers/types.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { dropStoredStreetViewFrame, purgeRemovedPanorama } from '../render/source.js';
import {
  createPipelineTestDeps,
  createRenderJobRecord,
  createStreetViewSource,
} from '../testing.js';
import { runStreetViewRevalidation } from './commerce-and-coverage.js';
import { deleteProject } from './deletion.js';
import { copyHeldObjects, placePreservationHold } from './holds.js';
import { runReconciliation } from './reconciliation.js';
import { purgeBlockedPlaces, purgePlace } from './takedown.js';

const PLACE = 'ChIJfxLanternHillColonial01';
/** What the storage client needs to write Street View pixels in these tests. */
const STORE = { store: true, evidenceId: 'test' } as never;

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

interface Enhanced {
  ownerId: string;
  projectId: string;
  source: SourceAsset;
  frameKey: string;
  enhancementId: string;
  enhancementKey: string;
}

/**
 * A `persist` Street View source with a stored frame and an accepted enhancement, under a place
 * ID and a pano ID of its own (so takedown and revalidation runs touch nothing else).
 */
async function enhancedSource(into?: { projectId: string }): Promise<Enhanced> {
  const created = await createStreetViewSource(base, {
    placeId: PLACE,
    streetViewMode: 'persist',
  });
  const placeId = `test-place-${newId()}`;
  await base.db
    .updateTable('properties')
    .set({ placeId })
    .where('id', 'in', (eb) =>
      eb.selectFrom('projects').select('propertyId').where('id', '=', created.projectId),
    )
    .execute();
  const projectId = into?.projectId ?? created.projectId;
  const frameKey = keys.original(created.ownerId, created.source.id);
  const frame = Buffer.from(`frame-${created.source.id}`);
  await base.storage.put({
    bucket: 'private',
    key: frameKey,
    body: frame,
    contentType: 'image/jpeg',
    provenance: { sourceKind: 'street_view', permission: STORE },
  });
  const source = await base.db
    .updateTable('sourceAssets')
    .set({
      projectId,
      objectKey: frameKey,
      checksumSha256: sha256Hex(frame),
      viewpoint: toJson({ ...created.source.viewpoint, panoId: `testPano${newId()}` }),
    })
    .where('id', '=', created.source.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  const enhancementId = newId();
  const enhancementKey = keys.enhanced(created.ownerId, source.id, enhancementId);
  const picture = Buffer.from(`enhanced-${enhancementId}`);
  await base.storage.put({
    bucket: 'private',
    key: enhancementKey,
    body: picture,
    contentType: 'image/png',
    provenance: { sourceKind: 'street_view', permission: STORE, derivative: false },
  });
  await base.db
    .insertInto('sourceEnhancements')
    .values({
      id: enhancementId,
      sourceAssetId: source.id,
      frameChecksumSha256: sha256Hex(frame),
      compilerVersion: 'test',
      workingWidth: 1024,
      workingHeight: 1024,
      status: 'accepted',
      objectKey: enhancementKey,
      enhancedChecksumSha256: sha256Hex(picture),
      decidedAt: new Date(),
    })
    .execute();
  return {
    ownerId: created.ownerId,
    projectId,
    source,
    frameKey,
    enhancementId,
    enhancementKey,
  };
}

async function kept(e: Enhanced) {
  const rows = await base.db
    .selectFrom('sourceEnhancements')
    .select('id')
    .where('sourceAssetId', '=', e.source.id)
    .execute();
  const object = await base.storage.head('private', e.enhancementKey);
  return { rows: rows.length, object: object !== null };
}

async function holdSource(sourceId: string) {
  return base.db.transaction().execute((trx) =>
    placePreservationHold(trx, {
      targetKind: 'source_asset',
      targetId: sourceId,
      reason: 'complaint_investigation',
      authorityRef: `test:${sourceId}`,
      releaseCondition: 'test',
      placedBy: null,
    }),
  );
}

const fresh = (source: SourceAsset) =>
  base.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', source.id)
    .executeTakeFirstOrThrow();

describe('every path that deletes or replaces a stored frame drops its enhancement', () => {
  it('the policy no longer allows storage (dropStoredStreetViewFrame), unless held', async () => {
    const e = await enhancedSource();
    await dropStoredStreetViewFrame(base, e.source);
    expect(await kept(e)).toEqual({ rows: 0, object: false });

    const h = await enhancedSource();
    await dropStoredStreetViewFrame(base, h.source, {
      sources: new Map([[h.source.id, 'hold']]),
    } as never);
    expect(await kept(h)).toEqual({ rows: 1, object: true });
  });

  it('a panorama found removed at render time, unless held', async () => {
    const e = await enhancedSource();
    await purgeRemovedPanorama(base, e.source);
    expect(await kept(e)).toEqual({ rows: 0, object: false });

    const h = await enhancedSource();
    await holdSource(h.source.id);
    await purgeRemovedPanorama(base, await fresh(h.source));
    expect(await kept(h)).toEqual({ rows: 1, object: true });
  });

  it('an opt-out or block of the place (purgePlace)', async () => {
    const e = await enhancedSource();
    const property = await base.db
      .selectFrom('projects')
      .innerJoin('properties', 'properties.id', 'projects.propertyId')
      .select('properties.placeId')
      .where('projects.id', '=', e.projectId)
      .executeTakeFirstOrThrow();
    await purgePlace(base, property.placeId, { requestedBy: 'operator' });
    expect(await kept(e)).toEqual({ rows: 0, object: false });
    expect((await fresh(e.source)).objectKey).toBeNull();
  });

  it('the daily revalidation: a removed or replaced panorama', async () => {
    for (const answer of [
      { status: 'missing', metadata: { status: 'ZERO_RESULTS', panoId: null } },
      { status: 'replaced', metadata: { status: 'OK', panoId: 'newerPano' } },
    ]) {
      const e = await enhancedSource();
      const streetView: StreetViewProvider = {
        ...base.providers.fixtures.streetView,
        async refreshPanorama() {
          return {
            ...answer,
            metadata: { location: null, date: null, copyright: null, ...answer.metadata },
          } as RefreshPanoramaResult;
        },
      };
      const deps = {
        ...base,
        providers: { ...base.providers, fixtures: { ...base.providers.fixtures, streetView } },
      } as PipelineDeps;
      await runStreetViewRevalidation(deps, { sourceAssetIds: [e.source.id] });
      expect((await fresh(e.source)).objectKey).toBeNull();
      expect(await kept(e)).toEqual({ rows: 0, object: false });
    }
  });

  it('project deletion: the picture is deleted and tombstoned, the rows go', async () => {
    const e = await enhancedSource();
    const project = await base.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', e.projectId)
      .executeTakeFirstOrThrow();
    await deleteProject(base, { project, scope: 'project', requestedBy: 'user' });
    expect(await kept(e)).toEqual({ rows: 0, object: false });
    const tombstone = await base.db
      .selectFrom('tombstones')
      .select('kind')
      .where('hashSha256', '=', sha256Hex(e.enhancementKey))
      .executeTakeFirst();
    expect(tombstone?.kind).toBe('object_key');
  });

  it('project deletion under a hold: the held source keeps its enhancement, the other loses it', async () => {
    const heldSource = await enhancedSource();
    const other = await enhancedSource({ projectId: heldSource.projectId });
    const placed = await holdSource(heldSource.source.id);
    const records = await copyHeldObjects(base, placed.holdId);
    // The held source's enhanced picture is protected in place, like its frame.
    expect(records.map((record) => record.originalKeyHash)).toContain(
      sha256Hex(heldSource.enhancementKey),
    );
    expect(
      records.find((r) => r.originalKeyHash === sha256Hex(heldSource.enhancementKey)),
    ).toMatchObject({ inPlace: true, heldKey: null });
    const project = await base.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', heldSource.projectId)
      .executeTakeFirstOrThrow();
    const result = await deleteProject(base, { project, scope: 'project', requestedBy: 'user' });
    expect(result.status).toBe('held');
    expect(await kept(heldSource)).toEqual({ rows: 1, object: true });
    expect(await kept(other)).toEqual({ rows: 0, object: false });
  });
});

/** The place ID of an enhanced source's property. */
async function placeOf(e: Enhanced): Promise<string> {
  const property = await base.db
    .selectFrom('projects')
    .innerJoin('properties', 'properties.id', 'projects.propertyId')
    .select('properties.placeId')
    .where('projects.id', '=', e.projectId)
    .executeTakeFirstOrThrow();
  return property.placeId;
}

/** A hold on the project; the source keeps no hold of its own (it was added after the hold). */
async function holdProjectOnly(e: Enhanced) {
  await base.db.transaction().execute((trx) =>
    placePreservationHold(trx, {
      targetKind: 'project',
      targetId: e.projectId,
      reason: 'complaint_investigation',
      authorityRef: `test:${e.projectId}`,
      releaseCondition: 'test',
      placedBy: null,
    }),
  );
  await base.db
    .updateTable('sourceAssets')
    .set({ preservationHoldId: null })
    .where('id', '=', e.source.id)
    .execute();
}

describe('more paths that delete a stored frame drop its enhancement', () => {
  it('a blocked place (purgeBlockedPlaces)', async () => {
    const e = await enhancedSource();
    await base.db
      .insertInto('blockedAddresses')
      .values({
        id: newId(),
        placeId: await placeOf(e),
        source: 'operator',
        evidenceRef: 'test',
        createdBy: null,
      })
      .execute();
    await purgeBlockedPlaces(base, { limit: 1000 });
    expect((await fresh(e.source)).objectKey).toBeNull();
    expect(await kept(e)).toEqual({ rows: 0, object: false });
  });

  it('the daily revalidation: a policy that no longer allows storage', async () => {
    const e = await enhancedSource();
    const streetView: StreetViewProvider = {
      ...base.providers.fixtures.streetView,
      async refreshPanorama() {
        return {
          status: 'unchanged',
          metadata: {
            status: 'OK',
            panoId: e.source.viewpoint?.panoId ?? null,
            location: null,
            date: null,
            copyright: null,
          },
        } as RefreshPanoramaResult;
      },
    };
    const deps = {
      ...base,
      providers: { ...base.providers, fixtures: { ...base.providers.fixtures, streetView } },
      config: { ...base.config, streetView: { ...base.config.streetView, usePolicy: 'decorate' } },
    } as PipelineDeps;
    const result = await runStreetViewRevalidation(deps, { sourceAssetIds: [e.source.id] });
    expect(result.framesDropped).toBe(1);
    expect((await fresh(e.source)).objectKey).toBeNull();
    expect(await kept(e)).toEqual({ rows: 0, object: false });
  });

  it('project deletion that keeps a shared look (pinned): the enhancement and its picture go', async () => {
    const e = await enhancedSource();
    const job = await createRenderJobRecord(base, {
      ownerId: e.ownerId,
      projectId: e.projectId,
      source: await fresh(e.source),
    });
    const assetId = newId();
    await base.db
      .insertInto('renderAssets')
      .values({
        id: assetId,
        ownerId: e.ownerId,
        projectId: e.projectId,
        jobId: job.id,
        sourceAssetId: e.source.id,
        variantKey: job.variantKey,
        holidayId: job.holidayId,
        style: job.style,
        lightingMode: job.lightingMode,
        holidayPackVersion: job.holidayPackVersion,
        compilerVersion: job.compilerVersion,
        objectKey: keys.output(e.ownerId, assetId, 'full.jpg'),
        width: 1024,
        height: 1024,
        contentType: 'image/jpeg',
        byteLength: 1,
        nativeWidth: 1024,
        nativeHeight: 1024,
        fidelityMode: 'composite_additive',
        provenance: toJson({}),
        distributable: true,
        downloadable: false,
      })
      .execute();
    const token = randomToken(16);
    await base.db
      .insertInto('shareGrants')
      .values({
        id: newId(),
        ownerId: e.ownerId,
        renderAssetId: assetId,
        tokenHash: sha256Hex(token),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        shareCardObjectKey: keys.card(token),
      })
      .execute();
    const project = await base.db
      .selectFrom('projects')
      .selectAll()
      .where('id', '=', e.projectId)
      .executeTakeFirstOrThrow();
    const result = await deleteProject(base, {
      project,
      scope: 'expiry_sweep',
      requestedBy: 'system',
    });
    expect(result.status).toBe('pinned');
    expect(await kept(e)).toEqual({ rows: 0, object: false });
    expect((await fresh(e.source)).state).toBe('deleted');
  });
});

describe('reconciliation of enhanced pictures', () => {
  it('keeps a picture no row names while a hold on its project covers the source', async () => {
    const heldOne = await enhancedSource();
    const free = await enhancedSource();
    await holdProjectOnly(heldOne);
    for (const e of [heldOne, free]) {
      await base.db.deleteFrom('sourceEnhancements').where('id', '=', e.enhancementId).execute();
    }
    // Only this test's objects are scanned, and no job's rows are touched.
    const owners = [heldOne.ownerId, free.ownerId];
    const scoped = {
      ...base,
      storage: {
        ...base.storage,
        async list(bucket: Parameters<PipelineDeps['storage']['list']>[0], prefix: string) {
          const listed = await base.storage.list(bucket, prefix, 100_000);
          return listed.filter((key) => owners.some((owner) => key.includes(owner)));
        },
      },
    } as PipelineDeps;
    // Objects younger than a second may read as written in the future.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await runReconciliation(scoped, { objectGraceMs: 0, jobIds: [] });
    expect(await base.storage.head('private', heldOne.enhancementKey)).not.toBeNull();
    expect(await base.storage.head('private', free.enhancementKey)).toBeNull();
    expect(await base.storage.head('private', heldOne.frameKey)).not.toBeNull();
    expect(await base.storage.head('private', free.frameKey)).not.toBeNull();
  });
});
