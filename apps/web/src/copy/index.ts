import type { HolidayId, LightingMode, RoomType, SceneType, Style } from '@holiday/core';
import { COPY_DECK, type CopyKey } from './deck';

export { COPY_DECK, SUPPLEMENT_KEYS, type CopyKey } from './deck';

export type CopyParams = Record<string, string | number>;

const PLACEHOLDER = /\{([a-zA-Z][a-zA-Z0-9]*)\}/g;

/** Fills `{name}` placeholders; unknown placeholders are left in place so gaps are visible. */
export function formatCopy(template: string, params?: CopyParams): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Returns the catalog string for a key with placeholders filled. */
export function t(key: CopyKey, params?: CopyParams): string {
  return formatCopy(COPY_DECK[key], params);
}

/** Whether a string from the API (for example a `labelKey`) names a catalog entry. */
export function isCopyKey(value: string): value is CopyKey {
  return Object.prototype.hasOwnProperty.call(COPY_DECK, value);
}

/** Looks up an API-provided key, falling back to a known key when the catalog lacks it. */
export function tDynamic(key: string, fallback: CopyKey, params?: CopyParams): string {
  return t(isCopyKey(key) ? key : fallback, params);
}

export function holidayName(holidayId: HolidayId): string {
  return t(`holiday.${holidayId}`);
}

export function styleLabel(style: Style): string {
  return t(`controls.style.${style}`);
}

export function lightingLabel(mode: LightingMode): string {
  return t(`controls.lighting.${mode}`);
}

/** The scene-type label used inside sentences ("Looks like a dining room"). */
export function sceneTypeLabel(sceneType: SceneType, roomType?: RoomType | null): string {
  if (sceneType !== 'interior') return t(`scene.label.${sceneType}`);
  if (!roomType || roomType === 'other') return t('scene.label.room');
  return t(`scene.label.${roomType}`);
}
