import { describe, expect, it } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { aimAt } from '../../providers/street-view/framing.js';
import type { LocateHomeResult } from '../../providers/types.js';
import { PIPELINE_DEFAULTS } from '../versions.js';
import { roadStep } from './framing.js';

describe("the step a road frame's answer asks for", () => {
  const view = { panoId: 'p', heading: 109.9, pitch: 10, fov: 90, width: 640, height: 640 };
  const home = (box: NormalizedBox, confidence = 0.9): LocateHomeResult => ({
    home: box,
    ambiguous: false,
    confidence,
  });
  const reaimTo = (box: NormalizedBox) => ({
    step: 'reaim',
    heading: aimAt(view, box).heading,
    box,
  });

  it('refuses a frame without a home and an ambiguous one', () => {
    expect(roadStep(view, { home: null, ambiguous: false, confidence: 0.9 })).toEqual({
      step: 'refuse',
    });
    expect(roadStep(view, { home: null, ambiguous: true, confidence: 0.9 })).toEqual({
      step: 'refuse',
    });
    expect(
      roadStep(view, { home: [0.4, 0.3, 0.6, 0.7], ambiguous: true, confidence: 0.9 }),
    ).toEqual({ step: 'refuse' });
  });

  it('decides on the frame for a home that reaches the middle third and no side edge cuts', () => {
    expect(roadStep(view, home([0.4, 0.3, 0.6, 0.7]))).toEqual({ step: 'decide' });
    // Under the confidence the decision asks for: the decision refuses it, not this step.
    expect(roadStep(view, home([0.4, 0.3, 0.6, 0.7], 0.2))).toEqual({ step: 'decide' });
  });

  it('turns to a home off to one side, or one the edge cuts, whatever its confidence', () => {
    expect(roadStep(view, home([0.7, 0.35, 0.95, 0.65]))).toEqual({
      step: 'reaim',
      heading: 142.2,
      box: [0.7, 0.35, 0.95, 0.65],
    });
    for (const confidence of [0.9, 0.2]) {
      expect(roadStep(view, home([0.83, 0.3, 1, 0.7], confidence))).toEqual({
        step: 'reaim',
        heading: 149.5,
        box: [0.83, 0.3, 1, 0.7],
      });
    }
  });

  it('decides on the frame for a home both side edges cut, or a turn under the minimum', () => {
    expect(roadStep(view, home([0, 0.2, 1, 0.8]))).toEqual({ step: 'decide' });
    const turned = { ...view, heading: 200, pitch: 0 };
    const box: NormalizedBox = [0, 0.2, 0.97, 0.8];
    expect(aimAt(turned, box).turnDeg).toBeCloseTo(-0.9, 9);
    expect(roadStep(turned, home(box))).toEqual({ step: 'decide' });
    expect(PIPELINE_DEFAULTS.framing.reaimMinTurnDeg).toBe(3);
  });

  it('never re-aims a home both side edges cut, whatever the minimum turn', () => {
    // A box both edges cut is centred within a degree or so, so the minimum turn alone would
    // usually stop its re-aim; with no minimum only the rule for both edges does.
    const framing = PIPELINE_DEFAULTS.framing as { reaimMinTurnDeg: number };
    const minimum = framing.reaimMinTurnDeg;
    framing.reaimMinTurnDeg = 0;
    try {
      expect(roadStep(view, home([0, 0.2, 0.98, 0.8]))).toEqual({ step: 'decide' });
      expect(roadStep(view, home([0.02, 0.2, 1, 0.8]))).toEqual({ step: 'decide' });
      // A home cut by one edge is then turned to, however slight the turn.
      expect(roadStep(view, home([0, 0.2, 0.97, 0.8]))).toMatchObject({ step: 'reaim' });
    } finally {
      framing.reaimMinTurnDeg = minimum;
    }
  });

  it('draws the middle third and the edges where the decision and the edge share draw them', () => {
    const edge = PIPELINE_DEFAULTS.framing.edgeCutFraction;
    expect(edge).toBe(0.02);
    // Off-centre at the middle third's bounds.
    for (const box of [
      [0.1, 0.3, 1 / 3, 0.7],
      [2 / 3, 0.3, 0.9, 0.7],
    ] as NormalizedBox[]) {
      expect(roadStep(view, home(box))).toEqual(reaimTo(box));
    }
    expect(roadStep(view, home([0.05, 0.3, 0.34, 0.7]))).toEqual({ step: 'decide' });
    expect(roadStep(view, home([0.66, 0.3, 0.95, 0.7]))).toEqual({ step: 'decide' });
    // Cut within the edge share of either side.
    for (const box of [
      [0.5, 0.3, 0.98, 0.7],
      [0.02, 0.3, 0.5, 0.7],
    ] as NormalizedBox[]) {
      expect(roadStep(view, home(box))).toEqual(reaimTo(box));
    }
    expect(roadStep(view, home([0.5, 0.3, 0.979, 0.7]))).toEqual({ step: 'decide' });
    expect(roadStep(view, home([0.021, 0.3, 0.5, 0.7]))).toEqual({ step: 'decide' });
  });
});
