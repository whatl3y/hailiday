import { z } from 'zod';
import { APP_ENVS, NormalizedBoxSchema } from '@holiday/core';
import type { AppEnv, NormalizedBox } from '@holiday/core';
import { REFUSED_ENV_NAMES } from './dotenv.js';

/** Session secret used only when `APP_ENV` is `development` or `test`. */
export const DEV_SESSION_SECRET = 'dev-only-session-secret-change-me-0123456789';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export const ADDRESS_PROVIDERS = ['fixture', 'google'] as const;
export const STREET_VIEW_PROVIDERS = ['fixture', 'google'] as const;
export const IMAGE_EDITOR_PROVIDERS = ['fixture', 'openai', 'gemini'] as const;
export const VISION_PROVIDERS = ['fixture', 'anthropic'] as const;
export const SAFETY_PROVIDERS = ['fixture'] as const;
export const EMAIL_PROVIDERS = ['smtp', 'fixture'] as const;
export const TURNSTILE_MODES = ['fixture', 'live'] as const;

/** OpenAI image edit `quality` levels Holiday configures (`OPENAI_IMAGE_QUALITY`). */
export const OPENAI_IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
/** Gemini image output size tiers (`GEMINI_IMAGE_SIZE`). */
export const GEMINI_IMAGE_SIZES = ['1K', '2K'] as const;
/** Gemini thinking levels the image models accept (`GEMINI_THINKING_LEVEL`). */
export const GEMINI_THINKING_LEVELS = ['minimal', 'medium', 'high'] as const;
/**
 * Whether the composite mask is sent to the image-edit provider (`IMAGE_EDIT_PROVIDER_MASK`):
 * `none` sends no mask, `tight` sends the placement mask to providers that take one. The local
 * paste-back in `source` lighting always uses the tight mask either way.
 */
export const IMAGE_EDIT_PROVIDER_MASKS = ['none', 'tight'] as const;
/** The live image editor `auto` selects when both keys are set (`IMAGE_EDITOR_PREFERENCE`). */
export const IMAGE_EDITOR_PREFERENCES = ['gemini', 'openai'] as const;
/**
 * The default preference: OpenAI (`gpt-image-2.5-flare` at `medium`) had the most judge-accepted
 * variants at the lowest cost per accepted variant in the bake-off; Gemini is the fallback when
 * only its key is set or when chosen.
 */
export const DEFAULT_IMAGE_EDITOR_PREFERENCE = 'openai' satisfies ImageEditorPreference;

/**
 * `auto` selects the live provider when its keys are configured and the fixture otherwise. It is
 * the default in development; test, staging and production default to `fixture`. Under
 * `APP_ENV=test`, `auto` always resolves to `fixture` and an explicit live selection is an error.
 */
export const AUTO_PROVIDER = 'auto';
export type AutoProvider = typeof AUTO_PROVIDER;

export type AddressProviderName = (typeof ADDRESS_PROVIDERS)[number];
export type StreetViewProviderName = (typeof STREET_VIEW_PROVIDERS)[number];
export type ImageEditorProviderName = (typeof IMAGE_EDITOR_PROVIDERS)[number];
export type VisionProviderName = (typeof VISION_PROVIDERS)[number];
export type SafetyProviderName = (typeof SAFETY_PROVIDERS)[number];
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];
export type TurnstileMode = (typeof TURNSTILE_MODES)[number];
export type OpenAiImageQuality = (typeof OPENAI_IMAGE_QUALITIES)[number];
export type GeminiImageSize = (typeof GEMINI_IMAGE_SIZES)[number];
export type GeminiThinkingLevel = (typeof GEMINI_THINKING_LEVELS)[number];
export type ImageEditProviderMask = (typeof IMAGE_EDIT_PROVIDER_MASKS)[number];
export type ImageEditorPreference = (typeof IMAGE_EDITOR_PREFERENCES)[number];

/** Image-edit request settings, frozen per configuration and hashed into `settingsHash`. */
export interface ImageEditSettings {
  /** Whether the composite mask is sent to the provider. */
  providerMask: ImageEditProviderMask;
  /** OpenAI `quality`. */
  openaiQuality: OpenAiImageQuality;
  /** Gemini `imageSize`. */
  geminiImageSize: GeminiImageSize;
  /** Gemini `thinkingLevel`. */
  geminiThinkingLevel: GeminiThinkingLevel;
}

/** Budget defaults: measured as the cheapest settings that kept homes photographic. */
export const DEFAULT_IMAGE_EDIT_SETTINGS: Readonly<ImageEditSettings> = Object.freeze({
  providerMask: 'none',
  openaiQuality: 'medium',
  geminiImageSize: '1K',
  geminiThinkingLevel: 'minimal',
});

/** The Vite dev server origin, allowed by the default bucket CORS only in development and test. */
const LOCAL_WEB_DEV_ORIGIN = 'http://localhost:5173';

/** Variables that must be set explicitly outside development and test. */
const REQUIRED_OUTSIDE_DEV = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'PUBLIC_BASE_URL',
  'S3_ENDPOINT',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PRIVATE_BUCKET',
  'S3_PUBLIC_BUCKET',
] as const;

/** Local development defaults, applied only when `APP_ENV` is `development` or `test`. */
const DEV_DEFAULTS: Readonly<Record<string, string>> = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5434/holiday',
  DATABASE_URL_TEST: 'postgres://postgres:postgres@localhost:5434/holiday_test',
  SESSION_SECRET: DEV_SESSION_SECRET,
  PUBLIC_BASE_URL: 'http://localhost:8080',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'holiday',
  S3_SECRET_ACCESS_KEY: 'holiday-dev-secret',
  S3_PRIVATE_BUCKET: 'holiday-private',
  S3_PUBLIC_BUCKET: 'holiday-public',
  SMTP_URL: 'smtp://localhost:1025',
};

const booleanString = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((value) => value === 'true' || value === '1' || value === 'yes');

const positiveInt = z.coerce.number().int().positive();
const nonNegativeInt = z.coerce.number().int().nonnegative();
const httpUrl = z.url({ protocol: /^https?$/ });
const optionalSecret = z.string().default('');

const EnvSchema = z.object({
  APP_ENV: z.enum(APP_ENVS).default('development'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  PORT: positiveInt.default(8080),
  PUBLIC_BASE_URL: httpUrl,
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'Expected a postgres:// URL'),
  DATABASE_URL_TEST: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'Expected a postgres:// URL')
    .optional(),
  DATABASE_POOL_MAX: positiveInt.default(10),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),

  S3_ENDPOINT: httpUrl,
  S3_PUBLIC_ENDPOINT: httpUrl.optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_PRIVATE_BUCKET: z.string().min(3),
  S3_PUBLIC_BUCKET: z.string().min(3),
  S3_FORCE_PATH_STYLE: booleanString.default(true),
  PUBLIC_ASSET_BASE_URL: httpUrl.optional(),
  STORAGE_CORS_ORIGINS: z.string().optional(),
  SIGNED_URL_TTL_S: positiveInt.max(900).default(900),
  UPLOAD_POLICY_TTL_S: positiveInt.max(300).default(300),
  UPLOAD_MAX_BYTES: positiveInt.default(26_214_400),

  SMTP_URL: z.string().regex(/^smtps?:\/\//, 'Expected an smtp:// or smtps:// URL'),
  EMAIL_FROM: z.string().min(3).default('Holiday <hello@holiday.local>'),

  ADDRESS_PROVIDER: z.enum([AUTO_PROVIDER, ...ADDRESS_PROVIDERS]).optional(),
  STREET_VIEW_PROVIDER: z.enum([AUTO_PROVIDER, ...STREET_VIEW_PROVIDERS]).optional(),
  IMAGE_EDITOR_PROVIDER: z.enum([AUTO_PROVIDER, ...IMAGE_EDITOR_PROVIDERS]).optional(),
  VISION_PROVIDER: z.enum([AUTO_PROVIDER, ...VISION_PROVIDERS]).optional(),
  SAFETY_PROVIDER: z.enum(SAFETY_PROVIDERS).default('fixture'),
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS).default('fixture'),
  TURNSTILE_MODE: z.enum(TURNSTILE_MODES).default('fixture'),

  GOOGLE_MAPS_SERVER_KEY: optionalSecret,
  GOOGLE_STREET_VIEW_BROWSER_KEY: optionalSecret,
  GOOGLE_STREET_VIEW_SIGNING_SECRET: optionalSecret,
  OPENAI_API_KEY: optionalSecret,
  OPENAI_IMAGE_MODEL: z.string().min(1).default('gpt-image-2.5-flare'),
  OPENAI_IMAGE_QUALITY: z
    .enum(OPENAI_IMAGE_QUALITIES)
    .default(DEFAULT_IMAGE_EDIT_SETTINGS.openaiQuality),
  GEMINI_API_KEY: optionalSecret,
  GEMINI_IMAGE_MODEL: z.string().min(1).default('gemini-nano-banana-2.1'),
  GEMINI_IMAGE_SIZE: z
    .enum(GEMINI_IMAGE_SIZES)
    .default(DEFAULT_IMAGE_EDIT_SETTINGS.geminiImageSize),
  GEMINI_THINKING_LEVEL: z
    .enum(GEMINI_THINKING_LEVELS)
    .default(DEFAULT_IMAGE_EDIT_SETTINGS.geminiThinkingLevel),
  IMAGE_EDITOR_PREFERENCE: z
    .enum(IMAGE_EDITOR_PREFERENCES)
    .default(DEFAULT_IMAGE_EDITOR_PREFERENCE),
  IMAGE_EDIT_PROVIDER_MASK: z
    .enum(IMAGE_EDIT_PROVIDER_MASKS)
    .default(DEFAULT_IMAGE_EDIT_SETTINGS.providerMask),
  STREET_VIEW_ATTRIBUTION_REGIONS: z.string().optional(),
  ANTHROPIC_API_KEY: optionalSecret,
  ANTHROPIC_VISION_MODEL: z.string().min(1).default('claude-opus-5-5'),
  TURNSTILE_SITE_KEY: optionalSecret,
  TURNSTILE_SECRET_KEY: optionalSecret,
  SENTRY_DSN: optionalSecret,

  OPERATOR_EMAILS: z.string().default(''),
  MAGIC_LINK_TTL_MIN: positiveInt.default(15),
  OPERATOR_REAUTH_MIN: positiveInt.default(15),

  SETTINGS_CACHE_S: nonNegativeInt.default(30),
  RENDER_HEARTBEAT_S: z.coerce.number().int().min(10).default(15),
  RENDER_MAX_JOB_DURATION_S: positiveInt.default(180),
  RENDER_REPAIR_BUDGET_S: positiveInt.default(48),
  RENDER_TRANSPORT_RETRY_LIMIT: nonNegativeInt.default(2),
  RENDER_RETRY_DELAY_S: positiveInt.default(2),
  RENDER_RETRY_DELAY_MAX_S: positiveInt.default(10),
  RENDER_WORKER_CONCURRENCY: positiveInt.default(2),
  UPLOAD_VALIDATE_MAX_DURATION_S: positiveInt.default(60),
  UPLOAD_SCREEN_MAX_DURATION_S: positiveInt.default(120),
  RENDER_QUEUE_DEPTH_MAX: nonNegativeInt.default(36),
  RENDER_MAX_WAIT_S: nonNegativeInt.default(240),

  TRUST_PROXY_HOPS: nonNegativeInt.optional(),
});

/** Every environment variable the configuration reads by exact name. */
export const CONFIG_ENV_NAMES: readonly string[] = Object.freeze(
  Object.keys(EnvSchema.shape).sort(),
);

type Env = z.infer<typeof EnvSchema>;

/** Parsed, immutable configuration shared by the API, the workers and the release scripts. */
export interface AppConfig {
  appEnv: AppEnv;
  appVersion: string;
  isProduction: boolean;
  /** True for `development` and `test`, where local defaults and fixture shortcuts apply. */
  isLocal: boolean;
  logLevel: (typeof LOG_LEVELS)[number];
  port: number;
  /**
   * Proxy hops in front of the API whose `X-Forwarded-For` entries are trusted: the client address
   * is the entry that many hops from the right. 0 (the local default) ignores the header; 1 (the
   * default elsewhere) trusts only the entry the platform router appends.
   */
  trustProxyHops: number;
  publicBaseUrl: string;
  database: { url: string; testUrl: string | null; poolMax: number };
  sessionSecret: string;
  storage: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    privateBucket: string;
    publicBucket: string;
    forcePathStyle: boolean;
    publicAssetBaseUrl: string;
    corsOrigins: string[];
    signedUrlTtlSeconds: number;
    uploadPolicyTtlSeconds: number;
    uploadMaxBytes: number;
  };
  email: { provider: EmailProviderName; smtpUrl: string; from: string };
  /** Resolved provider per leg (`auto` already resolved against the configured keys). */
  providers: ResolvedProviders;
  /** The provider selection as configured, before `auto` was resolved. */
  providerSelection: {
    address: AddressProviderName | AutoProvider;
    streetView: StreetViewProviderName | AutoProvider;
    imageEditor: ImageEditorProviderName | AutoProvider;
    vision: VisionProviderName | AutoProvider;
  };
  google: { mapsServerKey: string; streetViewBrowserKey: string; streetViewSigningSecret: string };
  streetView: {
    /**
     * Embedded attribution rectangles of live Street View Static frames, keyed by the requested
     * size (`"<width>x<height>"`), each normalized to that frame. A size with no entry has none.
     */
    attributionRegions: Readonly<Record<string, readonly NormalizedBox[]>>;
  };
  openai: { apiKey: string; imageModel: string };
  gemini: { apiKey: string; imageModel: string };
  /**
   * Image-edit request settings (passed to the prompt compiler) and the live editor `auto`
   * prefers when both the OpenAI and the Gemini key are set.
   */
  imageEdit: ImageEditSettings & { preference: ImageEditorPreference };
  anthropic: { apiKey: string; visionModel: string };
  turnstile: { mode: TurnstileMode; siteKey: string; secretKey: string };
  sentryDsn: string;
  auth: { operatorEmails: string[]; magicLinkTtlMinutes: number; operatorReauthMinutes: number };
  settingsCacheSeconds: number;
  queue: {
    renderHeartbeatSeconds: number;
    renderMaxJobDurationSeconds: number;
    renderRepairBudgetSeconds: number;
    renderTransportRetryLimit: number;
    renderRetryDelaySeconds: number;
    renderRetryDelayMaxSeconds: number;
    renderWorkerConcurrency: number;
    uploadValidateMaxDurationSeconds: number;
    uploadScreenMaxDurationSeconds: number;
  };
  admission: {
    maxQueueDepth: number;
    maxWaitSeconds: number;
    /** `<PROVIDER>_MAX_CONCURRENCY` values, keyed by lower-case provider name. */
    providerConcurrency: Record<string, number>;
  };
  /**
   * Environment overrides of runtime setting defaults: `ALLOWANCE_VARIANTS_PER_24H=5` overrides
   * `allowance.variants_per_24h` (dots become underscores, upper-cased; values are JSON).
   */
  settingOverrides: Record<string, string>;
  /** Every secret value, so the logger can scrub them from output. */
  secrets: string[];
}

export interface ResolvedProviders {
  address: AddressProviderName;
  streetView: StreetViewProviderName;
  imageEditor: ImageEditorProviderName;
  vision: VisionProviderName;
  safety: SafetyProviderName;
}

/** A configuration problem detected at startup. */
export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

type EnvSource = Readonly<Record<string, string | undefined>>;

function present(env: EnvSource, key: string): string | undefined {
  const value = env[key];
  return value === undefined || value === '' ? undefined : value;
}

type ProviderSelection = AppConfig['providerSelection'];

/** The selection per leg: the configured value, or `auto` in development and `fixture` elsewhere. */
function providerSelectionOf(env: Env): ProviderSelection {
  const fallback = env.APP_ENV === 'development' ? AUTO_PROVIDER : 'fixture';
  return {
    address: env.ADDRESS_PROVIDER ?? fallback,
    streetView: env.STREET_VIEW_PROVIDER ?? fallback,
    imageEditor: env.IMAGE_EDITOR_PROVIDER ?? fallback,
    vision: env.VISION_PROVIDER ?? fallback,
  };
}

/**
 * Resolves `auto` against the configured keys: Google address lookup needs the server key;
 * Google Street View also needs the browser key and the URL signing secret; image editing uses
 * the preferred editor (`IMAGE_EDITOR_PREFERENCE`, default OpenAI) when both keys are set and
 * otherwise whichever key is set; vision uses Anthropic when its key is set. Anything else
 * resolves to the fixture adapter. Explicit selections pass through.
 */
export function resolveProviderSelection(
  selection: ProviderSelection,
  keys: {
    googleMapsServerKey: string;
    googleStreetViewBrowserKey: string;
    googleStreetViewSigningSecret: string;
    openaiApiKey: string;
    geminiApiKey: string;
    anthropicApiKey: string;
  },
  imageEditorPreference: ImageEditorPreference = DEFAULT_IMAGE_EDITOR_PREFERENCE,
): Omit<ResolvedProviders, 'safety'> {
  const google = Boolean(keys.googleMapsServerKey);
  const editors: ImageEditorProviderName[] = [];
  if (keys.openaiApiKey) editors.push('openai');
  if (keys.geminiApiKey) editors.push('gemini');
  const autoEditor: ImageEditorProviderName = editors.includes(imageEditorPreference)
    ? imageEditorPreference
    : (editors[0] ?? 'fixture');
  const streetViewKeys =
    google &&
    Boolean(keys.googleStreetViewBrowserKey) &&
    Boolean(keys.googleStreetViewSigningSecret);
  return {
    address:
      selection.address === AUTO_PROVIDER ? (google ? 'google' : 'fixture') : selection.address,
    streetView:
      selection.streetView === AUTO_PROVIDER
        ? streetViewKeys
          ? 'google'
          : 'fixture'
        : selection.streetView,
    imageEditor: selection.imageEditor === AUTO_PROVIDER ? autoEditor : selection.imageEditor,
    vision:
      selection.vision === AUTO_PROVIDER
        ? keys.anthropicApiKey
          ? 'anthropic'
          : 'fixture'
        : selection.vision,
  };
}

/** Keys as `resolveProviderSelection` sees them; under `APP_ENV=test` they count as unset. */
function selectionKeysOf(env: Env): Parameters<typeof resolveProviderSelection>[1] {
  if (env.APP_ENV === 'test') {
    return {
      googleMapsServerKey: '',
      googleStreetViewBrowserKey: '',
      googleStreetViewSigningSecret: '',
      openaiApiKey: '',
      geminiApiKey: '',
      anthropicApiKey: '',
    };
  }
  return {
    googleMapsServerKey: env.GOOGLE_MAPS_SERVER_KEY,
    googleStreetViewBrowserKey: env.GOOGLE_STREET_VIEW_BROWSER_KEY,
    googleStreetViewSigningSecret: env.GOOGLE_STREET_VIEW_SIGNING_SECRET,
    openaiApiKey: env.OPENAI_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  };
}

/** Under `APP_ENV=test` every leg runs its fixture: an explicit live selection is an error. */
function testEnvironmentIssues(env: Env): string[] {
  if (env.APP_ENV !== 'test') return [];
  const issues: string[] = [];
  const live = (name: string, value: string | undefined) => {
    if (value !== undefined && value !== AUTO_PROVIDER && value !== 'fixture') {
      issues.push(`${name}=${value} is live, but APP_ENV=test only runs fixture providers`);
    }
  };
  live('ADDRESS_PROVIDER', env.ADDRESS_PROVIDER);
  live('STREET_VIEW_PROVIDER', env.STREET_VIEW_PROVIDER);
  live('IMAGE_EDITOR_PROVIDER', env.IMAGE_EDITOR_PROVIDER);
  live('VISION_PROVIDER', env.VISION_PROVIDER);
  live('SAFETY_PROVIDER', env.SAFETY_PROVIDER);
  live('TURNSTILE_MODE', env.TURNSTILE_MODE);
  return issues;
}

/**
 * Staging and production never run the fixture bot check (it accepts a public constant token) or
 * the fixture email sender (it stores sign-in links in the database instead of delivering them).
 */
function deployedEnvironmentIssues(env: Env, isLocal: boolean): string[] {
  if (isLocal) return [];
  const issues: string[] = [];
  if (env.TURNSTILE_MODE !== 'live') {
    issues.push(`TURNSTILE_MODE must be live when APP_ENV=${env.APP_ENV}`);
  }
  if (env.EMAIL_PROVIDER !== 'smtp') {
    issues.push(`EMAIL_PROVIDER must be smtp when APP_ENV=${env.APP_ENV}`);
  }
  return issues;
}

function liveProviderIssues(env: Env, providers: Omit<ResolvedProviders, 'safety'>): string[] {
  const issues: string[] = [];
  const need = (provider: string, keys: (keyof Env)[]) => {
    for (const key of keys) {
      if (!env[key]) issues.push(`${provider} is live but ${String(key)} is not set`);
    }
  };
  if (providers.address === 'google') {
    need('ADDRESS_PROVIDER=google', ['GOOGLE_MAPS_SERVER_KEY']);
  }
  if (providers.streetView === 'google') {
    need('STREET_VIEW_PROVIDER=google', [
      'GOOGLE_MAPS_SERVER_KEY',
      'GOOGLE_STREET_VIEW_BROWSER_KEY',
      'GOOGLE_STREET_VIEW_SIGNING_SECRET',
    ]);
  }
  if (providers.imageEditor === 'openai') need('IMAGE_EDITOR_PROVIDER=openai', ['OPENAI_API_KEY']);
  if (providers.imageEditor === 'gemini') need('IMAGE_EDITOR_PROVIDER=gemini', ['GEMINI_API_KEY']);
  if (providers.vision === 'anthropic') need('VISION_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']);
  if (env.TURNSTILE_MODE === 'live') {
    need('TURNSTILE_MODE=live', ['TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY']);
  }
  return issues;
}

/** Prefixes of runtime setting overrides (`ALLOWANCE_VARIANTS_PER_24H=5`). */
export const SETTING_ENV_PREFIXES: readonly string[] = [
  'ALLOWANCE_',
  'QUOTA_',
  'RATE_',
  'SPEND_',
  'ADMISSION_',
  'PAUSE_',
  'DISCOVERY_',
  'REVIEW_',
  'IDEMPOTENCY_',
  'SSE_',
  'POLL_',
];

/** Per-provider concurrency limits: `<PROVIDER>_MAX_CONCURRENCY`. */
export const PROVIDER_CONCURRENCY_ENV_PATTERN = /^([A-Z0-9_]+)_MAX_CONCURRENCY$/;

/** True when the configuration reads `name`, by exact name or as a setting or concurrency override. */
export function isConfigEnvName(name: string): boolean {
  return (
    CONFIG_ENV_NAMES.includes(name) ||
    SETTING_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    PROVIDER_CONCURRENCY_ENV_PATTERN.test(name)
  );
}

function collectSettingOverrides(env: EnvSource): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue;
    if (SETTING_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) overrides[key] = value;
  }
  return overrides;
}

function collectProviderConcurrency(env: EnvSource): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(env)) {
    const match = PROVIDER_CONCURRENCY_ENV_PATTERN.exec(key);
    if (!match || value === undefined || value === '') continue;
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      result[(match[1] as string).toLowerCase()] = parsed;
    }
  }
  return result;
}

/** `STREET_VIEW_ATTRIBUTION_REGIONS`: `"<width>x<height>"` to boxes normalized to that frame. */
const AttributionRegionsSchema = z.record(
  z.string().regex(/^[1-9]\d{0,4}x[1-9]\d{0,4}$/, 'keys must be "<width>x<height>"'),
  z.array(NormalizedBoxSchema),
);

/**
 * Parses `STREET_VIEW_ATTRIBUTION_REGIONS` (default: no rectangles). The rectangles are measured
 * on real frames and configured; nothing guesses them.
 */
function parseAttributionRegions(
  value: string | undefined,
  issues: string[],
): Record<string, NormalizedBox[]> {
  if (value === undefined || value.trim() === '') return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    issues.push(
      'STREET_VIEW_ATTRIBUTION_REGIONS must be JSON: an object mapping "<width>x<height>" to a list of [x0, y0, x1, y1] boxes normalized to that frame',
    );
    return {};
  }
  const parsed = AttributionRegionsSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    issues.push(
      `STREET_VIEW_ATTRIBUTION_REGIONS must map "<width>x<height>" to a list of [x0, y0, x1, y1] boxes normalized to that frame (${first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid'})`,
    );
    return {};
  }
  return parsed.data;
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Parses configuration from environment variables. Local defaults apply only when `APP_ENV` is
 * `development` or `test`; elsewhere every required value must be set, and the bot check and email
 * must be live. A live provider selected without its key is an error, and so is any live provider
 * under `APP_ENV=test` and any of the refused vendor redirect variables.
 */
export function parseConfig(source: EnvSource = process.env): AppConfig {
  const appEnvRaw = present(source, 'APP_ENV') ?? 'development';
  const isLocal = appEnvRaw === 'development' || appEnvRaw === 'test';
  const issues: string[] = [];

  const merged: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') merged[key] = value;
  }
  if (isLocal) {
    for (const [key, value] of Object.entries(DEV_DEFAULTS)) {
      if (merged[key] === undefined) merged[key] = value;
    }
  } else {
    for (const key of REQUIRED_OUTSIDE_DEV) {
      if (merged[key] === undefined) issues.push(`${key} is required when APP_ENV=${appEnvRaw}`);
    }
  }

  const parsed = EnvSchema.safeParse(merged);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push(`${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    throw new ConfigError(issues);
  }
  const env = parsed.data;
  const providerSelection = providerSelectionOf(env);
  const resolvedProviders = resolveProviderSelection(
    providerSelection,
    selectionKeysOf(env),
    env.IMAGE_EDITOR_PREFERENCE,
  );
  issues.push(...testEnvironmentIssues(env));
  issues.push(...liveProviderIssues(env, resolvedProviders));
  if (!isLocal && env.SESSION_SECRET === DEV_SESSION_SECRET) {
    issues.push('SESSION_SECRET must not be the development default outside development and test');
  }
  issues.push(...deployedEnvironmentIssues(env, isLocal));
  const attributionRegions = parseAttributionRegions(env.STREET_VIEW_ATTRIBUTION_REGIONS, issues);
  for (const name of REFUSED_ENV_NAMES) {
    if (present(source, name) !== undefined) {
      issues.push(`${name} must not be set: provider requests go only to the vendor's own host`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  const publicBaseUrl = trimSlash(env.PUBLIC_BASE_URL);
  const publicEndpoint = trimSlash(env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT);
  const corsOrigins = env.STORAGE_CORS_ORIGINS
    ? splitList(env.STORAGE_CORS_ORIGINS).map(trimSlash)
    : isLocal
      ? [...new Set([publicBaseUrl, LOCAL_WEB_DEV_ORIGIN])]
      : [publicBaseUrl];

  const config: AppConfig = {
    appEnv: env.APP_ENV,
    appVersion: env.APP_VERSION,
    isProduction: env.APP_ENV === 'production',
    isLocal,
    logLevel: env.LOG_LEVEL,
    port: env.PORT,
    trustProxyHops: env.TRUST_PROXY_HOPS ?? (isLocal ? 0 : 1),
    publicBaseUrl,
    database: {
      url: env.DATABASE_URL,
      testUrl: env.DATABASE_URL_TEST ?? null,
      poolMax: env.DATABASE_POOL_MAX,
    },
    sessionSecret: env.SESSION_SECRET,
    storage: {
      endpoint: trimSlash(env.S3_ENDPOINT),
      publicEndpoint,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      privateBucket: env.S3_PRIVATE_BUCKET,
      publicBucket: env.S3_PUBLIC_BUCKET,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      publicAssetBaseUrl: trimSlash(
        env.PUBLIC_ASSET_BASE_URL ?? `${publicEndpoint}/${env.S3_PUBLIC_BUCKET}`,
      ),
      corsOrigins,
      signedUrlTtlSeconds: env.SIGNED_URL_TTL_S,
      uploadPolicyTtlSeconds: env.UPLOAD_POLICY_TTL_S,
      uploadMaxBytes: env.UPLOAD_MAX_BYTES,
    },
    email: { provider: env.EMAIL_PROVIDER, smtpUrl: env.SMTP_URL, from: env.EMAIL_FROM },
    providers: { ...resolvedProviders, safety: env.SAFETY_PROVIDER },
    providerSelection,
    google: {
      mapsServerKey: env.GOOGLE_MAPS_SERVER_KEY,
      streetViewBrowserKey: env.GOOGLE_STREET_VIEW_BROWSER_KEY,
      streetViewSigningSecret: env.GOOGLE_STREET_VIEW_SIGNING_SECRET,
    },
    streetView: { attributionRegions },
    openai: { apiKey: env.OPENAI_API_KEY, imageModel: env.OPENAI_IMAGE_MODEL },
    gemini: { apiKey: env.GEMINI_API_KEY, imageModel: env.GEMINI_IMAGE_MODEL },
    imageEdit: {
      preference: env.IMAGE_EDITOR_PREFERENCE,
      providerMask: env.IMAGE_EDIT_PROVIDER_MASK,
      openaiQuality: env.OPENAI_IMAGE_QUALITY,
      geminiImageSize: env.GEMINI_IMAGE_SIZE,
      geminiThinkingLevel: env.GEMINI_THINKING_LEVEL,
    },
    anthropic: { apiKey: env.ANTHROPIC_API_KEY, visionModel: env.ANTHROPIC_VISION_MODEL },
    turnstile: {
      mode: env.TURNSTILE_MODE,
      siteKey: env.TURNSTILE_SITE_KEY,
      secretKey: env.TURNSTILE_SECRET_KEY,
    },
    sentryDsn: env.SENTRY_DSN,
    auth: {
      operatorEmails: splitList(env.OPERATOR_EMAILS).map((email) => email.toLowerCase()),
      magicLinkTtlMinutes: env.MAGIC_LINK_TTL_MIN,
      operatorReauthMinutes: env.OPERATOR_REAUTH_MIN,
    },
    settingsCacheSeconds: env.SETTINGS_CACHE_S,
    queue: {
      renderHeartbeatSeconds: env.RENDER_HEARTBEAT_S,
      renderMaxJobDurationSeconds: env.RENDER_MAX_JOB_DURATION_S,
      renderRepairBudgetSeconds: env.RENDER_REPAIR_BUDGET_S,
      renderTransportRetryLimit: env.RENDER_TRANSPORT_RETRY_LIMIT,
      renderRetryDelaySeconds: env.RENDER_RETRY_DELAY_S,
      renderRetryDelayMaxSeconds: env.RENDER_RETRY_DELAY_MAX_S,
      renderWorkerConcurrency: env.RENDER_WORKER_CONCURRENCY,
      uploadValidateMaxDurationSeconds: env.UPLOAD_VALIDATE_MAX_DURATION_S,
      uploadScreenMaxDurationSeconds: env.UPLOAD_SCREEN_MAX_DURATION_S,
    },
    admission: {
      maxQueueDepth: env.RENDER_QUEUE_DEPTH_MAX,
      maxWaitSeconds: env.RENDER_MAX_WAIT_S,
      providerConcurrency: collectProviderConcurrency(source),
    },
    settingOverrides: collectSettingOverrides(source),
    secrets: [
      env.SESSION_SECRET,
      env.S3_SECRET_ACCESS_KEY,
      env.GOOGLE_MAPS_SERVER_KEY,
      env.GOOGLE_STREET_VIEW_BROWSER_KEY,
      env.GOOGLE_STREET_VIEW_SIGNING_SECRET,
      env.OPENAI_API_KEY,
      env.GEMINI_API_KEY,
      env.ANTHROPIC_API_KEY,
      env.TURNSTILE_SECRET_KEY,
      env.SENTRY_DSN,
      passwordOf(env.DATABASE_URL),
      passwordOf(env.SMTP_URL),
    ].filter((secret): secret is string => typeof secret === 'string' && secret.length >= 6),
  };
  return deepFreeze(config);
}

function passwordOf(url: string): string | undefined {
  try {
    const password = new URL(url).password;
    return password ? decodeURIComponent(password) : undefined;
  } catch {
    return undefined;
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

let cached: AppConfig | null = null;

/** Parses `process.env` once and caches the result for the process. */
export function loadConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Clears the cached configuration (tests). */
export function resetConfigCache(): void {
  cached = null;
}

/** Test configuration: local defaults with the test database URL as the primary database. */
export function testConfig(overrides: EnvSource = {}): AppConfig {
  const base: Record<string, string | undefined> = {
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    EMAIL_PROVIDER: 'fixture',
    ...overrides,
  };
  const testUrl =
    present(base, 'DATABASE_URL_TEST') ??
    present(process.env, 'DATABASE_URL_TEST') ??
    DEV_DEFAULTS.DATABASE_URL_TEST;
  base.DATABASE_URL ??= testUrl;
  base.DATABASE_URL_TEST ??= testUrl;
  return parseConfig(base);
}
