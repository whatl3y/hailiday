import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AttributionLogo, Project, Variant } from '@hailiday/core';
import { deleteProject, listProjects, listVariants } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { StreetViewAttribution } from '../../ui/Attribution';
import { attributionParts } from '../../ui/attributionText';
import {
  aiBadgeCorner,
  cornerClassName,
  isStreetViewVariant,
  thumbClassName,
} from '../../ui/badgeCorner';
import { useIsFixtureStreetView } from '../../ui/fixture';
import { PageShell } from '../../ui/Layout';
import { Sheet } from '../../ui/Sheet';
import './account.css';

const EXPIRY_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;

/** The project's newest variant, read once the project has any. */
function useLatestVariant(project: Project): Variant | null {
  const [latest, setLatest] = useState<Variant | null>(null);
  useEffect(() => {
    if (project.variantCount === 0) return;
    let active = true;
    listVariants(project.id)
      .then((list) => {
        const newest = [...list.items].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        )[0];
        if (active && newest) setLatest(newest);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [project.id, project.variantCount]);
  return latest;
}

/** Whether the project's active source is a Street View frame (live or fixture). */
function isStreetViewSource(project: Project): boolean {
  const kind = project.activeSource?.kind;
  return kind === 'street_view' || kind === 'fixture';
}

/**
 * The picture of a place: its newest look, large, with the AI preview badge (a Street View-origin
 * look is cropped from the top so its burned-in logo and copyright stay in view). A place without
 * a look shows its source photo when there is one: an uploaded photo fills the box, and a Street
 * View frame is shown whole, contained on the stage ground, with its marks in view. Otherwise the
 * holiday's dot.
 */
export function PlaceThumb({ project, latest }: { project: Project; latest: Variant | null }) {
  if (!latest) {
    const source = project.variantCount === 0 ? project.activeSource : null;
    if (source?.displayUrl) {
      const streetView = isStreetViewSource(project);
      return (
        <span
          className={
            streetView
              ? 'place__thumb place__thumb--source-frame'
              : 'place__thumb place__thumb--source'
          }
        >
          <img
            src={source.displayUrl}
            width={source.width ?? undefined}
            height={source.height ?? undefined}
            alt={streetView ? t('result.streetViewAlt') : t('upload.previewAltPending')}
            loading="lazy"
            decoding="async"
          />
        </span>
      );
    }
    return (
      <span className="place__thumb">
        <span className="place__swatch" aria-hidden="true" />
      </span>
    );
  }
  const streetView = isStreetViewVariant(latest, project.activeSource);
  const corner = aiBadgeCorner(streetView);
  return (
    <span className={thumbClassName('place__thumb', streetView)}>
      <img
        src={latest.imageUrl}
        width={latest.width}
        height={latest.height}
        alt={t('places.thumbAlt', { holiday: holidayName(project.holidayId) })}
        loading="lazy"
        decoding="async"
      />
      <span className={cornerClassName('place__badge', corner)} data-corner={corner}>
        {t('result.aiPreview')}
      </span>
    </span>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * The Google Maps credit of the Street View pixels on the card (a Street View-origin look, or the
 * raw frame of a place without a look); nothing for an uploaded photo.
 */
function PlaceCredit({ project, latest }: { project: Project; latest: Variant | null }) {
  const fixture = useIsFixtureStreetView(project.activeSource?.kind ?? null);
  let text: string | null;
  let logo: AttributionLogo | null;
  if (latest) {
    if (!isStreetViewVariant(latest, project.activeSource)) return null;
    text = latest.attribution?.text ?? null;
    logo = latest.attribution?.logo ?? 'google_maps';
  } else {
    const source = project.activeSource;
    if (project.variantCount > 0 || !source?.displayUrl || !isStreetViewSource(project)) {
      return null;
    }
    text = source.copyright;
    logo = 'google_maps';
  }
  const { showLogo, credit } = attributionParts({ text, logo, fixture });
  if (!showLogo && !credit) return null;
  return (
    <span className="fine place__credit">
      <StreetViewAttribution
        text={text}
        logo={logo}
        captureDate={null}
        showCaptureDate={false}
        fixture={fixture}
      />
    </span>
  );
}

/** How many looks the place has, or nothing before its first. */
function looksCount(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? t('places.looksOne') : t('places.looks', { n: count });
}

/**
 * One saved project as a picture card: its newest look large (or its source photo, or the holiday
 * dot), the Street View credit under it, then the address or "Uploaded photo", the holiday, the
 * number of looks and the last activity, and Open and Delete. The whole card above the actions is
 * one link to the place, named by its title.
 */
export function PlaceRow({
  project,
  now,
  onDelete,
}: {
  project: Project;
  now: number;
  onDelete: () => void;
}) {
  const expiresSoon =
    project.expiresAt !== null && Date.parse(project.expiresAt) - now < EXPIRY_NOTICE_MS;
  const title = project.property?.formattedAddress ?? t('places.uploadedPhoto');
  const latest = useLatestVariant(project);
  const looks = looksCount(project.variantCount);
  const titleId = `place-title-${project.id}`;
  const metaId = `place-meta-${project.id}`;
  return (
    <li className="place" data-holiday={project.holidayId}>
      <Link
        to={`/p/${project.id}`}
        className="place__link"
        aria-labelledby={titleId}
        aria-describedby={metaId}
      >
        <PlaceThumb project={project} latest={latest} />
        <span className="place__text">
          <PlaceCredit project={project} latest={latest} />
          <span className="place__title" id={titleId}>
            {title}
          </span>
          <span className="fine place__meta" id={metaId}>
            <span className="place__dot" aria-hidden="true" />
            {holidayName(project.holidayId)}
            {looks ? ` · ${looks}` : ''} ·{' '}
            {t('places.lastActivity', { date: formatDate(project.lastActivityAt) })}
          </span>
          {expiresSoon && project.expiresAt ? (
            <span className="fine">
              {t('places.expires', { date: formatDate(project.expiresAt) })}
            </span>
          ) : null}
        </span>
      </Link>
      <div className="place__actions">
        <Link to={`/p/${project.id}`} className="button button--small button--quiet">
          {t('places.open')}
        </Link>
        <button
          type="button"
          className="button button--small button--quiet place__delete"
          onClick={onDelete}
        >
          {t('result.delete')}
        </button>
      </div>
    </li>
  );
}

/** `/places`: the account's saved projects. */
export function PlacesPage() {
  const forgetProject = useAppStore((state) => state.forgetProject);
  const [items, setItems] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Project | null>(null);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let active = true;
    listProjects()
      .then((page) => {
        if (active) setItems(page.items.filter((project) => project.saved));
      })
      .catch((failure: unknown) => {
        if (active) setError(presentError(failure)?.message ?? t('error.unknown'));
      });
    return () => {
      active = false;
    };
  }, []);

  async function remove(project: Project) {
    setConfirming(null);
    try {
      await deleteProject(project.id);
      forgetProject(project.id);
      setItems((current) => current?.filter((item) => item.id !== project.id) ?? null);
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
    }
  }

  return (
    <PageShell title={t('places.title')}>
      <section className="places-page">
        <div className="places__head">
          <h1 className="places__title">{t('places.title')}</h1>
          <div className="places__links">
            <Link to="/gallery" className="link-button">
              {t('gallery.title')}
            </Link>
            <Link to="/account" className="link-button">
              {t('account.title')}
            </Link>
          </div>
        </div>
        {error ? (
          <p className="message message--error places__note" role="alert">
            {error}
          </p>
        ) : null}
        {items === null && !error ? (
          <div className="places__note">
            <div className="indeterminate" aria-hidden="true" />
          </div>
        ) : null}
        {items && items.length === 0 ? (
          <p className="lede places__note">{t('places.empty')}</p>
        ) : null}
        {items && items.length > 0 ? (
          <ul className="places">
            {items.map((project) => (
              <PlaceRow
                key={project.id}
                project={project}
                now={now}
                onDelete={() => setConfirming(project)}
              />
            ))}
          </ul>
        ) : null}
      </section>
      {confirming ? (
        <Sheet title={t('result.delete')} hideTitle onClose={() => setConfirming(null)}>
          <p className="lede">{t('delete.confirm')}</p>
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void remove(confirming)}
            >
              {t('delete.yes')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirming(null)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </Sheet>
      ) : null}
    </PageShell>
  );
}
