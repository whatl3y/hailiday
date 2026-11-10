import type { AttributionLogo, Candidate, Project } from '@holiday/core';
import { t } from '../../copy';
import { StreetViewAttribution } from '../../ui/Attribution';
import { ImageCard } from '../../ui/ImageCard';
import { useIsFixtureImage, useIsFixtureStreetView } from '../../ui/fixture';

/**
 * A Street View image with its attribution strip directly beneath it, inside the card. `logo`
 * is the discovery's attribution requirement.
 */
export function StreetViewCard({
  candidate,
  logo,
  loading,
}: {
  candidate: Candidate;
  logo: AttributionLogo | null;
  loading?: boolean;
}) {
  const fixture = useIsFixtureImage('street_view', { url: candidate.displayUrl });
  const fixtureStreetView = useIsFixtureStreetView();
  return (
    <ImageCard
      ratio={candidate.width / candidate.height}
      fixture={fixture}
      strip={
        <StreetViewAttribution
          text={candidate.copyright}
          logo={logo}
          captureDate={candidate.captureDate}
          fixture={fixtureStreetView}
        />
      }
    >
      {candidate.displayUrl ? (
        <img
          key={candidate.displayUrl}
          className="fade-in"
          src={candidate.displayUrl}
          alt={t('result.streetViewAlt')}
          width={candidate.width}
          height={candidate.height}
        />
      ) : null}
      {loading ? <span className="image-card__loading">{t('confirm.loadingView')}</span> : null}
    </ImageCard>
  );
}

/** The project's current source: the Street View image with attribution, or "Your photo". */
export function ProjectSourceCard({ project }: { project: Project }) {
  const source = project.activeSource;
  const isStreetView = source?.kind === 'street_view' || source?.kind === 'fixture';
  const fixture = useIsFixtureImage(isStreetView ? 'street_view' : 'photo', {
    url: source?.displayUrl,
    sourceKind: source?.kind,
  });
  const fixtureStreetView = useIsFixtureStreetView(source?.kind);
  if (!source?.displayUrl) return null;
  const ratio = source.width && source.height ? source.width / source.height : 1;
  return (
    <ImageCard
      ratio={ratio}
      fixture={fixture}
      strip={
        isStreetView ? (
          <StreetViewAttribution
            text={source.copyright}
            logo="google_maps"
            captureDate={source.captureDate}
            fixture={fixtureStreetView}
          />
        ) : (
          <span>{t('result.yourPhoto')}</span>
        )
      }
    >
      <img
        src={source.displayUrl}
        alt={isStreetView ? t('result.streetViewAlt') : t('upload.previewAltPending')}
        width={source.width ?? undefined}
        height={source.height ?? undefined}
      />
    </ImageCard>
  );
}
