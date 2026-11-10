import {
  ERROR_CODES,
  buildErrorBody,
  type Allowance,
  type ErrorCode,
  type Project,
  type RenderStatus,
  type Variant,
} from '@holiday/core';
import { errorFromResponse, type ApiError } from '../api/errors';

/** Test data builders shaped exactly like the core schemas. */

/** The active source of the default project; default variants are rendered from it. */
export const SOURCE_ASSET_ID = '018f0000-0000-7000-8000-bbbbbbbbbbbb';

export function allowance(remaining = 5): Allowance {
  return {
    variants: { limit: 6, remaining, resetsAt: '2026-11-10T05:00:00.000Z' },
    addresses: { limit: 3, remaining: 3, resetsAt: '2026-11-10T05:00:00.000Z' },
    gate: remaining > 0 ? 'none' : 'allowance_variants',
  };
}

let counter = 0;
function uuid(): string {
  counter += 1;
  return `018f0000-0000-7000-8000-${String(counter).padStart(12, '0')}`;
}

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: '018f0000-0000-7000-8000-aaaaaaaaaaaa',
    kind: 'address',
    projectVersion: 3,
    holidayId: 'christmas',
    style: 'classic',
    lightingMode: 'source',
    sceneType: 'house_exterior',
    buildingForm: null,
    roomType: null,
    property: null,
    activeSource: {
      sourceAssetId: SOURCE_ASSET_ID,
      kind: 'upload',
      state: 'ready',
      sourceMode: null,
      displayUrl: 'https://cdn.test/source.jpg',
      captureDate: null,
      copyright: null,
      isGoogleImagery: null,
      width: 1600,
      height: 1200,
      peopleDetected: false,
      privateOnly: false,
    },
    discovery: null,
    offered: { styles: ['subtle', 'classic', 'abundant'], lightingModes: ['source', 'evening'] },
    activeRenderJobId: null,
    variantCount: 1,
    saved: false,
    expiresAt: null,
    lastActivityAt: '2026-11-09T12:00:00.000Z',
    allowance: allowance(),
    ...overrides,
  };
}

export function variant(overrides: Partial<Variant> = {}): Variant {
  return {
    renderAssetId: uuid(),
    renderJobId: uuid(),
    sourceAssetId: SOURCE_ASSET_ID,
    holidayId: 'christmas',
    style: 'classic',
    lightingMode: 'source',
    holidayPackVersion: '1.0.0',
    compilerVersion: '1',
    imageUrl: `https://cdn.test/after-${counter}.jpg`,
    beforeImageUrl: 'https://cdn.test/before.jpg',
    width: 1600,
    height: 1200,
    labelKey: 'result.aiPreview',
    attribution: null,
    distributable: true,
    downloadable: true,
    downloadUrl: 'https://cdn.test/download.jpg',
    privateOnly: false,
    existingDecorConflict: false,
    placements: ['eaves', 'front_door', 'porch_rail'],
    sourceState: 'ready',
    createdAt: '2026-11-09T12:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

export function renderStatus(overrides: Partial<RenderStatus> = {}): RenderStatus {
  return {
    renderJobId: uuid(),
    projectId: '018f0000-0000-7000-8000-aaaaaaaaaaaa',
    projectVersion: 3,
    state: 'queued',
    stageLabelKey: 'stage.preparing',
    seq: 1,
    attempt: 0,
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
    permittedActions: [],
    variant: null,
    supersededByRenderJobId: null,
    timestamps: {
      requestedAt: '2026-11-09T12:00:00.000Z',
      sourceReadyAt: null,
      startedAt: null,
      renderStartedAt: null,
      renderCompletedAt: null,
      qaPassedAt: null,
      reviewCompletedAt: null,
      succeededAt: null,
      terminalAt: null,
    },
    allowance: allowance(),
    ...overrides,
  };
}

/** Makes `matchMedia('(prefers-reduced-motion: reduce)')` answer `reduce`. */
export function mockReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** An `ApiError` exactly as the client builds it from the API's error envelope. */
export function apiError(
  code: ErrorCode,
  options: { details?: Record<string, unknown>; retryAfter?: string } = {},
): ApiError {
  return errorFromResponse(
    ERROR_CODES[code].httpStatus,
    buildErrorBody(code, { requestId: 'req-test', details: options.details as never }),
    options.retryAfter ?? null,
  );
}
