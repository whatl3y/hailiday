import type {
  HolidayId,
  LightingMode,
  ProjectKind,
  RenderJobState,
  SourceKind,
  Style,
} from '@holiday/core';
import { newId, randomToken, sha256Hex } from '../ids/index.js';
import { createAssetPolicy, defaultPolicyTemplate, evaluatePermission } from '../policy/index.js';
import { recordPermissionEvaluation } from '../policy/index.js';
import { toJson } from './client.js';
import type { DbOrTx } from './client.js';
import type { Owner, Project, RenderJob, SourceAsset } from './schema.js';

/**
 * Row factories for integration tests: each inserts the smallest valid row (with its required
 * parents) and returns it. Never used by production code paths.
 */
export const factories = {
  async owner(db: DbOrTx, input: { createdAt?: Date } = {}): Promise<Owner> {
    return db
      .insertInto('owners')
      .values({
        id: newId(),
        kind: 'anonymous',
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async session(db: DbOrTx, input: { ownerId: string; now?: Date }) {
    const now = input.now ?? new Date();
    return db
      .insertInto('anonymousSessions')
      .values({
        id: newId(),
        ownerId: input.ownerId,
        tokenHash: sha256Hex(randomToken()),
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async project(
    db: DbOrTx,
    input: {
      ownerId: string;
      kind?: ProjectKind;
      holidayId?: HolidayId;
      createdAt?: Date;
    },
  ): Promise<Project> {
    const kind = input.kind ?? 'upload';
    let propertyId: string | null = null;
    if (kind === 'address') {
      const property = await db
        .insertInto('properties')
        .values({
          id: newId(),
          ownerId: input.ownerId,
          placeId: `fixture-place-${randomToken(6)}`,
          placeIdRefreshedAt: new Date(),
          countryCode: 'US',
          entryMethod: 'autocomplete',
          precision: 'rooftop_equivalent',
          precisionSource: 'geocoding',
          partialMatch: false,
          placeTypes: ['street_address'],
          multiUnit: false,
          geometryAvailable: false,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      propertyId = property.id;
    }
    return db
      .insertInto('projects')
      .values({
        id: newId(),
        ownerId: input.ownerId,
        kind,
        propertyId,
        holidayId: input.holidayId ?? 'christmas',
        lastActivityAt: input.createdAt ?? new Date(),
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async sourceAsset(
    db: DbOrTx,
    input: { ownerId: string; projectId: string; kind?: SourceKind },
  ): Promise<SourceAsset> {
    const kind = input.kind ?? 'fixture';
    const id = newId();
    const policy = await createAssetPolicy(db, {
      subjectKind: 'source_asset',
      subjectId: id,
      template: defaultPolicyTemplate(kind),
    });
    return db
      .insertInto('sourceAssets')
      .values({
        id,
        ownerId: input.ownerId,
        projectId: input.projectId,
        kind,
        state: 'ready',
        peopleResolution: kind === 'upload' ? 'none' : null,
        sceneType: 'house_exterior',
        assetPolicyId: policy.id,
        readyAt: new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  async renderJob(
    db: DbOrTx,
    input: {
      ownerId: string;
      projectId: string;
      sourceAssetId: string;
      state?: RenderJobState;
      style?: Style;
      lightingMode?: LightingMode;
      requestedAt?: Date;
      succeededAt?: Date | null;
      deviceHash?: string | null;
      ipHash?: string | null;
    },
  ): Promise<RenderJob> {
    const source = await db
      .selectFrom('sourceAssets')
      .select(['assetPolicyId', 'kind'])
      .where('id', '=', input.sourceAssetId)
      .executeTakeFirstOrThrow();
    const policy = await db
      .selectFrom('assetPolicies')
      .selectAll()
      .where('id', '=', source.assetPolicyId as string)
      .executeTakeFirstOrThrow();
    const now = input.requestedAt ?? new Date();
    const evaluationId = await recordPermissionEvaluation(db, {
      assetPolicyId: policy.id,
      sourceAssetId: input.sourceAssetId,
      context: 'submission',
      result: evaluatePermission({ policy, capabilityState: 'fixture', appEnv: 'test', now }),
      capabilityState: 'fixture',
      evaluatedAt: now,
    });
    const state = input.state ?? 'queued';
    const terminal = ![
      'queued',
      'preparing',
      'analyzing',
      'planning',
      'rendering',
      'checking',
      'needs_review',
    ].includes(state);
    return db
      .insertInto('renderJobs')
      .values({
        id: newId(),
        ownerId: input.ownerId,
        projectId: input.projectId,
        projectVersion: 0,
        sourceAssetId: input.sourceAssetId,
        holidayId: 'christmas',
        style: input.style ?? 'classic',
        lightingMode: input.lightingMode ?? 'source',
        holidayPackVersion: '1.0.0',
        compilerVersion: 'test-compiler-1',
        inputSnapshot: toJson({ test: true }),
        permissionEvaluationId: evaluationId,
        state,
        failureKind: state === 'failed' ? 'provider_error' : null,
        rejectionReason: state === 'rejected' ? 'qa_critical' : null,
        idempotencyKey: newId(),
        requestHash: sha256Hex(newId()),
        reviewMode: 'sampled_audit',
        requestedAt: now,
        succeededAt: state === 'succeeded' ? (input.succeededAt ?? now) : null,
        terminalAt: terminal ? (input.succeededAt ?? now) : null,
        deviceHash: input.deviceHash ?? null,
        ipHash: input.ipHash ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
};
