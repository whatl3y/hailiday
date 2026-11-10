/** Copyright prefix of fixture Street View stand-ins (licensed photographs, never Google's). */
export const FIXTURE_PHOTO_COPYRIGHT_PREFIX = 'Fixture photo:';

/** Suffix marking a fixture photo that stands in for contributor (non-first-party) imagery. */
export const CONTRIBUTOR_STAND_IN_SUFFIX = '(contributor imagery stand-in)';

/** True for the copyright line of a fixture stand-in photograph. */
export function isFixturePhotoCopyright(copyright: string | null | undefined): boolean {
  return Boolean(copyright?.startsWith(FIXTURE_PHOTO_COPYRIGHT_PREFIX));
}

/** True for a fixture stand-in photograph marked as contributor imagery. */
export function isContributorStandIn(copyright: string | null | undefined): boolean {
  return (
    isFixturePhotoCopyright(copyright) && Boolean(copyright?.endsWith(CONTRIBUTOR_STAND_IN_SUFFIX))
  );
}
