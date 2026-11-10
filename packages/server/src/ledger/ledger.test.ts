import { describe, expect, it } from 'vitest';
import {
  PRICE_LIST,
  VISION_LEDGER_STAGES,
  VISION_PRICES_MICROS,
  decoratingAttempts,
  linesBySku,
  linesTotalMicros,
  microsFor,
  microsToMinor,
  openAmount,
  renderReservationLines,
  unitPriceFor,
  usageCostMicros,
} from './index.js';

describe('ledger arithmetic', () => {
  it('multiplies units by unit price exactly in micros', () => {
    expect(microsFor(1, 2_830)).toBe(2_830);
    expect(microsFor(12, 2_830)).toBe(33_960);
    expect(microsFor(0, 130_000)).toBe(0);
    expect(microsFor(1_400.5, 2)).toBe(2_801);
    expect(microsFor(0.0001, 1)).toBe(0);
    expect(microsFor(0.0005, 1_000)).toBe(1);
    expect(microsFor(0.1 + 0.2, 10)).toBe(3);
  });

  it('rejects negative or fractional prices and negative units', () => {
    expect(() => microsFor(-1, 10)).toThrow(RangeError);
    expect(() => microsFor(1, 1.5)).toThrow(RangeError);
    expect(() => microsFor(Number.NaN, 1)).toThrow(RangeError);
  });

  it('converts micros to minor units with half-up rounding', () => {
    expect(microsToMinor(130_000)).toBe(13);
    expect(microsToMinor(5_000)).toBe(1);
    expect(microsToMinor(4_999)).toBe(0);
    expect(microsToMinor(-5_000)).toBe(-1);
  });

  it('computes the open remainder of a reservation', () => {
    expect(openAmount(130_000, 0, 0)).toBe(130_000);
    expect(openAmount(130_000, 100_000, 0)).toBe(30_000);
    expect(openAmount(130_000, 100_000, -30_000)).toBe(0);
    expect(openAmount(130_000, 150_000, 0)).toBe(0);
  });

  it('uses list prices from the cost worksheet', () => {
    expect(PRICE_LIST.places_autocomplete_requests.unitPriceMicros).toBe(2_830);
    expect(PRICE_LIST.street_view_static_fetch.unitPriceMicros).toBe(7_000);
    expect(PRICE_LIST.street_view_metadata.unitPriceMicros).toBe(0);
    expect(unitPriceFor('image_edit_attempt', { provider: 'gemini' })).toBe(134_000);
    expect(unitPriceFor('vision_call', { visionStage: 'analysis' })).toBe(30_000);
  });
});

describe('render reservation lines', () => {
  const base = { imageEditProvider: 'fixture', visionProvider: 'fixture' };
  const shape = (lines: ReturnType<typeof renderReservationLines>) =>
    lines.map((line) => `${line.sku}:${line.stage}:${line.unitPriceMicros}`);

  it('reserves analysis, two attempts, two judges, one escalation and two localizations', () => {
    const lines = renderReservationLines({ ...base, streetViewFetch: false, reuseAnalysis: false });
    expect(shape(lines)).toEqual([
      'vision_call:analyzing:30000',
      'image_edit_attempt:rendering:130000',
      'image_edit_attempt:rendering:130000',
      'vision_call:checking:20000',
      'vision_call:checking:20000',
      'vision_call:checking:40000',
      'vision_call:localizing:20000',
      'vision_call:localizing:20000',
    ]);
    expect(linesTotalMicros(lines)).toBe(30_000 + 2 * 130_000 + 2 * 20_000 + 40_000 + 2 * 20_000);
    expect(
      shape(
        renderReservationLines({
          ...base,
          streetViewFetch: false,
          reuseAnalysis: false,
          lightingMode: 'source',
        }),
      ),
    ).toEqual(shape(lines));
  });

  it('prices a localization like a judge call, on its own ledger stage', () => {
    expect(VISION_PRICES_MICROS.localization).toBe(VISION_PRICES_MICROS.judge);
    expect(unitPriceFor('vision_call', { visionStage: 'localization' })).toBe(20_000);
    expect(VISION_LEDGER_STAGES).toEqual({
      analysis: 'analyzing',
      judge: 'checking',
      escalation: 'checking',
      localization: 'localizing',
    });
  });

  it('reserves an evening relight of an accepted daylight variant without localizations', () => {
    const lines = renderReservationLines({
      ...base,
      streetViewFetch: false,
      reuseAnalysis: true,
      lightingMode: 'evening',
      relightBase: true,
    });
    expect(shape(lines)).toEqual([
      'image_edit_attempt:rendering:130000',
      'image_edit_attempt:rendering:130000',
      'vision_call:checking:20000',
      'vision_call:checking:20000',
      'vision_call:checking:40000',
    ]);
    expect(decoratingAttempts({ lightingMode: 'evening', relightBase: true })).toBe(0);
  });

  it('reserves the daylight base attempt of an evening job that has none yet', () => {
    const lines = renderReservationLines({
      ...base,
      streetViewFetch: false,
      reuseAnalysis: false,
      lightingMode: 'evening',
    });
    // Attempt 1 decorates (analysis, edit, localization, judge); attempt 2 relights (edit, judge).
    expect(shape(lines)).toEqual([
      'vision_call:analyzing:30000',
      'image_edit_attempt:rendering:130000',
      'image_edit_attempt:rendering:130000',
      'vision_call:checking:20000',
      'vision_call:checking:20000',
      'vision_call:checking:40000',
      'vision_call:localizing:20000',
    ]);
    expect(
      shape(
        renderReservationLines({
          ...base,
          streetViewFetch: false,
          reuseAnalysis: false,
          lightingMode: 'evening',
          relightBase: false,
        }),
      ),
    ).toEqual(shape(lines));
    // The daylight shape (the default) covers every evening shape.
    const daylight = renderReservationLines({
      ...base,
      streetViewFetch: false,
      reuseAnalysis: false,
    });
    expect(linesTotalMicros(daylight)).toBeGreaterThan(linesTotalMicros(lines));
  });

  it('marks each line served by a fixture adapter as fixture work', () => {
    const lines = renderReservationLines({
      imageEditProvider: 'openai',
      visionProvider: 'fixture',
      streetViewFetch: false,
      reuseAnalysis: false,
    });
    expect(
      lines.filter((line) => line.sku === 'vision_call').map((line) => line.isFixture),
    ).toEqual([true, true, true, true, true, true]);
    expect(
      lines.filter((line) => line.sku === 'image_edit_attempt').map((l) => l.isFixture),
    ).toEqual([undefined, undefined]);
    const live = renderReservationLines({
      imageEditProvider: 'fixture',
      visionProvider: 'anthropic',
      visionModel: 'claude-opus-5-5',
      streetViewFetch: false,
      reuseAnalysis: true,
    });
    const localizing = live.filter((line) => line.stage === 'localizing');
    expect(localizing).toHaveLength(2);
    for (const line of localizing) {
      expect(line).toMatchObject({ provider: 'anthropic', modelId: 'claude-opus-5-5' });
      expect(line.isFixture).toBeUndefined();
    }
  });

  it('adds a transient Street View fetch and drops a reusable analysis', () => {
    const lines = renderReservationLines({ ...base, streetViewFetch: true, reuseAnalysis: true });
    expect(lines[0]?.sku).toBe('street_view_static_fetch');
    expect(lines.filter((line) => line.stage === 'analyzing')).toHaveLength(0);
    const bySku = linesBySku(lines);
    expect(bySku.get('street_view_static_fetch')).toBe(7_000);
    expect(bySku.get('image_edit_attempt')).toBe(260_000);
    expect(bySku.get('vision_call')).toBe(2 * 20_000 + 40_000 + 2 * 20_000);
  });
});

describe('settlement from reported usage', () => {
  it('prices Claude vision calls from tokens at the worksheet token prices', () => {
    // Opus 5.5: $4 / $20 per million input / output tokens, cache reads $0.20.
    expect(
      usageCostMicros('claude-opus-5-5', {
        inputTokens: 3_000,
        outputTokens: 1_500,
        cacheReadInputTokens: 2_000,
      }),
    ).toBe(3_000 * 4 + 1_500 * 20 + Math.round(2_000 * 0.2));
    expect(usageCostMicros('claude-sonnet-5-5', { inputTokens: 1_000, outputTokens: 100 })).toBe(
      3_000,
    );
  });

  it('prices GPT image edits from input and output tokens', () => {
    // The metered bake-off edit: 1,964 input and 1,372 output tokens cost about $0.057.
    expect(
      usageCostMicros('gpt-image-2.5-sunburst', {
        inputTokens: 1_964,
        outputTokens: 1_372,
        images: 1,
      }),
    ).toBe(56_872);
    expect(usageCostMicros('gpt-image-2.5-flare', { images: 1 })).toBeNull();
  });

  it('prices per-image models by the size tier when the reply carries no token usage', () => {
    expect(usageCostMicros('gemini-nano-banana-2.1', { images: 1 }, { imageSize: '1K' })).toBe(
      33_600,
    );
    expect(usageCostMicros('gemini-nano-banana-2.1', { images: 1 }, { imageSize: '2K' })).toBe(
      50_400,
    );
    expect(
      usageCostMicros('gemini-nano-banana-2.1', { inputTokens: 1_531, images: 1, raw: {} }),
    ).toBe(33_600);
  });

  it('reproduces the measured bake-off costs from the recorded usage', () => {
    // Nano Banana 2.1 at 1K, minimal thinking: prompt tokens at $0.50 per million, candidates
    // (image) tokens at $30 per million; the bake-off measured $0.046-$0.050 per edit.
    const gemini = [
      { inputTokens: 1_531, outputTokens: 1_519, measured: 0.0463355 },
      { inputTokens: 1_622, outputTokens: 1_631, measured: 0.049741 },
      { inputTokens: 1_601, outputTokens: 1_630, measured: 0.0497005 },
      { inputTokens: 1_504, outputTokens: 1_503, measured: 0.045842 },
      { inputTokens: 1_496, outputTokens: 1_548, measured: 0.047188 },
    ];
    for (const { measured, ...usage } of gemini) {
      const micros = usageCostMicros(
        'gemini-nano-banana-2.1',
        { ...usage, images: 1, raw: { thoughtsTokenCount: 0 } },
        { imageSize: '1K' },
      );
      expect(Math.abs((micros as number) - measured * 1e6)).toBeLessThanOrEqual(0.5);
      expect(micros).toBeGreaterThan(45_000);
      expect(micros).toBeLessThan(50_000);
    }
    // Thinking tokens are billed at the output price, from the field or from Gemini's own record.
    const thinking = { inputTokens: 1_531, outputTokens: 1_519, images: 1 };
    expect(usageCostMicros('gemini-nano-banana-2.1', { ...thinking, thoughtsTokens: 400 })).toBe(
      Math.round(1_531 * 0.5 + (1_519 + 400) * 30),
    );
    expect(
      usageCostMicros('gemini-nano-banana-2.1', { ...thinking, raw: { thoughtsTokenCount: 400 } }),
    ).toBe(Math.round(1_531 * 0.5 + (1_519 + 400) * 30));

    // GPT image 2.5 Flare at medium: text input $5, image input $8, output $30 per million; the
    // bake-off measured about $0.025 per edit (428 text and 1,536 image input tokens).
    const flare = { inputTokens: 1_964, outputTokens: 343, images: 1 };
    expect(
      usageCostMicros('gpt-image-2.5-flare', {
        ...flare,
        raw: { input_tokens_details: { text_tokens: 428, image_tokens: 1_536 } },
      }),
    ).toBe(24_718);
    expect(
      usageCostMicros('gpt-image-2.5-flare', {
        ...flare,
        inputTextTokens: 428,
        inputImageTokens: 1_536,
        raw: {},
      }),
    ).toBe(24_718);
    // Without the split, all input is priced as image input.
    expect(usageCostMicros('gpt-image-2.5-flare', { ...flare, raw: {} })).toBe(
      1_964 * 8 + 343 * 30,
    );
  });

  it('returns null for models without a worksheet price (list price applies)', () => {
    expect(usageCostMicros('fixture-compositor-1', { images: 1 })).toBeNull();
    expect(usageCostMicros('claude-opus-5-5', null)).toBeNull();
    expect(usageCostMicros(null, { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });
});
