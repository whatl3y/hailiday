import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JUDGE_RESULT_SCHEMA_VERSION,
  type CompiledRequest,
  type JudgeResult,
  type SceneAnalysis,
} from '@holiday/core';
import {
  BakeoffUsageError,
  CURATED_EXAMPLE_IDS,
  DEFAULT_ARM_SPECS,
  armImageEdit,
  claudeCostUsd,
  imageEditCostUsd,
  keyPresence,
  parseBakeoffArgs,
  resolveArm,
  runBakeoff,
  summarizeArms,
  type BakeoffArm,
  type RunRecord,
} from './bakeoff.js';
import { findWorkspaceRoot } from './config/dotenv.js';
import { loadContent, type Content, type ExampleContent } from './content/load.js';
import type { EditOutcome, ImageEditor, VisionModel } from './providers/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = findWorkspaceRoot(here);
if (!root) throw new Error('workspace root not found');

const context = {
  tmpDir: '/tmp/scratch',
  now: new Date('2026-11-09T15:30:12.345Z'),
  workspaceRoot: root,
  cwd: path.join(root, 'packages/server'),
};

describe('arm resolution', () => {
  it('maps a Gemini arm to its model, request parameters and configuration', () => {
    expect(resolveArm('gemini-1k-minimal')).toEqual({
      id: 'gemini-1k-minimal',
      label: 'Google Nano Banana 2.1 · 1K · thinking minimal',
      provider: 'gemini',
      model: 'gemini-nano-banana-2.1',
      params: { image_size: '1K', thinking_level: 'minimal' },
      env: {
        IMAGE_EDITOR_PROVIDER: 'gemini',
        GEMINI_IMAGE_MODEL: 'gemini-nano-banana-2.1',
        GEMINI_IMAGE_SIZE: '1K',
        GEMINI_THINKING_LEVEL: 'minimal',
      },
    });
    expect(resolveArm('gemini-2k-medium').params).toEqual({
      image_size: '2K',
      thinking_level: 'medium',
    });
  });

  it('maps an OpenAI arm to the GPT image 2.5 family and quality', () => {
    expect(resolveArm('openai-sunburst-high')).toMatchObject({
      provider: 'openai',
      model: 'gpt-image-2.5-sunburst',
      label: 'OpenAI 2.5 Sunburst · high',
      params: { quality: 'high' },
      env: {
        IMAGE_EDITOR_PROVIDER: 'openai',
        OPENAI_IMAGE_MODEL: 'gpt-image-2.5-sunburst',
        OPENAI_IMAGE_QUALITY: 'high',
      },
    });
    expect(resolveArm('openai-flare-medium').model).toBe('gpt-image-2.5-flare');
  });

  it('ignores case and takes another model snapshot after @', () => {
    const arm = resolveArm(' OpenAI-Flare-Medium@gpt-image-2.6-flare ');
    expect(arm.id).toBe('openai-flare-medium@gpt-image-2.6-flare');
    expect(arm.model).toBe('gpt-image-2.6-flare');
    expect(arm.env.OPENAI_IMAGE_MODEL).toBe('gpt-image-2.6-flare');
    expect(arm.label).toBe('gpt-image-2.6-flare · medium');
  });

  it.each([
    'gemini-1k-low',
    'gemini-4k-medium',
    'openai-flare-ultra',
    'openai-1k-medium',
    'flux-1k-medium',
    'gemini-1k',
    'gemini-1k-minimal@',
    'gemini-1k-minimal@a@b',
    'gemini-1k-minimal@bad model',
  ])('rejects %s', (spec) => {
    expect(() => resolveArm(spec)).toThrow(BakeoffUsageError);
  });
});

describe('arm request settings', () => {
  const configured = {
    providerMask: 'tight',
    openaiQuality: 'high',
    geminiImageSize: '1K',
    geminiThinkingLevel: 'minimal',
  } as const;

  it("keeps the configured mask policy and takes the arm's quality, size and thinking level", () => {
    expect(armImageEdit(configured, resolveArm('gemini-2k-high'))).toEqual({
      providerMask: 'tight',
      openaiQuality: 'high',
      geminiImageSize: '2K',
      geminiThinkingLevel: 'high',
    });
    expect(armImageEdit(configured, resolveArm('openai-flare-low'))).toEqual({
      providerMask: 'tight',
      openaiQuality: 'low',
      geminiImageSize: '1K',
      geminiThinkingLevel: 'minimal',
    });
    expect(armImageEdit({ providerMask: 'none' }, resolveArm('openai-sunburst-medium'))).toEqual({
      providerMask: 'none',
      openaiQuality: 'medium',
    });
  });

  it('never carries the editor preference or other configuration into the request settings', () => {
    const settings = armImageEdit(
      { ...configured, preference: 'gemini' } as Parameters<typeof armImageEdit>[0],
      resolveArm('gemini-1k-medium'),
    );
    expect(settings).not.toHaveProperty('preference');
  });
});

describe('argument parsing', () => {
  it('defaults to the budget arms, every curated photo and a temp folder', () => {
    const options = parseBakeoffArgs([], context);
    expect(options.arms.map((arm) => arm.id)).toEqual([...DEFAULT_ARM_SPECS]);
    expect(options.photos).toBe(CURATED_EXAMPLE_IDS.length);
    expect(options.out).toBe(path.join('/tmp/scratch', 'holiday-bakeoff-20261109-153012'));
    expect(options).toMatchObject({ concurrency: 2, judge: true, saveRaw: false, help: false });
  });

  it('reads arms, photos, output and switches, in both flag forms, skipping a forwarded --', () => {
    const options = parseBakeoffArgs(
      [
        '--',
        '--arms',
        'gemini-1k-minimal,gemini-1k-medium, openai-flare-medium,openai-sunburst-high',
        '--photos=3',
        '--out',
        '../../../bakeoff-out',
        '--concurrency',
        '4',
        '--no-judge',
        '--save-raw',
      ],
      context,
    );
    expect(options.arms.map((arm) => arm.id)).toEqual([
      'gemini-1k-minimal',
      'gemini-1k-medium',
      'openai-flare-medium',
      'openai-sunburst-high',
    ]);
    expect(options.photos).toBe(3);
    expect(options.out).toBe(path.resolve(context.cwd, '../../../bakeoff-out'));
    expect(options).toMatchObject({ concurrency: 4, judge: false, saveRaw: true });
    expect(parseBakeoffArgs(['-h'], context).help).toBe(true);
  });

  it.each([
    [['--photos', '0']],
    [['--photos', '9']],
    [['--photos', '2.5']],
    [['--photos', 'all']],
    [['--concurrency', '5']],
    [['--arms']],
    [['--arms', '--photos', '2']],
    [['--arms', '']],
    [['--arms', ',']],
    [['--arms', 'gemini-1k-minimal,GEMINI-1K-MINIMAL']],
    [['--arms', 'gemini-1k-minimal', '--arms', 'openai-flare-medium']],
    [['--fast']],
    [['--out', '.']],
    [['--out', path.join(root, 'tmp/bakeoff')]],
  ])('rejects %j', (argv) => {
    expect(() => parseBakeoffArgs(argv, context)).toThrow(BakeoffUsageError);
  });
});

describe('cost math', () => {
  it('prices OpenAI GPT image 2.5 usage at $8 image input and $30 output per million', () => {
    // A measured 2.5 Sunburst high edit at 1536x1024.
    expect(
      imageEditCostUsd('openai', 'gpt-image-2.5-sunburst', {
        inputTokens: 1963,
        outputTokens: 1372,
        raw: {},
      }),
    ).toBeCloseTo(0.056864, 9);
    // Text input tokens cost $5 per million when the usage separates them.
    expect(
      imageEditCostUsd('openai', 'gpt-image-2.5-flare', {
        inputTokens: 1963,
        outputTokens: 1372,
        raw: { input_tokens_details: { text_tokens: 400, image_tokens: 1563 } },
      }),
    ).toBeCloseTo((400 * 5 + 1563 * 8 + 1372 * 30) / 1e6, 12);
  });

  it('prices Nano Banana 2.1 output at $30 per million, thinking tokens included', () => {
    // A measured 1K minimal edit.
    expect(
      imageEditCostUsd('gemini', 'gemini-nano-banana-2.1', {
        inputTokens: 1530,
        outputTokens: 1539,
        raw: {},
      }),
    ).toBeCloseTo(0.046935, 9);
    expect(
      imageEditCostUsd('gemini', 'gemini-nano-banana-2.1', {
        inputTokens: 1530,
        outputTokens: 1539,
        raw: { thoughtsTokenCount: 200 },
      }),
    ).toBeCloseTo((1530 * 0.5 + 1739 * 30) / 1e6, 12);
    expect(
      imageEditCostUsd('gemini', 'gemini-3-pro-image', {
        inputTokens: 1000,
        outputTokens: 1000,
        raw: {},
      }),
    ).toBeCloseTo((1000 * 2 + 1000 * 120) / 1e6, 12);
  });

  it('returns null for a model without a list price and 0 without usage', () => {
    expect(imageEditCostUsd('openai', 'dall-e-9', { inputTokens: 10, raw: {} })).toBeNull();
    expect(imageEditCostUsd('gemini', 'gpt-image-2.5-flare', { raw: {} })).toBeNull();
    expect(imageEditCostUsd('gemini', 'gemini-nano-banana-2.1', null)).toBe(0);
  });

  it('prices Claude at $4/$20 (Opus 5.5), $2/$10 (Sonnet 5.5) and $0.10/$0.50 (Haiku 5.5)', () => {
    const usage = { inputTokens: 6000, outputTokens: 800, calls: 1 };
    expect(claudeCostUsd('claude-opus-5-5', usage)).toBeCloseTo((6000 * 4 + 800 * 20) / 1e6, 12);
    expect(claudeCostUsd('claude-sonnet-5-5', usage)).toBeCloseTo((6000 * 2 + 800 * 10) / 1e6, 12);
    expect(claudeCostUsd('claude-haiku-5-5', usage)).toBeCloseTo(
      (6000 * 0.1 + 800 * 0.5) / 1e6,
      12,
    );
    expect(
      claudeCostUsd('claude-opus-5-5', { ...usage, cacheReadInputTokens: 10_000 }),
    ).toBeCloseTo((6000 * 4 + 10_000 * 0.2 + 800 * 20) / 1e6, 12);
    expect(claudeCostUsd('claude-unknown-1', usage)).toBeNull();
  });

  it('divides every run’s edit and judge spend by the accepted outputs', () => {
    const arm = resolveArm('gemini-1k-minimal');
    const judge = (decision: 'pass' | 'reject', usd: number) => ({
      decision,
      critical: decision === 'reject' ? ['structure_changed'] : [],
      uncertain: [],
      major: [],
      scores: { realism: 4, appeal: 4, planAdherence: 4 },
      placementsPresent: 3,
      placementsAdherent: 3,
      placementsPlanned: 3,
      model: 'claude-opus-5-5',
      usd,
      seconds: 5,
    });
    const record = (over: Partial<RunRecord>): RunRecord => ({
      arm: arm.id,
      exampleId: 'e',
      photoId: 'p',
      ok: true,
      editUsd: 0.05,
      editSeconds: 10,
      totalSeconds: 12,
      ...over,
    });
    const [summary] = summarizeArms(
      [arm],
      [
        record({ judge: judge('pass', 0.02) }),
        record({ judge: judge('reject', 0.02) }),
        record({ ok: false, failure: 'provider_error', editUsd: null, editSeconds: null }),
      ],
    );
    expect(summary).toMatchObject({ runs: 3, ok: 2, failed: 1, judged: 2, accepted: 1 });
    expect(summary?.avgEditUsd).toBeCloseTo(0.05, 12);
    expect(summary?.avgJudgeUsd).toBeCloseTo(0.02, 12);
    expect(summary?.usdPerAcceptedVariant).toBeCloseTo(0.05 + 0.05 + 0.02 + 0.02, 12);
    expect(summary?.failures).toEqual({ provider_error: 1 });
    expect(summary?.codes).toEqual({ structure_changed: 1 });
  });
});

describe('key presence', () => {
  it('reports only whether each key is set', () => {
    const secret = 'sk-test-0123456789abcdef';
    const presence = keyPresence({ OPENAI_API_KEY: secret, GEMINI_API_KEY: '' });
    expect(presence).toEqual({ openai: true, gemini: false, anthropic: false });
    expect(JSON.stringify(presence)).not.toContain(secret);
  });
});

describe('package scripts', () => {
  const scripts = (file: string) =>
    (JSON.parse(readFileSync(file, 'utf8')) as { scripts: Record<string, string> }).scripts;

  it('runs the built command through the .env preload, with a root alias', () => {
    const server = scripts(path.join(root, 'packages/server/package.json'))['models:bakeoff'];
    expect(server).toBe('node --import ./dist/config/load-env/index.js dist/bakeoff.js');
    expect(scripts(path.join(root, 'package.json'))['models:bakeoff']).toBe(
      'pnpm --filter @holiday/server models:bakeoff',
    );
    expect(existsSync(path.join(here, 'bakeoff.ts'))).toBe(true);
  });
});

/** Recorded live Claude analyses of the example photographs. */
function recordedAnalysis(exampleId: string): SceneAnalysis {
  const name = exampleId.replace(/^example\./, '').replace(/\.v\d+$/, '');
  const file = path.join(here, 'pipeline/plan/testdata/live-analyses', `${name}.json`);
  return (JSON.parse(readFileSync(file, 'utf8')) as { analysis: SceneAnalysis }).analysis;
}

function stubVision(calls: { analyze: string[]; judge: string[]; relight: string[] }): VisionModel {
  const usage = { inputTokens: 5000, outputTokens: 1000, calls: 1 };
  return {
    providerId: 'anthropic',
    mode: 'live',
    classifyUpload: () => Promise.reject(new Error('not used')),
    async analyzeScene(input) {
      calls.analyze.push(input.sourceAssetId);
      return {
        result: { ...recordedAnalysis(input.sourceAssetId), sourceAssetId: input.sourceAssetId },
        usage,
        model: 'claude-opus-5-5',
        promptVersion: 'recorded',
        elapsedMs: 10,
        providerMode: 'live',
      };
    },
    async judge(input) {
      calls.judge.push(input.renderAttemptId);
      if (input.mode === 'relight' && input.base) calls.relight.push(input.renderAttemptId);
      const reject = input.renderAttemptId.includes('openai');
      const result: JudgeResult = {
        schemaVersion: JUDGE_RESULT_SCHEMA_VERSION,
        renderAttemptId: input.renderAttemptId,
        judgeModel: 'claude-opus-5-5',
        judgePromptVersion: 'recorded',
        escalated: false,
        critical: reject
          ? [{ code: 'structure_changed', confidence: 0.9, evidence: 'The roof changed.' }]
          : [],
        major: [],
        placements: input.plan.placements.map((placement) => ({
          placementId: placement.id,
          present: true,
          confidence: 0.9,
          adherence: { category: true, colorFamily: true, count: 'pass', scale: 'ok' },
        })),
        scores: { realism: 4, appeal: 4, planAdherence: 4 },
        overallConfidence: 0.9,
        elapsedMs: 5,
      };
      return {
        result,
        usage: { inputTokens: 3000, outputTokens: 500, calls: 1 },
        model: 'claude-opus-5-5',
        promptVersion: 'recorded',
        elapsedMs: 5,
        providerMode: 'live',
      };
    },
    async localizeAdditions(input) {
      return {
        result: {
          added: input.placements.map((placement) => ({
            label: placement.specText ?? placement.kitItemId,
            box: placement.region,
            placementId: placement.id,
          })),
          otherChanges: [],
        },
        usage: { inputTokens: 4000, outputTokens: 600, calls: 1 },
        model: 'claude-opus-5-5',
        promptVersion: 'recorded',
        elapsedMs: 5,
        providerMode: 'live',
      };
    },
  };
}

/**
 * A live-mode editor stand-in that returns the source unchanged (no network); the request with
 * the 1-based index `failOn` fails as a provider error.
 */
function stubEditor(
  providerId: 'openai' | 'gemini',
  requests: CompiledRequest[],
  failOn: number | null,
): ImageEditor {
  return {
    providerId,
    mode: 'live',
    capabilities: {
      supportsMask: providerId === 'openai',
      supportsMarkup: false,
      maxReferenceImages: 0,
      supportedOutputSizes: [],
      asyncOperations: false,
      supportsIdempotencyKey: false,
      supportsCancel: false,
    },
    async edit(request, input): Promise<EditOutcome> {
      requests.push(request);
      if (requests.length === failOn) {
        return {
          status: 'failed',
          kind: 'provider_error',
          providerCode: 'server_error',
          retryable: true,
        };
      }
      const working = request.images[0] as { width: number; height: number };
      return {
        status: 'completed',
        operationId: `op-${requests.length}`,
        image: input.image,
        width: working.width,
        height: working.height,
        format: 'png',
        usage: { inputTokens: 1530, outputTokens: 1539, raw: {} },
        modelSnapshot: 'stand-in',
        provenance: {},
        providerMode: 'live',
      };
    },
    getOperation: () => Promise.reject(new Error('not used')),
  };
}

describe('runBakeoff', () => {
  let content: Content;
  let out: string;
  beforeAll(async () => {
    content = await loadContent();
    out = await mkdtemp(path.join(os.tmpdir(), 'holiday-bakeoff-test-'));
  });
  afterAll(async () => {
    await rm(out, { recursive: true, force: true });
  });

  it('shares one analysis per photo across arms, judges every output and writes the report', async () => {
    const examples = CURATED_EXAMPLE_IDS.slice(0, 3).map(
      (id) => content.examples.find((example) => example.exampleId === id) as ExampleContent,
    );
    const calls = { analyze: [] as string[], judge: [] as string[], relight: [] as string[] };
    const requests: Record<string, CompiledRequest[]> = { gemini: [], openai: [] };
    const arms: BakeoffArm[] = [resolveArm('gemini-2k-high'), resolveArm('openai-flare-medium')];
    const skipped = resolveArm('openai-sunburst-high');
    const lines: string[] = [];
    const report = await runBakeoff({
      content,
      examples,
      arms: [...arms, skipped],
      editorFor: (arm) =>
        arm.id === skipped.id
          ? { skip: 'OPENAI_API_KEY is not set' }
          : stubEditor(
              arm.provider,
              requests[arm.provider] as CompiledRequest[],
              arm.provider === 'openai' ? 2 : null,
            ),
      vision: stubVision(calls),
      imageEdit: { providerMask: 'tight' },
      judge: true,
      out,
      concurrency: 1,
      saveRaw: false,
      keys: { openai: true, gemini: true, anthropic: true },
      log: (line) => lines.push(line),
      now: () => new Date('2026-11-09T12:00:00Z'),
    });

    // The Christmas source and evening examples share one photograph.
    expect(calls.analyze).toHaveLength(2);
    expect(report.analyses.map((a) => a.photoId).sort()).toEqual(
      ['house-04-bungalow-summer', 'house-14-victorian-autumn'].sort(),
    );
    expect(report.analysisUsd).toBeCloseTo(2 * ((5000 * 4 + 1000 * 20) / 1e6), 12);

    // Every request carried its arm's parameters.
    for (const request of requests.gemini ?? []) {
      expect(request.parameters).toMatchObject({ image_size: '2K', thinking_level: 'high' });
    }
    for (const request of requests.openai ?? []) {
      expect(request.parameters).toMatchObject({ quality: 'medium' });
    }
    // The configured mask policy reaches the compiler: OpenAI takes the mask in source lighting
    // (two of the three examples); Gemini takes none.
    expect((requests.openai ?? []).filter((request) => request.mask)).toHaveLength(2);
    for (const request of requests.gemini ?? []) expect(request.mask).toBeUndefined();
    // The evening example relights its arm's daylight composite of the same photo: one edit, a
    // relight without a mask, after the daylight examples.
    for (const arm of ['gemini', 'openai']) {
      const sent = requests[arm] ?? [];
      expect(sent.map((request) => request.kind ?? 'decorate')).toEqual([
        'decorate',
        'decorate',
        'relight',
      ]);
      expect(sent[2]?.mask).toBeUndefined();
    }

    expect(report.records).toHaveLength(6);
    const failed = report.records.filter((record) => !record.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      arm: 'openai-flare-medium',
      failure: 'provider_error',
      providerCode: 'server_error',
    });
    // Every output was judged against the plan the editor was sent.
    for (const record of report.records.filter((r) => r.ok)) {
      expect(record.judgeSkipped).toBeUndefined();
      expect(record.judge?.placementsPlanned).toBeGreaterThan(0);
      expect(record.judge?.placementsPresent).toBe(record.judge?.placementsPlanned);
    }
    expect(calls.judge).toHaveLength(5);
    // Each arm's evening output is judged in relight mode against its daylight composite.
    expect(calls.relight.sort()).toEqual([
      'bakeoff-gemini-2k-high-example.christmas.house_exterior.classic.evening.v1',
      'bakeoff-openai-flare-medium-example.christmas.house_exterior.classic.evening.v1',
    ]);

    const judgeUsd = (3000 * 4 + 500 * 20) / 1e6;
    const editUsd = (1530 * 0.5 + 1539 * 30) / 1e6;
    const gemini = report.summary.find((s) => s.arm === 'gemini-2k-high');
    expect(gemini).toMatchObject({ ok: 3, judged: 3, accepted: 3 });
    expect(gemini?.usdPerAcceptedVariant).toBeCloseTo(editUsd + judgeUsd, 12);
    const openai = report.summary.find((s) => s.arm === 'openai-flare-medium');
    expect(openai).toMatchObject({ ok: 2, failed: 1, judged: 2, accepted: 0 });
    expect(openai?.usdPerAcceptedVariant).toBeNull();
    expect(openai?.codes).toEqual({ structure_changed: 2 });
    expect(report.skippedArms).toEqual([
      { arm: 'openai-sunburst-high', reason: 'OPENAI_API_KEY is not set' },
    ]);

    const written = JSON.parse(await readFile(path.join(out, 'results.json'), 'utf8')) as {
      records: unknown[];
      summary: unknown[];
    };
    expect(written.records).toHaveLength(6);
    expect(written.summary).toHaveLength(2);
    const summary = await readFile(path.join(out, 'summary.md'), 'utf8');
    expect(summary).toContain('| Google Nano Banana 2.1 · 2K · thinking high |');
    expect(summary).toContain('Skipped openai-sunburst-high: OPENAI_API_KEY is not set.');
    expect(summary).toContain('failed: provider_error');
    expect(report.sheets).toHaveLength(3);
    for (const sheet of report.sheets) expect(existsSync(sheet)).toBe(true);
    for (const example of examples) {
      expect(existsSync(path.join(out, example.exampleId, 'before.jpg'))).toBe(true);
    }
    expect(lines.some((line) => line.startsWith('skip openai-sunburst-high'))).toBe(true);
  }, 180_000);
});
