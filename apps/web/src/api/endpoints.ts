import {
  CompleteUploadResponseSchema,
  CreateClickResponseSchema,
  CreateFeedbackResponseSchema,
  CreateRenderResponseSchema,
  CreateReportResponseSchema,
  CreateSessionResponseSchema,
  CreateShareResponseSchema,
  CreateUploadResponseSchema,
  DeleteMeResponseSchema,
  DeleteProjectResponseSchema,
  EmptyObjectSchema,
  GeocodeResponseSchema,
  MeSchema,
  ProductsPanelSchema,
  ProjectListResponseSchema,
  ProjectResponseSchema,
  RenderStatusSchema,
  ResolveAddressResponseSchema,
  ShareViewSchema,
  SourceDiscoveryResponseSchema,
  UploadStatusSchema,
  VariantListResponseSchema,
  VerifyMagicLinkResponseSchema,
  ViewpointResponseSchema,
  AddressSuggestionsResponseSchema,
  type AnalyticsBatch,
  type CreateFeedbackRequest,
  type CreateProjectRequest,
  type CreateRenderRequest,
  type CreateReportRequest,
  type CreateShareRequest,
  type CreateUploadRequest,
  type GeocodeRequest,
  type PutSourceRequest,
  type ResolveAddressRequest,
  type VerifyMagicLinkRequest,
  type ViewpointRequest,
} from '@holiday/core';
import { detectClientTimeZone } from '@holiday/core';
import { sessionError, type ApiError } from './errors';
import { createApiClient } from './http';
import { getTurnstileToken } from './turnstile';
import { parseExperiencePayload } from '../experience/payload';

/** How long `POST /v1/sessions` may take before the attempt counts as failed. */
export const SESSION_REQUEST_TIMEOUT_MS = 15_000;
/** The wait after a refused session start whose response named none. */
export const SESSION_RETRY_FALLBACK_SECONDS = 30;

let sessionPromise: Promise<void> | null = null;
let sessionReady = false;
const sessionListeners = new Set<() => void>();
/** The refused session start and when another attempt may be sent (epoch milliseconds). */
let sessionCooldown: { error: ApiError; retryAt: number } | null = null;

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(ms) : undefined;
}

/**
 * Creates the session cookie once per page (`POST /v1/sessions`). Calling it again with a
 * valid cookie rotates nothing, so a page reload simply re-confirms the session.
 *
 * It never leaves a caller waiting indefinitely: the request has a deadline, and a failure
 * rejects every waiting call with an `ApiError` marked `session`. After a refusal with
 * `RATE_LIMITED`, calls made before its `Retry-After` has passed are refused at once with the
 * remaining wait, without another request, so no flow hangs or hammers the limit.
 */
export function ensureSession(): Promise<void> {
  if (!sessionPromise && sessionCooldown) {
    const waitMs = sessionCooldown.retryAt - Date.now();
    if (waitMs > 0) {
      return Promise.reject(sessionError(sessionCooldown.error, Math.ceil(waitMs / 1000)));
    }
    sessionCooldown = null;
  }
  sessionPromise ??= (async () => {
    const turnstileToken = await getTurnstileToken();
    await api.request('/v1/sessions', {
      method: 'POST',
      session: false,
      body: { turnstileToken, timezone: detectClientTimeZone() },
      schema: CreateSessionResponseSchema,
      signal: timeoutSignal(SESSION_REQUEST_TIMEOUT_MS),
    });
    sessionCooldown = null;
    sessionReady = true;
    for (const listener of [...sessionListeners]) listener();
  })().catch((error: unknown) => {
    sessionPromise = null;
    const failure = sessionError(error);
    if (failure.code !== 'RATE_LIMITED') throw failure;
    const seconds = failure.retryAfterSeconds ?? SESSION_RETRY_FALLBACK_SECONDS;
    const limited = sessionError(failure, seconds);
    sessionCooldown = { error: limited, retryAt: Date.now() + seconds * 1000 };
    throw limited;
  });
  return sessionPromise;
}

/** Whether this page has created (or re-confirmed) its session. */
export function hasSession(): boolean {
  return sessionReady;
}

/** Calls the listener each time a session is created; returns the unsubscribe function. */
export function onSessionReady(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

/** Forgets the session so the next call creates a new one (after sign-out). */
export function resetSession(): void {
  sessionPromise = null;
  sessionReady = false;
  sessionCooldown = null;
}

export const api = createApiClient({
  fetch: (input, init) => window.fetch(input, init),
  ensureSession,
  getVerificationToken: getTurnstileToken,
});

const id = (value: string) => encodeURIComponent(value);

export async function getExperience(holiday?: string | null, signal?: AbortSignal) {
  const { data } = await api.request<unknown>('/v1/experience', {
    query: { holiday: holiday ?? undefined },
    signal,
    schema: { safeParse: (raw: unknown) => ({ success: true as const, data: raw }) },
  });
  return parseExperiencePayload(data, { requireAllowance: true });
}

export async function getAddressSuggestions(
  q: string,
  sessionToken: string | undefined,
  signal?: AbortSignal,
) {
  const { data } = await api.request('/v1/addresses/suggestions', {
    query: { q, sessionToken },
    signal,
    schema: AddressSuggestionsResponseSchema,
  });
  return data;
}

export async function resolveAddress(body: ResolveAddressRequest) {
  const { data } = await api.request('/v1/addresses/resolve', {
    method: 'POST',
    body,
    schema: ResolveAddressResponseSchema,
  });
  return data.project;
}

export async function geocodeAddress(body: GeocodeRequest) {
  const { data } = await api.request('/v1/addresses/geocode', {
    method: 'POST',
    body,
    schema: GeocodeResponseSchema,
  });
  return data.candidates;
}

export async function createUploadProject(body: CreateProjectRequest) {
  const { data } = await api.request('/v1/projects', {
    method: 'POST',
    body,
    schema: ProjectResponseSchema,
  });
  return data.project;
}

export async function listProjects(cursor?: string | null, limit = 20) {
  const { data } = await api.request('/v1/projects', {
    query: { limit, cursor: cursor ?? undefined },
    schema: ProjectListResponseSchema,
  });
  return data;
}

export async function getProject(projectId: string, signal?: AbortSignal) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}`, {
    signal,
    schema: ProjectResponseSchema,
  });
  return data.project;
}

export async function deleteProject(projectId: string) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}`, {
    method: 'DELETE',
    schema: DeleteProjectResponseSchema,
  });
  return data;
}

export async function runSourceDiscovery(projectId: string, projectVersion: number) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}/source-discovery`, {
    method: 'POST',
    body: { projectVersion },
    schema: SourceDiscoveryResponseSchema,
  });
  return data;
}

export async function putProjectSource(projectId: string, body: PutSourceRequest) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}/source`, {
    method: 'PUT',
    body,
    schema: ProjectResponseSchema,
  });
  return data.project;
}

export async function putViewpoint(projectId: string, body: ViewpointRequest) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}/viewpoint`, {
    method: 'PUT',
    body,
    schema: ViewpointResponseSchema,
  });
  return data;
}

/** The longest original file name sent with an upload. */
export const UPLOAD_FILE_NAME_MAX = 120;

/**
 * `POST /v1/uploads`. The original file name is sent as the body's optional `fileName`, which
 * the API uses only to drive the fixture screening and render scenarios.
 */
export async function createUpload(body: CreateUploadRequest, fileName?: string) {
  const name = fileName?.trim().slice(0, UPLOAD_FILE_NAME_MAX);
  const { data } = await api.request('/v1/uploads', {
    method: 'POST',
    body: name ? { ...body, fileName: name } : body,
    schema: CreateUploadResponseSchema,
  });
  return data;
}

export async function completeUpload(sourceAssetId: string) {
  const { data } = await api.request(`/v1/uploads/${id(sourceAssetId)}/complete`, {
    method: 'POST',
    body: {},
    schema: CompleteUploadResponseSchema,
  });
  return data;
}

export async function getUploadStatus(sourceAssetId: string, signal?: AbortSignal) {
  const { data } = await api.request(`/v1/uploads/${id(sourceAssetId)}`, {
    signal,
    schema: UploadStatusSchema,
  });
  return data;
}

export async function createRender(body: CreateRenderRequest, idempotencyKey: string) {
  const { data } = await api.request('/v1/renders', {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
    schema: CreateRenderResponseSchema,
  });
  return data;
}

export async function getRender(renderJobId: string, signal?: AbortSignal) {
  const { data } = await api.request(`/v1/renders/${id(renderJobId)}`, {
    signal,
    schema: RenderStatusSchema,
  });
  return data;
}

export async function cancelRender(renderJobId: string) {
  const { data } = await api.request(`/v1/renders/${id(renderJobId)}/cancel`, {
    method: 'POST',
    body: {},
    schema: RenderStatusSchema,
  });
  return data;
}

export async function listVariants(projectId: string) {
  const { data } = await api.request(`/v1/projects/${id(projectId)}/variants`, {
    schema: VariantListResponseSchema,
  });
  return data;
}

export async function getProducts(renderJobId: string) {
  const { data } = await api.request(`/v1/renders/${id(renderJobId)}/products`, {
    schema: ProductsPanelSchema,
  });
  return data;
}

export async function createClick(clickToken: string) {
  const { data } = await api.request('/v1/clicks', {
    method: 'POST',
    body: { clickToken },
    keepalive: true,
    schema: CreateClickResponseSchema,
  });
  return data;
}

export async function createShare(body: CreateShareRequest, idempotencyKey?: string) {
  const { data } = await api.request('/v1/shares', {
    method: 'POST',
    body,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    schema: CreateShareResponseSchema,
  });
  return data;
}

export async function getShare(token: string) {
  const { data } = await api.request(`/v1/shares/${id(token)}`, {
    session: false,
    schema: ShareViewSchema,
  });
  return data;
}

export async function deleteShare(token: string) {
  await api.request(`/v1/shares/${id(token)}`, { method: 'DELETE' });
}

export async function createFeedback(body: CreateFeedbackRequest, idempotencyKey?: string) {
  const { data } = await api.request('/v1/feedback', {
    method: 'POST',
    body,
    headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
    schema: CreateFeedbackResponseSchema,
  });
  return data;
}

export async function createReport(body: CreateReportRequest) {
  const { data } = await api.request('/v1/reports', {
    method: 'POST',
    body,
    schema: CreateReportResponseSchema,
  });
  return data;
}

export async function requestMagicLink(email: string, returnTo?: string) {
  await api.request('/v1/auth/magic-link', {
    method: 'POST',
    body: { email, ...(returnTo ? { returnTo } : {}) },
    schema: EmptyObjectSchema,
  });
}

/**
 * `POST /v1/auth/verify`. A link opened in another browser first answers
 * `confirmationRequired`; sending `confirm: true` then completes the sign-in.
 */
export async function verifyMagicLink(token: string, confirm = false) {
  const body: VerifyMagicLinkRequest = confirm ? { token, confirm: true } : { token };
  const { data } = await api.request('/v1/auth/verify', {
    method: 'POST',
    body,
    schema: VerifyMagicLinkResponseSchema,
  });
  return data;
}

export async function logout() {
  await api.request('/v1/auth/logout', { method: 'POST', body: {} });
}

export async function getMe() {
  const { data } = await api.request('/v1/me', { schema: MeSchema });
  return data;
}

export async function deleteMe() {
  const { data } = await api.request('/v1/me', {
    method: 'DELETE',
    schema: DeleteMeResponseSchema,
  });
  return data;
}

/** Sends one analytics batch over the existing session; it never starts a session itself. */
export async function sendAnalytics(batch: AnalyticsBatch, keepalive = false) {
  await api.request('/v1/analytics', { method: 'POST', body: batch, keepalive, session: false });
}
