import type { AnchorCategory, Variant } from '@holiday/core';
import { holidayName, t, type CopyKey } from '../../copy';

/** How many placements the alt text names. */
const MAX_NAMED = 3;

/** The Shop the look phrase for an anchor ("your front door"). */
function anchorPhrase(category: AnchorCategory): string {
  return t(`shop.anchor.${category}`);
}

/** "decorations on your eaves, your front door and your porch rail" (up to three phrases). */
export function placementSummary(placements: readonly AnchorCategory[]): string | null {
  const phrases: string[] = [];
  for (const category of placements) {
    const phrase = anchorPhrase(category);
    if (!phrases.includes(phrase)) phrases.push(phrase);
    if (phrases.length === MAX_NAMED) break;
  }
  const [first, second, third] = phrases;
  if (!first) return null;
  if (!second) return t('result.placementSummary.one', { first });
  if (!third) return t('result.placementSummary.two', { first, second });
  return t('result.placementSummary.three', { first, second, third });
}

/**
 * Alt text of a generated image: the scene, the holiday and what the accepted plan decorated
 * ("AI preview of your house exterior decorated for Christmas: decorations on your eaves, your
 * front door and your porch rail"). Without placements it names the scene and holiday only.
 */
export function generatedAlt(
  variant: Pick<Variant, 'holidayId' | 'placements'>,
  sceneTypeLabel: string,
): string {
  const holiday = holidayName(variant.holidayId);
  const summary = placementSummary(variant.placements);
  const key: CopyKey = summary ? 'result.generatedAltPlaced' : 'result.generatedAlt';
  return t(key, { sceneTypeLabel, holiday, ...(summary ? { placementSummary: summary } : {}) });
}
