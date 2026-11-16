import type { ActiveSource, Variant } from '@hailiday/core';

/** The corner of an image that carries the "AI preview" badge. */
export type AiBadgeCorner = 'lower-right' | 'upper-left';

/**
 * Where the "AI preview" badge sits: the lower-right corner, unless the image is a Street View
 * frame. A Street View-origin image (fixture or live) carries burned-in attribution along its
 * lower edge (the Google logo at the lower left and the copyright at the lower right), so its
 * badge goes to the upper-left corner, where it covers neither.
 */
export function aiBadgeCorner(streetViewOrigin: boolean): AiBadgeCorner {
  return streetViewOrigin ? 'upper-left' : 'lower-right';
}

/** The class names that place a corner mark: `base` plus its `base--<corner>` modifier. */
export function cornerClassName(base: string, corner: AiBadgeCorner): string {
  return `${base} ${base}--${corner}`;
}

/**
 * The class names of a cropped thumbnail: `base`, plus `base--street-view` for a Street
 * View-origin image, whose stylesheet rule keeps the bottom of the frame (where the burned-in
 * logo and copyright sit) in view and crops from the top instead.
 */
export function thumbClassName(base: string, streetViewOrigin: boolean): string {
  return streetViewOrigin ? `${base} ${base}--street-view` : base;
}

/**
 * Whether a variant was made from a Street View frame: the variant carries Street View
 * attribution, or the project's active source (when the variant was made from it) is a Street
 * View or fixture Street View frame.
 */
export function isStreetViewVariant(
  variant: Pick<Variant, 'attribution' | 'sourceAssetId'>,
  activeSource: Pick<ActiveSource, 'sourceAssetId' | 'kind'> | null | undefined,
): boolean {
  if (variant.attribution !== null) return true;
  const own =
    activeSource && activeSource.sourceAssetId === variant.sourceAssetId ? activeSource : null;
  return own?.kind === 'street_view' || own?.kind === 'fixture';
}
