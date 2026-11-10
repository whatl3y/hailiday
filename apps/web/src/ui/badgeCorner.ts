import type { ActiveSource, Variant } from '@holiday/core';

/** The corner of an image that carries the "AI preview" badge. */
export type AiBadgeCorner = 'lower-right' | 'lower-left';

/**
 * Where the "AI preview" badge sits: the lower-right corner, unless the image carries
 * burned-in attribution there. Every Street View-origin image (fixture or live) carries its
 * photo credit in the lower-right corner, so its badge moves to the lower-left corner.
 */
export function aiBadgeCorner(streetViewOrigin: boolean): AiBadgeCorner {
  return streetViewOrigin ? 'lower-left' : 'lower-right';
}

/** The class names that place a corner mark: `base` plus its `base--<corner>` modifier. */
export function cornerClassName(base: string, corner: AiBadgeCorner): string {
  return `${base} ${base}--${corner}`;
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
