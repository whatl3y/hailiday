import { useId, useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { STRAIGHTEN_MAX_DEGREES } from '@holiday/core';
import { t } from '../../copy';
import { clampStraighten, nextStraighten, straightenText } from './crop';

export interface StraightenSliderProps {
  /** Degrees, clockwise positive. */
  value: number;
  onChange: (degrees: number) => void;
}

/**
 * The crop tool's straighten control: a horizontal `role="slider"` from 15° counterclockwise to
 * 15° clockwise with level in the middle. The whole 44 px track is the pointer target; arrows
 * move half a degree, Page Up and Page Down five, Home and End go to the limits.
 */
export function StraightenSlider({ value, onChange }: StraightenSliderProps) {
  const labelId = useId();
  const dragging = useRef(false);
  const percent = ((value + STRAIGHTEN_MAX_DEGREES) / (2 * STRAIGHTEN_MAX_DEGREES)) * 100;

  function fromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    const next = clampStraighten((fraction * 2 - 1) * STRAIGHTEN_MAX_DEGREES);
    if (next !== value) onChange(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = nextStraighten(value, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onChange(next);
  }

  return (
    <div className="straighten">
      <span className="straighten__label" id={labelId}>
        {t('upload.straighten')}
      </span>
      <div
        className="straighten__track"
        style={{ '--straighten': `${percent}%` } as CSSProperties}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          fromPointer(event);
        }}
        onPointerMove={(event) => {
          if (dragging.current) fromPointer(event);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
        }}
      >
        <span className="straighten__level" aria-hidden="true" />
        <div
          className="straighten__thumb"
          role="slider"
          tabIndex={0}
          aria-labelledby={labelId}
          aria-valuemin={-STRAIGHTEN_MAX_DEGREES}
          aria-valuemax={STRAIGHTEN_MAX_DEGREES}
          aria-valuenow={value}
          aria-valuetext={straightenText(value)}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
        />
      </div>
      <span className="straighten__value" aria-hidden="true">
        {straightenText(value)}
      </span>
    </div>
  );
}
