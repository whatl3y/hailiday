import type { AttributionLogo } from '@hailiday/core';
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
  if (credit && showLogo) credit = withoutLogoPrefix(credit, t('attribution.googleMaps'));
  if (credit && fixture && /google/i.test(credit)) credit = null;
  return { showLogo, credit };
}

/**
 * The credit without the logo's own words: a credit that is only the logo name becomes null,
 * and a leading logo name with its `·` separator ("Google Maps · © 2026 Google") is removed, so
 * the strip never prints the name twice when the logo is shown.
 */
export function withoutLogoPrefix(credit: string, logoName: string): string | null {
  if (credit === logoName) return null;
  if (!credit.startsWith(logoName)) return credit;
  const rest = credit.slice(logoName.length);
  const match = /^\s*·\s*/.exec(rest);
  if (!match) return credit;
  return rest.slice(match[0].length).trim() || null;
}
