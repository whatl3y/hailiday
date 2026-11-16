import { useId } from 'react';
import type { HolidayId, LightingMode, Style } from '@hailiday/core';
import { holidayName, lightingLabel, styleLabel, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import {
  lookOf,
  makingLook,
  refuseWhileMakingLook,
  useProjectStore,
} from '../../state/projectStore';
import { chooseHolidayExplicitly } from '../../ui/holidaySelection';
import { chooseLook, offeredFor } from './controller';
import { LOCK_HINT_ID } from './LookProgress';
import { splitLeadingHoliday } from './lookSummary';
import { allowanceCounterText, holidaysForScene, lookLabel } from './looks';

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
  locked,
}: {
  labelId: string;
  values: readonly T[];
  selected: T;
  label: (value: T) => string;
  onChoose: (value: T) => void;
  /** Locked while a look is being made: focusable, described by the lock line, inert. */
  locked: boolean;
}) {
  return (
    <div className="segmented look-controls__segmented" role="group" aria-labelledby={labelId}>
      {values.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={selected === value}
          aria-disabled={locked || undefined}
          aria-describedby={locked ? LOCK_HINT_ID : undefined}
          onClick={() => onChoose(value)}
        >
          {label(value)}
        </button>
      ))}
    </div>
  );
}

/**
 * The selected look's label ("Christmas · Abundant · Evening"), for the collapsed row. The
 * holiday part sits in its own span, which narrow screens hide: the title above names it.
 */
export function SelectedLookLabel() {
  const variant = useProjectStore((state) => state.variant);
  const storedLook = useProjectStore((state) => state.look);
  // Subscribing keeps the label current when the variants list brings the offered sets.
  useProjectStore((state) => state.offered);
  if (!variant) return null;
  const look = storedLook ?? lookOf(variant);
  const label = lookLabel(look, offeredFor(look.holidayId).lightingModes);
  const parts = splitLeadingHoliday(label, holidayName(look.holidayId));
  if (!parts) return <>{label}</>;
  return (
    <>
      <span className="look-summary__holiday">{parts.lead}</span>
      {parts.rest}
    </>
  );
}

/**
 * Holiday, style and lighting inside "Try another look", plus the allowance counter. A cached
 * look switches instantly, a new one is decorated while the current preview stays on screen, and
 * at the limit the allowance sheet explains when more looks are available. While a look is being
 * made every control is locked (focusable, inert, described by the lock line, which takes the
 * counter's place). The lighting row shows only where the scene offers evening.
 */
export function LookControls() {
  const id = useId();
  const project = useProjectStore((state) => state.project);
  const variant = useProjectStore((state) => state.variant);
  const storedLook = useProjectStore((state) => state.look);
  const locked = useProjectStore(makingLook);
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
    // The app's holiday is recorded before the look changes, so a locked press records nothing.
    if (refuseWhileMakingLook()) return;
    chooseHolidayExplicitly(holidayId, 'result');
    chooseLook({ holidayId });
  }

  return (
    <div className="look-controls" data-locked={locked || undefined}>
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
                aria-disabled={locked || undefined}
                aria-describedby={locked ? LOCK_HINT_ID : undefined}
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
            locked={locked}
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
            locked={locked}
            onChoose={(lightingMode) => chooseLook({ lightingMode })}
          />
        </div>
      ) : null}
      {locked ? (
        <p className="look-controls__locked">{t('controls.locked')}</p>
      ) : (
        <AllowanceCounter />
      )}
    </div>
  );
}
