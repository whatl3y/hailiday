import { describe, expect, it } from 'vitest';
import {
  clampStraighten,
  fitMinimumSpan,
  minimumCropSpan,
  nextStraighten,
  straightenedSize,
} from './crop';

describe('straighten model', () => {
  it('moves half a degree with arrows and five with Page keys, within ±15°', () => {
    expect(nextStraighten(0, 'ArrowRight')).toBe(0.5);
    expect(nextStraighten(0, 'ArrowUp')).toBe(0.5);
    expect(nextStraighten(0, 'ArrowLeft')).toBe(-0.5);
    expect(nextStraighten(0, 'ArrowDown')).toBe(-0.5);
    expect(nextStraighten(12, 'PageUp')).toBe(15);
    expect(nextStraighten(-12, 'PageDown')).toBe(-15);
    expect(nextStraighten(3, 'Home')).toBe(-15);
    expect(nextStraighten(3, 'End')).toBe(15);
    expect(nextStraighten(3, 'Enter')).toBeNull();
    expect(clampStraighten(0.24)).toBe(0);
    expect(Object.is(clampStraighten(-0.1), -0)).toBe(false);
    expect(clampStraighten(40)).toBe(15);
  });

  it('counts the zoom against the minimum crop size', () => {
    expect(straightenedSize(1600, 1200, 0)).toEqual({ width: 1600, height: 1200 });
    const turned = straightenedSize(1600, 1200, 15);
    expect(turned.width).toBeLessThan(1600);
    expect(turned.height).toBeLessThan(1200);
    const level = minimumCropSpan(1600, 1200, 640);
    const straightened = minimumCropSpan(turned.width, turned.height, 640);
    expect(straightened.y).toBeGreaterThan(level.y);
  });

  it('grows a frame about its center until it meets the minimum span', () => {
    expect(fitMinimumSpan([0.4, 0.4, 0.6, 0.6], { x: 0.4, y: 0.3 })).toEqual([
      0.3, 0.35, 0.7, 0.65,
    ]);
    // Near an edge the grown frame stays inside the photo.
    const grown = fitMinimumSpan([0.9, 0, 1, 0.5], { x: 0.4, y: 0.2 });
    expect(grown[0]).toBeCloseTo(0.6);
    expect(grown[2]).toBeCloseTo(1);
    expect(fitMinimumSpan([0, 0, 1, 1], { x: 0.5, y: 0.5 })).toEqual([0, 0, 1, 1]);
  });
});
