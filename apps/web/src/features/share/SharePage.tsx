import { useEffect, useState, type CSSProperties } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { ShareView } from '@hailiday/core';
import { getShare } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { holidayName, styleLabel, t } from '../../copy';
import { StreetViewAttribution } from '../../ui/Attribution';
import { ImageCorner } from '../../ui/ImageCard';
import { Stage } from '../../ui/Stage';
import { stageStyle } from '../../ui/stageStyle';
import { aiBadgeCorner } from '../../ui/badgeCorner';
import { SiteFooter, Wordmark } from '../../ui/Layout';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { usePageTitle } from '../../ui/pageTitle';
import { useThemeColor, type SurfaceTone } from '../../ui/themeColor';
import { ReportSheet } from '../report/ReportSheet';
import { readInlineShare, type ShareData } from './inline';
import './share.css';

/**
 * How long the server-painted picture has been arriving: the time since the page first painted,
 * or 0 before any paint (then nothing is on screen yet to continue).
 */
function paintedElapsed(): number {
  try {
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    return paint ? Math.max(0, Math.round(performance.now() - paint.startTime)) : 0;
  } catch {
    return 0;
  }
}

/**
 * The shared picture on a stage, edge to edge and as large as the first viewport allows, with
 * its marks; then, on the paper directly beneath it and lined up with its edges, the look and
 * the credit, and the headline with the one way in.
 */
function SharedPicture({
  view,
  continues,
  ctaHref,
}: {
  view: ShareView;
  continues: boolean;
  ctaHref: string;
}) {
  const [showBefore, setShowBefore] = useState(false);
  // A picture taken over from the server-painted page continues its arrival where it is.
  const [elapsed] = useState(() => (continues ? paintedElapsed() : 0));
  const name = holidayName(view.holidayId);
  const before = view.beforeImageUrl;
  // The switch rests in the stage's upper right corner from 600px; on phones the same switch sits
  // on the paper under the picture instead (the stylesheet shows one of the two), so nothing but
  // the mark lies on the picture.
  const toggle = () =>
    before ? (
      <div
        className="segmented segmented--on-stage"
        role="group"
        aria-label={t('result.compareLabel')}
      >
        <button type="button" aria-pressed={showBefore} onClick={() => setShowBefore(true)}>
          {t('result.before')}
        </button>
        <button type="button" aria-pressed={!showBefore} onClick={() => setShowBefore(false)}>
          {t('result.aiPreview')}
        </button>
      </div>
    ) : null;
  return (
    <div
      className={continues ? 'shared stage-scope shared--continues' : 'shared stage-scope'}
      style={
        continues
          ? ({
              ...stageStyle(view.width, view.height),
              '--share-elapsed': `${elapsed}ms`,
            } as CSSProperties)
          : stageStyle(view.width, view.height)
      }
    >
      <Stage
        width={view.width}
        height={view.height}
        ambientSrc={view.imageUrl}
        overlay={toggle()}
        className="shared__stage"
      >
        {before ? (
          <img
            src={before}
            alt={t('upload.previewAltPending')}
            width={view.width}
            height={view.height}
            aria-hidden={!showBefore || undefined}
            draggable={false}
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
          draggable={false}
        />
        {!showBefore ? <ImageCorner corner={aiBadgeCorner(view.attribution !== null)} /> : null}
      </Stage>
      <div className="share-page-app__below">
        {before ? <div className="stage-controls shared__controls">{toggle()}</div> : null}
        <p className="share-page-app__credit">
          <span className="share-page-app__label">
            {t('share.labelLine', { holiday: name, style: styleLabel(view.style) })}
          </span>
          {view.attribution ? (
            <StreetViewAttribution
              text={view.attribution.text}
              logo={view.attribution.logo}
              captureDate={null}
              showCaptureDate={false}
            />
          ) : null}
        </p>
        <div className="share-page-app__text">
          <h1 className="share-page-app__caption">{t('share.caption')}</h1>
          {/* A full page load gives the landing page its server-rendered hero. */}
          <a className="button button--primary share-page-app__cta" href={ctaHref}>
            {t('share.cta')}
          </a>
        </div>
      </div>
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
  // starts from inline data takes over a picture already on screen: it continues that picture in
  // place instead of playing the entrance a second time.
  const [continuesServerPage] = useState(() => data !== null);
  const [reporting, setReporting] = useState(() => params.get('report') === 'share');
  const holidayId = data?.status === 'active' ? data.view.holidayId : null;
  // The shared picture is shown on the ink stage under an ink header band; a link that no longer
  // works is a plain paper page.
  const tone: SurfaceTone = data && data.status !== 'active' ? 'paper' : 'stage';
  useHolidayTheme(holidayId);
  usePageTitle(t('share.title'));
  useThemeColor(tone);

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
    <div className={tone === 'stage' ? 'page page--stage share-page-app' : 'page share-page-app'}>
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header
        className={
          tone === 'stage'
            ? 'site-header site-header--stage share-page-app__header'
            : 'site-header share-page-app__header'
        }
      >
        <Wordmark />
      </header>
      <main id="main" className="page__main share-page-app__main" tabIndex={-1}>
        {data === null ? <div className="indeterminate" aria-hidden="true" /> : null}
        {data?.status === 'active' ? (
          <article className="share-page-app__article">
            <SharedPicture view={data.view} continues={continuesServerPage} ctaHref={ctaHref} />
            <p className="share-page-app__more">
              <button type="button" className="link-button" onClick={() => setReporting(true)}>
                {t('share.report')}
              </button>
            </p>
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
