import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ShareView } from '@holiday/core';
import { getShare } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { holidayName, styleLabel, t } from '../../copy';
import { StreetViewAttribution } from '../../ui/Attribution';
import { ImageCorner } from '../../ui/ImageCard';
import { aiBadgeCorner } from '../../ui/badgeCorner';
import { SiteFooter, Wordmark } from '../../ui/Layout';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { usePageTitle } from '../../ui/pageTitle';
import { ReportSheet } from '../report/ReportSheet';
import { readInlineShare, type ShareData } from './inline';
import './share.css';

function SharedImage({ view, continues }: { view: ShareView; continues: boolean }) {
  const [showBefore, setShowBefore] = useState(false);
  const name = holidayName(view.holidayId);
  const before = view.beforeImageUrl;
  return (
    <div className="shared">
      {before ? (
        <div className="segmented" role="group" aria-label={t('result.compareLabel')}>
          <button type="button" aria-pressed={showBefore} onClick={() => setShowBefore(true)}>
            {t('result.before')}
          </button>
          <button type="button" aria-pressed={!showBefore} onClick={() => setShowBefore(false)}>
            {t('result.aiPreview')}
          </button>
        </div>
      ) : null}
      <figure className="image-card shared__card" data-continues={continues || undefined}>
        <div
          className="image-card__frame shared__frame"
          style={{ ['--frame-ratio' as string]: String(view.width / view.height) }}
        >
          {before ? (
            <img
              src={before}
              alt={t('upload.previewAltPending')}
              width={view.width}
              height={view.height}
              aria-hidden={!showBefore || undefined}
            />
          ) : null}
          <img
            className="shared__after"
            data-hidden={showBefore || undefined}
            src={view.imageUrl}
            alt={t('share.cardAlt', { holiday: name })}
            width={view.width}
            height={view.height}
            aria-hidden={showBefore || undefined}
          />
          {!showBefore ? <ImageCorner corner={aiBadgeCorner(view.attribution !== null)} /> : null}
        </div>
        <figcaption className="image-card__strip">
          {view.attribution ? (
            <StreetViewAttribution
              text={view.attribution.text}
              logo={view.attribution.logo}
              captureDate={null}
              showCaptureDate={false}
            />
          ) : (
            <span />
          )}
          <span className="variant__label">
            {t('share.labelLine', { holiday: name, style: styleLabel(view.style) })}
          </span>
        </figcaption>
      </figure>
    </div>
  );
}

/**
 * `/s/:token`: the public share page. The server renders it (noindex) with the share inline;
 * the app takes over from that data, or reads `GET /v1/shares/:token` when it is absent. It
 * shows no address, map, name, product links or disclosure.
 */
export function SharePage() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const [data, setData] = useState<ShareData | null>(() => readInlineShare(token));
  // The server sends the inline share together with the page it painted from it, so a page that
  // starts from inline data takes over a card already on screen: it continues that card in place
  // instead of playing the entrance a second time.
  const [continuesServerPage] = useState(() => data !== null);
  const [reporting, setReporting] = useState(() => params.get('report') === 'share');
  const holidayId = data?.status === 'active' ? data.view.holidayId : null;
  useHolidayTheme(holidayId);
  usePageTitle(t('share.title'));

  useEffect(() => {
    if (data) return;
    let active = true;
    getShare(token)
      .then((view) => {
        if (active) setData({ status: 'active', token, view });
      })
      .catch((failure: unknown) => {
        if (!active) return;
        setData(
          isApiError(failure) && failure.code === 'SHARE_REVOKED'
            ? { status: 'gone' }
            : { status: 'not_found' },
        );
      });
    return () => {
      active = false;
    };
  }, [data, token]);

  const ctaHref = holidayId ? `/?holiday=${encodeURIComponent(holidayId)}` : '/';

  return (
    <div className="page share-page-app">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header className="site-header share-page-app__header">
        <Wordmark />
      </header>
      <main id="main" className="page__main share-page-app__main" tabIndex={-1}>
        {data === null ? <div className="indeterminate" aria-hidden="true" /> : null}
        {data?.status === 'active' ? (
          <article className="share-page-app__article">
            <SharedImage view={data.view} continues={continuesServerPage} />
            <div className="share-page-app__text">
              <p className="share-page-app__caption">{t('share.caption')}</p>
              {/* A full page load gives the landing page its server-rendered hero. */}
              <a className="button button--primary" href={ctaHref}>
                {t('share.cta')}
              </a>
              <button type="button" className="link-button" onClick={() => setReporting(true)}>
                {t('share.report')}
              </button>
            </div>
          </article>
        ) : null}
        {data && data.status !== 'active' ? (
          <section className="share-page-app__gone stack">
            <h1 className="title-section">
              {t(data.status === 'gone' ? 'error.SHARE_REVOKED' : 'error.NOT_FOUND')}
            </h1>
            <a className="button button--primary" href="/">
              {t('share.cta')}
            </a>
          </section>
        ) : null}
      </main>
      <SiteFooter />
      {reporting && data?.status === 'active' ? (
        <ReportSheet
          target={{ kind: 'share', token: data.token }}
          onClose={() => setReporting(false)}
        />
      ) : null}
    </div>
  );
}
