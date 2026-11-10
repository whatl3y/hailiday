import { describe, expect, it } from 'vitest';
import {
  AllowanceSchema,
  AnalyticsBatchSchema,
  CommerceCatalogSchema,
  CreateRenderRequestSchema,
  CreateRenderResponseSchema,
  CreateReportRequestSchema,
  DecorationPlanSchema,
  DiscoverySchema,
  ExperienceSchema,
  GeocodeRequestSchema,
  HolidayPackSchema,
  JudgeResultSchema,
  MagicLinkRequestSchema,
  VerifyMagicLinkRequestSchema,
  VerifyMagicLinkResponseSchema,
  isVerifyConfirmationRequired,
  maskEmail,
  NormalizedBoxSchema,
  OfferContentSchema,
  PaginationQuerySchema,
  ProductsPanelSchema,
  ProjectSchema,
  PutCapabilityRequestSchema,
  PutSourceRequestSchema,
  RenderStatusSchema,
  ResolveAddressRequestSchema,
  SceneAnalysisSchema,
  StyleKitSchema,
  UploadStatusSchema,
  VariantSchema,
  variantPlacements,
  boxArea,
  boxContains,
  boxIoU,
  boxThirds,
  clampBox,
  effectiveSectionAnchors,
  fromYxBox,
  intersectBoxes,
  isContentCellOffered,
  isNudgeWithinBounds,
  kitInPriorityOrder,
  overlapFraction,
  packOfferFor,
  regionOverlapFraction,
  runtimeSettingSchemaFor,
  styleKitFromSection,
  toPixelBox,
  validateClientAnalyticsEvent,
} from './index.js';

const ID = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5e';
const ID2 = '0192f3b2-7c1e-7a6b-9c1d-2f6a1b3c4d5f';
const NOW = '2026-11-09T14:03:00.000Z';

const allowance = {
  variants: { limit: 3, remaining: 2, resetsAt: '2026-11-10T14:03:00.000Z' },
  addresses: { limit: 3, remaining: 2, resetsAt: null },
  gate: 'none',
};

const project = {
  id: ID,
  kind: 'address',
  projectVersion: 1,
  holidayId: 'christmas',
  style: 'classic',
  lightingMode: 'source',
  sceneType: 'house_exterior',
  buildingForm: 'detached',
  roomType: null,
  property: {
    id: ID2,
    formattedAddress: null,
    precision: 'rooftop_equivalent',
    multiUnit: false,
    countryCode: 'US',
  },
  activeSource: {
    sourceAssetId: ID2,
    kind: 'street_view',
    state: 'ready',
    sourceMode: 'transient',
    displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=x&signature=y',
    captureDate: '2024-06',
    copyright: '© 2024 Google',
    isGoogleImagery: true,
    width: 640,
    height: 640,
    peopleDetected: false,
    privateOnly: false,
  },
  discovery: {
    matchClass: 'auto_start',
    reason: null,
    sourceMode: 'transient',
    candidateCount: 3,
    remainingDisplayLoads: 5,
  },
  offered: { styles: ['subtle', 'classic', 'abundant'], lightingModes: ['source', 'evening'] },
  activeRenderJobId: null,
  variantCount: 2,
  saved: false,
  expiresAt: '2026-11-10T14:03:00.000Z',
  lastActivityAt: NOW,
  allowance,
};

const variant = {
  renderAssetId: ID,
  renderJobId: ID2,
  sourceAssetId: ID2,
  holidayId: 'christmas',
  style: 'classic',
  lightingMode: 'source',
  holidayPackVersion: '1.2.0',
  compilerVersion: '3',
  imageUrl: 'https://cdn.example/signed',
  beforeImageUrl: 'https://cdn.example/before',
  width: 1024,
  height: 1024,
  labelKey: 'result.aiPreview',
  attribution: { required: true, text: '© 2024 Google', logo: 'google_maps' },
  distributable: true,
  downloadable: true,
  downloadUrl: 'https://cdn.example/download',
  privateOnly: false,
  existingDecorConflict: false,
  placements: ['eaves', 'front_door', 'porch_rail'],
  sourceState: 'ready',
  createdAt: '2026-11-09T14:04:10.000Z',
  expiresAt: '2026-11-10T14:04:10.000Z',
};

const renderStatus = {
  renderJobId: ID,
  projectId: ID2,
  projectVersion: 1,
  state: 'rendering',
  stageLabelKey: 'stage.rendering',
  seq: 4,
  attempt: 1,
  repairUsed: false,
  queuePosition: null,
  holidayId: 'christmas',
  style: 'classic',
  lightingMode: 'source',
  failureKind: null,
  failureDetail: null,
  rejectionReason: null,
  failureCodes: [],
  errorCode: null,
  permittedActions: ['cancel'],
  variant: null,
  supersededByRenderJobId: null,
  timestamps: {
    requestedAt: NOW,
    sourceReadyAt: NOW,
    startedAt: NOW,
    renderStartedAt: NOW,
    renderCompletedAt: null,
    qaPassedAt: null,
    reviewCompletedAt: null,
    succeededAt: null,
    terminalAt: null,
  },
  allowance,
};

describe('shared objects', () => {
  it('parses the spec Allowance, Project, Variant and RenderStatus examples', () => {
    expect(AllowanceSchema.parse(allowance)).toEqual(allowance);
    expect(ProjectSchema.parse(project)).toEqual(project);
    expect(VariantSchema.parse(variant)).toEqual(variant);
    expect(RenderStatusSchema.parse(renderStatus)).toEqual(renderStatus);
    expect(
      RenderStatusSchema.parse({
        ...renderStatus,
        state: 'succeeded',
        stageLabelKey: null,
        variant,
      }).variant?.renderAssetId,
    ).toBe(ID);
  });

  it('requires the source a variant was rendered from', () => {
    const { sourceAssetId: _sourceAssetId, ...withoutSource } = variant;
    expect(VariantSchema.safeParse(withoutSource).success).toBe(false);
    expect(VariantSchema.safeParse({ ...variant, sourceAssetId: 'sa_1' }).success).toBe(false);
    expect(VariantSchema.parse(variant).sourceAssetId).toBe(ID2);
  });

  it("requires the accepted plan's anchor categories, each once", () => {
    const { placements: _placements, ...withoutPlacements } = variant;
    expect(VariantSchema.safeParse(withoutPlacements).success).toBe(false);
    expect(VariantSchema.safeParse({ ...variant, placements: [] }).success).toBe(true);
    expect(VariantSchema.safeParse({ ...variant, placements: ['eaves', 'eaves'] }).success).toBe(
      false,
    );
    expect(VariantSchema.safeParse({ ...variant, placements: ['chimney'] }).success).toBe(false);
    expect(
      variantPlacements([
        { anchorCategory: 'porch_rail' },
        { anchorCategory: 'front_door' },
        { anchorCategory: 'porch_rail' },
        { anchorCategory: 'eaves' },
      ]),
    ).toEqual(['porch_rail', 'front_door', 'eaves']);
  });

  it('rejects unknown fields and bad enum values', () => {
    expect(ProjectSchema.safeParse({ ...project, address: '1 Main St' }).success).toBe(false);
    expect(AllowanceSchema.safeParse({ ...allowance, gate: 'quota_exceeded' }).success).toBe(false);
    expect(RenderStatusSchema.safeParse({ ...renderStatus, state: 'cancelled' }).success).toBe(
      false,
    );
    expect(
      RenderStatusSchema.safeParse({ ...renderStatus, timestamps: { requestedAt: '2026-11-09' } })
        .success,
    ).toBe(false);
  });

  it('discriminates cached and queued render responses', () => {
    const cached = CreateRenderResponseSchema.parse({ cached: true, variant, allowance });
    expect(cached.cached).toBe(true);
    const queued = CreateRenderResponseSchema.parse({
      ...renderStatus,
      state: 'queued',
      stageLabelKey: 'stage.preparing',
      cached: false,
      supersededRenderJobId: null,
    });
    expect(queued.cached).toBe(false);
  });
});

describe('magic-link verification responses', () => {
  const signedIn = {
    user: { id: ID, email: 'person@example.com', roles: ['user'] },
    claimedProjects: 2,
    returnTo: '/p/1',
  };

  it('accepts the signed-in shape and the confirmation shape, and nothing in between', () => {
    const done = VerifyMagicLinkResponseSchema.parse(signedIn);
    expect(isVerifyConfirmationRequired(done)).toBe(false);
    const confirm = VerifyMagicLinkResponseSchema.parse({
      confirmationRequired: true,
      emailHint: 't•••@example.com',
    });
    expect(isVerifyConfirmationRequired(confirm)).toBe(true);
    expect(
      VerifyMagicLinkResponseSchema.safeParse({ confirmationRequired: false, emailHint: 'x' })
        .success,
    ).toBe(false);
    expect(
      VerifyMagicLinkResponseSchema.safeParse({ ...signedIn, confirmationRequired: true }).success,
    ).toBe(false);
    expect(VerifyMagicLinkResponseSchema.safeParse({ confirmationRequired: true }).success).toBe(
      false,
    );
  });

  it('masks all but the first character of the local part', () => {
    expect(maskEmail('taylor@example.com')).toBe('t•••@example.com');
    expect(maskEmail('a@b.co')).toBe('a•••@b.co');
    expect(maskEmail('not-an-email')).toBe('•••');
  });
});

describe('request bodies', () => {
  it('validates render requests and rejects client-sent content versions', () => {
    const body = {
      projectId: ID,
      projectVersion: 1,
      holidayId: 'christmas',
      style: 'classic',
      lightingMode: 'source',
    };
    expect(CreateRenderRequestSchema.parse(body)).toEqual(body);
    expect(
      CreateRenderRequestSchema.safeParse({ ...body, holidayPackVersion: '1.0.0' }).success,
    ).toBe(false);
    expect(CreateRenderRequestSchema.safeParse({ ...body, lightingMode: 'dusk' }).success).toBe(
      false,
    );
  });

  it('accepts both address resolve paths', () => {
    expect(
      ResolveAddressRequestSchema.safeParse({
        placeId: 'ChIJabc',
        sessionToken: '6f1c2c6e-3c4f-4b57-9a77-3a2b7bcfe1a1',
        holidayId: 'christmas',
      }).success,
    ).toBe(true);
    expect(ResolveAddressRequestSchema.safeParse({ candidateId: 'signed.token' }).success).toBe(
      true,
    );
    expect(ResolveAddressRequestSchema.safeParse({ placeId: 'ChIJabc' }).success).toBe(false);
    expect(
      GeocodeRequestSchema.safeParse({
        line1: '123 Main St',
        line2: '',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      }).success,
    ).toBe(true);
  });

  it('validates source binding bodies including the people resolution', () => {
    expect(PutSourceRequestSchema.safeParse({ projectVersion: 0, candidateId: 'c1' }).success).toBe(
      true,
    );
    expect(
      PutSourceRequestSchema.safeParse({
        projectVersion: 1,
        sourceAssetId: ID,
        sceneType: 'interior',
        roomType: 'dining_room',
        buildingForm: null,
        peopleResolution: { action: 'crop', box: [0.3, 0.0, 1.0, 1.0] },
      }).success,
    ).toBe(true);
    expect(
      PutSourceRequestSchema.safeParse({
        projectVersion: 1,
        sourceAssetId: ID,
        peopleResolution: { action: 'crop' },
      }).success,
    ).toBe(false);
  });

  it('requires this_is_my_home for address reports', () => {
    expect(
      CreateReportRequestSchema.safeParse({
        target: { kind: 'address', placeId: 'ChIJabc' },
        reason: 'this_is_my_home',
        requestOptOut: true,
      }).success,
    ).toBe(true);
    expect(
      CreateReportRequestSchema.safeParse({
        target: { kind: 'address', placeId: 'ChIJabc' },
        reason: 'privacy',
      }).success,
    ).toBe(false);
    expect(
      CreateReportRequestSchema.parse({ target: { kind: 'render', id: ID }, reason: 'other' })
        .requestOptOut,
    ).toBe(false);
  });

  it('accepts relative returnTo paths only', () => {
    expect(
      MagicLinkRequestSchema.safeParse({ email: 'person@example.com', returnTo: '/projects/1' })
        .success,
    ).toBe(true);
    expect(
      MagicLinkRequestSchema.safeParse({ email: 'person@example.com', returnTo: '//evil.example' })
        .success,
    ).toBe(false);
    expect(
      MagicLinkRequestSchema.safeParse({
        email: 'person@example.com',
        returnTo: 'https://evil.example',
      }).success,
    ).toBe(false);
  });

  it('accepts an optional confirm flag on magic-link verification', () => {
    expect(VerifyMagicLinkRequestSchema.parse({ token: 'abc' })).toEqual({ token: 'abc' });
    expect(VerifyMagicLinkRequestSchema.parse({ token: 'abc', confirm: true })).toEqual({
      token: 'abc',
      confirm: true,
    });
    expect(VerifyMagicLinkRequestSchema.safeParse({ token: 'abc', confirm: 'yes' }).success).toBe(
      false,
    );
  });

  it('coerces pagination and requires confirm for live_public', () => {
    expect(PaginationQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(PaginationQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    const put = { state: 'live_public', evidenceRef: 'grant-1', reviewedAt: NOW, version: 3 };
    expect(PutCapabilityRequestSchema.safeParse(put).success).toBe(false);
    expect(PutCapabilityRequestSchema.safeParse({ ...put, confirm: true }).success).toBe(true);
  });

  it('checks nudges against the default grammar', () => {
    expect(isNudgeWithinBounds({ headingDelta: -15, fov: 75 })).toBe(true);
    expect(isNudgeWithinBounds({ headingDelta: 45, fov: 75 })).toBe(false);
    expect(isNudgeWithinBounds({ headingDelta: 10, fov: 75 })).toBe(false);
    expect(isNudgeWithinBounds({ headingDelta: 0, fov: 70 })).toBe(false);
  });
});

describe('discovery, uploads, products and experience', () => {
  it('parses the discovery example and rejects the stored blocked_address reason', () => {
    const discovery = {
      discoveryId: ID,
      projectVersion: 0,
      entryMethod: 'autocomplete',
      matchClass: 'confirm',
      reason: null,
      retryable: false,
      sourceMode: 'transient',
      thresholdsVersion: '1',
      sourceAssetId: null,
      remainingDisplayLoads: 5,
      candidates: [
        {
          candidateId: 'c1',
          isPrimary: true,
          rank: 1,
          displayUrl: 'https://maps.googleapis.com/maps/api/streetview?pano=x',
          heading: 212.4,
          headingMode: 'geometry',
          pitch: 4,
          fov: 75,
          captureDate: '2024-06',
          captureGranularity: 'month',
          copyright: '© 2024 Google',
          isGoogleImagery: true,
          distanceMeters: 18,
          estimatedFacadePx: 310,
          flags: [],
          width: 640,
          height: 640,
        },
        {
          candidateId: 'c2',
          isPrimary: false,
          rank: 2,
          displayUrl: null,
          heading: 188,
          headingMode: 'geometry',
          pitch: 3,
          fov: 90,
          captureDate: '2023-09',
          captureGranularity: 'month',
          copyright: '© 2023 Google',
          isGoogleImagery: true,
          distanceMeters: 31,
          estimatedFacadePx: 205,
          flags: ['deepSetback'],
          width: 640,
          height: 640,
        },
      ],
      attribution: { logo: 'google_maps', required: true },
      nextAction: 'confirm_place',
    };
    expect(DiscoverySchema.parse(discovery).candidates).toHaveLength(2);
    const skipped = {
      ...discovery,
      matchClass: 'skip_to_upload',
      candidates: [],
      nextAction: 'upload_photo',
    };
    expect(DiscoverySchema.safeParse({ ...skipped, reason: 'unavailable' }).success).toBe(true);
    expect(DiscoverySchema.safeParse({ ...skipped, reason: 'blocked_address' }).success).toBe(
      false,
    );
  });

  it('parses the upload status example', () => {
    const status = {
      sourceAssetId: ID,
      state: 'ready',
      holdForReview: false,
      sceneType: 'interior',
      sceneTypeConfidence: 0.91,
      roomType: 'dining_room',
      buildingForm: null,
      multiUnitFacade: false,
      people: {
        detected: true,
        boxes: [[0.12, 0.3, 0.25, 0.7]],
        suggestedCropBox: [0.3, 0.0, 1.0, 1.0],
      },
      guidance: ['dark'],
      detectedFormat: 'jpeg',
      attestationVersion: 'upload-attestation-2026-11',
      declineCode: null,
      declineReasonClass: null,
      declineReason: null,
      width: 2048,
      height: 1536,
    };
    expect(UploadStatusSchema.parse(status)).toEqual(status);
    expect(UploadStatusSchema.safeParse({ ...status, declineReason: 'hash_match' }).success).toBe(
      false,
    );
  });

  it('keeps product items empty unless the panel is active', () => {
    const card = {
      clickToken: 'tok',
      title: 'Pre-lit artificial garland, 9 ft, warm white',
      merchantName: 'Amazon',
      relationship: 'described',
      relationshipLabelKey: 'commerce.relationship.described',
      anchorCategory: 'porch_rail',
      price: { policy: 'check_at_retailer' },
      linkMode: 'tracking',
      sponsored: false,
      href: 'https://merchant.example/item',
      rankPosition: 1,
    };
    const panel = {
      panelState: 'active',
      linkMode: 'tracking',
      disclosure: {
        copyKeys: ['commerce.disclosure.paid', 'commerce.disclosure.amazon'],
        programs: ['amazon_associates'],
      },
      items: [card],
    };
    expect(ProductsPanelSchema.safeParse(panel).success).toBe(true);
    expect(ProductsPanelSchema.safeParse({ ...panel, panelState: 'hidden' }).success).toBe(false);
    expect(
      ProductsPanelSchema.safeParse({ ...panel, items: [{ ...card, price: { policy: 'show' } }] })
        .success,
    ).toBe(false);
  });

  it('parses an experience projection, including off-season', () => {
    const experience = {
      defaultHolidayId: 'thanksgiving_us',
      requestedHolidayId: 'christmas',
      editorialTimezone: 'America/New_York',
      offSeason: false,
      holidays: [
        {
          id: 'thanksgiving_us',
          nameKey: 'holiday.thanksgiving_us',
          isDefault: true,
          journeyEmphasis: 'interior',
          inWindow: true,
          windowStart: '2026-11-01',
          windowEnd: '2026-11-26',
          packVersion: '1.2.0',
          sceneTypes: {
            house_exterior: {
              styles: ['subtle', 'classic', 'abundant'],
              defaultStyle: 'classic',
              lightingModes: ['source'],
              defaultLightingMode: 'source',
            },
          },
        },
      ],
      calendar: [
        {
          occurrenceKey: 'thanksgiving_us.US.2026',
          holidayId: 'thanksgiving_us',
          promotionStart: '2026-11-01',
          promotionEnd: '2026-11-26',
        },
      ],
      hero: {
        holidayId: 'thanksgiving_us',
        sceneType: 'interior',
        renditions: {
          landscape: [{ url: 'https://cdn/hero/a.jpg', width: 2400, height: 1600 }],
          portrait: [{ url: 'https://cdn/hero/b.jpg', width: 1080, height: 1620 }],
        },
        altKey: 'hero.thanksgiving_us.alt',
      },
      examples: [],
      capabilities: {
        addressLookup: true,
        streetViewAi: false,
        uploads: true,
        sharing: true,
        commerce: false,
      },
      allowance,
      clientConfig: {
        autocompleteMinChars: 3,
        autocompleteDebounceMs: 250,
        uploadMaxBytes: 26214400,
        uploadAcceptedTypes: ['image/jpeg', 'image/png', 'image/webp'],
        pollRenderMs: 3000,
        pollUploadMs: 2000,
      },
      legal: {
        termsVersion: '2026-11',
        ageLineKey: 'landing.ageLine',
        termsUrl: '/terms',
        privacyUrl: '/privacy',
      },
    };
    expect(ExperienceSchema.parse(experience).holidays[0]?.id).toBe('thanksgiving_us');
    expect(ExperienceSchema.parse(experience).fixtureCapabilities).toBeUndefined();
    expect(
      ExperienceSchema.parse({
        ...experience,
        fixtureCapabilities: ['image_editing', 'street_view_display', 'commerce:lumen_home'],
      }).fixtureCapabilities,
    ).toEqual(['image_editing', 'street_view_display', 'commerce:lumen_home']);
    expect(
      ExperienceSchema.safeParse({ ...experience, fixtureCapabilities: ['teleportation'] }).success,
    ).toBe(false);
    expect(
      ExperienceSchema.safeParse({
        ...experience,
        defaultHolidayId: null,
        offSeason: true,
        hero: { ...experience.hero, holidayId: null, sceneType: null, altKey: 'hero.neutral.alt' },
      }).success,
    ).toBe(true);
  });
});

describe('normalized boxes', () => {
  it('accepts valid boxes and rejects out-of-range or inverted ones', () => {
    expect(NormalizedBoxSchema.safeParse([0.1, 0.2, 0.3, 0.4]).success).toBe(true);
    expect(NormalizedBoxSchema.safeParse([0.3, 0.2, 0.1, 0.4]).success).toBe(false);
    expect(NormalizedBoxSchema.safeParse([0.1, 0.2, 1.2, 0.4]).success).toBe(false);
    expect(NormalizedBoxSchema.safeParse([0.1, 0.2, 0.3]).success).toBe(false);
  });

  it('computes geometry', () => {
    expect(boxArea([0, 0, 0.5, 0.5])).toBeCloseTo(0.25);
    expect(intersectBoxes([0, 0, 0.5, 0.5], [0.25, 0.25, 1, 1])).toEqual([0.25, 0.25, 0.5, 0.5]);
    expect(intersectBoxes([0, 0, 0.2, 0.2], [0.5, 0.5, 1, 1])).toBeNull();
    expect(overlapFraction([0, 0, 0.5, 0.5], [0.25, 0, 1, 1])).toBeCloseTo(0.5);
    expect(boxIoU([0, 0, 0.5, 0.5], [0, 0, 0.5, 0.5])).toBeCloseTo(1);
    expect(boxContains([0.1, 0.1, 0.9, 0.9], [0.2, 0.2, 0.8, 0.8])).toBe(true);
    expect(boxContains([0.1, 0.1, 0.9, 0.9], [0.05, 0.2, 0.8, 0.8], 0.06)).toBe(true);
    expect(clampBox([-0.1, 0.2, 1.4, 0.5])).toEqual([0, 0.2, 1, 0.5]);
    expect(clampBox([0.5, 0.5, 0.5, 0.6])).toBeNull();
    expect(toPixelBox([0.46, 0.56, 0.54, 0.66], 1024, 1024)).toEqual({
      left: 471,
      top: 573,
      width: 82,
      height: 103,
    });
    expect(fromYxBox([100, 200, 500, 800])).toEqual([0.2, 0.1, 0.8, 0.5]);
    expect(boxThirds([0.46, 0.56, 0.54, 0.66])).toEqual({
      horizontal: 'center',
      vertical: 'middle',
    });
    expect(
      regionOverlapFraction(
        [0, 0, 1, 1],
        [
          [0, 0, 0.5, 1],
          [0.25, 0, 0.75, 1],
        ],
      ),
    ).toBeCloseTo(0.75, 2);
  });
});

const sceneAnalysis = {
  schemaVersion: '1.0',
  sourceAssetId: 'sa_1',
  workingImage: { width: 1024, height: 1024, checksum: 'sha256:abc' },
  sceneType: 'house_exterior',
  sceneTypeConfidence: 0.95,
  sceneTypeMismatch: false,
  buildingForm: 'detached',
  targetFacade: [0.14, 0.18, 0.86, 0.95],
  targetFacadeAmbiguous: false,
  anchors: [
    {
      id: 'a1',
      category: 'front_door',
      box: [0.46, 0.56, 0.54, 0.76],
      confidence: 0.9,
      occluded: false,
    },
  ],
  preserveRegions: [{ kind: 'house_number', box: [0.58, 0.6, 0.62, 0.64] }],
  accessRegions: [{ kind: 'steps', box: [0.4, 0.84, 0.6, 0.95] }],
  hazards: [],
  existingDecorations: { present: false, density: 'none', boxes: [] },
  peopleBoxes: [],
  protectedBlurRegions: [{ kind: 'plate', box: [0.88, 0.86, 0.94, 0.89] }],
  lighting: { timeOfDay: 'day', isDaylight: true, exposure: 'normal' },
  seasonCues: { snowVisible: false, foliage: 'leafy' },
  qualityFlags: {
    blur: false,
    lowLight: false,
    heavyOcclusion: false,
    multipleBuildings: false,
    embeddedPhoto: false,
    tooClose: false,
    tooFar: false,
  },
  model: { analysisModel: 'fixture-vision', analysisPromptVersion: '1' },
  elapsedMs: 120,
};

describe('render pipeline contracts', () => {
  it('parses a scene analysis and rejects bad boxes, categories and duplicate ids', () => {
    expect(SceneAnalysisSchema.parse(sceneAnalysis).anchors).toHaveLength(1);
    expect(
      SceneAnalysisSchema.safeParse({ ...sceneAnalysis, targetFacade: [0.9, 0.1, 0.2, 0.5] })
        .success,
    ).toBe(false);
    expect(
      SceneAnalysisSchema.safeParse({
        ...sceneAnalysis,
        anchors: [{ ...sceneAnalysis.anchors[0], category: 'chimney' }],
      }).success,
    ).toBe(false);
    expect(
      SceneAnalysisSchema.safeParse({
        ...sceneAnalysis,
        anchors: [sceneAnalysis.anchors[0], sceneAnalysis.anchors[0]],
      }).success,
    ).toBe(false);
  });

  it('parses the worked decoration plan', () => {
    const plan = {
      schemaVersion: '1.0',
      renderJobId: 'rj_01JCDX4P8Q2M7N9R3S5T7V9W1X',
      planVersion: 1,
      attemptNumber: 1,
      sourceAssetId: 'sa_01JCDX3K2A8B4C6D8E0F2G4H6J',
      sceneAnalysisId: 'an_01JCDX4A1B2C3D4E5F6G7H8J9K',
      countryCode: 'US',
      locale: 'en-US',
      sceneType: 'house_exterior',
      buildingForm: 'detached',
      holidayId: 'thanksgiving_us',
      holidayPackVersion: '1.0.0',
      styleKitVersionId: 'kit_thanksgiving_us_house_exterior_v1',
      style: 'classic',
      lightingMode: 'source',
      fidelityMode: 'composite_additive',
      compilerVersion: '2026.11.2-openai',
      placements: [
        {
          id: 'p1',
          kitItemId: 'thx_ext_wreath_autumn',
          anchorId: 'a1',
          anchorCategory: 'front_door',
          region: [0.46, 0.56, 0.54, 0.66],
          placementRule: 'centered_on',
          count: 1,
          specText: '24-to-30-inch autumn-leaf wreath',
          specAttributes: { diameterInches: '24-30', colorFamily: 'orange-russet' },
          lit: false,
          priority: 1,
        },
      ],
      preserve: {
        targetFacade: [0.14, 0.18, 0.86, 0.95],
        regions: [{ kind: 'house_number', box: [0.58, 0.6, 0.62, 0.64] }],
        protectedBlurRegions: [{ kind: 'plate', box: [0.88, 0.86, 0.94, 0.89] }],
        peopleBoxes: [],
        accessRegions: [{ kind: 'steps', box: [0.4, 0.84, 0.6, 0.95] }],
        existingDecorations: [],
        keepSkyAndTimeOfDay: true,
        neighborsUnchanged: true,
        noSnow: true,
      },
      negatives: ['people', 'pets'],
      lightingInstruction: { mode: 'source', text: 'Keep the lighting.' },
      existingDecorConflict: false,
      permissionEvaluationId: 'perm_01',
      referenceAssetIds: [],
      compositeMask: { dilationFraction: 0.04, featherFraction: 0.02 },
      compiled: {
        provider: 'openai',
        modelSnapshot: 'gpt-image-2.5-sunburst-2026-09-08',
        instructionText: 'Edit only the target house…',
        parameters: { size: '1024x1024', quality: 'high', output_format: 'jpeg' },
        hash: 'sha256:…',
      },
    };
    expect(DecorationPlanSchema.parse(plan).placements[0]?.id).toBe('p1');
    expect(DecorationPlanSchema.safeParse({ ...plan, planVersion: 3 }).success).toBe(false);

    // Attribution: a stored plan with the single rectangle still parses; the list is optional.
    const single = { ...plan, preserve: { ...plan.preserve, attributionRegion: [0.7, 0.9, 1, 1] } };
    expect(DecorationPlanSchema.parse(single).preserve.attributionRegions).toBeUndefined();
    const listed = {
      ...plan,
      preserve: {
        ...plan.preserve,
        attributionRegion: [0, 0.92, 0.12, 1],
        attributionRegions: [
          [0, 0.92, 0.12, 1],
          [0.7, 0.95, 1, 1],
        ],
      },
    };
    expect(DecorationPlanSchema.parse(listed).preserve.attributionRegions).toHaveLength(2);
    expect(
      DecorationPlanSchema.safeParse({
        ...plan,
        preserve: { ...plan.preserve, attributionRegions: [[0.5, 0.5, 0.4, 0.6]] },
      }).success,
    ).toBe(false);
  });

  it('restricts judge codes to the canonical enums', () => {
    const judge = {
      schemaVersion: '1.0',
      renderAttemptId: 'att_1',
      judgeModel: 'fixture-judge',
      judgePromptVersion: '1',
      escalated: false,
      critical: [{ code: 'attribution_altered', confidence: 0.9, evidence: 'Logo covered.' }],
      major: [],
      placements: [
        {
          placementId: 'p1',
          present: true,
          confidence: 0.8,
          adherence: { category: true, colorFamily: true, count: 'pass', scale: 'ok' },
        },
      ],
      scores: { realism: 4, appeal: 4, planAdherence: 5 },
      overallConfidence: 0.85,
      elapsedMs: 900,
    };
    expect(JudgeResultSchema.safeParse(judge).success).toBe(true);
    expect(
      JudgeResultSchema.safeParse({
        ...judge,
        critical: [{ code: 'plan_not_followed', confidence: 0.9, evidence: 'x' }],
      }).success,
    ).toBe(false);
    expect(
      JudgeResultSchema.safeParse({ ...judge, scores: { realism: 6, appeal: 4, planAdherence: 5 } })
        .success,
    ).toBe(false);
  });
});

/** The Christmas `house_exterior` example pack with the baseline sections around it. */
function christmasPack() {
  return {
    id: 'christmas.US',
    version: '1.0.0',
    holidayId: 'christmas',
    region: 'US',
    displayName: 'Christmas',
    journeyEmphasis: 'balanced',
    traditionNotes: 'Evergreen, light and warmth.',
    lightingPolicy: {
      bySceneType: {
        house_exterior: { default: 'source', offered: ['source', 'evening'] },
        interior: { default: 'source', offered: ['source', 'evening'] },
      },
      eveningGuidance: 'Early dusk.',
    },
    climateRule: {
      sourcePrecedence: ['scene_analysis', 'address_region', 'neutral'],
      snow: 'only_if_visible_in_source',
      coldClimateOnlyItems: [],
    },
    existingDecorPolicy: 'preserve_and_complement',
    forbidden: [
      'people',
      'pets',
      'text_or_signage',
      'house_number_changes',
      'new_structures',
      'structural_changes',
      'landscaping_changes',
      'neighbor_decor',
      'blocked_access',
      'brand_logos',
      'cartoon_or_licensed_characters',
      'mascots_and_inflatables',
      'snow_or_frost_unless_visible',
      'sky_effects',
      'religious_symbols',
      'open_flame_indoors',
    ],
    sceneSections: {
      house_exterior: {
        buildingForms: ['detached', 'attached', 'other'],
        formRules: {
          attached: { excludeAnchors: ['lawn'], note: 'stay within the target unit' },
          other: { excludeAnchors: ['roofline', 'eaves', 'lawn'] },
        },
        anchors: [
          'front_door',
          'door_frame',
          'porch_rail',
          'porch_steps',
          'roofline',
          'eaves',
          'window_frame',
          'column',
          'walkway_edge',
          'planter',
          'lawn',
        ],
        preserve: ['roofline shape'],
        keepClear: ['door swing'],
        kitId: 'christmas.house_exterior',
        kit: [
          {
            kitItemId: 'christmas.house_exterior.string_lights_warm_white',
            anchors: ['eaves', 'roofline', 'porch_rail'],
            attachment: 'strung',
            placementRule: 'along',
            specText: 'outdoor warm-white LED string lights',
            specAttributes: {
              category: 'string lights',
              sizeRange: '25–100 ft run',
              material: 'LED on green wire',
              colorFamily: ['warm white'],
              lit: true,
              lightType: 'electric',
              lightColor: 'warm white',
              indoorOutdoor: 'outdoor',
            },
            quantity: { subtle: [0, 1], classic: [1, 2], abundant: [2, 3] },
            required: ['classic', 'abundant'],
          },
          {
            kitItemId: 'christmas.house_exterior.wreath_evergreen',
            anchors: ['front_door'],
            attachment: 'hung',
            placementRule: 'centered_on',
            specText: 'a 24 to 30 inch mixed evergreen wreath with a red velvet bow',
            quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 1] },
            required: ['subtle', 'classic', 'abundant'],
          },
        ],
        promptFragments: {
          scene: 'a tasteful US Christmas display',
          preserve: 'keep the same camera position',
          negative: 'no snow or frost unless present',
        },
      },
      interior: {
        roomRules: {
          dining_room: {
            anchors: ['dining_table', 'sideboard', 'interior_window', 'wall', 'shelf'],
          },
        },
        anchors: [
          'mantel',
          'dining_table',
          'sideboard',
          'interior_window',
          'wall',
          'floor_area',
          'shelf',
          'banister',
        ],
        kitId: 'christmas.interior',
        kit: [
          {
            kitItemId: 'christmas.interior.table_centerpiece',
            anchors: ['dining_table'],
            attachment: 'placed',
            placementRule: 'on_surface',
            specText: 'a low evergreen centerpiece',
            quantity: { subtle: [1, 1], classic: [1, 1], abundant: [1, 2] },
            required: ['subtle', 'classic', 'abundant'],
          },
        ],
        promptFragments: { scene: 'interior', preserve: 'walls', negative: 'no open flames' },
      },
    },
    heroRefs: [{ heroAssetId: 'hero.christmas.exterior.v1', orientation: 'landscape' }],
    exampleRefs: [
      {
        exampleAssetId: 'example.christmas.house_exterior.classic.source.v1',
        sceneType: 'house_exterior',
        style: 'classic',
        lightingMode: 'source',
      },
    ],
    review: {
      checklistVersion: 1,
      approvedBy: ['editorial_lead'],
      approvedAt: null,
      goldenRunId: null,
    },
  };
}

describe('holiday packs', () => {
  it('parses a valid pack and applies section defaults', () => {
    const pack = HolidayPackSchema.parse(christmasPack());
    const exterior = pack.sceneSections.house_exterior!;
    expect(exterior.limits.maxPlacements).toEqual({ subtle: 3, classic: 6, abundant: 10 });
    expect(exterior.limits.overlapTolerance).toBe(0.1);
    expect(effectiveSectionAnchors(exterior, { buildingForm: 'other' })).not.toContain('eaves');
    expect(effectiveSectionAnchors(exterior, { buildingForm: 'detached' })).toContain('lawn');
    expect(
      effectiveSectionAnchors(pack.sceneSections.interior!, { roomType: 'dining_room' }),
    ).toEqual(['dining_table', 'sideboard', 'interior_window', 'wall', 'shelf']);
    expect(
      effectiveSectionAnchors(pack.sceneSections.interior!, { roomType: 'kitchen' }),
    ).toHaveLength(8);
    expect(kitInPriorityOrder(exterior).map((k) => k.kitItemId)[0]).toBe(
      'christmas.house_exterior.string_lights_warm_white',
    );
    expect(packOfferFor(pack, 'house_exterior')).toEqual({
      styles: ['subtle', 'classic', 'abundant'],
      defaultStyle: 'classic',
      lightingModes: ['source', 'evening'],
      defaultLightingMode: 'source',
    });
    expect(packOfferFor(pack, 'balcony')).toBeNull();
    expect(isContentCellOffered(pack, 'house_exterior', 'abundant', 'evening')).toBe(true);
    expect(isContentCellOffered(pack, 'apartment_entry', 'classic', 'source')).toBe(false);
  });

  const invalid: [string, (pack: ReturnType<typeof christmasPack>) => void][] = [
    ['id mismatch', (p) => void (p.id = 'christmas.CA')],
    ['missing baseline forbidden item', (p) => void (p.forbidden = p.forbidden.slice(1))],
    [
      'interior without open_flame_indoors',
      (p) => void (p.forbidden = p.forbidden.filter((f) => f !== 'open_flame_indoors')),
    ],
    [
      'anchor not allowed for the scene type',
      (p) => void p.sceneSections.house_exterior.anchors.push('mantel'),
    ],
    [
      'kit anchor not in section anchors',
      (p) => void p.sceneSections.house_exterior.kit[1]!.anchors.push('balcony_railing'),
    ],
    ['kitId mismatch', (p) => void (p.sceneSections.house_exterior.kitId = 'christmas.porch')],
    [
      'kitItemId outside the kit',
      (p) => void (p.sceneSections.house_exterior.kit[1]!.kitItemId = 'halloween.house_exterior.x'),
    ],
    [
      'minimum above maximum',
      (p) =>
        void (p.sceneSections.house_exterior.kit[0]!.quantity.classic = [3, 2] as [number, number]),
    ],
    [
      'required style with a zero minimum',
      (p) => void p.sceneSections.house_exterior.kit[0]!.required.push('subtle'),
    ],
    [
      'lighting default not offered',
      (p) =>
        void (p.lightingPolicy.bySceneType.house_exterior = {
          default: 'evening',
          offered: ['source'],
        }),
    ],
    [
      'missing lighting policy for a section',
      (p) => void delete (p.lightingPolicy.bySceneType as Record<string, unknown>)['interior'],
    ],
    [
      'formRules anchor not in anchors',
      (p) =>
        void (p.sceneSections.house_exterior.formRules.other.excludeAnchors = ['balcony_floor']),
    ],
    ['bad version', (p) => void (p.version = '1.0')],
    [
      'snow rule other than only_if_visible_in_source',
      (p) => void ((p.climateRule as { snow: string }).snow = 'allowed'),
    ],
    [
      'example for a cell that is not offered',
      (p) => void (p.exampleRefs[0]!.sceneType = 'balcony'),
    ],
  ];

  for (const [label, mutate] of invalid) {
    it(`rejects a pack with ${label}`, () => {
      const pack = christmasPack();
      mutate(pack);
      expect(HolidayPackSchema.safeParse(pack).success).toBe(false);
    });
  }

  it('enforces maxPlacements ordering and required coverage', () => {
    const pack = christmasPack();
    (pack.sceneSections.house_exterior as Record<string, unknown>)['limits'] = {
      maxPlacements: { subtle: 4, classic: 3, abundant: 10 },
    };
    expect(HolidayPackSchema.safeParse(pack).success).toBe(false);
    (pack.sceneSections.house_exterior as Record<string, unknown>)['limits'] = {
      maxPlacements: { subtle: 1, classic: 1, abundant: 10 },
    };
    expect(HolidayPackSchema.safeParse(pack).success).toBe(false);
  });

  it('derives a style kit from a section', () => {
    const pack = HolidayPackSchema.parse(christmasPack());
    const kit = styleKitFromSection(pack, 'house_exterior', pack.sceneSections.house_exterior!);
    expect(StyleKitSchema.parse(kit).items).toHaveLength(2);
    expect(kit.kitKey).toBe('christmas.house_exterior');
    expect(kit.items[0]?.styleQuantities.classic).toEqual({ min: 1, max: 2 });
  });
});

describe('commerce content', () => {
  const offer = {
    offerKey: 'fixture-garland-1',
    productKey: 'garland-evergreen-9ft',
    merchantProgramKey: 'fixture_decor_us',
    merchantItemId: 'SKU-1',
    destinationCountry: 'US',
    currency: 'USD',
    destinationUrl: 'https://shop.example/garland',
    status: 'active',
    seasonalEligibility: ['christmas.US.2026'],
  };

  it('applies offer defaults and checks prices and tracking parameters', () => {
    const parsed = OfferContentSchema.parse(offer);
    expect(parsed.priceSource).toBe('none');
    expect(parsed.contentRights.imageAiInput).toBe('unknown');
    expect(
      OfferContentSchema.safeParse({ ...offer, priceMinor: 3999, priceSource: 'feed' }).success,
    ).toBe(false);
    expect(
      OfferContentSchema.safeParse({ ...offer, destinationUrl: 'https://shop.example/x?tag=abc' })
        .success,
    ).toBe(false);
    expect(
      OfferContentSchema.safeParse({ ...offer, seasonalEligibility: ['christmas.2026'] }).success,
    ).toBe(false);
  });

  it('checks catalog cross-references', () => {
    const catalog = {
      merchantPrograms: [
        {
          programKey: 'fixture_decor_us',
          displayName: 'Fixture Decor',
          network: 'direct',
          status: 'planned',
        },
      ],
      products: [
        {
          productKey: 'garland-evergreen-9ft',
          kitItemIds: ['christmas.house_exterior.garland_evergreen'],
          ourTitle: 'Mixed evergreen garland, 9 ft',
          ourDescription: 'Artificial evergreen garland with pinecones.',
          category: 'garland',
          specAttributes: {
            category: 'garland',
            colorFamily: ['green'],
            lit: false,
            indoorOutdoor: 'outdoor',
          },
        },
      ],
      offers: [offer],
    };
    expect(CommerceCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(
      CommerceCatalogSchema.safeParse({ ...catalog, offers: [{ ...offer, productKey: 'missing' }] })
        .success,
    ).toBe(false);
  });
});

describe('analytics', () => {
  it('accepts a client batch and drops server-only or invalid events', () => {
    const batch = AnalyticsBatchSchema.parse({
      events: [
        { name: 'compare_used', occurredAt: NOW, properties: { mode: 'slider' } },
        { name: 'render_succeeded', occurredAt: NOW, properties: {} },
        { name: 'compare_used', occurredAt: NOW, properties: { mode: 'wiggle' } },
        {
          name: 'holiday_changed',
          occurredAt: NOW,
          properties: {
            fromHolidayId: null,
            toHolidayId: 'christmas',
            surface: 'landing',
            address: 'x',
          },
        },
      ],
    });
    const kept = batch.events.map(validateClientAnalyticsEvent).filter((e) => e !== null);
    expect(kept.map((e) => e.name)).toEqual(['compare_used', 'holiday_changed']);
    expect(kept[1]?.properties).not.toHaveProperty('address');
  });

  it('limits batch size', () => {
    const event = { name: 'compare_used', occurredAt: NOW, properties: { mode: 'toggle' } };
    expect(AnalyticsBatchSchema.safeParse({ events: Array(21).fill(event) }).success).toBe(false);
    expect(AnalyticsBatchSchema.safeParse({ events: [] }).success).toBe(false);
  });
});

describe('runtime settings', () => {
  it('resolves per-key schemas including patterned keys', () => {
    expect(runtimeSettingSchemaFor('allowance.variants_per_24h')?.safeParse(3).success).toBe(true);
    expect(runtimeSettingSchemaFor('allowance.variants_per_24h')?.safeParse(-1).success).toBe(
      false,
    );
    expect(
      runtimeSettingSchemaFor('allowance.new_owner_variants_per_24h')?.safeParse(null).success,
    ).toBe(true);
    expect(
      runtimeSettingSchemaFor('spend.sku_daily_micros.street_view_static')?.safeParse(5).success,
    ).toBe(true);
    expect(runtimeSettingSchemaFor('spend.sku_daily_micros.unknown_sku')).toBeNull();
    expect(runtimeSettingSchemaFor('pause.provider.openai')?.safeParse(true).success).toBe(true);
    expect(
      runtimeSettingSchemaFor('review.mode')?.safeParse({ interior: 'sampled_audit' }).success,
    ).toBe(true);
    expect(
      runtimeSettingSchemaFor('review.mode')?.safeParse({ garage: 'sampled_audit' }).success,
    ).toBe(false);
    expect(runtimeSettingSchemaFor('app_settings.anything')).toBeNull();
  });

  it('gives the render backstop separate device and IP limits', () => {
    for (const key of [
      'quota.render_requests_per_device_24h',
      'quota.render_requests_per_ip_24h',
    ]) {
      expect(runtimeSettingSchemaFor(key)?.safeParse(6).success).toBe(true);
      expect(runtimeSettingSchemaFor(key)?.safeParse(0).success).toBe(true);
      expect(runtimeSettingSchemaFor(key)?.safeParse(-1).success).toBe(false);
      expect(runtimeSettingSchemaFor(key)?.safeParse(1.5).success).toBe(false);
    }
  });
});
