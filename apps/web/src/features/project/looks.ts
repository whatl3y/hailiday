import {
  DEFAULT_LIGHTING_MODE,
  DEFAULT_STYLE,
  type Allowance,
  type ExperienceHoliday,
  type HolidayId,
  type LightingMode,
  type OfferedSet,
  type SceneType,
  type Variant,
} from '@hailiday/core';
import { formatResetTime } from '../../api/present';
import { holidayName, lightingLabel, styleLabel, t } from '../../copy';
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

/**
 * The variant that already shows an as-photographed look of a dusk or night photo. Such a photo
 * is not offered evening once it has been analyzed, and its evening look was decorated in the
 * photo's own light, so the evening variant of the same holiday and style stands in for the
 * as-photographed look. Null when evening is still offered or the look is not as photographed.
 */
export function asPhotographedStandIn(
  variants: readonly Variant[],
  look: Look,
  sourceAssetId: string | null | undefined,
  lightingModes: readonly LightingMode[],
): Variant | null {
  if (look.lightingMode !== 'source' || lightingModes.includes('evening')) return null;
  return findCachedVariant(variants, { ...look, lightingMode: 'evening' }, sourceAssetId);
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

/** Offered styles and lighting modes with the look a never-chosen render starts from. */
export type OfferedLookOptions = OfferedSet;

/**
 * Styles and lighting modes the controls may offer for a holiday. The project's own offered
 * set (computed by the server, including whether the photo was judged daylight, and carrying
 * the scene type's default look) is used for its current holiday; another holiday's pack offer
 * comes from the experience, with lighting limited to what the source allows.
 */
export function offeredForHoliday(input: {
  holidayId: HolidayId;
  projectHolidayId: HolidayId | null;
  projectOffered: OfferedSet | null;
  sceneType: SceneType | null;
  holidays: readonly ExperienceHoliday[];
}): OfferedLookOptions {
  if (input.holidayId === input.projectHolidayId && input.projectOffered) {
    return input.projectOffered;
  }
  const pack =
    input.sceneType !== null
      ? (input.holidays.find((holiday) => holiday.id === input.holidayId)?.sceneTypes[
          input.sceneType
        ] ?? null)
      : null;
  const sourceLighting = input.projectOffered?.lightingModes ?? [DEFAULT_LIGHTING_MODE];
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

/**
 * The default look for a holiday: the offered default style and lighting, kept inside the
 * offered sets.
 */
export function defaultLook(holidayId: HolidayId, offered: OfferedLookOptions): Look {
  return normalizeLook(
    { holidayId, style: offered.defaultStyle, lightingMode: offered.defaultLightingMode },
    offered,
  );
}

/**
 * Whether a look's label names its lighting: never for `bright` (the only lighting of an
 * interior, so there is nothing to tell apart), and not when the scene offers a single lighting
 * mode and the look uses it.
 */
export function labelsLighting(
  lightingMode: LightingMode,
  lightingModes: readonly LightingMode[],
): boolean {
  if (lightingMode === 'bright') return false;
  return !(lightingModes.length === 1 && lightingModes[0] === lightingMode);
}

const NO_BREAK_SPACE = '\u00a0';

/**
 * Text that never wraps inside: its spaces become non-breaking spaces. Each part of a look label
 * is written this way (for example the holiday part is `unbroken(holidayName(id))`).
 */
export function unbroken(text: string): string {
  return text.replace(/ /g, NO_BREAK_SPACE);
}

/**
 * "{holiday} · {style} · {lighting}", or "{holiday} · {style}" when the lighting says nothing.
 * Each part stays whole and each separator stays with the part before it, so a narrow line wraps
 * only after a separator ("Christmas · Abundant ·" / "As photographed"), never inside a part or
 * before a separator.
 */
export function lookLabel(look: Look, lightingModes: readonly LightingMode[]): string {
  const holiday = unbroken(holidayName(look.holidayId));
  const style = unbroken(styleLabel(look.style));
  const label = labelsLighting(look.lightingMode, lightingModes)
    ? t('result.holidayLabel', {
        holiday,
        style,
        lighting: unbroken(lightingLabel(look.lightingMode)),
      })
    : t('result.holidayStyleLabel', { holiday, style });
  return label.replace(/ ·/g, `${NO_BREAK_SPACE}·`);
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
