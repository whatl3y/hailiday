import { useState } from 'react';
import type { HolidayChangeSurface, HolidayId } from '@holiday/core';
import { holidayName, t } from '../copy';
import { currentHolidayId, useAppStore } from '../state/appStore';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { chooseHolidayExplicitly } from './holidaySelection';

export interface HolidayOptionsProps {
  selected: HolidayId | null;
  onChoose: (holidayId: HolidayId) => void;
  labelledBy?: string;
  label?: string;
  /** Inline pill layout instead of the full-width list. */
  compact?: boolean;
  /** The holidays to offer, in picker order (defaults to every holiday in picker order). */
  holidayIds?: readonly HolidayId[];
}

/** The holiday list in picker order; the current value is conveyed by `aria-pressed`. */
export function HolidayOptions({
  selected,
  onChoose,
  labelledBy,
  label,
  compact,
  holidayIds,
}: HolidayOptionsProps) {
  const pickerOrder = useAppStore((state) => state.pickerHolidayIds);
  const order = holidayIds ?? pickerOrder;
  const inWindow = useAppStore((state) => state.clientDefaultHolidayId);

  if (compact) {
    return (
      <div className="holiday-inline" role="group" aria-labelledby={labelledBy} aria-label={label}>
        {order.map((holidayId) => (
          <button
            key={holidayId}
            type="button"
            className="chip"
            data-holiday={holidayId}
            aria-pressed={selected === holidayId}
            onClick={() => onChoose(holidayId)}
          >
            <span className="chip__swatch" aria-hidden="true" />
            {holidayName(holidayId)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <ul className="holiday-options" aria-labelledby={labelledBy} aria-label={label}>
      {order.map((holidayId) => (
        <li key={holidayId}>
          <button
            type="button"
            className="holiday-option"
            data-holiday={holidayId}
            aria-pressed={selected === holidayId}
            onClick={() => onChoose(holidayId)}
          >
            <span className="holiday-option__swatch" aria-hidden="true" />
            <span className="holiday-option__name">{holidayName(holidayId)}</span>
            <span className="holiday-option__meta">
              {holidayId === inWindow ? t('landing.pickerCurrent') : t('landing.pickerUpcoming')}
            </span>
            {selected === holidayId ? (
              <span className="holiday-option__check">
                <Icon name="check" />
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface HolidayChipProps {
  surface: HolidayChangeSurface;
  /** Glass style for use over a photograph. */
  onPhoto?: boolean;
  onChange?: (holidayId: HolidayId) => void;
  /** Limits the picker to these holidays (for example those the project's scene supports). */
  holidayIds?: readonly HolidayId[];
  /** Overrides the holiday the chip names (for example the look on screen). */
  shown?: HolidayId | null;
}

/** The header chip: reads the current holiday and opens the picker sheet. */
export function HolidayChip({ surface, onPhoto, onChange, holidayIds, shown }: HolidayChipProps) {
  const [open, setOpen] = useState(false);
  const current = useAppStore(currentHolidayId);
  const hasPickerHolidays = useAppStore((state) => state.pickerHolidayIds.length > 0);
  const selected = shown === undefined ? current : shown;
  const hasHolidays = holidayIds ? holidayIds.length > 0 : hasPickerHolidays;
  if (!hasHolidays) return null;

  return (
    <>
      <button
        type="button"
        className={onPhoto ? 'chip chip--glass' : 'chip'}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {selected ? <span className="chip__swatch" aria-hidden="true" /> : null}
        <span className="sr-only">{t('landing.pickerLabel')}: </span>
        {selected ? holidayName(selected) : t('landing.chooseHoliday')}
        <Icon name="chevronDown" />
      </button>
      {open ? (
        <Sheet title={t('landing.pickerHeading')} onClose={() => setOpen(false)}>
          <HolidayOptions
            selected={selected}
            label={t('landing.pickerHeading')}
            holidayIds={holidayIds}
            onChoose={(holidayId) => {
              chooseHolidayExplicitly(holidayId, surface);
              setOpen(false);
              onChange?.(holidayId);
            }}
          />
        </Sheet>
      ) : null}
    </>
  );
}
