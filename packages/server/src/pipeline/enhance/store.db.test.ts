import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { factories } from '../../db/factories.js';
import type { SourceAsset, SourceEnhancement } from '../../db/schema.js';
import { newId, sha256Hex } from '../../ids/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { encodePng, type Raster } from '../imaging/raster.js';
import type { WorkingImage } from '../imaging/working.js';
import { createPipelineTestDeps, createStreetViewSource } from '../testing.js';
import {
  dropSourceEnhancements,
  enhancementDecided,
  enhancementObjectKeys,
  enhancementReservationExpected,
  findEnhancement,
  loadEnhancedWorking,
} from './store.js';

let base: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  base = await createPipelineTestDeps();
});

afterAll(async () => {
  await base.close();
});

const PLACE = 'ChIJfxLanternHillColonial01';
const VERSION = '2026.11.7-fixture';
const FRAME = 'f'.repeat(64);

/** A `persist` Street View source whose frame is stored with the checksum `FRAME`. */
async function storedSource(): Promise<SourceAsset> {
  const { source } = await createStreetViewSource(base, {
    placeId: PLACE,
    streetViewMode: 'persist',
  });
  return base.db
    .updateTable('sourceAssets')
    .set({ objectKey: keys.original(source.ownerId, source.id), checksumSha256: FRAME })
    .where('id', '=', source.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

async function insertRow(
  source: Pick<SourceAsset, 'id'>,
  values: Partial<{
    status: SourceEnhancement['status'];
    retryable: boolean;
    editCount: number;
    compilerVersion: string;
    frameChecksumSha256: string;
    objectKey: string | null;
    enhancedChecksumSha256: string | null;
    width: number;
  }> = {},
): Promise<SourceEnhancement> {
  return base.db
    .insertInto('sourceEnhancements')
    .values({
      id: newId(),
      sourceAssetId: source.id,
      frameChecksumSha256: values.frameChecksumSha256 ?? FRAME,
      compilerVersion: values.compilerVersion ?? VERSION,
      workingWidth: values.width ?? 32,
      workingHeight: values.width ?? 32,
      status: values.status ?? 'pending',
      retryable: values.retryable ?? false,
      editCount: values.editCount ?? 0,
      objectKey: values.objectKey ?? null,
      enhancedChecksumSha256: values.enhancedChecksumSha256 ?? null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

function raster(width: number, value: number): Raster {
  const data = Buffer.alloc(width * width * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = (value + i * 7) % 256;
  return { data, width, height: width };
}

async function workingOf(image: Raster): Promise<WorkingImage> {
  const png = await encodePng(image);
  return {
    raster: image,
    png,
    checksum: sha256Hex(png),
    width: image.width,
    height: image.height,
    nativeWidth: image.width,
    nativeHeight: image.height,
    resampler: 'lanczos3',
    scaleFactor: 1,
    cropBox: null,
    contentBox: null,
    padRegions: [[0, 0, 1, 0.1]],
  };
}

async function putObject(key: string, body: Uint8Array) {
  await base.storage.put({
    bucket: 'private',
    key,
    body,
    contentType: 'image/png',
    provenance: { sourceKind: 'system' },
  });
}

describe('the decided rule', () => {
  it('decides accepted and rejected rows, and failed rows that are final or out of edits', () => {
    const decided = (status: SourceEnhancement['status'], retryable: boolean, editCount: number) =>
      enhancementDecided({ status, retryable, editCount });
    expect(decided('accepted', false, 1)).toBe(true);
    expect(decided('rejected', false, 0)).toBe(true);
    expect(decided('pending', false, 1)).toBe(false);
    expect(decided('failed', true, 0)).toBe(false);
    expect(decided('failed', true, 1)).toBe(false);
    expect(decided('failed', true, 2)).toBe(true);
    expect(decided('failed', false, 0)).toBe(true);
    // A stored output that has no judge answer yet keeps a row with no edits left open.
    const awaiting = { status: 'failed' as const, retryable: true, editCount: 2 };
    expect(enhancementDecided({ ...awaiting, rawObjectKey: 'raw.jpg', judge: null })).toBe(false);
    expect(enhancementDecided({ ...awaiting, rawObjectKey: 'raw.jpg', judge: {} })).toBe(true);
    expect(enhancementDecided({ ...awaiting, rawObjectKey: null, judge: null })).toBe(true);
    expect(
      enhancementDecided({ ...awaiting, retryable: false, rawObjectKey: 'raw.jpg', judge: null }),
    ).toBe(true);
  });
});

describe('the enhancement reservation at admission', () => {
  const expected = (
    source: Pick<SourceAsset, 'id' | 'kind' | 'objectKey' | 'checksumSha256' | 'streetViewMode'>,
    options: { enabled?: boolean; streetViewFetch?: boolean; compilerVersion?: string } = {},
  ) =>
    enhancementReservationExpected(base.db, {
      enabled: options.enabled ?? true,
      source,
      streetViewFetch: options.streetViewFetch ?? false,
      compilerVersion: options.compilerVersion ?? VERSION,
    });

  it('reserves for a stored frame without a decided row of this release', async () => {
    const source = await storedSource();
    expect(await expected(source)).toBe(true);
    expect(await expected(source, { enabled: false })).toBe(false);
    // A row of another release does not count.
    await insertRow(source, { status: 'rejected', compilerVersion: '2026.11.6-fixture' });
    expect(await expected(source)).toBe(true);
    // A pending or an undecided failed row of this release may still edit.
    const row = await insertRow(source, { status: 'pending' });
    expect(await expected(source)).toBe(true);
    await base.db
      .updateTable('sourceEnhancements')
      .set({ status: 'failed', retryable: true, editCount: 1 })
      .where('id', '=', row.id)
      .execute();
    expect(await expected(source)).toBe(true);
    // A decided row: nothing to reserve, unless the frame may be fetched again.
    await base.db
      .updateTable('sourceEnhancements')
      .set({ editCount: 2 })
      .where('id', '=', row.id)
      .execute();
    expect(await expected(source)).toBe(false);
    expect(await expected(source, { streetViewFetch: true })).toBe(true);
    // A row of another frame does not count.
    expect(await expected({ ...source, checksumSha256: 'e'.repeat(64) })).toBe(true);
  });

  it('reserves before the first frame is stored, and never for transient, upload or fixture sources', async () => {
    const { source } = await createStreetViewSource(base, {
      placeId: PLACE,
      streetViewMode: 'persist',
    });
    expect(source.objectKey).toBeNull();
    expect(await expected(source, { streetViewFetch: true })).toBe(true);
    expect(await expected(source, { streetViewFetch: true, enabled: false })).toBe(false);
    const transient = await createStreetViewSource(base, {
      placeId: PLACE,
      streetViewMode: 'transient',
    });
    expect(await expected(transient.source, { streetViewFetch: true })).toBe(false);
    const owner = await factories.owner(base.db);
    const project = await factories.project(base.db, { ownerId: owner.id });
    for (const kind of ['upload', 'fixture'] as const) {
      const other = await factories.sourceAsset(base.db, {
        ownerId: owner.id,
        projectId: project.id,
        kind,
      });
      expect(await expected({ ...other, streetViewMode: 'persist' }), kind).toBe(false);
    }
  });
});

describe('finding and loading an enhancement', () => {
  it('finds the row of a source, frame and release', async () => {
    const source = await storedSource();
    expect(
      await findEnhancement(base.db, {
        sourceAssetId: source.id,
        frameChecksum: FRAME,
        compilerVersion: VERSION,
      }),
    ).toBeNull();
    const row = await insertRow(source);
    expect(
      (
        await findEnhancement(base.db, {
          sourceAssetId: source.id,
          frameChecksum: FRAME,
          compilerVersion: VERSION,
        })
      )?.id,
    ).toBe(row.id);
    expect(
      await findEnhancement(base.db, {
        sourceAssetId: source.id,
        frameChecksum: FRAME,
        compilerVersion: '2026.11.8-fixture',
      }),
    ).toBeNull();
  });

  it('loads the stored picture only when its bytes and size match the row', async () => {
    const source = await storedSource();
    const frame = await workingOf(raster(32, 10));
    const enhanced = raster(32, 90);
    const png = await encodePng(enhanced);
    const id = newId();
    const objectKey = keys.enhanced(source.ownerId, source.id, id);
    await putObject(objectKey, png);
    const row = await insertRow(source, {
      status: 'accepted',
      objectKey,
      enhancedChecksumSha256: sha256Hex(png),
    });
    const loaded = await loadEnhancedWorking(base, { row, frame });
    expect(loaded).not.toBeNull();
    expect(loaded?.checksum).toBe(sha256Hex(png));
    expect(Buffer.from(loaded?.png ?? []).equals(png)).toBe(true);
    expect(loaded?.raster.data.equals(enhanced.data)).toBe(true);
    // The frame's grid facts carry over.
    expect(loaded?.padRegions).toEqual(frame.padRegions);
    expect(loaded?.nativeWidth).toBe(frame.nativeWidth);
    // Other bytes, another size, a missing object or no key: nothing.
    expect(
      await loadEnhancedWorking(base, {
        row: { ...row, enhancedChecksumSha256: 'd'.repeat(64) },
        frame,
      }),
    ).toBeNull();
    expect(
      await loadEnhancedWorking(base, { row, frame: await workingOf(raster(16, 10)) }),
    ).toBeNull();
    expect(
      await loadEnhancedWorking(base, {
        row: { ...row, objectKey: keys.enhanced(source.ownerId, source.id, newId()) },
        frame,
      }),
    ).toBeNull();
    expect(await loadEnhancedWorking(base, { row: { ...row, objectKey: null }, frame })).toBeNull();
  });
});

describe('dropping the enhancements of a source', () => {
  async function sourceWithPictures(count: number) {
    const source = await storedSource();
    const rows: SourceEnhancement[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = newId();
      const objectKey = keys.enhanced(source.ownerId, source.id, id);
      await putObject(objectKey, new Uint8Array([index, 1, 2, 3]));
      rows.push(
        await insertRow(source, {
          status: 'accepted',
          compilerVersion: `2026.11.${7 + index}-fixture`,
          objectKey,
          enhancedChecksumSha256: 'c'.repeat(64),
        }),
      );
    }
    return { source, rows };
  }

  const rowsOf = (sourceId: string) =>
    base.db
      .selectFrom('sourceEnhancements')
      .select('id')
      .where('sourceAssetId', '=', sourceId)
      .execute();

  it('removes the rows and the stored pictures', async () => {
    const { source, rows } = await sourceWithPictures(2);
    expect(await enhancementObjectKeys(base.db, [source.id])).toEqual(
      rows.map((row) => row.objectKey).sort(),
    );
    expect(await dropSourceEnhancements(base, source)).toBe(2);
    expect(await rowsOf(source.id)).toEqual([]);
    for (const row of rows) {
      expect(await base.storage.head('private', row.objectKey as string)).toBeNull();
    }
    expect(await enhancementObjectKeys(base.db, [source.id])).toEqual([]);
    expect(await enhancementObjectKeys(base.db, [])).toEqual([]);
  });

  it('keeps the rows and pictures of a held source', async () => {
    const { source, rows } = await sourceWithPictures(1);
    expect(
      await dropSourceEnhancements(base, source, {
        held: { sources: new Map([[source.id, newId()]]) },
      }),
    ).toBe(0);
    expect(await dropSourceEnhancements(base, { ...source, preservationHoldId: newId() })).toBe(0);
    expect(await rowsOf(source.id)).toHaveLength(1);
    expect(await base.storage.head('private', rows[0]?.objectKey as string)).not.toBeNull();
  });

  it('keeps the excepted row and its picture', async () => {
    const { source, rows } = await sourceWithPictures(3);
    const [kept, ...dropped] = rows as [SourceEnhancement, ...SourceEnhancement[]];
    expect(await dropSourceEnhancements(base, source, { exceptId: kept.id })).toBe(2);
    expect((await rowsOf(source.id)).map((row) => row.id)).toEqual([kept.id]);
    expect(await base.storage.head('private', kept.objectKey as string)).not.toBeNull();
    for (const row of dropped) {
      expect(await base.storage.head('private', row.objectKey as string)).toBeNull();
    }
  });
});
