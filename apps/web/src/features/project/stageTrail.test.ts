import { describe, expect, it } from 'vitest';
import type { StageLabelKey } from '@hailiday/core';
import { FRAMING_STAGE } from '../../api/renderStatus';
import { t } from '../../copy';
import { renderStatus } from '../../test/fixtures';
import {
  FIRST_STAGE,
  advanceTrail,
  passedStageKeys,
  stageKeyOf,
  trailFor,
  trailWordKey,
} from './stageTrail';

describe('passedStageKeys', () => {
  it('lists the stages of the states before each state, each once', () => {
    expect(passedStageKeys('queued')).toEqual([]);
    expect(passedStageKeys('preparing')).toEqual([]);
    expect(passedStageKeys('analyzing')).toEqual(['stage.preparing']);
    expect(passedStageKeys('planning')).toEqual(['stage.preparing']);
    expect(passedStageKeys('rendering')).toEqual(['stage.preparing', 'stage.planning']);
    expect(passedStageKeys('checking')).toEqual([
      'stage.preparing',
      'stage.planning',
      'stage.rendering',
    ]);
    expect(passedStageKeys('needs_review')).toEqual([
      'stage.preparing',
      'stage.planning',
      'stage.rendering',
      'stage.checking',
    ]);
  });

  it('lists nothing for a terminal state', () => {
    expect(passedStageKeys('succeeded')).toEqual([]);
    expect(passedStageKeys('canceled')).toEqual([]);
  });
});

describe('stageKeyOf', () => {
  it("prefers the server's key and falls back to the state's", () => {
    expect(stageKeyOf({ state: 'rendering', stageLabelKey: 'stage.checking' })).toBe(
      'stage.checking',
    );
    expect(stageKeyOf({ state: 'rendering', stageLabelKey: null })).toBe('stage.rendering');
    expect(stageKeyOf({ state: 'succeeded', stageLabelKey: null })).toBeNull();
  });
});

describe('advanceTrail', () => {
  const job = renderStatus({ state: 'queued', stageLabelKey: 'stage.preparing' });
  const at = (
    state: (typeof job)['state'],
    stageLabelKey: (typeof job)['stageLabelKey'] = null,
  ) => ({
    ...job,
    state,
    stageLabelKey,
  });

  it('fills in the stages a first status at checking implies', () => {
    expect(advanceTrail(null, at('checking'))).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering', 'stage.checking'],
      current: 'stage.checking',
    });
  });

  it('makes a repeated stage current again and adds nothing', () => {
    const checked = advanceTrail(null, at('checking'));
    expect(advanceTrail(checked, at('planning'))).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering', 'stage.checking'],
      current: 'stage.planning',
    });
  });

  it("adds a server key that differs from the state's key once, and makes it current", () => {
    const started = advanceTrail(null, at('preparing'));
    expect(started?.keys).toEqual(['stage.preparing']);
    const reported = advanceTrail(started, at('rendering', 'stage.checking'));
    expect(reported).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.checking'],
      current: 'stage.checking',
    });
    const again = advanceTrail(reported, at('rendering', 'stage.checking'));
    expect(again).toBe(reported);
  });

  it('fills in a skipped stage before the current entry', () => {
    const started = advanceTrail(null, at('preparing'));
    expect(advanceTrail(started, at('rendering'))?.keys).toEqual([
      'stage.preparing',
      'stage.planning',
      'stage.rendering',
    ]);
  });

  it('starts over for another job', () => {
    const checked = advanceTrail(null, at('checking'));
    const other = renderStatus({ state: 'planning', stageLabelKey: 'stage.planning' });
    expect(advanceTrail(checked, other)).toEqual({
      renderJobId: other.renderJobId,
      keys: ['stage.preparing', 'stage.planning'],
      current: 'stage.planning',
    });
  });

  it('keeps the trail for a terminal status of the same job, and has none for another', () => {
    const checked = advanceTrail(null, at('checking'));
    expect(advanceTrail(checked, at('succeeded'))).toBe(checked);
    expect(
      advanceTrail(checked, renderStatus({ state: 'canceled', stageLabelKey: null })),
    ).toBeNull();
    expect(advanceTrail(null, at('failed'))).toBeNull();
  });
});

describe('the framing stage on the trail', () => {
  const framing = FRAMING_STAGE as StageLabelKey;
  const job = renderStatus({ state: 'queued', stageLabelKey: 'stage.preparing' });
  const at = (state: (typeof job)['state'], stageLabelKey: StageLabelKey | null = null) => ({
    ...job,
    state,
    stageLabelKey,
  });
  const words = (keys: readonly string[]) =>
    keys.map((key) => t(trailWordKey(key) as Parameters<typeof t>[0]));

  it('follows the photo as Zoom, then gives way to the stages after it', () => {
    let trail = advanceTrail(null, at('queued', 'stage.preparing'));
    trail = advanceTrail(trail, at('preparing', framing));
    expect(trail).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', framing],
      current: framing,
    });
    trail = advanceTrail(trail, at('analyzing', 'stage.planning'));
    trail = advanceTrail(trail, at('analyzing', 'stage.enhancing'));
    trail = advanceTrail(trail, at('rendering', 'stage.rendering'));
    trail = advanceTrail(trail, at('checking', 'stage.checking'));
    trail = advanceTrail(trail, at('planning', 'stage.eveningLight'));
    expect(words(trail!.keys)).toEqual([
      'Photo',
      'Zoom',
      'Plan',
      'Sharpen',
      'Decorate',
      'Check',
      'Evening light',
    ]);
  });

  it('counts the photo as done when the first status the page sees is the framing step', () => {
    expect(advanceTrail(null, at('preparing', framing))).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', framing],
      current: framing,
    });
  });

  it('is never listed when the page did not see it', () => {
    expect(advanceTrail(null, at('rendering'))?.keys).not.toContain(framing);
    expect(advanceTrail(null, at('needs_review'))?.keys).not.toContain(framing);
    expect(trailWordKey(framing)).toBe('trail.framing');
  });
});

describe('trailFor', () => {
  it('uses the stored trail of the job being followed', () => {
    const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const stored = {
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.rendering'] as const,
      current: 'stage.rendering' as const,
    };
    const trail = { ...stored, keys: [...stored.keys] };
    expect(trailFor(trail, job)).toBe(trail);
  });

  it("ignores a stored trail of another job and reads the status's own stages", () => {
    const job = renderStatus({ state: 'rendering', stageLabelKey: 'stage.rendering' });
    const stale = {
      renderJobId: 'other',
      keys: ['stage.checking' as const],
      current: 'stage.checking' as const,
    };
    expect(trailFor(stale, job)).toEqual({
      renderJobId: job.renderJobId,
      keys: ['stage.preparing', 'stage.planning', 'stage.rendering'],
      current: 'stage.rendering',
    });
  });

  it('shows the first stage while the request is on its way', () => {
    expect(trailFor(null, null)).toEqual({
      renderJobId: '',
      keys: [FIRST_STAGE],
      current: FIRST_STAGE,
    });
  });
});

describe('trailWordKey', () => {
  it('names the trail word of a stage', () => {
    expect(trailWordKey('stage.planning')).toBe('trail.planning');
    expect(trailWordKey('stage.eveningLight')).toBe('trail.eveningLight');
  });
});
