import { useId } from 'react';
import type { HolidayId, LightingMode, Style } from '@holiday/core';
import { holidayName, lightingLabel, styleLabel, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { lookOf, useProjectStore } from '../../state/projectStore';
import { chooseHolidayExplicitly } from '../../ui/holidaySelection';
import { chooseLook, offeredFor } from './controller';
import { allowanceCounterText, holidaysForScene } from './looks';

/** "{n} more looks today": passive, beside the controls, after the first result only. */
export function AllowanceCounter() {
  const allowance = useAppStore((state) => state.allowance);
  if (!allowance) return null;
  return (
    <p className="allowance-counter" data-zero={allowance.variants.remaining <= 0 || undefined}>
      <span className="allowance-counter__dot" aria-hidden="true" />
      {allowanceCounterText(allowance)}
    </p>
  );
}

function Segmented<T extends string>({
  labelId,
  values,
  selected,
  label,
  onChoose,
}: {
  labelId: string;
  values: readonly T[];
  selected: T;
  label: (value: T) => string;
  onChoose: (value: T) => void;
}) {
  return (
    <div className="segmented look-controls__segmented" role="group" aria-labelledby={labelId}>
      {values.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected === value}
          onClick={() => onChoose(value)}
        >
          {label(value)}
        </button>
      ))}
    </div>
  );
}

/**
 * Holiday, style and lighting under the result card, plus the allowance counter. Every control
 * stays enabled: a cached look switches instantly, a new one is decorated under the pending
 * band, and at the limit the allowance sheet explains when more looks are available.
 */
export function LookControls() {
  const id = useId();
  const project = useProjectStore((state) => state.project);
  const variant = useProjectStore((state) => state.variant);
  const storedLook = useProjectStore((state) => state.look);
  const pickerIds = useAppStore((state) => state.pickerHolidayIds);
  const holidays = useAppStore((state) => state.experience?.holidays ?? null);
  // Subscribing keeps the offered sets current when the variants list arrives.
  useProjectStore((state) => state.offered);
  if (!project || !variant) return null;

  const look = storedLook ?? lookOf(variant);
  const offered = offeredFor(look.holidayId);
  const sceneType = project.sceneType;
  const holidayIds = holidaysForScene(pickerIds, holidays, sceneType);
  const showLighting = offered.lightingModes.includes('evening');

  function chooseHoliday(holidayId: HolidayId) {
    chooseHolidayExplicitly(holidayId, 'result');
    chooseLook({ holidayId });
  }

  return (
    <section className="look-controls" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="look-controls__heading">
        {t('result.controlsHeading')}
      </h2>
      {holidayIds.length > 1 ? (
        <div className="look-controls__row">
          <span id={`${id}-holiday`} className="look-controls__label">
            {t('controls.holidayLabel')}
          </span>
          <div className="holiday-inline" role="group" aria-labelledby={`${id}-holiday`}>
            {holidayIds.map((holidayId) => (
              <button
                key={holidayId}
                type="button"
                className="chip"
                data-holiday={holidayId}
                aria-pressed={look.holidayId === holidayId}
                onClick={() => chooseHoliday(holidayId)}
              >
                <span className="chip__swatch" aria-hidden="true" />
                {holidayName(holidayId)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {offered.styles.length > 1 ? (
        <div className="look-controls__row">
          <span id={`${id}-style`} className="look-controls__label">
            {t('controls.styleLabel')}
          </span>
          <Segmented<Style>
            labelId={`${id}-style`}
            values={offered.styles}
            selected={look.style}
            label={styleLabel}
            onChoose={(style) => chooseLook({ style })}
          />
        </div>
      ) : null}
      {showLighting ? (
        <div className="look-controls__row">
          <span id={`${id}-lighting`} className="look-controls__label">
            {t('controls.lightingLabel')}
          </span>
          <Segmented<LightingMode>
            labelId={`${id}-lighting`}
            values={offered.lightingModes}
            selected={look.lightingMode}
            label={lightingLabel}
            onChoose={(lightingMode) => chooseLook({ lightingMode })}
          />
        </div>
      ) : null}
      <AllowanceCounter />
    </section>
  );
}
