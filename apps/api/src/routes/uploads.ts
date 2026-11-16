import { sql } from '@hailiday/server/db';
import { z } from 'zod';
import {
  CompleteUploadResponseSchema,
  CreateUploadRequestSchema,
  CreateUploadResponseSchema,
  DEFAULT_UPLOAD_MAX_PIXELS,
  DetectedFormatSchema,
  EmptyObjectSchema,
  IdParamsSchema,
  QualityHintSchema,
  UPLOAD_ACCEPTED_CONTENT_TYPES,
  UploadGuidanceReasonSchema,
  UploadStatusSchema,
  byteBucket,
  type NormalizedBox,
  type UploadStatus,
} from '@hailiday/core';
import { DAY_MS, addMs } from '@hailiday/server/clock';
import { toJson } from '@hailiday/server/db';
import { AppError, notFound, rateLimited, validationFailed } from '@hailiday/server/errors';
import { newId } from '@hailiday/server/ids';
import { UPLOAD_BYTES_PER_OWNER_24H } from '@hailiday/server/limits';
import { createAssetPolicy, defaultPolicyTemplate } from '@hailiday/server/policy';
import { EnqueueConflictError } from '@hailiday/server/queue';
import { keys } from '@hailiday/server/storage';
import type { ApiDeps } from '../deps.js';
import type { App } from '../http/types.js';
import { enforceEndpointLimit } from '../auth/limits.js';
import { requireSession, type AuthState } from '../auth/session.js';
import { emitEvent } from '../domain/events.js';
import { loadOwnedProject, touchProject } from '../domain/projects.js';
import { capabilityModeFor } from '../domain/sources.js';

/**
 * `POST /v1/uploads` body. `fileName` is accepted only to drive the fixture screening and render
 * triggers; it is stored (in the screening summary) only when content screening runs in fixture
 * mode and is never logged or used in object keys.
 */
export const CreateUploadBodySchema = CreateUploadRequestSchema.extend({
  fileName: z.string().min(1).max(255).optional(),
});

async function loadOwnedUpload(deps: ApiDeps, auth: AuthState, id: string) {
  const asset = await deps.db
    .selectFrom('sourceAssets')
    .selectAll()
    .where('id', '=', id)
    .where('ownerId', '=', auth.ownerId)
    .where('kind', '=', 'upload')
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!asset) throw notFound();
  return asset;
}

/**
 * Upload bytes of an owner in the rolling 24 hours: the verified length where `complete` recorded
 * one, otherwise the declared length.
 */
async function uploadBytesInWindow(deps: ApiDeps, ownerId: string, now: Date): Promise<number> {
  const row = await deps.db
    .selectFrom('sourceAssets')
    .select(sql<number>`coalesce(sum(coalesce(original_byte_length, byte_length)), 0)`.as('bytes'))
    .where('ownerId', '=', ownerId)
    .where('kind', '=', 'upload')
    .where('createdAt', '>', addMs(now, -DAY_MS))
    .executeTakeFirstOrThrow();
  return Number(row.bytes);
}

/** Uploads: a presigned POST into quarantine, completion that enqueues validation, and status. */
export function registerUploadRoutes(app: App, deps: ApiDeps): void {
  app.post(
    '/v1/uploads',
    { schema: { body: CreateUploadBodySchema, response: { 201: CreateUploadResponseSchema } } },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const body = request.body;
      const project = await loadOwnedProject(deps, auth, body.projectId);
      if ((await capabilityModeFor(deps, 'uploads', auth.audience)) === 'unavailable') {
        throw new AppError('PROVIDER_UNAVAILABLE', { provider: 'uploads' });
      }
      const contentType = body.contentType.toLowerCase();
      if (!(UPLOAD_ACCEPTED_CONTENT_TYPES as readonly string[]).includes(contentType)) {
        throw new AppError('UPLOAD_UNSUPPORTED_FORMAT', {
          acceptedTypes: [...UPLOAD_ACCEPTED_CONTENT_TYPES],
          detectedFormat: null,
        });
      }
      const maxBytes = deps.config.storage.uploadMaxBytes;
      if (body.byteLength > maxBytes) {
        throw new AppError('UPLOAD_TOO_LARGE', { maxBytes, maxPixels: DEFAULT_UPLOAD_MAX_PIXELS });
      }
      enforceEndpointLimit(deps, request, reply, 'uploads', { auth });
      const now = deps.clock.now();
      if (
        (await uploadBytesInWindow(deps, auth.ownerId, now)) + body.byteLength >
        UPLOAD_BYTES_PER_OWNER_24H
      ) {
        throw rateLimited('upload_bytes', 3600);
      }

      const screeningMode = await capabilityModeFor(deps, 'content_screening', auth.audience);
      const fixtureHint =
        screeningMode === 'fixture' && body.fileName
          ? { fixture: { fileName: body.fileName } }
          : null;
      const sourceId = newId();
      await deps.db.transaction().execute(async (trx) => {
        const policy = await createAssetPolicy(trx, {
          subjectKind: 'source_asset',
          subjectId: sourceId,
          template: defaultPolicyTemplate('upload', {
            attestationVersion: body.attestation.attestationVersion,
          }),
        });
        await trx
          .insertInto('sourceAssets')
          .values({
            id: sourceId,
            ownerId: auth.ownerId,
            projectId: project.id,
            kind: 'upload',
            state: 'pending_upload',
            contentType,
            byteLength: body.byteLength,
            clientPrepared: body.clientPrepared,
            attestationVersion: body.attestation.attestationVersion,
            attestedAt: now,
            peopleResolution: 'none',
            screening: fixtureHint ? toJson(fixtureHint) : null,
            assetPolicyId: policy.id,
            expiresAt: project.expiresAt,
          })
          .execute();
        await touchProject(deps, trx, project);
      });
      // The policy admits at most the declared length, so the bytes counted above are the most
      // that can arrive.
      const upload = await deps.storage.presignUpload({
        key: keys.quarantine(sourceId),
        contentType,
        maxBytes: body.byteLength,
      });
      await emitEvent(deps, deps.db, {
        name: 'upload_started',
        ownerId: auth.ownerId,
        holidayId: project.holidayId,
        sourceKind: 'upload',
        properties: {
          captureMethod: /mobile|android|iphone|ipad/i.test(String(request.headers['user-agent']))
            ? 'library'
            : 'desktop',
          contentType,
          byteBucket: byteBucket(body.byteLength),
        },
      });
      reply.code(201);
      return {
        sourceAssetId: sourceId,
        state: 'pending_upload' as const,
        upload: {
          method: 'POST' as const,
          url: upload.url,
          fields: upload.fields,
          expiresAt: upload.expiresAt.toISOString(),
          maxBytes: upload.maxBytes,
        },
      };
    },
  );

  app.post(
    '/v1/uploads/:id/complete',
    {
      schema: {
        params: IdParamsSchema,
        body: EmptyObjectSchema.optional(),
        response: { 202: CompleteUploadResponseSchema },
      },
    },
    async (request, reply) => {
      const auth = await requireSession(deps, request, reply);
      const asset = await loadOwnedUpload(deps, auth, request.params.id);
      reply.code(202);
      if (asset.state !== 'pending_upload') {
        return { sourceAssetId: asset.id, state: asset.state };
      }
      const quarantineKey = keys.quarantine(asset.id);
      const head = await deps.storage.head('private', quarantineKey);
      if (!head) throw validationFailed({ reason: 'upload_incomplete' });
      // Bytes beyond the declared length (what the quota counted) or the cap are discarded and
      // refused.
      const declared = asset.byteLength ?? deps.config.storage.uploadMaxBytes;
      if (
        head.contentLength > deps.config.storage.uploadMaxBytes ||
        head.contentLength > declared
      ) {
        await deps.storage.delete('private', quarantineKey);
        throw new AppError('UPLOAD_TOO_LARGE', {
          maxBytes: deps.config.storage.uploadMaxBytes,
          maxPixels: DEFAULT_UPLOAD_MAX_PIXELS,
        });
      }
      // The verified bytes count against the rolling upload quota; until `complete` records them
      // this asset counts at its declared length, which bounds the verified length.
      if (
        (await uploadBytesInWindow(deps, auth.ownerId, deps.clock.now())) >
        UPLOAD_BYTES_PER_OWNER_24H
      ) {
        await deps.storage.delete('private', quarantineKey);
        throw rateLimited('upload_bytes', 3600);
      }
      if (head.contentType && asset.contentType && head.contentType !== asset.contentType) {
        throw new AppError('UPLOAD_UNSUPPORTED_FORMAT', {
          acceptedTypes: [...UPLOAD_ACCEPTED_CONTENT_TYPES],
          detectedFormat: null,
        });
      }
      const updated = await deps.db.transaction().execute(async (trx) => {
        const row = await trx
          .updateTable('sourceAssets')
          .set({ state: 'quarantined', originalByteLength: head.contentLength })
          .where('id', '=', asset.id)
          .where('state', '=', 'pending_upload')
          .returning(['id', 'state'])
          .executeTakeFirst();
        if (!row) return null;
        try {
          await deps.queue.enqueue(trx, 'upload_validate', {
            sourceAssetId: asset.id,
            ownerId: asset.ownerId,
            correlationId: request.id,
          });
        } catch (error) {
          if (!(error instanceof EnqueueConflictError)) throw error;
        }
        return row;
      });
      if (!updated) {
        const current = await loadOwnedUpload(deps, auth, asset.id);
        return { sourceAssetId: current.id, state: current.state };
      }
      return { sourceAssetId: asset.id, state: 'quarantined' as const };
    },
  );

  app.get(
    '/v1/uploads/:id',
    { schema: { params: IdParamsSchema, response: { 200: UploadStatusSchema } } },
    async (request, reply): Promise<UploadStatus> => {
      const auth = await requireSession(deps, request, reply);
      const asset = await loadOwnedUpload(deps, auth, request.params.id);
      const detected = DetectedFormatSchema.safeParse(asset.originalFormat);
      const guidance = asset.qualityHints.flatMap((hint) => {
        const parsed = QualityHintSchema.safeParse(hint);
        return parsed.success ? [parsed.data] : [];
      });
      const reason =
        asset.declinedReasonClass === 'guidance'
          ? UploadGuidanceReasonSchema.safeParse(asset.declinedReason)
          : null;
      return {
        sourceAssetId: asset.id,
        state: asset.state,
        holdForReview: asset.holdForReview,
        sceneType: asset.sceneType,
        sceneTypeConfidence:
          asset.sceneTypeConfidence === null
            ? null
            : Math.max(0, Math.min(1, asset.sceneTypeConfidence)),
        roomType: asset.roomType,
        buildingForm: asset.buildingForm,
        multiUnitFacade: asset.multiUnitFacade ?? false,
        people: {
          detected: asset.peopleDetected,
          boxes: (asset.peopleBoxes ?? []) as NormalizedBox[],
          suggestedCropBox: (asset.suggestedCropBox as NormalizedBox | null) ?? null,
        },
        guidance,
        detectedFormat: detected.success ? detected.data : null,
        attestationVersion: asset.attestationVersion,
        declineCode: asset.state === 'declined' ? asset.declinedCode : null,
        declineReasonClass: asset.state === 'declined' ? asset.declinedReasonClass : null,
        declineReason: reason?.success ? reason.data : null,
        width: asset.width,
        height: asset.height,
      };
    },
  );
}
