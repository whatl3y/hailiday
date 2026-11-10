import { describe, expect, it } from 'vitest';
import { generatedAlt, placementSummary } from './generatedAlt';

describe('generated image alt text', () => {
  it('names the scene, the holiday and up to three placements with the Shop the look phrases', () => {
    expect(
      generatedAlt(
        { holidayId: 'christmas', placements: ['eaves', 'front_door', 'porch_rail', 'planter'] },
        'house exterior',
      ),
    ).toBe(
      'AI preview of your house exterior decorated for Christmas: decorations on your eaves, ' +
        'your front door and your porch rail',
    );
  });

  it('names one or two placements and never repeats a phrase', () => {
    expect(placementSummary(['mantel'])).toBe('decorations on your mantel');
    // A window frame and an interior window read the same.
    expect(placementSummary(['window_frame', 'interior_window', 'dining_table'])).toBe(
      'decorations on your windows and your table',
    );
  });

  it('falls back to the scene and holiday when the plan is unknown', () => {
    expect(placementSummary([])).toBeNull();
    expect(generatedAlt({ holidayId: 'halloween', placements: [] }, 'balcony or patio')).toBe(
      'AI preview of your balcony or patio decorated for Halloween',
    );
  });
});
