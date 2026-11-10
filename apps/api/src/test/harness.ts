import { createServerContext, type ServerContext } from '@holiday/server';
import type { Clock } from '@holiday/server/clock';
import { testConfig, type AppConfig } from '@holiday/server/config';
import type { FixtureEmailSender } from '@holiday/server/email';
import { createSilentLogger, type Logger } from '@holiday/server/logger';
import { runRenderJob, seedPipelineTestContent, type PipelineDeps } from '@holiday/server/pipeline';
import { createProviders } from '@holiday/server/providers';
import type { LightMyRequestResponse } from 'fastify';
import { buildServer, type ApiServer } from '../server.js';

export const TEST_BUCKETS = {
  S3_PRIVATE_BUCKET: 'test-api-private',
  S3_PUBLIC_BUCKET: 'test-api-public',
} as const;

export const OPERATOR_EMAIL = 'ops@example.com';

export interface Harness {
  config: AppConfig;
  context: ServerContext;
  server: ApiServer;
  pipeline: PipelineDeps;
  email: FixtureEmailSender;
  /** A new client; `remoteAddress` puts it behind its own IP address (default 127.0.0.1). */
  client(options?: TestClientOptions): TestClient;
  /** Runs the render worker for a job directly (no queue consumer). */
  completeRender(renderJobId: string): Promise<string>;
  close(): Promise<void>;
}

export interface RequestInput {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  payload?: unknown;
  headers?: Record<string, string>;
  /** Omit the `Origin` header (same-origin check tests). */
  noOrigin?: boolean;
}

export interface TestClientOptions {
  /** The socket address requests come from (the API trusts no proxy header in tests). */
  remoteAddress?: string;
  /** A `holiday_device` cookie to start with, so several sessions share one browser. */
  deviceCookie?: string | null;
}

/**
 * An inject client with a cookie jar (the session and the `holiday_device` cookie, as a browser
 * keeps them) and the app origin on every request.
 */
export class TestClient {
  cookie: string | null = null;
  deviceCookie: string | null;
  readonly remoteAddress: string | undefined;

  constructor(
    private readonly harness: Pick<Harness, 'server' | 'config'>,
    options: TestClientOptions = {},
  ) {
    this.deviceCookie = options.deviceCookie ?? null;
    this.remoteAddress = options.remoteAddress;
  }

  async request(input: RequestInput): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...(input.headers ?? {}) };
    if (!input.noOrigin) headers.origin ??= this.harness.config.publicBaseUrl;
    const jar = [
      ...(this.cookie ? [`holiday_session=${this.cookie}`] : []),
      ...(this.deviceCookie ? [`holiday_device=${this.deviceCookie}`] : []),
    ];
    if (jar.length > 0) headers.cookie = jar.join('; ');
    const response = await this.harness.server.app.inject({
      method: input.method ?? 'GET',
      url: input.url,
      headers,
      ...(this.remoteAddress ? { remoteAddress: this.remoteAddress } : {}),
      ...(input.payload !== undefined ? { payload: input.payload as object } : {}),
    });
    const session = response.cookies.find((cookie) => cookie.name === 'holiday_session');
    if (session) this.cookie = session.value || null;
    const device = response.cookies.find((cookie) => cookie.name === 'holiday_device');
    if (device) this.deviceCookie = device.value || null;
    return response;
  }

  get(url: string, headers?: Record<string, string>) {
    return this.request({ url, ...(headers ? { headers } : {}) });
  }

  post(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request({
      method: 'POST',
      url,
      payload: payload ?? {},
      ...(headers ? { headers } : {}),
    });
  }

  put(url: string, payload?: unknown, headers?: Record<string, string>) {
    return this.request({
      method: 'PUT',
      url,
      payload: payload ?? {},
      ...(headers ? { headers } : {}),
    });
  }

  delete(url: string, headers?: Record<string, string>) {
    return this.request({ method: 'DELETE', url, ...(headers ? { headers } : {}) });
  }

  /** Creates a session with the fixture Turnstile token. */
  async createSession(): Promise<void> {
    const response = await this.post('/v1/sessions', { turnstileToken: 'fixture-pass' });
    if (response.statusCode !== 201) {
      throw new Error(`session creation failed: ${response.statusCode} ${response.body}`);
    }
  }
}

/** Builds the API against `holiday_test`, the `test-api-*` buckets and fixture providers. */
export async function createHarness(
  options: {
    overrides?: Record<string, string>;
    webDistDir?: string | null;
    logger?: Logger;
    /** The clock of the API and pipeline (default: the system clock). */
    clock?: Clock;
    /**
     * Adjusts the configuration the API reads (for example the configured provider names). The
     * adapters are always built from the unadjusted test configuration, so every one of them stays
     * a fixture.
     */
    mapConfig?: (config: AppConfig) => AppConfig;
  } = {},
): Promise<Harness> {
  const parsed = testConfig({
    ...TEST_BUCKETS,
    SETTINGS_CACHE_S: '0',
    OPERATOR_EMAILS: OPERATOR_EMAIL,
    ...(options.overrides ?? {}),
  });
  const config = options.mapConfig ? options.mapConfig(parsed) : parsed;
  const logger = options.logger ?? createSilentLogger();
  const context = createServerContext({
    config,
    logger,
    queueRole: 'producer',
    name: 'api-test',
    ...(options.clock ? { clock: options.clock } : {}),
  });
  await context.start();
  await context.queue.ensureQueues();
  for (const bucket of [config.storage.privateBucket, config.storage.publicBucket]) {
    await context.storage.ensureBucket(bucket);
  }
  const content = await seedPipelineTestContent(context.db, config);
  await context.db.updateTable('heroAssets').set({ active: true }).execute();
  const providers = createProviders(parsed, { content, logger, fixtureSlowDelayMs: 200 });
  const server = await buildServer({
    context,
    content,
    providers,
    webDistDir: options.webDistDir === undefined ? null : options.webDistDir,
  });
  const pipeline: PipelineDeps = {
    ...server.deps.pipeline,
    queue: null,
    options: { retryDelayMs: () => 20, statusPollMs: 20 },
  };
  const harness: Harness = {
    config,
    context,
    server,
    pipeline,
    email: context.email as FixtureEmailSender,
    client: (clientOptions) => new TestClient(harness, clientOptions),
    async completeRender(renderJobId) {
      const result = await runRenderJob(pipeline, { renderJobId });
      return result.state;
    },
    async close() {
      await server.close();
      await context.close();
    },
  };
  return harness;
}

/** Parses a JSON response body. */
export function json<T = Record<string, unknown>>(response: LightMyRequestResponse): T {
  return response.json() as T;
}
