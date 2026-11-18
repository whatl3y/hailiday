import type {
  HolidayId,
  LightingMode,
  LinkMode,
  MerchantProgramStatus,
  ProductRelationship,
  ProgramKind,
  ProgramPlacement,
  ProgramRights,
  ProjectKind,
  RenderJobState,
  SceneType,
  ShopGroupBasis,
  ShopLinkKind,
  SourceKind,
  Style,
} from '@hailiday/core';
import { DEFAULT_STREET_VIEW_CONTRIBUTOR_IMAGERY } from '../config/index.js';
import { newId, randomToken, sha256Hex } from '../ids/index.js';
import { createAssetPolicy, defaultPolicyTemplate, evaluatePermission } from '../policy/index.js';
import { recordPermissionEvaluation } from '../policy/index.js';
import { toJson } from './client.js';
import type { DbOrTx } from './client.js';
import type {
  AffiliateClick,
  KitItemSearchPhrase,
  LookItem,
  MerchantProgram,
  Owner,
  Project,
  RenderJob,
  RenderShopTarget,
  SourceAsset,
} from './schema.js';

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
      result: evaluatePermission({
        policy,
        capabilityState: 'fixture',
        appEnv: 'test',
        contributorImagery: DEFAULT_STREET_VIEW_CONTRIBUTOR_IMAGERY,
        now,
      }),
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

  /** A merchant program: by default a planned fixture program with plain links only. */
  async merchantProgram(
    db: DbOrTx,
    input: {
      programKey?: string;
      displayName?: string;
      kind?: ProgramKind;
      placement?: ProgramPlacement;
      programType?: string;
      status?: MerchantProgramStatus;
      searchUrlTemplate?: string | null;
      trackingLinkTemplate?: string | null;
      displayRights?: ProgramRights;
      refreshTermHours?: number | null;
      subIdCapability?: boolean;
      trackingIds?: { holidayId: string; channel: string; trackingId: string }[];
    } = {},
  ): Promise<MerchantProgram> {
    const programKey = input.programKey ?? `test_program_${sha256Hex(newId()).slice(0, 12)}`;
    return db
      .insertInto('merchantPrograms')
      .values({
        id: newId(),
        programKey,
        displayName: input.displayName ?? programKey,
        programType: input.programType ?? 'network',
        network: 'test',
        status: input.status ?? 'planned',
        linkMethod: 'manual_links',
        apiAccess: 'none',
        kind: input.kind ?? 'fixture',
        placement: input.placement ?? 'group',
        searchUrlTemplate:
          input.searchUrlTemplate === undefined
            ? `https://example.com/${programKey}/search?q={query}`
            : input.searchUrlTemplate,
        trackingLinkTemplate: input.trackingLinkTemplate ?? null,
        displayRights: toJson(input.displayRights ?? {}),
        refreshTermHours: input.refreshTermHours ?? null,
        subIdCapability: input.subIdCapability ?? false,
        trackingIds: toJson(input.trackingIds ?? []),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  /** The search phrase of a kit item key. */
  async kitItemSearchPhrase(
    db: DbOrTx,
    input: { kitItemKey: string; phrase?: string; programOverrides?: Record<string, string> },
  ): Promise<KitItemSearchPhrase> {
    return db
      .insertInto('kitItemSearchPhrases')
      .values({
        id: newId(),
        kitItemKey: input.kitItemKey,
        phrase: input.phrase ?? 'outdoor holiday decoration',
        programOverrides: toJson(input.programOverrides ?? {}),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  /** A look item of a look; by default an active one of the abundant Christmas house exterior. */
  async lookItem(
    db: DbOrTx,
    input: {
      lookItemKey?: string;
      holidayId?: HolidayId;
      sceneType?: SceneType;
      style?: Style;
      ourTitle?: string;
      anchorCategory?: string | null;
      searchPhrase?: string;
      programOverrides?: Record<string, string>;
      sortOrder?: number;
      status?: LookItem['status'];
    } = {},
  ): Promise<LookItem> {
    const holidayId = input.holidayId ?? 'christmas';
    const sceneType = input.sceneType ?? 'house_exterior';
    const style = input.style ?? 'abundant';
    return db
      .insertInto('lookItems')
      .values({
        id: newId(),
        lookItemKey:
          input.lookItemKey ??
          `${holidayId}.${sceneType}.${style}.test_${sha256Hex(newId()).slice(0, 12)}`,
        holidayId,
        sceneType,
        style,
        ourTitle: input.ourTitle ?? 'Warm white net lights for shrubs',
        anchorCategory: input.anchorCategory ?? null,
        searchPhrase: input.searchPhrase ?? 'warm white net lights outdoor',
        programOverrides: toJson(input.programOverrides ?? {}),
        sortOrder: input.sortOrder ?? 1,
        status: input.status ?? 'active',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  /** A shop target of a rendering: by default a plain search link of a placed group. */
  async renderShopTarget(
    db: DbOrTx,
    input: {
      renderAssetId: string;
      merchantProgramId: string;
      programKey?: string;
      linkKind?: ShopLinkKind;
      groupBasis?: ShopGroupBasis;
      groupKey?: string;
      offerId?: string | null;
      renderProductLinkId?: string | null;
      lookItemId?: string | null;
      linkMode?: LinkMode;
      placement?: ProgramPlacement;
      relationship?: ProductRelationship | null;
      groupPosition?: number;
      optionPosition?: number;
      sponsored?: boolean;
      lastShownAt?: Date;
    },
  ): Promise<RenderShopTarget> {
    const linkKind = input.linkKind ?? 'search';
    const groupKey = input.groupKey ?? 'christmas.house_exterior.wreath_evergreen';
    const target =
      linkKind === 'product'
        ? `product:${input.offerId ?? newId()}`
        : `search:${input.programKey ?? input.merchantProgramId}`;
    return db
      .insertInto('renderShopTargets')
      .values({
        id: newId(),
        renderAssetId: input.renderAssetId,
        targetKey: `${groupKey}|${target}`,
        linkKind,
        groupBasis: input.groupBasis ?? 'placed',
        groupKey,
        renderProductLinkId: input.renderProductLinkId ?? null,
        lookItemId: input.lookItemId ?? null,
        offerId: input.offerId ?? null,
        merchantProgramId: input.merchantProgramId,
        linkMode: input.linkMode ?? 'plain',
        placement: input.placement ?? 'group',
        relationship: input.relationship ?? (linkKind === 'product' ? 'similar' : null),
        groupPosition: input.groupPosition ?? 1,
        optionPosition: input.optionPosition ?? 1,
        sponsored: input.sponsored ?? false,
        lastShownAt: input.lastShownAt ?? new Date(),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },

  /**
   * A recorded click: by default a plain click on a search link of a placed group (no offer, no
   * relationship) of a Christmas house exterior from an upload.
   */
  async affiliateClick(
    db: DbOrTx,
    input: {
      merchantProgramId: string;
      shopTargetId?: string | null;
      renderProductLinkId?: string | null;
      linkKind?: ShopLinkKind;
      groupBasis?: ShopGroupBasis;
      groupKey?: string | null;
      groupPosition?: number | null;
      optionPosition?: number | null;
      offerId?: string | null;
      relationship?: ProductRelationship | null;
      linkMode?: LinkMode;
      sentSubId?: string | null;
      trackingId?: string | null;
      rankPosition?: number;
      holidayId?: HolidayId;
      occurrenceKey?: string;
      sceneType?: SceneType;
      sourceKind?: SourceKind;
      sessionHash?: string;
    },
  ): Promise<AffiliateClick> {
    const linkKind = input.linkKind ?? 'search';
    const groupPosition = input.groupPosition === undefined ? 1 : input.groupPosition;
    return db
      .insertInto('affiliateClicks')
      .values({
        id: newId(),
        clickToken: sha256Hex(newId()),
        shopTargetId: input.shopTargetId ?? null,
        renderProductLinkId: input.renderProductLinkId ?? null,
        linkKind,
        groupBasis: input.groupBasis ?? 'placed',
        groupKey:
          input.groupKey === undefined
            ? 'christmas.house_exterior.wreath_evergreen'
            : input.groupKey,
        groupPosition,
        optionPosition: input.optionPosition === undefined ? 1 : input.optionPosition,
        offerId: input.offerId ?? null,
        relationship: input.relationship ?? (linkKind === 'product' ? 'similar' : null),
        merchantProgramId: input.merchantProgramId,
        linkMode: input.linkMode ?? 'plain',
        sentSubId: input.sentSubId ?? null,
        trackingId: input.trackingId ?? null,
        rankPosition: input.rankPosition ?? groupPosition ?? 1,
        holidayId: input.holidayId ?? 'christmas',
        occurrenceKey: input.occurrenceKey ?? 'christmas.US.2026',
        sceneType: input.sceneType ?? 'house_exterior',
        sourceKind: input.sourceKind ?? 'upload',
        sessionHash: input.sessionHash ?? sha256Hex(newId()),
        countryCode: 'US',
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  },
};
