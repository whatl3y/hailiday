import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { t } from '../../copy';
import { clampPercent, nextSliderValue } from './slider';

export interface CompareSliderProps {
  /** Percentage of the width, from the left, that shows the before photo. */
  value: number;
  onChange: (value: number, mode: 'slider' | 'keyboard') => void;
}

/**
 * The divider on the image with its handle (`role="slider"`). It is an enhancement: the
 * Before / AI preview toggle is always present, so comparing never depends on dragging. The
 * handle is 44 px and uses `touch-action: pan-y` so the page still scrolls on touch.
 */
export function CompareSlider({ value, onChange }: CompareSliderProps) {
  const dragging = useRef(false);

  function valueFromPointer(event: PointerEvent<HTMLElement>): number | null {
    const frame = event.currentTarget.parentElement;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    if (rect.width <= 0) return null;
    return clampPercent(((event.clientX - rect.left) / rect.width) * 100);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextSliderValue(value, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next, 'keyboard');
  }

  return (
    <div
      className="compare__handle"
      role="slider"
      tabIndex={0}
      aria-label={t('result.compareLabel')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      aria-valuetext={t('result.compareValue', { n: value })}
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!dragging.current) return;
        const next = valueFromPointer(event);
        if (next !== null && next !== value) onChange(next, 'slider');
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <span className="compare__grip" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false">
          <path d="m9 7-5 5 5 5M15 7l5 5-5 5" />
        </svg>
      </span>
    </div>
  );
}
