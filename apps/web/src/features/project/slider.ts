export const SLIDER_STEP = 5;
export const SLIDER_PAGE_STEP = 20;

export function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

/**
 * The slider's keyboard model: arrows move 5, Page Up and Page Down move 20, Home sets 0 and
 * End sets 100. Returns null for keys the slider does not handle.
 */
export function nextSliderValue(value: number, key: string): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clampPercent(value + SLIDER_STEP);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clampPercent(value - SLIDER_STEP);
    case 'PageUp':
      return clampPercent(value + SLIDER_PAGE_STEP);
    case 'PageDown':
      return clampPercent(value - SLIDER_PAGE_STEP);
    case 'Home':
      return 0;
    case 'End':
      return 100;
    default:
      return null;
  }
}
