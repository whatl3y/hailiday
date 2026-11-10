import {
  DEFAULT_LIGHTING_MODE,
  DEFAULT_STYLE,
  type Allowance,
  type ExperienceHoliday,
  type HolidayId,
  type OfferedSet,
  type SceneType,
  type Variant,
} from '@holiday/core';
import { formatResetTime } from '../../api/present';
import { t } from '../../copy';
import type { Look } from '../../state/projectStore';

/** Whether two looks are the same combination. */
export function sameLook(a: Look | null, b: Look | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.holidayId === b.holidayId &&
    a.style === b.style &&
    a.lightingMode === b.lightingMode
  );
}

/** Variants sorted newest first. */
export function newestFirst(variants: readonly Variant[]): Variant[] {
  return [...variants].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/**
 * The newest accepted variant for a look made from the given source, if the project already
 * has one. Variants of an earlier source (a replaced photo or another view) never stand in for
 * the current source's look.
 */
export function findCachedVariant(
  variants: readonly Variant[],
  look: Look,
  sourceAssetId: string | null | undefined,
): Variant | null {
  if (!sourceAssetId) return null;
  return (
    newestFirst(variants).find(
      (variant) => variant.sourceAssetId === sourceAssetId && sameLook(look, variant),
    ) ?? null
  );
}

/** Variants made from the given source, newest first. */
export function variantsOfSource(
  variants: readonly Variant[],
  sourceAssetId: string | null | undefined,
): Variant[] {
  if (!sourceAssetId) return [];
  return newestFirst(variants.filter((variant) => variant.sourceAssetId === sourceAssetId));
}

/**
 * Holidays (in picker order) that offer a section for the scene type, so no control offers a
 * holiday the project cannot be decorated for. Without a scene type or the holiday list, every
 * holiday is kept.
 */
export function holidaysForScene(
  pickerIds: readonly HolidayId[],
  holidays: readonly ExperienceHoliday[] | null,
  sceneType: SceneType | null,
): HolidayId[] {
  if (!sceneType || !holidays) return [...pickerIds];
  return pickerIds.filter((holidayId) => {
    const holiday = holidays.find((item) => item.id === holidayId);
    return holiday ? holiday.sceneTypes[sceneType] !== undefined : false;
  });
}

/** Adds (or refreshes) a variant in a newest-first list. */
export function withVariant(variants: readonly Variant[], variant: Variant): Variant[] {
  return newestFirst([
    variant,
    ...variants.filter((item) => item.renderAssetId !== variant.renderAssetId),
  ]);
}

export interface OfferedLookOptions extends OfferedSet {
  defaultStyle: Variant['style'];
  defaultLightingMode: Variant['lightingMode'];
}

/**
 * Styles and lighting modes the controls may offer for a holiday. The project's own offered
 * set (computed by the server, including whether the photo was judged daylight) is used for
 * its current holiday; another holiday's pack offer comes from the experience, with lighting
 * limited to what the source allows.
 */
export function offeredForHoliday(input: {
  holidayId: HolidayId;
  projectHolidayId: HolidayId | null;
  projectOffered: OfferedSet | null;
  sceneType: SceneType | null;
  holidays: readonly ExperienceHoliday[];
}): OfferedLookOptions {
  const pack =
    input.sceneType !== null
      ? (input.holidays.find((holiday) => holiday.id === input.holidayId)?.sceneTypes[
          input.sceneType
        ] ?? null)
      : null;
  const sourceLighting = input.projectOffered?.lightingModes ?? [DEFAULT_LIGHTING_MODE];
  if (input.holidayId === input.projectHolidayId && input.projectOffered) {
    return {
      ...input.projectOffered,
      defaultStyle: pack?.defaultStyle ?? DEFAULT_STYLE,
      defaultLightingMode: DEFAULT_LIGHTING_MODE,
    };
  }
  if (pack) {
    const lightingModes = pack.lightingModes.filter((mode) => sourceLighting.includes(mode));
    return {
      styles: pack.styles,
      lightingModes: lightingModes.length > 0 ? lightingModes : [DEFAULT_LIGHTING_MODE],
      defaultStyle: pack.defaultStyle,
      defaultLightingMode: lightingModes.includes(pack.defaultLightingMode)
        ? pack.defaultLightingMode
        : DEFAULT_LIGHTING_MODE,
    };
  }
  return {
    styles: input.projectOffered?.styles ?? [DEFAULT_STYLE],
    lightingModes: sourceLighting,
    defaultStyle: DEFAULT_STYLE,
    defaultLightingMode: DEFAULT_LIGHTING_MODE,
  };
}

/** Keeps a look inside the offered sets, falling back to the defaults. */
export function normalizeLook(look: Look, offered: OfferedLookOptions): Look {
  const style = offered.styles.includes(look.style)
    ? look.style
    : offered.styles.includes(offered.defaultStyle)
      ? offered.defaultStyle
      : (offered.styles[0] ?? DEFAULT_STYLE);
  const lightingMode = offered.lightingModes.includes(look.lightingMode)
    ? look.lightingMode
    : offered.defaultLightingMode;
  return { holidayId: look.holidayId, style, lightingMode };
}

/** Whether the allowance snapshot says no more looks can be made today. */
export function looksExhausted(allowance: Allowance | null): boolean {
  return allowance !== null && allowance.variants.remaining <= 0;
}

/**
 * The allowance counter's line: "{n} more looks today", "1 more look today", or the reset time
 * at zero.
 */
export function allowanceCounterText(allowance: Allowance): string {
  const { remaining, resetsAt } = allowance.variants;
  if (remaining <= 0) return t('allowance.counterZero', { resetsAt: formatResetTime(resetsAt) });
  return remaining === 1 ? t('allowance.counterOne') : t('allowance.counter', { n: remaining });
}

/** Whether the person may share this preview, and what the menu says when they may not. */
export function shareAvailability(
  variant: Variant,
  sharingEnabled: boolean,
): { canShare: boolean; unavailableNote: boolean } {
  if (variant.privateOnly || !sharingEnabled) return { canShare: false, unavailableNote: false };
  if (variant.distributable) return { canShare: true, unavailableNote: false };
  return { canShare: false, unavailableNote: variant.attribution !== null };
}
