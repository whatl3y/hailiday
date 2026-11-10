import { crc32 } from 'node:zlib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivationState, UploadTriage } from '@holiday/core';
import type { Capabilities } from '../../capabilities/index.js';
import { addMs } from '../../clock/index.js';
import type { AppConfig } from '../../config/index.js';
import { toJson } from '../../db/client.js';
import { dailySaltedHash, newId } from '../../ids/index.js';
import { VISION_PRICES_MICROS, usageCostMicros } from '../../ledger/index.js';
import { createAssetPolicy, defaultPolicyTemplate } from '../../policy/index.js';
import { ProviderError } from '../../providers/errors.js';
import type { Providers, VisionModel } from '../../providers/types.js';
import { TRIAGE_PROMPT_VERSION } from '../../providers/vision/prompts.js';
import type { RuntimeSettings } from '../../settings/index.js';
import { keys } from '../../storage/keys.js';
import type { PipelineDeps } from '../context.js';
import { createPipelineTestDeps } from '../testing.js';
import { expireUploadHolds, screenUpload } from './screen.js';
import { sniffFormat } from './sniff.js';
import { validateUpload } from './validate.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/** A textured test photo (gradient plus shapes), so decoding and screening see real pixels. */
async function photo(
  width: number,
  height: number,
  format: 'jpeg' | 'png' = 'jpeg',
  alpha = false,
) {
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7aa6d8"/><stop offset="1" stop-color="#d8c27a"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"${alpha ? ' fill-opacity="0.6"' : ''}/><rect x="${width * 0.2}" y="${height * 0.3}" width="${width * 0.6}" height="${height * 0.5}" fill="#f4f1ea" stroke="#333" stroke-width="6"/><rect x="${width * 0.45}" y="${height * 0.55}" width="${width * 0.1}" height="${height * 0.25}" fill="#8b1e1e"/></svg>`,
  );
  const image = sharp(svg);
  return format === 'png'
    ? image.png().toBuffer()
    : image.flatten({ background: '#fff' }).jpeg({ quality: 92 }).toBuffer();
}

/** A PNG whose header claims a size far beyond the pixel cap (no pixel data needed). */
function pngBombHeader(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01])),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Creates an upload source asset in `quarantined` with its bytes under the quarantine key. */
async function quarantined(bytes: Buffer, fileName: string, contentType = 'image/jpeg') {
  const ownerId = newId();
  await deps.db.insertInto('owners').values({ id: ownerId, kind: 'anonymous' }).execute();
  const projectId = newId();
  await deps.db
    .insertInto('projects')
    .values({
      id: projectId,
      ownerId,
      kind: 'upload',
      holidayId: 'christmas',
      lastActivityAt: new Date(),
    })
    .execute();
  const id = newId();
  const policy = await createAssetPolicy(deps.db, {
    subjectKind: 'source_asset',
    subjectId: id,
    template: defaultPolicyTemplate('upload', { attestationVersion: 'test-1' }),
  });
  await deps.storage.put({
    bucket: 'private',
    key: keys.quarantine(id),
    body: bytes,
    contentType,
    provenance: { sourceKind: 'upload' },
  });
  await deps.db
    .insertInto('sourceAssets')
    .values({
      id,
      ownerId,
      projectId,
      kind: 'upload',
      state: 'quarantined',
      contentType,
      originalByteLength: bytes.length,
      clientPrepared: true,
      peopleResolution: 'none',
      attestationVersion: 'test-1',
      attestedAt: new Date(),
      assetPolicyId: policy.id,
      screening: toJson({ fixture: { fileName } }),
    })
    .execute();
  return { id, ownerId };
}

async function asset(id: string) {
  return deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
}

describe('format sniffing', () => {
  it('decides the format by magic bytes', async () => {
    expect(sniffFormat(await photo(700, 700))).toBe('jpeg');
    expect(sniffFormat(await photo(700, 700, 'png'))).toBe('png');
    expect(sniffFormat(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniffFormat(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(sniffFormat(Buffer.from('  <svg xmlns="x"></svg>'))).toBe('svg');
    const heic = Buffer.alloc(24);
    heic.write('ftypheic', 4, 'ascii');
    expect(sniffFormat(heic)).toBe('heic');
    expect(sniffFormat(Buffer.alloc(0))).toBe('unknown');
  });
});

describe('upload_validate and upload_screen', () => {
  it('admits a JPEG with EXIF orientation: upright, re-encoded, no metadata, promoted', async () => {
    const raw = await sharp(await photo(1400, 1000))
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const { id, ownerId } = await quarantined(raw, 'front-porch.jpg');
    const validated = await validateUpload(deps, { sourceAssetId: id });
    expect(validated.outcome).toBe('promoted');
    const promoted = await asset(id);
    expect(promoted).toMatchObject({
      state: 'screening',
      objectKey: keys.original(ownerId, id),
      contentType: 'image/jpeg',
      originalFormat: 'jpeg',
      originalWidth: 1400,
      originalHeight: 1000,
      orientationApplied: 6,
      width: 1000,
      height: 1400,
    });
    expect(await deps.storage.head('private', keys.quarantine(id))).toBeNull();
    const original = await deps.storage.get('private', promoted.objectKey as string);
    const meta = await sharp(original?.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 1000, height: 1400, space: 'srgb' });
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();

    const screened = await screenUpload(deps, { sourceAssetId: id });
    expect(screened.outcome).toBe('admitted');
    const ready = await asset(id);
    expect(ready).toMatchObject({
      state: 'ready',
      sceneType: 'house_exterior',
      peopleDetected: false,
    });
    expect(ready.readyAt).toBeInstanceOf(Date);
    expect((ready.screening as { fixture?: { fileName?: string } }).fixture?.fileName).toBe(
      'front-porch.jpg',
    );
  });

  it('admits a PNG with alpha (flattened, 8-bit JPEG) and resizes to 2048 on the long edge', async () => {
    const { id } = await quarantined(
      await photo(3000, 2000, 'png', true),
      'living room.png',
      'image/png',
    );
    expect((await validateUpload(deps, { sourceAssetId: id })).outcome).toBe('promoted');
    const promoted = await asset(id);
    expect(promoted).toMatchObject({ originalFormat: 'png', width: 2048, height: 1365 });
    const original = await deps.storage.get('private', promoted.objectKey as string);
    const meta = await sharp(original?.body as Buffer).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', hasAlpha: false, channels: 3 });
    expect((await screenUpload(deps, { sourceAssetId: id })).outcome).toBe('admitted');
    expect(await asset(id)).toMatchObject({
      state: 'ready',
      sceneType: 'interior',
      roomType: 'living_room',
    });
  });

  it('declines an image over the pixel cap at the header pre-check', async () => {
    const { id } = await quarantined(pngBombHeader(20_000, 20_000), 'bomb.png', 'image/png');
    expect(await validateUpload(deps, { sourceAssetId: id })).toMatchObject({
      outcome: 'declined',
      code: 'UPLOAD_TOO_LARGE',
      reason: 'too_many_pixels',
    });
    expect(await asset(id)).toMatchObject({
      state: 'declined',
      declinedCode: 'UPLOAD_TOO_LARGE',
      declinedReasonClass: 'guidance',
      declinedReason: 'too_many_pixels',
    });
    expect(await deps.storage.head('private', keys.quarantine(id))).toBeNull();
  });

  it('declines a file over the byte cap', async () => {
    const big = Buffer.alloc(26_214_401);
    big.set([0xff, 0xd8, 0xff], 0);
    const { id } = await quarantined(big, 'huge.jpg');
    expect(await validateUpload(deps, { sourceAssetId: id })).toMatchObject({
      outcome: 'declined',
      code: 'UPLOAD_TOO_LARGE',
      reason: 'file_too_large',
    });
  });

  it('declines unsupported formats with the detected format', async () => {
    const gif = await sharp(await photo(700, 700))
      .gif()
      .toBuffer();
    const { id } = await quarantined(gif, 'animation.gif', 'image/gif');
    expect(await validateUpload(deps, { sourceAssetId: id })).toMatchObject({
      outcome: 'declined',
      code: 'UPLOAD_UNSUPPORTED_FORMAT',
      reason: 'unsupported_format',
      detectedFormat: 'gif',
    });
    expect(await asset(id)).toMatchObject({
      originalFormat: 'gif',
      declinedReason: 'unsupported_format',
    });

    const heic = Buffer.alloc(64);
    heic.write('ftypheic', 4, 'ascii');
    const second = await quarantined(heic, 'IMG_0001.HEIC', 'image/heic');
    expect(await validateUpload(deps, { sourceAssetId: second.id })).toMatchObject({
      code: 'UPLOAD_UNSUPPORTED_FORMAT',
      detectedFormat: 'heic',
    });
  });

  it('declines images that are too small, empty or unreadable', async () => {
    const small = await quarantined(await photo(800, 600), 'small.jpg');
    expect(await validateUpload(deps, { sourceAssetId: small.id })).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'image_too_small',
    });
    const empty = await quarantined(Buffer.alloc(0), 'empty.jpg');
    expect(await validateUpload(deps, { sourceAssetId: empty.id })).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'unreadable',
    });
    const full = await photo(900, 900);
    const truncated = await quarantined(full.subarray(0, Math.floor(full.length / 3)), 'cut.jpg');
    expect(await validateUpload(deps, { sourceAssetId: truncated.id })).toMatchObject({
      code: 'VALIDATION_FAILED',
      reason: 'unreadable',
    });
  });

  it('applies the file-name screening triggers', async () => {
    const image = await photo(1200, 900);
    const declined = await quarantined(image, 'please-decline-me.jpg');
    await validateUpload(deps, { sourceAssetId: declined.id });
    expect((await screenUpload(deps, { sourceAssetId: declined.id })).outcome).toBe('declined');
    expect(await asset(declined.id)).toMatchObject({
      state: 'declined',
      declinedCode: 'UPLOAD_DECLINED',
      declinedReasonClass: 'guidance',
      declinedReason: 'not_a_living_space',
    });

    const people = await quarantined(image, 'porch_with_people.jpg');
    await validateUpload(deps, { sourceAssetId: people.id });
    expect((await screenUpload(deps, { sourceAssetId: people.id })).outcome).toBe('admitted');
    expect(await asset(people.id)).toMatchObject({
      state: 'ready',
      peopleDetected: true,
      peopleBoxes: [[0.62, 0.38, 0.78, 0.96]],
      suggestedCropBox: [0, 0, 0.58, 1],
      peopleResolution: 'none',
    });

    const held = await quarantined(image, 'hold this one.jpg');
    await validateUpload(deps, { sourceAssetId: held.id });
    expect((await screenUpload(deps, { sourceAssetId: held.id })).outcome).toBe('held');
    const heldRow = await asset(held.id);
    expect(heldRow).toMatchObject({ state: 'screening', holdForReview: true });
    // Reviewers get a reduced-size copy, never the normalized original.
    const reviewKey = (heldRow.screening as { reviewObjectKey?: string }).reviewObjectKey;
    expect(reviewKey).toBe(keys.review(held.id));
    expect(reviewKey).not.toBe(heldRow.objectKey);
    const copy = await deps.storage.get('private', keys.review(held.id));
    const copyMeta = await sharp(copy?.body ?? Buffer.alloc(0)).metadata();
    expect(Math.max(copyMeta.width ?? 0, copyMeta.height ?? 0)).toBe(1024);
    expect(copyMeta.exif).toBeUndefined();
    // A second screening run leaves a held upload alone; the hold window ends it.
    expect((await screenUpload(deps, { sourceAssetId: held.id })).outcome).toBe('skipped');
    const later = { ...deps, clock: { now: () => addMs(new Date(), 11 * 60_000) } };
    expect(await expireUploadHolds(later)).toBeGreaterThanOrEqual(1);
    const timedOut = await asset(held.id);
    expect(timedOut).toMatchObject({
      state: 'declined',
      holdForReview: false,
      declinedReasonClass: 'safety',
      declinedReason: 'hold_timeout',
    });
    expect((timedOut.screening as { reviewObjectKey?: string }).reviewObjectKey).toBeUndefined();
    expect(await deps.storage.head('private', keys.review(held.id))).toBeNull();

    const admitted = await quarantined(image, 'my-house.jpg');
    await validateUpload(deps, { sourceAssetId: admitted.id });
    expect((await screenUpload(deps, { sourceAssetId: admitted.id })).outcome).toBe('admitted');
  });

  it('declines a re-upload whose normalized checksum is blocklisted', async () => {
    const image = await photo(1000, 1000);
    const first = await quarantined(image, 'first.jpg');
    const validated = await validateUpload(deps, { sourceAssetId: first.id });
    if (validated.outcome !== 'promoted') throw new Error('expected promotion');
    await deps.db
      .insertInto('tombstones')
      .values({
        id: newId(),
        kind: 'declined_checksum',
        hashSha256: validated.checksum,
        deletedAt: new Date(),
        retainUntil: addMs(new Date(), 86_400_000),
      })
      .onConflict((oc) => oc.columns(['kind', 'hashSha256']).doNothing())
      .execute();
    const again = await quarantined(image, 'again.jpg');
    expect(await validateUpload(deps, { sourceAssetId: again.id })).toMatchObject({
      outcome: 'declined',
      reason: 'checksum_blocklisted',
    });
    expect(await asset(again.id)).toMatchObject({ declinedReasonClass: 'safety', objectKey: null });
  });

  it('is idempotent: a repeat validation after promotion only re-enqueues screening', async () => {
    const { id } = await quarantined(await photo(900, 900), 'repeat.jpg');
    const first = await validateUpload(deps, { sourceAssetId: id });
    const second = await validateUpload(deps, { sourceAssetId: id });
    expect(second).toEqual(first);
  });
});

/** Upload triage through the vision leg, independent of the content-screening leg. */
describe('upload triage on the vision leg', () => {
  const liveTriage: UploadTriage = {
    subjectClass: 'living_space',
    sceneType: 'house_exterior',
    sceneTypeConfidence: 0.97,
    roomType: null,
    roomTypeConfidence: null,
    buildingForm: 'detached',
    buildingFormConfidence: 0.95,
    multiUnitFacade: false,
    qualityFlags: [],
    existingDecorations: 'none',
    seasonCues: ['leafy'],
    peopleBoxes: [],
  };
  const usage = { inputTokens: 1800, outputTokens: 240, cacheReadInputTokens: 0, calls: 1 };

  /** A live vision model whose triage is recorded and answered (or refused) without a vendor. */
  function liveVision(refuse = false) {
    const calls: string[] = [];
    const vision: VisionModel = {
      ...deps.providers.fixtures.vision,
      providerId: 'anthropic',
      mode: 'live',
      async classifyUpload(input) {
        calls.push(input.fixture?.fileName ?? '');
        if (refuse) {
          throw new ProviderError('anthropic', 'moderation_blocked', 'refused', {
            retryable: false,
          });
        }
        return {
          result: liveTriage,
          usage,
          model: 'claude-opus-5-5',
          promptVersion: TRIAGE_PROMPT_VERSION,
          elapsedMs: 900,
          providerMode: 'live',
        };
      },
    };
    return { vision, calls };
  }

  /** The shared dependencies with a vision capability state, settings and the live model. */
  function withVision(
    vision: VisionModel,
    state: ActivationState,
    values: Record<string, unknown> = {},
  ): PipelineDeps {
    const settings: RuntimeSettings = {
      ...deps.settings,
      get: ((key: string) =>
        key in values
          ? Promise.resolve(values[key])
          : deps.settings.get(
              key as Parameters<RuntimeSettings['get']>[0],
            )) as RuntimeSettings['get'],
      isProviderPaused: async (provider) =>
        values[`pause.provider.${provider}`] === true || deps.settings.isProviderPaused(provider),
    };
    const capabilities: Capabilities = {
      ...deps.capabilities,
      state: async (country, capability) =>
        capability === 'vision_analysis' ? state : deps.capabilities.state(country, capability),
    };
    const providers: Providers = { ...deps.providers, vision };
    const config: AppConfig = {
      ...deps.config,
      providers: { ...deps.config.providers, vision: 'anthropic' },
    };
    return { ...deps, settings, capabilities, providers, config };
  }

  /** What a screening left behind: the row, its ledger lines and its upload analytics event. */
  async function recorded(upload: { id: string; ownerId: string }) {
    const row = await asset(upload.id);
    const ledger = await deps.db
      .selectFrom('usageLedger')
      .selectAll()
      .where('ownerId', '=', upload.ownerId)
      .execute();
    const events = await deps.db
      .selectFrom('analyticsEvents')
      .select(['eventName', 'properties'])
      .where(
        'sessionHash',
        '=',
        dailySaltedHash(deps.config.sessionSecret, `owner:${upload.ownerId}`, new Date()),
      )
      .where('eventName', 'in', ['upload_accepted', 'upload_declined'])
      .execute();
    return {
      row,
      visionCharges: ledger.filter((line) => line.sku === 'vision_call'),
      screenedUpload: ledger.filter((line) => line.sku === 'screened_upload'),
      events,
      screening: row.screening as Record<string, unknown>,
    };
  }

  async function screened(screenDeps: PipelineDeps, fileName: string) {
    const upload = await quarantined(await photo(1200, 900), fileName);
    await validateUpload(deps, { sourceAssetId: upload.id });
    const outcome = await screenUpload(screenDeps, { sourceAssetId: upload.id });
    return { outcome, ...(await recorded(upload)) };
  }

  /** Deps whose screening adapter fails once after its triage step returned (the job retries). */
  function failingAfterTriage(screenDeps: PipelineDeps): PipelineDeps {
    const inner = screenDeps.providers.fixtures.safety;
    let failed = false;
    const safety = {
      ...inner,
      async screenUpload(...args: Parameters<typeof inner.screenUpload>) {
        const result = await inner.screenUpload(...args);
        if (!failed) {
          failed = true;
          throw new Error('people detection failed');
        }
        return result;
      },
    };
    return {
      ...screenDeps,
      providers: {
        ...screenDeps.providers,
        fixtures: { ...screenDeps.providers.fixtures, safety },
      },
    };
  }

  it('calls the live triage once and charges it when vision_analysis is live', async () => {
    const { vision, calls } = liveVision();
    const result = await screened(withVision(vision, 'live_public'), 'IMG_7731.jpg');
    expect(result.outcome.outcome).toBe('admitted');
    expect(calls).toEqual(['IMG_7731.jpg']);
    // The scene comes from the live model, not the fixture's file-name hints.
    expect(result.row).toMatchObject({
      state: 'ready',
      sceneType: 'house_exterior',
      buildingForm: 'detached',
    });
    // A screening that paid for a live triage is live work, although the screener is a fixture.
    expect(result.screening).toMatchObject({
      providerMode: 'live',
      triageMode: 'live',
      triageFallbackReason: null,
      triageModel: 'claude-opus-5-5',
      triagePromptVersion: TRIAGE_PROMPT_VERSION,
      triageUsage: usage,
      triageLedgerEntryId: result.visionCharges[0]?.id,
    });
    expect(result.screening).not.toHaveProperty('liveTriage');
    expect(result.visionCharges).toHaveLength(1);
    const expectedMicros = usageCostMicros('claude-opus-5-5', usage);
    expect(expectedMicros).toBeGreaterThan(0);
    expect(result.visionCharges[0]).toMatchObject({
      kind: 'charge',
      provider: 'anthropic',
      stage: 'screening',
      modelId: 'claude-opus-5-5',
      isFixture: false,
      amountMicros: expectedMicros,
    });
    expect(result.screenedUpload.map((line) => line.isFixture)).toEqual([false]);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.eventName).toBe('upload_accepted');
    expect(result.events[0]?.properties).not.toHaveProperty('fixture');
  });

  it('reuses the recorded live triage when the screening is redelivered: one call, one charge', async () => {
    const { vision, calls } = liveVision();
    const live = withVision(vision, 'live_public');
    const upload = await quarantined(await photo(1200, 900), 'IMG_7741.jpg');
    await validateUpload(deps, { sourceAssetId: upload.id });
    await expect(
      screenUpload(failingAfterTriage(live), { sourceAssetId: upload.id }),
    ).rejects.toThrow('people detection failed');
    const between = await recorded(upload);
    expect(between.row.state).toBe('screening');
    expect(between.visionCharges).toHaveLength(1);
    expect(between.screening.liveTriage).toMatchObject({
      ledgerEntryId: between.visionCharges[0]?.id,
      call: { result: liveTriage, model: 'claude-opus-5-5' },
    });

    const outcome = await screenUpload(live, { sourceAssetId: upload.id });
    expect(outcome.outcome).toBe('admitted');
    expect(calls).toEqual(['IMG_7741.jpg']);
    const after = await recorded(upload);
    expect(after.visionCharges).toHaveLength(1);
    expect(after.row).toMatchObject({ state: 'ready', sceneType: 'house_exterior' });
    expect(after.screening).toMatchObject({
      providerMode: 'live',
      triageMode: 'live',
      triageLedgerEntryId: after.visionCharges[0]?.id,
    });
    expect(after.screening).not.toHaveProperty('liveTriage');
  });

  it('makes no live call while paused and records why the fixture triage ran', async () => {
    for (const [values, reason] of [
      [{ 'pause.provider.anthropic': true }, 'paused_provider'],
      [{ 'pause.global': true }, 'paused_global'],
    ] as const) {
      const { vision, calls } = liveVision();
      const result = await screened(withVision(vision, 'live_public', values), 'IMG_7732.jpg');
      expect(calls).toEqual([]);
      expect(result.outcome.outcome).toBe('admitted');
      expect(result.row).toMatchObject({ state: 'ready', sceneType: null });
      expect(result.screening).toMatchObject({
        triageMode: 'fixture',
        triageFallbackReason: reason,
      });
      expect(result.visionCharges.filter((row) => !row.isFixture)).toEqual([]);
    }
  });

  it('falls back to the fixture triage when the spend ceiling is reached', async () => {
    const { vision, calls } = liveVision();
    const result = await screened(
      withVision(vision, 'live_public', { 'spend.daily_micros': 0 }),
      'IMG_7733.jpg',
    );
    expect(calls).toEqual([]);
    expect(result.screening).toMatchObject({ triageMode: 'fixture' });
    expect(String(result.screening.triageFallbackReason)).toMatch(/^spend_/);
    expect(result.visionCharges.filter((row) => !row.isFixture)).toEqual([]);
  });

  it('uses the fixture triage with no live charge when vision_analysis is fixture', async () => {
    const { vision, calls } = liveVision();
    const result = await screened(withVision(vision, 'fixture'), 'e2e-front-porch.jpg');
    expect(calls).toEqual([]);
    expect(result.row).toMatchObject({ state: 'ready', sceneType: 'house_exterior' });
    expect(result.screening).toMatchObject({
      providerMode: 'fixture',
      triageMode: 'fixture',
      triageFallbackReason: null,
      triagePromptVersion: TRIAGE_PROMPT_VERSION,
    });
    expect(result.screening).not.toHaveProperty('triageLedgerEntryId');
    expect(result.visionCharges.filter((row) => !row.isFixture)).toEqual([]);
    expect(result.screenedUpload.map((line) => line.isFixture)).toEqual([true]);
    expect(result.events.map((event) => event.properties)).toEqual([
      expect.objectContaining({ fixture: true }),
    ]);
  });

  it('runs hash matching and moderation first: a held upload never reaches the triage', async () => {
    const { vision, calls } = liveVision();
    const result = await screened(withVision(vision, 'live_public'), 'hold-this.jpg');
    expect(result.outcome.outcome).toBe('held');
    expect(calls).toEqual([]);
    expect(result.visionCharges).toEqual([]);
  });

  it('holds an upload the live triage refuses to look at and charges the refused call', async () => {
    const { vision, calls } = liveVision(true);
    const result = await screened(withVision(vision, 'live_public'), 'IMG_7734.jpg');
    expect(calls).toHaveLength(1);
    expect(result.outcome.outcome).toBe('held');
    expect(result.row).toMatchObject({ state: 'screening', holdForReview: true });
    // The refusal reports no usage: the triage list price is charged.
    expect(result.visionCharges).toHaveLength(1);
    expect(result.visionCharges[0]).toMatchObject({
      provider: 'anthropic',
      stage: 'screening',
      isFixture: false,
      amountMicros: VISION_PRICES_MICROS.triage,
    });
    expect(result.screening).toMatchObject({
      providerMode: 'live',
      triageLedgerEntryId: result.visionCharges[0]?.id,
    });
  });

  it('reports a timed-out hold as fixture work only when its screening was fixture work', async () => {
    const { vision } = liveVision(true);
    const live = await screened(withVision(vision, 'live_public'), 'IMG_7743.jpg');
    expect(live.outcome.outcome).toBe('held');
    expect(live.screening.providerMode).toBe('live');
    const fixture = await screened(deps, 'hold-for-review.jpg');
    expect(fixture.outcome.outcome).toBe('held');
    expect(fixture.screening.providerMode).toBe('fixture');

    // The sweep runs with the configured screener a fixture; each event follows its own row.
    expect(deps.config.providers.safety).toBe('fixture');
    const at = addMs(new Date(), 11 * 60_000);
    expect(await expireUploadHolds({ ...deps, clock: { now: () => at } })).toBeGreaterThanOrEqual(
      2,
    );
    const declined = async (ownerId: string) =>
      deps.db
        .selectFrom('analyticsEvents')
        .select('properties')
        .where(
          'sessionHash',
          '=',
          dailySaltedHash(deps.config.sessionSecret, `owner:${ownerId}`, at),
        )
        .where('eventName', '=', 'upload_declined')
        .execute();
    expect(await asset(live.row.id)).toMatchObject({ declinedReason: 'hold_timeout' });
    expect(await asset(fixture.row.id)).toMatchObject({ declinedReason: 'hold_timeout' });
    const liveEvents = await declined(live.row.ownerId);
    expect(liveEvents).toHaveLength(1);
    expect(liveEvents[0]?.properties).not.toHaveProperty('fixture');
    expect((await declined(fixture.row.ownerId)).map((event) => event.properties)).toEqual([
      expect.objectContaining({ fixture: true }),
    ]);
  });

  it('charges screened_upload once when a screening fails after the charge and is redelivered', async () => {
    const upload = await quarantined(await photo(1200, 900), 'hold-after-charge.jpg');
    await validateUpload(deps, { sourceAssetId: upload.id });
    // The reviewer copy is written after the charge; its first write fails (the job retries).
    let failed = false;
    const failing: PipelineDeps = {
      ...deps,
      storage: {
        ...deps.storage,
        async put(input) {
          if (!failed && input.key === keys.review(upload.id)) {
            failed = true;
            throw new Error('storage unavailable');
          }
          return deps.storage.put(input);
        },
      },
    };
    await expect(screenUpload(failing, { sourceAssetId: upload.id })).rejects.toThrow(
      'storage unavailable',
    );
    const between = await recorded(upload);
    expect(between.row).toMatchObject({ state: 'screening', holdForReview: false });
    expect(between.screenedUpload).toHaveLength(1);
    expect(between.screening.screenedLedgerEntryId).toBe(between.screenedUpload[0]?.id);

    expect((await screenUpload(deps, { sourceAssetId: upload.id })).outcome).toBe('held');
    const after = await recorded(upload);
    expect(after.row).toMatchObject({ state: 'screening', holdForReview: true });
    expect(after.screenedUpload).toHaveLength(1);
    expect(after.screening.screenedLedgerEntryId).toBe(after.screenedUpload[0]?.id);
  });

  it('charges a refused live triage once when the screening is redelivered', async () => {
    const { vision, calls } = liveVision(true);
    const live = withVision(vision, 'live_public');
    const upload = await quarantined(await photo(1200, 900), 'IMG_7742.jpg');
    await validateUpload(deps, { sourceAssetId: upload.id });
    await expect(
      screenUpload(failingAfterTriage(live), { sourceAssetId: upload.id }),
    ).rejects.toThrow('people detection failed');
    const outcome = await screenUpload(live, { sourceAssetId: upload.id });
    expect(outcome.outcome).toBe('held');
    expect(calls).toHaveLength(1);
    const after = await recorded(upload);
    expect(after.visionCharges).toHaveLength(1);
    expect(after.visionCharges[0]?.amountMicros).toBe(VISION_PRICES_MICROS.triage);
    expect(after.row).toMatchObject({ state: 'screening', holdForReview: true });
  });
});
