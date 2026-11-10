import type { AttributionLogo } from '@holiday/core';
import { t } from '../copy';

/** Fixture stand-in photographs credit their photographer with this prefix. */
export const FIXTURE_PHOTO_CREDIT_PREFIX = 'Fixture photo:';

/** Whether a credit line belongs to a fixture stand-in photograph. */
export function isFixturePhotoCredit(text: string | null | undefined): boolean {
  return Boolean(text?.trim().startsWith(FIXTURE_PHOTO_CREDIT_PREFIX));
}

export interface AttributionParts {
  /** The Google Maps logo, shown only when the attribution calls for it on real imagery. */
  showLogo: boolean;
  /** The credit line, unless it only repeats the logo or would name Google on fixture imagery. */
  credit: string | null;
}

/**
 * What the strip under a Street View-origin image says. The API's credit text is shown as it
 * is; the Google Maps logo appears only when `logo` asks for it, and nothing naming Google is
 * ever printed next to fixture imagery.
 */
export function attributionParts(input: {
  text: string | null;
  logo: AttributionLogo | null;
  fixture: boolean;
}): AttributionParts {
  const text = input.text?.trim() || null;
  const fixture = input.fixture || isFixturePhotoCredit(text);
  const showLogo = input.logo === 'google_maps' && !fixture;
  let credit = text;
  if (credit && showLogo && credit === t('attribution.googleMaps')) credit = null;
  if (credit && fixture && /google/i.test(credit)) credit = null;
  return { showLogo, credit };
}
