import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Project, Variant } from '@holiday/core';
import { deleteProject, listProjects, listVariants } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { aiBadgeCorner, cornerClassName, isStreetViewVariant } from '../../ui/badgeCorner';
import { HolidayChip } from '../../ui/HolidayPicker';
import { PageShell } from '../../ui/Layout';
import { Sheet } from '../../ui/Sheet';
import './account.css';

const EXPIRY_NOTICE_MS = 30 * 24 * 60 * 60 * 1000;

/** The project's latest preview as a small thumbnail with the AI preview badge. */
export function PlaceThumb({ project }: { project: Project }) {
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
  const corner = latest
    ? aiBadgeCorner(isStreetViewVariant(latest, project.activeSource))
    : 'lower-right';
  return (
    <span className="place__thumb">
      {latest ? (
        <>
          <img
            src={latest.imageUrl}
            alt={t('places.thumbAlt', { holiday: holidayName(project.holidayId) })}
            loading="lazy"
          />
          <span className={cornerClassName('place__badge', corner)} data-corner={corner}>
            {t('result.aiPreview')}
          </span>
        </>
      ) : (
        <span className="place__swatch" aria-hidden="true" />
      )}
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

function PlaceRow({
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
  return (
    <li className="place" data-holiday={project.holidayId}>
      <PlaceThumb project={project} />
      <div className="place__text">
        <Link to={`/p/${project.id}`} className="place__title">
          {title}
        </Link>
        <span className="fine">
          {holidayName(project.holidayId)} ·{' '}
          {t('places.lastActivity', { date: formatDate(project.lastActivityAt) })}
        </span>
        {expiresSoon && project.expiresAt ? (
          <span className="fine">
            {t('places.expires', { date: formatDate(project.expiresAt) })}
          </span>
        ) : null}
      </div>
      <div className="place__actions">
        <Link to={`/p/${project.id}`} className="button button--small">
          {t('places.open')}
        </Link>
        <button type="button" className="button button--small button--quiet" onClick={onDelete}>
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
    <PageShell title={t('places.title')} headerEnd={<HolidayChip surface="landing" />}>
      <section className="container container--narrow simple-page stack stack--loose">
        <div className="places__head">
          <h1 className="simple-page__title">{t('places.title')}</h1>
          <Link to="/account" className="link-button">
            {t('account.title')}
          </Link>
        </div>
        {error ? (
          <p className="message message--error" role="alert">
            {error}
          </p>
        ) : null}
        {items === null && !error ? <div className="indeterminate" aria-hidden="true" /> : null}
        {items && items.length === 0 ? <p className="lede">{t('places.empty')}</p> : null}
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
            <button type="button" className="button" onClick={() => setConfirming(null)}>
              {t('common.cancel')}
            </button>
          </div>
        </Sheet>
      ) : null}
    </PageShell>
  );
}
