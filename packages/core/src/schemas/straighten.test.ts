import { describe, expect, it } from 'vitest';
import { PeopleResolutionInputSchema } from './projects.js';
import {
  STRAIGHTEN_MAX_DEGREES,
  straightenBoxBounds,
  straightenPoint,
  straightenScale,
} from './straighten.js';

describe('straightening the people crop', () => {
  it('accepts an optional rotation of at most 15 degrees either way', () => {
    const box = [0.1, 0.1, 0.9, 0.9];
    expect(PeopleResolutionInputSchema.parse({ action: 'crop', box })).toEqual({
      action: 'crop',
      box,
    });
    for (const rotation of [-STRAIGHTEN_MAX_DEGREES, -2.5, 0, 7, STRAIGHTEN_MAX_DEGREES]) {
      expect(PeopleResolutionInputSchema.safeParse({ action: 'crop', box, rotation }).success).toBe(
        true,
      );
    }
    for (const rotation of [-15.5, 16, 90, Number.NaN]) {
      expect(PeopleResolutionInputSchema.safeParse({ action: 'crop', box, rotation }).success).toBe(
        false,
      );
    }
    expect(PeopleResolutionInputSchema.safeParse({ action: 'keep', rotation: 3 }).success).toBe(
      false,
    );
  });

  it('zooms just enough to fill the frame', () => {
    expect(straightenScale(0, 1600, 1200)).toBe(1);
    const angle = (10 * Math.PI) / 180;
    expect(straightenScale(10, 1600, 1200)).toBeCloseTo(
      Math.cos(angle) + (4 / 3) * Math.sin(angle),
    );
    expect(straightenScale(-10, 1200, 1600)).toBeCloseTo(straightenScale(10, 1600, 1200));
  });

  it('leaves no empty corner: every frame corner maps back inside the photo', () => {
    for (const [width, height] of [
      [1600, 1200],
      [1200, 1600],
      [1000, 1000],
      [2400, 1347],
    ] as const) {
      for (const degrees of [-15, -6, 3, 15]) {
        const scale = straightenScale(degrees, width, height);
        const angle = (degrees * Math.PI) / 180;
        for (const [x, y] of [
          [0, 0],
          [width, 0],
          [0, height],
          [width, height],
        ] as const) {
          // Inverse of straightenPoint: rotate back by -θ and undo the zoom.
          const dx = (x - width / 2) / scale;
          const dy = (y - height / 2) / scale;
          const px = width / 2 + Math.cos(angle) * dx + Math.sin(angle) * dy;
          const py = height / 2 - Math.sin(angle) * dx + Math.cos(angle) * dy;
          expect(px).toBeGreaterThanOrEqual(-1e-6);
          expect(px).toBeLessThanOrEqual(width + 1e-6);
          expect(py).toBeGreaterThanOrEqual(-1e-6);
          expect(py).toBeLessThanOrEqual(height + 1e-6);
          expect(straightenPoint([px, py], degrees, width, height)[0]).toBeCloseTo(x, 6);
          expect(straightenPoint([px, py], degrees, width, height)[1]).toBeCloseTo(y, 6);
        }
      }
    }
  });

  it('turns clockwise for a positive rotation and bounds a box on the straightened view', () => {
    // A point right of center moves down when the photo turns clockwise (y grows downward).
    const [, y] = straightenPoint([900, 500], 10, 1000, 1000);
    expect(y).toBeGreaterThan(500);
    expect(straightenBoxBounds([0.25, 0.25, 0.75, 0.75], 0, 1000, 1000)).toEqual([
      0.25, 0.25, 0.75, 0.75,
    ]);
    const bounds = straightenBoxBounds([0.45, 0.45, 0.55, 0.55], 15, 1000, 1000);
    // Centered boxes stay centered and grow (zoom plus the rotated corners).
    expect((bounds[0] + bounds[2]) / 2).toBeCloseTo(0.5);
    expect(bounds[2] - bounds[0]).toBeGreaterThan(0.1);
  });
});
