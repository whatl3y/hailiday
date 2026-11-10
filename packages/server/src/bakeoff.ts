import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  DecorationPlanSchema,
  type BuildingForm,
  type CompiledRequest,
  type DecorationPlan,
  type JudgeResult,
  type RoomType,
  type SceneAnalysis,
} from '@holiday/core';
import {
  GEMINI_IMAGE_SIZES,
  GEMINI_THINKING_LEVELS,
  OPENAI_IMAGE_QUALITIES,
  parseConfig,
  type AppConfig,
  type GeminiImageSize,
  type GeminiThinkingLevel,
  type ImageEditSettings,
  type OpenAiImageQuality,
} from './config/index.js';
import { findWorkspaceRoot } from './config/dotenv.js';
import { loadContent, type Content, type ExampleContent } from './content/load.js';
import { loadPhotoLibrary, type PhotoLibrary } from './fixtures/photos.js';
import { MICROS_PER_UNIT, tokenPriceFor, usageCostMicros } from './ledger/index.js';
import { createLogger } from './logger/index.js';
import {
  compiledRecordOf,
  compilerProviderFor,
  isRelightRequest,
} from './pipeline/compile/compiler.js';
import {
  ExampleCameraChangedError,
  examplePhoto,
  renderExamplePair,
  type ExampleDaylight,
} from './pipeline/examples.js';
import { registrationRecord } from './pipeline/imaging/registration.js';
import { planAndCompile, type PlanDraft } from './pipeline/plan/index.js';
import { classifyJudge, judgeDecision } from './pipeline/render/quality.js';
import { PIPELINE_DEFAULTS, compilerVersionFor } from './pipeline/versions.js';
import { createProviders } from './providers/create.js';
import type {
  EditOutcome,
  ImageEditor,
  ProviderUsage,
  VisionCallResult,
  VisionModel,
  VisionUsage,
} from './providers/types.js';

/**
 * `pnpm models:bakeoff [--arms a,b] [--photos N] [--out dir]`: decorates the curated example
 * photographs with several live image-editing models and settings ("arms") through the app's own
 * example path (live Claude scene analysis, the pack's plan, the compiled request, the edit,
 * registration and paste-back), scores every output with the live Claude QA judge, and writes
 * per-photo comparison sheets, `results.json` and `summary.md` outside the repository. Each arm
 * selects its provider, model and request parameters for this run only; configuration files are
 * never edited. Keys come from the repository `.env` through the preload, and only their
 * presence is printed.
 */

/** The curated examples, in run order: houses, an evening relight, rooms, an entry, a balcony. */
export const CURATED_EXAMPLE_IDS: readonly string[] = Object.freeze([
  'example.christmas.house_exterior.classic.source.v1',
  'example.christmas.house_exterior.classic.evening.v1',
  'example.halloween.house_exterior.classic.source.v1',
  'example.thanksgiving_us.house_exterior.classic.source.v1',
  'example.christmas.interior.classic.source.v1',
  'example.thanksgiving_us.interior.classic.source.v1',
  'example.christmas.apartment_entry.classic.source.v1',
  'example.christmas.balcony.classic.source.v1',
]);

/** Arms run when `--arms` is not given: the configured budget defaults of both editors. */
export const DEFAULT_ARM_SPECS: readonly string[] = Object.freeze([
  'gemini-1k-minimal',
  'openai-flare-medium',
]);

export const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY = 4;
const RENDER_TIMEOUT_MS = 300_000;
const JUDGE_TIMEOUT_MS = 90_000;

export type BakeoffProvider = 'openai' | 'gemini';

/** One model-and-settings combination under test. */
export interface BakeoffArm {
  /** The normalized arm spec, for example `gemini-1k-minimal`. */
  id: string;
  label: string;
  provider: BakeoffProvider;
  model: string;
  /** Provider request parameters this arm sets on every compiled request. */
  params: Record<string, string>;
  /** Configuration overrides that select this arm's editor (applied to a copy of the env). */
  env: Record<string, string>;
}

/** An invalid command line; the message says what to change. */
export class BakeoffUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BakeoffUsageError';
  }
}

const OPENAI_FAMILIES: Readonly<Record<string, { model: string; label: string }>> = {
  sunburst: { model: 'gpt-image-2.5-sunburst', label: 'OpenAI 2.5 Sunburst' },
  flare: { model: 'gpt-image-2.5-flare', label: 'OpenAI 2.5 Flare' },
};
const GEMINI_DEFAULT_MODEL = { model: 'gemini-nano-banana-2.1', label: 'Google Nano Banana 2.1' };
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * Resolves an arm spec. Grammar: `openai-<sunburst|flare>-<low|medium|high|auto>` (OpenAI GPT
 * image 2.5 model and `quality`) or `gemini-<1k|2k>-<minimal|medium|high>` (Nano Banana 2.1
 * `image_size` and `thinking_level`), optionally followed by `@<model-id>` to run another model
 * snapshot of the same provider with those parameters. Case is ignored.
 */
export function resolveArm(spec: string): BakeoffArm {
  const normalized = spec.trim().toLowerCase();
  const [base = '', modelOverride, ...extra] = normalized.split('@');
  if (extra.length > 0 || (modelOverride !== undefined && !MODEL_ID.test(modelOverride))) {
    throw new BakeoffUsageError(`Arm "${spec}": the part after @ must be one model ID`);
  }
  const parts = base.split('-');
  if (parts.length !== 3) throw unknownArm(spec);
  const [provider, variant = '', setting = ''] = parts;
  if (provider === 'openai') {
    const family = OPENAI_FAMILIES[variant];
    if (!family || !(OPENAI_IMAGE_QUALITIES as readonly string[]).includes(setting)) {
      throw unknownArm(spec);
    }
    const model = modelOverride ?? family.model;
    return {
      id: normalized,
      label: `${modelOverride ?? family.label} · ${setting}`,
      provider: 'openai',
      model,
      params: { quality: setting },
      env: {
        IMAGE_EDITOR_PROVIDER: 'openai',
        OPENAI_IMAGE_MODEL: model,
        OPENAI_IMAGE_QUALITY: setting,
      },
    };
  }
  if (provider === 'gemini') {
    const size = variant.toUpperCase();
    if (
      !(GEMINI_IMAGE_SIZES as readonly string[]).includes(size) ||
      !(GEMINI_THINKING_LEVELS as readonly string[]).includes(setting)
    ) {
      throw unknownArm(spec);
    }
    const model = modelOverride ?? GEMINI_DEFAULT_MODEL.model;
    return {
      id: normalized,
      label: `${modelOverride ?? GEMINI_DEFAULT_MODEL.label} · ${size} · thinking ${setting}`,
      provider: 'gemini',
      model,
      params: { image_size: size, thinking_level: setting },
      env: {
        IMAGE_EDITOR_PROVIDER: 'gemini',
        GEMINI_IMAGE_MODEL: model,
        GEMINI_IMAGE_SIZE: size,
        GEMINI_THINKING_LEVEL: setting,
      },
    };
  }
  throw unknownArm(spec);
}

/**
 * The request settings an arm's renders compile with: the configured settings (the provider mask
 * policy above all), with the arm's own OpenAI quality or Gemini size and thinking level.
 */
export function armImageEdit(
  configured: Partial<ImageEditSettings>,
  arm: Pick<BakeoffArm, 'params'>,
): Partial<ImageEditSettings> {
  const settings: Partial<ImageEditSettings> = {
    ...(configured.providerMask !== undefined ? { providerMask: configured.providerMask } : {}),
    ...(configured.openaiQuality !== undefined ? { openaiQuality: configured.openaiQuality } : {}),
    ...(configured.geminiImageSize !== undefined
      ? { geminiImageSize: configured.geminiImageSize }
      : {}),
    ...(configured.geminiThinkingLevel !== undefined
      ? { geminiThinkingLevel: configured.geminiThinkingLevel }
      : {}),
  };
  const { quality, image_size: size, thinking_level: thinking } = arm.params;
  if (quality !== undefined) settings.openaiQuality = quality as OpenAiImageQuality;
  if (size !== undefined) settings.geminiImageSize = size as GeminiImageSize;
  if (thinking !== undefined) settings.geminiThinkingLevel = thinking as GeminiThinkingLevel;
  return settings;
}

function unknownArm(spec: string): BakeoffUsageError {
  return new BakeoffUsageError(
    `Unknown arm "${spec}". Use openai-<sunburst|flare>-<${OPENAI_IMAGE_QUALITIES.join('|')}> or ` +
      `gemini-<1k|2k>-<${GEMINI_THINKING_LEVELS.join('|')}>, optionally followed by @<model-id>.`,
  );
}

export interface BakeoffOptions {
  arms: BakeoffArm[];
  /** How many of the curated examples to run, in order. */
  photos: number;
  /** Absolute output folder (outside the repository). */
  out: string;
  concurrency: number;
  /** Score outputs with the Claude judge (when Anthropic is configured). */
  judge: boolean;
  /** Also keep each raw model output and any mask sent to the provider. */
  saveRaw: boolean;
  help: boolean;
}

export const BAKEOFF_USAGE = `Usage: pnpm models:bakeoff [options]

  --arms <list>       Comma-separated arms (default ${DEFAULT_ARM_SPECS.join(',')}).
                      openai-<sunburst|flare>-<low|medium|high|auto>
                      gemini-<1k|2k>-<minimal|medium|high>
                      Append @<model-id> to run another snapshot with the same settings.
  --photos <n>        Run the first n of the ${CURATED_EXAMPLE_IDS.length} curated example photos (default ${CURATED_EXAMPLE_IDS.length}).
  --out <dir>         Output folder outside the repository (default: a new folder in the system temp directory).
  --concurrency <n>   Renders in flight per arm, 1 to ${MAX_CONCURRENCY} (default ${DEFAULT_CONCURRENCY}).
  --no-judge          Skip the Claude QA judge.
  --save-raw          Also keep each raw model output and any mask sent to the provider.
  --help              Show this text.

Every arm calls a paid provider. Keys are read only from the repository .env.`;

function timestampSlug(now: Date): string {
  return now
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Parses the command line (pnpm may forward a literal `--`, which is skipped). `--out` must lie
 * outside the repository; the default is `holiday-bakeoff-<UTC timestamp>` in the temp directory.
 */
export function parseBakeoffArgs(
  argv: readonly string[],
  context: { tmpDir: string; now: Date; workspaceRoot: string | null; cwd: string },
): BakeoffOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const withValue = new Set(['--arms', '--photos', '--out', '--concurrency']);
  const switches = new Set(['--no-judge', '--save-raw', '--help', '-h']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--') continue;
    const eq = token.indexOf('=');
    const name = token.startsWith('--') && eq > 0 ? token.slice(0, eq) : token;
    if (withValue.has(name)) {
      const inline = name !== token;
      const value = inline ? token.slice(eq + 1) : argv[(index += 1)];
      if (value === undefined || value === '' || (!inline && value.startsWith('--'))) {
        throw new BakeoffUsageError(`${name} needs a value`);
      }
      if (values.has(name)) throw new BakeoffUsageError(`${name} is given twice`);
      values.set(name, value);
    } else if (switches.has(token)) {
      flags.add(token === '-h' ? '--help' : token);
    } else {
      throw new BakeoffUsageError(`Unknown option "${token}"`);
    }
  }

  const specs = (values.get('--arms') ?? DEFAULT_ARM_SPECS.join(','))
    .split(',')
    .map((spec) => spec.trim())
    .filter((spec) => spec.length > 0);
  if (specs.length === 0) throw new BakeoffUsageError('--arms names no arm');
  const arms = specs.map(resolveArm);
  const seen = new Set<string>();
  for (const arm of arms) {
    if (seen.has(arm.id)) throw new BakeoffUsageError(`Arm ${arm.id} is listed twice`);
    seen.add(arm.id);
  }

  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = values.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || value < min || value > max) {
      throw new BakeoffUsageError(`${name} must be a whole number from ${min} to ${max}`);
    }
    return value;
  };
  const photos = integer('--photos', CURATED_EXAMPLE_IDS.length, 1, CURATED_EXAMPLE_IDS.length);
  const concurrency = integer('--concurrency', DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);

  const rawOut = values.get('--out');
  const out = rawOut
    ? path.resolve(context.cwd, rawOut)
    : path.join(context.tmpDir, `holiday-bakeoff-${timestampSlug(context.now)}`);
  if (context.workspaceRoot && isInside(path.resolve(context.workspaceRoot), out)) {
    throw new BakeoffUsageError(
      `--out ${out} is inside the repository; choose a folder outside it (the default is in the system temp directory)`,
    );
  }
  return {
    arms,
    photos,
    out,
    concurrency,
    judge: !flags.has('--no-judge'),
    saveRaw: flags.has('--save-raw'),
    help: flags.has('--help'),
  };
}

// ---- cost ---------------------------------------------------------------------------------------

/**
 * Cost of one image edit in USD from the usage the adapter reported, at the ledger's prices (the
 * single price source; OpenAI input split into text and image tokens when the usage carries the
 * split, Gemini thinking tokens at the output price), or null when the model has no price for
 * the arm's provider. A call without usage costs 0.
 */
export function imageEditCostUsd(
  provider: BakeoffProvider,
  model: string,
  usage: ProviderUsage | null | undefined,
): number | null {
  if (!tokenPriceFor(model, provider)) return null;
  if (!usage) return 0;
  const micros = usageCostMicros(model, {
    ...usage,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  });
  return micros === null ? null : micros / MICROS_PER_UNIT;
}

/** Cost of one or more Claude calls in USD at the ledger's prices, or null without a price. */
export function claudeCostUsd(model: string, usage: VisionUsage): number | null {
  if (!tokenPriceFor(model, 'anthropic')) return null;
  const micros = usageCostMicros(model, usage);
  return micros === null ? null : micros / MICROS_PER_UNIT;
}

// ---- run ----------------------------------------------------------------------------------------

export interface KeyPresence {
  openai: boolean;
  gemini: boolean;
  anthropic: boolean;
}

/** Which provider keys are set; never the values. */
export function keyPresence(env: Readonly<Record<string, string | undefined>>): KeyPresence {
  return {
    openai: Boolean(env.OPENAI_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
    anthropic: Boolean(env.ANTHROPIC_API_KEY),
  };
}

export interface JudgeRecord {
  decision: 'pass' | 'uncertain' | 'reject';
  critical: string[];
  uncertain: string[];
  major: string[];
  scores: JudgeResult['scores'];
  /** Planned placements the judge found present, and present with every adherence check met. */
  placementsPresent: number;
  placementsAdherent: number;
  placementsPlanned: number;
  model: string;
  usd: number | null;
  seconds: number;
}

export interface RunRecord {
  arm: string;
  exampleId: string;
  photoId: string;
  ok: boolean;
  /** Why the run produced no image: the editor's failure kind, `camera_changed` or `error`. */
  failure?: string;
  providerCode?: string;
  providerMessage?: string;
  error?: string;
  placements?: number;
  alignment?: Record<string, unknown>;
  usage?: Pick<
    ProviderUsage,
    'inputTokens' | 'outputTokens' | 'inputTextTokens' | 'inputImageTokens' | 'thoughtsTokens'
  > | null;
  editUsd: number | null;
  editSeconds: number | null;
  totalSeconds: number;
  judge?: JudgeRecord;
  /** Why the output was not judged. */
  judgeSkipped?: string;
}

export interface ArmSummary {
  arm: string;
  label: string;
  provider: BakeoffProvider;
  model: string;
  runs: number;
  ok: number;
  failed: number;
  judged: number;
  accepted: number;
  avgEditUsd: number | null;
  avgEditSeconds: number | null;
  avgTotalSeconds: number | null;
  avgJudgeUsd: number | null;
  /** Edit and judge spend over every run of the arm, divided by the accepted outputs. */
  usdPerAcceptedVariant: number | null;
  failures: Record<string, number>;
  codes: Record<string, number>;
}

export interface AnalysisRecord {
  photoId: string;
  sceneType: string;
  model: string;
  usd: number | null;
  seconds: number;
}

export interface BakeoffReport {
  generatedAt: string;
  keys: KeyPresence;
  vision: 'live' | 'fixture';
  judged: boolean;
  arms: BakeoffArm[];
  skippedArms: { arm: string; reason: string }[];
  examples: string[];
  analyses: AnalysisRecord[];
  analysisUsd: number;
  summary: ArmSummary[];
  records: RunRecord[];
  sheets: string[];
  out: string;
}

const average = (values: number[]): number | null =>
  values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

const tally = (keys: string[]): Record<string, number> => {
  const result: Record<string, number> = {};
  for (const key of keys) result[key] = (result[key] ?? 0) + 1;
  return result;
};

/** Per-arm totals over the run records. */
export function summarizeArms(
  arms: readonly BakeoffArm[],
  records: readonly RunRecord[],
): ArmSummary[] {
  return arms.map((arm) => {
    const runs = records.filter((record) => record.arm === arm.id);
    const ok = runs.filter((record) => record.ok);
    const judged = ok.filter((record) => record.judge);
    const accepted = judged.filter((record) => record.judge?.decision === 'pass');
    const spend = runs.reduce(
      (sum, record) => sum + (record.editUsd ?? 0) + (record.judge?.usd ?? 0),
      0,
    );
    return {
      arm: arm.id,
      label: arm.label,
      provider: arm.provider,
      model: arm.model,
      runs: runs.length,
      ok: ok.length,
      failed: runs.length - ok.length,
      judged: judged.length,
      accepted: accepted.length,
      avgEditUsd: average(
        ok.map((record) => record.editUsd).filter((usd): usd is number => usd !== null),
      ),
      avgEditSeconds: average(
        ok.map((record) => record.editSeconds).filter((s): s is number => s !== null),
      ),
      avgTotalSeconds: average(ok.map((record) => record.totalSeconds)),
      avgJudgeUsd: average(
        judged
          .map((record) => record.judge?.usd)
          .filter((usd): usd is number => typeof usd === 'number'),
      ),
      usdPerAcceptedVariant: accepted.length > 0 ? spend / accepted.length : null,
      failures: tally(
        runs.filter((record) => !record.ok).map((record) => record.failure ?? 'error'),
      ),
      codes: tally(
        judged.flatMap((record) => [
          ...(record.judge?.critical ?? []),
          ...(record.judge?.major ?? []),
          ...(record.judge?.uncertain ?? []).map((code) => `${code}?`),
        ]),
      ),
    };
  });
}

const usd = (value: number | null | undefined, digits = 3): string =>
  value === null || value === undefined ? '—' : `$${value.toFixed(digits)}`;
const secs = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${value.toFixed(1)} s`;
const codeList = (codes: Record<string, number>): string =>
  Object.entries(codes)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code} ×${n}`)
    .join(', ') || '—';

function cellFor(record: RunRecord | undefined): string {
  if (!record) return '—';
  if (!record.ok) return `failed: ${record.failure ?? 'error'}`;
  const cost = usd(record.editUsd);
  if (!record.judge) return `${cost} (not judged)`;
  const codes = [
    ...record.judge.critical,
    ...record.judge.major,
    ...record.judge.uncertain.map((c) => `${c}?`),
  ];
  return `${record.judge.decision}${codes.length ? ` (${codes.join(', ')})` : ''} · ${cost}`;
}

/** The human-readable summary written next to `results.json`. */
export function summaryMarkdown(report: BakeoffReport): string {
  const lines: string[] = [];
  lines.push(`# Model bake-off ${report.generatedAt}`, '');
  lines.push(
    `Keys present: OpenAI ${report.keys.openai ? 'yes' : 'no'}, Gemini ${report.keys.gemini ? 'yes' : 'no'}, Anthropic ${report.keys.anthropic ? 'yes' : 'no'}. ` +
      (report.vision === 'live'
        ? 'Scene analysis: live Claude, one analysis per photo shared by every arm.'
        : 'Scene analysis: the photo manifest anchors (Anthropic not configured).') +
      ' ' +
      (report.judged
        ? 'Every output was scored by the live Claude QA judge.'
        : 'Outputs were not judged.'),
    '',
  );
  lines.push(
    '| Arm | Model | OK | Accepted | Edit $/image | Judge $/image | $ per accepted variant | Edit time | Total time | Judge codes | Failures |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  );
  for (const s of report.summary) {
    lines.push(
      `| ${s.label} | \`${s.model}\` | ${s.ok}/${s.runs} | ${report.judged ? `${s.accepted}/${s.judged}` : '—'} | ${usd(s.avgEditUsd)} | ${usd(s.avgJudgeUsd)} | ${usd(s.usdPerAcceptedVariant)} | ${secs(s.avgEditSeconds)} | ${secs(s.avgTotalSeconds)} | ${codeList(s.codes)} | ${codeList(s.failures)} |`,
    );
  }
  for (const skipped of report.skippedArms) {
    lines.push('', `Skipped ${skipped.arm}: ${skipped.reason}.`);
  }
  lines.push('', '## Per photo', '');
  lines.push(
    `| Example | ${report.summary.map((s) => s.arm).join(' | ')} |`,
    `| --- | ${report.summary.map(() => '---').join(' | ')} |`,
  );
  for (const exampleId of report.examples) {
    const cells = report.summary.map((s) =>
      cellFor(report.records.find((r) => r.arm === s.arm && r.exampleId === exampleId)),
    );
    lines.push(`| ${exampleId} | ${cells.join(' | ')} |`);
  }
  lines.push(
    '',
    `Claude analyses: ${report.analyses.length}, ${usd(report.analysisUsd)} in total (once per photo, not included in the per-variant figures).`,
    '',
    'Costs are computed from the token usage each provider reported, at the list prices in docs/research/image-ai-providers.md. "Accepted" means the judge found no critical or major code at the production thresholds; "?" marks an uncertain critical code. The cost per accepted variant divides the edit and judge spend of every run, failed ones included, by the accepted outputs.',
    '',
  );
  if (report.sheets.length > 0) {
    lines.push('## Sheets', '', ...report.sheets.map((sheet) => `- ${path.basename(sheet)}`), '');
  }
  return lines.join('\n');
}

/** Runs `fn` over `items` with at most `size` in flight. */
async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(size, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

/**
 * Shares one scene analysis per photo (the same pixels, scene type and attribute) across arms
 * and examples, and reports each analysis once.
 */
function sharedAnalysisVision(
  vision: VisionModel,
  onAnalysis: (input: { sceneType: string }, result: VisionCallResult<SceneAnalysis>) => void,
  analyses: Map<string, SceneAnalysis>,
): VisionModel {
  const cache = new Map<string, Promise<VisionCallResult<SceneAnalysis>>>();
  return {
    providerId: vision.providerId,
    mode: vision.mode,
    classifyUpload: (input, options) => vision.classifyUpload(input, options),
    judge: (input, options) => vision.judge(input, options),
    localizeAdditions: (input, options) => vision.localizeAdditions(input, options),
    async analyzeScene(input, options) {
      const key = [
        input.image.checksum,
        input.sceneType,
        input.roomType ?? '',
        input.buildingForm ?? '',
      ].join('|');
      let pending = cache.get(key);
      if (!pending) {
        pending = vision.analyzeScene(input, options);
        cache.set(key, pending);
        pending.then(
          (result) => onAnalysis(input, result),
          () => cache.delete(key),
        );
      }
      const shared = await pending;
      const result = { ...shared.result, sourceAssetId: input.sourceAssetId };
      analyses.set(input.sourceAssetId, result);
      return { ...shared, result };
    },
  };
}

interface EditCapture {
  request?: CompiledRequest;
  mask?: Uint8Array;
  outcome?: EditOutcome;
  editMs?: number;
}

/** The arm's editor: its request parameters on every compiled request, with the call captured. */
function armEditor(editor: ImageEditor, arm: BakeoffArm, capture: EditCapture): ImageEditor {
  const cancel = editor.cancel?.bind(editor);
  return {
    providerId: editor.providerId,
    mode: editor.mode,
    capabilities: editor.capabilities,
    getOperation: (operationId) => editor.getOperation(operationId),
    ...(cancel ? { cancel } : {}),
    async edit(request, input, options) {
      const sent: CompiledRequest = {
        ...request,
        parameters: { ...request.parameters, ...arm.params },
      };
      capture.request = sent;
      if (input.mask) capture.mask = input.mask;
      const started = performance.now();
      const outcome = await editor.edit(sent, input, options);
      capture.editMs = performance.now() - started;
      capture.outcome = outcome;
      return outcome;
    },
  };
}

export interface BakeoffDeps {
  content: Content;
  library?: PhotoLibrary;
  examples: readonly ExampleContent[];
  arms: readonly BakeoffArm[];
  /** The live editor for an arm, or a reason it cannot run. */
  editorFor(arm: BakeoffArm): ImageEditor | { skip: string };
  /** Live Claude for analysis and judging; a fixture model analyzes from the photo manifest. */
  vision: VisionModel;
  /**
   * The configured request settings (`AppConfig.imageEdit`); each arm overrides its quality,
   * size and thinking level (`armImageEdit`).
   */
  imageEdit?: Partial<ImageEditSettings>;
  judge: boolean;
  out: string;
  concurrency: number;
  saveRaw: boolean;
  keys: KeyPresence;
  log(line: string): void;
  now?: () => Date;
}

const TILE_W = 768;
const TILE_H = 512;
const BAR = 40;
const escapeXml = (text: string) =>
  text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

async function tile(image: Uint8Array, label: string): Promise<Buffer> {
  const picture = await sharp(image).resize(TILE_W, TILE_H, { fit: 'cover' }).toBuffer();
  const bar = Buffer.from(
    `<svg width="${TILE_W}" height="${BAR}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#1d1a16"/><text x="12" y="26" font-family="Helvetica, Arial, sans-serif" font-size="16" fill="#ffffff">${escapeXml(label)}</text></svg>`,
  );
  return sharp({
    create: { width: TILE_W, height: TILE_H + BAR, channels: 3, background: '#1d1a16' },
  })
    .composite([
      { input: bar, top: 0, left: 0 },
      { input: picture, top: BAR, left: 0 },
    ])
    .jpeg({ quality: 86 })
    .toBuffer();
}

async function writeSheet(file: string, tiles: Buffer[]): Promise<void> {
  const cols = 2;
  const rows = Math.ceil(tiles.length / cols);
  await sharp({
    create: {
      width: cols * TILE_W,
      height: rows * (TILE_H + BAR),
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite(
      tiles.map((input, i) => ({
        input,
        left: (i % cols) * TILE_W,
        top: Math.floor(i / cols) * (TILE_H + BAR),
      })),
    )
    .jpeg({ quality: 84 })
    .toFile(file);
}

const safeName = (text: string) => text.replace(/[^a-zA-Z0-9._-]+/g, '_');

/**
 * Runs every arm over the examples, judges each output, and writes the sheets, `results.json`
 * and `summary.md` to `deps.out`. Arms run one after another; examples within an arm run with
 * `deps.concurrency` in flight, daylight examples first, so an evening example relights its arm's
 * daylight composite of the same photo (as an evening variant relights the accepted daylight
 * variant) and is judged in relight mode against it.
 */
export async function runBakeoff(deps: BakeoffDeps): Promise<BakeoffReport> {
  const now = deps.now ?? (() => new Date());
  const library = deps.library ?? loadPhotoLibrary();
  await mkdir(deps.out, { recursive: true });
  const analysisRecords: AnalysisRecord[] = [];
  const analyses = new Map<string, SceneAnalysis>();
  const photoOf = new Map(deps.examples.map((e) => [e.exampleId, examplePhoto(e, library).id]));
  const vision = sharedAnalysisVision(
    deps.vision,
    (input, result) =>
      analysisRecords.push({
        photoId: photoOf.get(result.result.sourceAssetId) ?? result.result.sourceAssetId,
        sceneType: input.sceneType,
        model: result.model,
        usd: deps.vision.mode === 'live' ? claudeCostUsd(result.model, result.usage) : 0,
        seconds: result.elapsedMs / 1000,
      }),
    analyses,
  );
  const judging = deps.judge && deps.vision.mode === 'live';
  const records: RunRecord[] = [];
  const outputs = new Map<
    string,
    { before: Buffer; after: Buffer; relightBase?: { image: Buffer; plan: PlanDraft } }
  >();
  const ranArms: BakeoffArm[] = [];
  const skippedArms: { arm: string; reason: string }[] = [];

  const runOne = async (
    arm: BakeoffArm,
    editor: ImageEditor,
    example: ExampleContent,
    daylight: Map<string, ExampleDaylight>,
  ) => {
    const capture: EditCapture = {};
    const record: RunRecord = {
      arm: arm.id,
      exampleId: example.exampleId,
      photoId: photoOf.get(example.exampleId) ?? '',
      ok: false,
      editUsd: null,
      editSeconds: null,
      totalSeconds: 0,
    };
    const started = performance.now();
    const dir = path.join(deps.out, safeName(example.exampleId));
    await mkdir(dir, { recursive: true });
    const wrapped = armEditor(editor, arm, capture);
    try {
      const pair = await renderExamplePair(
        {
          content: deps.content,
          imageEditor: wrapped,
          vision,
          styleKitVersionId: 'bakeoff',
          modelSnapshot: arm.model,
          library,
          timeoutMs: RENDER_TIMEOUT_MS,
          imageEdit: armImageEdit(deps.imageEdit ?? {}, arm),
          daylight,
        },
        example,
      );
      record.ok = true;
      record.placements = pair.placements;
      record.alignment = registrationRecord(pair.alignment);
      outputs.set(`${arm.id}|${example.exampleId}`, {
        before: pair.before,
        after: pair.after,
        ...(pair.relightBase ? { relightBase: pair.relightBase } : {}),
      });
      await writeFile(path.join(dir, 'before.jpg'), pair.before);
      await writeFile(path.join(dir, `${safeName(arm.id)}.jpg`), pair.after);
    } catch (error) {
      if (error instanceof ExampleCameraChangedError) {
        record.failure = 'camera_changed';
        record.alignment = registrationRecord(error.alignment);
      } else if (capture.outcome && capture.outcome.status === 'failed') {
        record.failure = capture.outcome.kind;
        if (capture.outcome.providerCode) record.providerCode = capture.outcome.providerCode;
        if (capture.outcome.providerMessage) {
          record.providerMessage = capture.outcome.providerMessage;
        }
      } else {
        record.failure = 'error';
      }
      record.error = String(error instanceof Error ? error.message : error).slice(0, 300);
    }
    record.totalSeconds = (performance.now() - started) / 1000;
    if (capture.editMs !== undefined) record.editSeconds = capture.editMs / 1000;
    if (capture.outcome?.status === 'completed') {
      const used = capture.outcome.usage;
      record.usage = {
        ...(used.inputTokens !== undefined ? { inputTokens: used.inputTokens } : {}),
        ...(used.outputTokens !== undefined ? { outputTokens: used.outputTokens } : {}),
        ...(used.inputTextTokens !== undefined ? { inputTextTokens: used.inputTextTokens } : {}),
        ...(used.inputImageTokens !== undefined ? { inputImageTokens: used.inputImageTokens } : {}),
        ...(used.thoughtsTokens !== undefined ? { thoughtsTokens: used.thoughtsTokens } : {}),
      };
      record.editUsd = imageEditCostUsd(arm.provider, arm.model, capture.outcome.usage);
      if (deps.saveRaw) {
        await writeFile(
          path.join(
            dir,
            `${safeName(arm.id)}.raw.${capture.outcome.format === 'jpeg' ? 'jpg' : capture.outcome.format}`,
          ),
          capture.outcome.image,
        );
      }
    }
    if (deps.saveRaw && capture.mask) {
      await writeFile(path.join(dir, `${safeName(arm.id)}.mask.png`), capture.mask);
    }
    if (record.ok) {
      if (!judging) record.judgeSkipped = deps.judge ? 'anthropic_not_configured' : 'disabled';
      else await judgeRun(arm, example, editor, capture, record);
    }
    deps.log(
      `${record.ok ? 'ok  ' : 'FAIL'} ${arm.id} ${example.exampleId} ${record.totalSeconds.toFixed(1)}s ${usd(record.editUsd, 4)}` +
        (record.judge ? ` judge=${record.judge.decision}` : '') +
        (record.ok
          ? ''
          : ` ${record.failure}${record.providerCode ? ` ${record.providerCode}` : ''}`),
    );
    records.push(record);
  };

  const judgeRun = async (
    arm: BakeoffArm,
    example: ExampleContent,
    editor: ImageEditor,
    capture: EditCapture,
    record: RunRecord,
  ) => {
    const request = capture.request;
    const analysis = analyses.get(example.exampleId);
    const output = outputs.get(`${arm.id}|${example.exampleId}`);
    const working = request?.images[0];
    if (!request || !analysis || !output || !working) {
      record.judgeSkipped = 'no_plan';
      return;
    }
    if (Math.abs(working.width / working.height - example.width / example.height) > 1e-3) {
      record.judgeSkipped = 'aspect_differs';
      return;
    }
    const pack = deps.content.packFor(example.holidayId);
    if (!pack) {
      record.judgeSkipped = 'no_pack';
      return;
    }
    let plan: DecorationPlan;
    if (isRelightRequest(request)) {
      // An evening example relit its daylight composite: the plan is that composite's plan in
      // evening lighting, and the judge compares the relit output with the composite.
      if (!output.relightBase) {
        record.judgeSkipped = 'no_plan';
        return;
      }
      plan = DecorationPlanSchema.parse({
        ...output.relightBase.plan,
        lightingMode: 'evening',
        fidelityMode: 'global_relight',
        lightingInstruction: {
          mode: 'evening',
          text: 'Relight the daylight composite to early evening: dusk ambient light, the decorations’ own lights glowing, existing windows and porch or room lights on; nothing else changes.',
        },
        compiled: compiledRecordOf(request),
      });
    } else {
      // The same plan the example path compiled: planning is deterministic for the same inputs,
      // and the compiled instruction is compared to the one the editor received.
      const source = example.source as { roomType?: RoomType; buildingForm?: BuildingForm };
      const provider = compilerProviderFor(editor.providerId);
      const planned = planAndCompile(
        {
          renderJobId: example.exampleId,
          planVersion: 1,
          sourceAssetId: example.exampleId,
          sceneAnalysisId: example.exampleId,
          analysis,
          sourceKind: 'upload',
          pack: pack.pack,
          holidayPackVersion: pack.version,
          styleKitVersionId: 'bakeoff',
          sceneType: example.sceneType,
          buildingForm: source.buildingForm ?? null,
          roomType: source.roomType ?? null,
          style: example.style,
          lightingMode: example.lightingMode,
          compilerVersion: compilerVersionFor(provider),
          permissionEvaluationId: `example:${example.exampleId}`,
        },
        () => ({
          provider,
          modelSnapshot: request.modelSnapshot,
          working,
          mask: null,
          supportsMask: false,
        }),
      );
      if (!planned.compile || planned.compile.request.instructionText !== request.instructionText) {
        record.judgeSkipped = 'plan_mismatch';
        return;
      }
      plan = DecorationPlanSchema.parse({
        ...planned.built.draft,
        compiled: { ...planned.compile.compiled, parameters: request.parameters },
      });
    }
    const started = performance.now();
    try {
      const result = await vision.judge(
        {
          renderAttemptId: `bakeoff-${arm.id}-${example.exampleId}`,
          original: { bytes: output.before, width: example.width, height: example.height },
          candidate: { bytes: output.after, width: example.width, height: example.height },
          plan,
          ...(output.relightBase && isRelightRequest(request)
            ? {
                mode: 'relight' as const,
                base: {
                  bytes: output.relightBase.image,
                  width: example.width,
                  height: example.height,
                },
              }
            : {}),
        },
        { timeoutMs: JUDGE_TIMEOUT_MS },
      );
      const classification = classifyJudge(result.result, PIPELINE_DEFAULTS.judgeThresholds);
      const plannedIds = new Set(plan.placements.map((placement) => placement.id));
      const findings = result.result.placements.filter((p) => plannedIds.has(p.placementId));
      record.judge = {
        decision: judgeDecision(classification),
        critical: classification.critical,
        uncertain: classification.uncertain,
        major: classification.major,
        scores: result.result.scores,
        placementsPresent: findings.filter((p) => p.present).length,
        placementsAdherent: findings.filter(
          (p) =>
            p.present &&
            p.adherence.category &&
            p.adherence.colorFamily &&
            p.adherence.count === 'pass' &&
            p.adherence.scale === 'ok',
        ).length,
        placementsPlanned: plan.placements.length,
        model: result.model,
        usd: claudeCostUsd(result.model, result.usage),
        seconds: (performance.now() - started) / 1000,
      };
    } catch (error) {
      record.judgeSkipped = `judge_failed: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`;
    }
  };

  for (const arm of deps.arms) {
    const editor = deps.editorFor(arm);
    if ('skip' in editor) {
      skippedArms.push({ arm: arm.id, reason: editor.skip });
      deps.log(`skip ${arm.id}: ${editor.skip}`);
      continue;
    }
    ranArms.push(arm);
    deps.log(`arm ${arm.id}: ${arm.label} (${arm.model})`);
    const daylight = new Map<string, ExampleDaylight>();
    const evening = (example: ExampleContent) => example.lightingMode === 'evening';
    for (const phase of [
      deps.examples.filter((example) => !evening(example)),
      deps.examples.filter(evening),
    ]) {
      await pool(phase, deps.concurrency, (example) => runOne(arm, editor, example, daylight));
    }
  }

  const summary = summarizeArms(ranArms, records);
  const sheets: string[] = [];
  for (const example of deps.examples) {
    const first = ranArms
      .map((arm) => outputs.get(`${arm.id}|${example.exampleId}`))
      .find((output) => output !== undefined);
    if (!first) continue;
    const tiles = [
      await tile(
        first.before,
        `Before · ${example.holidayId} · ${example.sceneType} · ${example.lightingMode}`,
      ),
    ];
    for (const arm of ranArms) {
      const output = outputs.get(`${arm.id}|${example.exampleId}`);
      const record = records.find((r) => r.arm === arm.id && r.exampleId === example.exampleId);
      if (!output || !record) continue;
      tiles.push(
        await tile(
          output.after,
          `${arm.label} · ${usd(record.editUsd)} · ${secs(record.editSeconds)}` +
            (record.judge ? ` · ${record.judge.decision}` : ''),
        ),
      );
    }
    const sheet = path.join(deps.out, `sheet-${safeName(example.exampleId)}.jpg`);
    await writeSheet(sheet, tiles);
    sheets.push(sheet);
  }

  const order = new Map(deps.examples.map((e, i) => [e.exampleId, i]));
  const armOrder = new Map(ranArms.map((a, i) => [a.id, i]));
  records.sort(
    (a, b) =>
      (armOrder.get(a.arm) ?? 0) - (armOrder.get(b.arm) ?? 0) ||
      (order.get(a.exampleId) ?? 0) - (order.get(b.exampleId) ?? 0),
  );
  const report: BakeoffReport = {
    generatedAt: now().toISOString(),
    keys: deps.keys,
    vision: deps.vision.mode,
    judged: judging,
    arms: ranArms,
    skippedArms,
    examples: deps.examples.map((example) => example.exampleId),
    analyses: analysisRecords,
    analysisUsd: analysisRecords.reduce((sum, record) => sum + (record.usd ?? 0), 0),
    summary,
    records,
    sheets,
    out: deps.out,
  };
  await writeFile(path.join(deps.out, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(deps.out, 'summary.md'), summaryMarkdown(report));
  return report;
}

// ---- command ------------------------------------------------------------------------------------

/** Every leg the bake-off does not test stays on its fixture. */
const FIXED_LEGS = {
  ADDRESS_PROVIDER: 'fixture',
  STREET_VIEW_PROVIDER: 'fixture',
  SAFETY_PROVIDER: 'fixture',
  TURNSTILE_MODE: 'fixture',
  EMAIL_PROVIDER: 'fixture',
} as const;

function configWith(overrides: Record<string, string>): AppConfig {
  return parseConfig({ ...process.env, ...FIXED_LEGS, ...overrides });
}

async function main(argv: readonly string[]): Promise<number> {
  let options: BakeoffOptions;
  try {
    options = parseBakeoffArgs(argv, {
      tmpDir: os.tmpdir(),
      now: new Date(),
      workspaceRoot: findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url))),
      // pnpm runs the script in the package folder; a relative --out is read from where the
      // command was typed.
      cwd: process.env.INIT_CWD ?? process.cwd(),
    });
  } catch (error) {
    if (error instanceof BakeoffUsageError) {
      console.error(`${error.message}\n\n${BAKEOFF_USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    console.log(BAKEOFF_USAGE);
    return 0;
  }
  const keys = keyPresence(process.env);
  console.log(
    `keys present: openai=${keys.openai ? 'yes' : 'no'} gemini=${keys.gemini ? 'yes' : 'no'} anthropic=${keys.anthropic ? 'yes' : 'no'}`,
  );
  if (!options.arms.some((arm) => keys[arm.provider])) {
    console.error(
      'None of the chosen arms has its key in .env (OPENAI_API_KEY for openai-*, GEMINI_API_KEY for gemini-*).',
    );
    return 2;
  }
  const base = configWith({
    IMAGE_EDITOR_PROVIDER: 'fixture',
    VISION_PROVIDER: keys.anthropic ? 'anthropic' : 'fixture',
  });
  const logger = createLogger({ level: 'warn', name: 'bakeoff', secrets: base.secrets });
  const content = await loadContent();
  const byId = new Map(content.examples.map((example) => [example.exampleId, example]));
  const examples = CURATED_EXAMPLE_IDS.slice(0, options.photos)
    .map((id) => byId.get(id))
    .filter((example): example is ExampleContent => example !== undefined);
  const vision = createProviders(base, { logger, content }).vision;
  if (vision.mode !== 'live') {
    console.log(
      'ANTHROPIC_API_KEY is not set: analyses use the photo manifest anchors and outputs are not judged.',
    );
  }
  console.log(
    `output: ${options.out}\narms: ${options.arms.map((arm) => arm.id).join(', ')}\nexamples: ${examples.length}`,
  );
  const report = await runBakeoff({
    content,
    examples,
    arms: options.arms,
    editorFor(arm) {
      if (!keys[arm.provider]) {
        return {
          skip: `${arm.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY'} is not set`,
        };
      }
      const config = configWith({ ...arm.env, VISION_PROVIDER: 'fixture' });
      const editor = createProviders(config, { logger, content }).imageEditor;
      return editor.mode === 'live' ? editor : { skip: 'the image editor did not resolve to live' };
    },
    vision,
    imageEdit: base.imageEdit,
    judge: options.judge,
    out: options.out,
    concurrency: options.concurrency,
    saveRaw: options.saveRaw,
    keys,
    log: (line) => console.log(line),
  });
  console.log('');
  for (const s of report.summary) {
    console.log(
      `${s.arm}: ok ${s.ok}/${s.runs}, accepted ${s.accepted}/${s.judged}, edit ${usd(s.avgEditUsd)} per image, ${usd(s.usdPerAcceptedVariant)} per accepted variant, ${secs(s.avgEditSeconds)} per edit`,
    );
  }
  console.log(`claude analyses: ${report.analyses.length}, ${usd(report.analysisUsd)}`);
  console.log(`summary: ${path.join(options.out, 'summary.md')}`);
  return report.records.some((record) => record.ok) ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error('models:bakeoff failed:', error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
