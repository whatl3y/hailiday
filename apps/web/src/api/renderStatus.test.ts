import { describe, expect, it } from 'vitest';
import {
  CreateRenderResponseSchema,
  RenderStatusSchema,
  STAGE_LABEL_KEYS,
  VariantListResponseSchema,
} from '@hailiday/core';
import { renderStatus, variant } from '../test/fixtures';
import {
  CreateRenderResponseReader,
  FRAMING_STAGE,
  RenderStatusReader,
  VariantListResponseReader,
  isFramingStage,
  withKnownStage,
} from './renderStatus';

const NEW_KEY = 'stage.somethingNew';

describe('withKnownStage', () => {
  it('leaves a known key, a null key and anything that is not an object alone', () => {
    const known = renderStatus({ stageLabelKey: 'stage.rendering' });
    expect(withKnownStage(known)).toBe(known);
    const none = renderStatus({ stageLabelKey: null });
    expect(withKnownStage(none)).toBe(none);
    expect(withKnownStage(null)).toBeNull();
    expect(withKnownStage('text')).toBe('text');
    expect(withKnownStage(3)).toBe(3);
    const cached = { cached: true, variant: variant() };
    expect(withKnownStage(cached)).toBe(cached);
  });

  it('sets a key this build does not know to null', () => {
    const raw = { ...renderStatus(), stageLabelKey: NEW_KEY };
    expect(withKnownStage(raw)).toEqual({ ...raw, stageLabelKey: null });
    expect(raw.stageLabelKey).toBe(NEW_KEY);
  });
});

describe('the status readers', () => {
  it('read a status with a newer stage key that the strict schema refuses', () => {
    const raw = { ...renderStatus({ state: 'preparing' }), stageLabelKey: NEW_KEY };
    expect(RenderStatusSchema.safeParse(raw).success).toBe(false);
    const parsed = RenderStatusReader.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.stageLabelKey).toBeNull();
    expect(parsed.data?.state).toBe('preparing');
  });

  it('read a queued render answer with a newer stage key', () => {
    const raw = {
      ...renderStatus(),
      stageLabelKey: NEW_KEY,
      cached: false,
      supersededRenderJobId: null,
    };
    expect(CreateRenderResponseSchema.safeParse(raw).success).toBe(false);
    const parsed = CreateRenderResponseReader.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data && !parsed.data.cached ? parsed.data.stageLabelKey : 'cached').toBeNull();
  });

  it('read a variants list whose running job has a newer stage key', () => {
    const raw = {
      items: [variant()],
      activeRender: { ...renderStatus({ state: 'rendering' }), stageLabelKey: NEW_KEY },
      offered: null,
    };
    expect(VariantListResponseSchema.safeParse(raw).success).toBe(false);
    const parsed = VariantListResponseReader.safeParse(raw);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.activeRender?.stageLabelKey).toBeNull();
    expect(VariantListResponseReader.safeParse({ ...raw, activeRender: null }).success).toBe(true);
  });

  it('keep the framing stage key in a status, an answer and a list', () => {
    expect(FRAMING_STAGE).toBe('stage.framing');
    expect(STAGE_LABEL_KEYS).toContain(FRAMING_STAGE);
    const raw = { ...renderStatus({ state: 'preparing' }), stageLabelKey: FRAMING_STAGE };
    const status = RenderStatusReader.safeParse(raw);
    expect(status.success).toBe(true);
    expect(status.data?.stageLabelKey).toBe(FRAMING_STAGE);
    expect(status.data?.state).toBe('preparing');

    const answer = CreateRenderResponseReader.safeParse({
      ...raw,
      cached: false,
      supersededRenderJobId: null,
    });
    expect(answer.success).toBe(true);
    expect(answer.data && !answer.data.cached ? answer.data.stageLabelKey : 'cached').toBe(
      FRAMING_STAGE,
    );

    const list = VariantListResponseReader.safeParse({
      items: [variant()],
      activeRender: raw,
      offered: null,
    });
    expect(list.success).toBe(true);
    expect(list.data?.activeRender?.stageLabelKey).toBe(FRAMING_STAGE);
    expect(raw.stageLabelKey).toBe(FRAMING_STAGE);
  });

  it('tell the framing stage from every other key', () => {
    expect(isFramingStage('stage.framing')).toBe(true);
    expect(isFramingStage('stage.preparing')).toBe(false);
    expect(isFramingStage(null)).toBe(false);
    expect(isFramingStage(undefined)).toBe(false);
  });

  it('still refuse a payload that is wrong in another way', () => {
    const raw = { ...renderStatus(), state: 'dreaming', stageLabelKey: NEW_KEY };
    expect(RenderStatusReader.safeParse(raw).success).toBe(false);
  });
});
