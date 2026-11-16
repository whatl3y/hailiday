import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import type { GalleryItem } from '@hailiday/core';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { StreetViewAttribution } from '../../ui/Attribution';
import { aiBadgeCorner } from '../../ui/badgeCorner';
import { useIsFixtureImage, useIsFixtureStreetView } from '../../ui/fixture';
import { Icon } from '../../ui/Icon';
import { FixtureBadge, ImageCorner } from '../../ui/ImageCard';
import { prefersReducedMotion } from '../../ui/motion';
import { followFreshDownload, isSignedUrlExpired } from '../project/download';
import { formatGalleryDate, galleryAttribution, galleryLookLabel, swipeStep } from './gallery';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** How long the viewer takes to fade out before it leaves the page. */
export const VIEWER_FADE_MS = 200;

interface Swipe {
  pointerId: number;
  x: number;
  y: number;
}

export interface GalleryViewerProps {
  /** Every rendering the page shows, in its order; the viewer steps through them. */
  items: readonly GalleryItem[];
  /** The position of the rendering on view in `items`. */
  index: number;
  /** Shows another rendering (a position in `items`). */
  onNavigate: (index: number) => void;
  onClose: () => void;
  /** Reads the gallery again and returns this rendering's new download URL, if any. */
  freshDownloadUrl?: (id: string) => Promise<string | null>;
}

/**
 * One rendering from the gallery, full screen on the ink stage ground: the picture contained at
 * the largest size the screen allows (never above its natural size, never cropped) with its
 * "AI preview" badge on its own corner; Close and the position at the top; the look, the credit
 * and the date, a Before / AI preview switch when the original photo is stored, Download when
 * the rendering may be downloaded and "Open this place" at the bottom, all outside the picture.
 * The arrow keys, the buttons beside the position and a swipe step through the gallery. Focus
 * stays inside while it is open and Escape closes it; it fades in and out. A Download link whose
 * signed URL has expired asks `freshDownloadUrl` for a new one first.
 */
export function GalleryViewer({
  items,
  index,
  onNavigate,
  onClose,
  freshDownloadUrl,
}: GalleryViewerProps) {
  const item = items[index] ?? items[0]!;
  const holidays = useAppStore((state) => state.experience?.holidays ?? null);
  const [beforeFor, setBeforeFor] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const swipeRef = useRef<Swipe | null>(null);
  const closingRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  const streetView = item.sourceKind === 'street_view';
  const generatedFixture = useIsFixtureImage('generated');
  const fixtureStreetView = useIsFixtureStreetView(null);
  const showBefore = beforeFor === item.id && item.beforeImageUrl !== null;
  const label = galleryLookLabel(item, holidays);
  const attribution = galleryAttribution(item);
  const several = items.length > 1;
  const atStart = index <= 0;
  const atEnd = index >= items.length - 1;
  const pictureStyle = {
    '--picture-w': String(item.width > 0 ? item.width : 1),
    '--picture-h': String(item.height > 0 ? item.height : 1),
  } as CSSProperties;

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (prefersReducedMotion()) {
      onCloseRef.current();
      return;
    }
    setClosing(true);
    timerRef.current = window.setTimeout(() => onCloseRef.current(), VIEWER_FADE_MS);
  }, []);

  const step = useCallback(
    (by: -1 | 1) => {
      const next = index + by;
      if (closingRef.current || next < 0 || next >= items.length) return;
      onNavigate(next);
    },
    [index, items.length, onNavigate],
  );

  // While open: the page behind is inert and does not scroll, and focus starts on Close.
  useEffect(() => {
    const root = document.getElementById('root');
    const wasInert = root?.hasAttribute('inert') ?? false;
    root?.setAttribute('inert', '');
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      document.body.style.overflow = overflow;
      if (!wasInert) root?.removeAttribute('inert');
    };
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const inside = active instanceof Node && active !== dialog && dialog.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [requestClose, step]);

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'mouse') return;
    swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.pointerId !== event.pointerId) return;
    const by = swipeStep(event.clientX - start.x, event.clientY - start.y);
    if (by !== 0) step(by);
  }

  async function onDownload(event: MouseEvent<HTMLAnchorElement>) {
    const url = item.downloadUrl;
    if (!url || !isSignedUrlExpired(url) || !freshDownloadUrl) return;
    // Signed links are short-lived: read the gallery again for a fresh one.
    event.preventDefault();
    const opened = window.open('', '_blank');
    try {
      followFreshDownload(opened, await freshDownloadUrl(item.id));
    } catch {
      opened?.close();
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className={closing ? 'lightbox lightbox--closing' : 'lightbox'}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className="lightbox__bar lightbox__bar--top">
        {several ? (
          <div className="lightbox__position">
            <button
              type="button"
              className="lightbox__icon-button"
              aria-label={t('gallery.previous')}
              aria-disabled={atStart || undefined}
              onClick={() => step(-1)}
            >
              <Icon name="chevronLeft" />
            </button>
            <p className="lightbox__counter" aria-live="polite">
              {t('gallery.position', { n: index + 1, total: items.length })}
            </p>
            <button
              type="button"
              className="lightbox__icon-button"
              aria-label={t('gallery.next')}
              aria-disabled={atEnd || undefined}
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" />
            </button>
          </div>
        ) : (
          <span />
        )}
        <button
          ref={closeRef}
          type="button"
          className="lightbox__icon-button lightbox__close"
          aria-label={t('common.close')}
          onClick={requestClose}
        >
          <Icon name="close" />
        </button>
      </div>
      <div
        className="lightbox__stage"
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          swipeRef.current = null;
        }}
      >
        {/* The rendering, never a raw Street View frame, colors the ground on wide screens. */}
        <div className="stage__ambient lightbox__ambient" aria-hidden="true" key={`a-${item.id}`}>
          <img src={item.imageUrl} alt="" decoding="async" draggable={false} />
        </div>
        <figure className="lightbox__picture" style={pictureStyle} key={item.id}>
          {showBefore && item.beforeImageUrl ? (
            <img
              className="gallery-viewer__image"
              src={item.beforeImageUrl}
              width={item.width}
              height={item.height}
              draggable={false}
              alt={streetView ? t('result.streetViewAlt') : t('upload.previewAltPending')}
            />
          ) : (
            <>
              <img
                className="gallery-viewer__image"
                src={item.imageUrl}
                width={item.width}
                height={item.height}
                draggable={false}
                alt={t('places.thumbAlt', { holiday: holidayName(item.holidayId) })}
              />
              <ImageCorner corner={aiBadgeCorner(streetView)} />
            </>
          )}
          {!showBefore && generatedFixture ? (
            <div className="image-card__badges">
              <span />
              <span>
                <FixtureBadge />
              </span>
            </div>
          ) : null}
        </figure>
      </div>
      <div className="lightbox__bar lightbox__bar--bottom">
        <div className="lightbox__caption">
          <h2 id={titleId} className="lightbox__title">
            {label}
          </h2>
          <p className="lightbox__meta">
            {attribution ? (
              <span className="lightbox__credit">
                <StreetViewAttribution
                  text={attribution.text}
                  logo={attribution.logo}
                  captureDate={null}
                  showCaptureDate={false}
                  fixture={fixtureStreetView}
                />
              </span>
            ) : (
              <span>{t('result.yourPhoto')}</span>
            )}
            <span className="gallery-viewer__date">{formatGalleryDate(item.createdAt)}</span>
          </p>
        </div>
        <div className="lightbox__actions">
          {item.beforeImageUrl ? (
            <div
              className="segmented segmented--on-stage lightbox__compare"
              role="group"
              aria-label={t('result.compareLabel')}
            >
              <button type="button" aria-pressed={showBefore} onClick={() => setBeforeFor(item.id)}>
                {t('result.before')}
              </button>
              <button type="button" aria-pressed={!showBefore} onClick={() => setBeforeFor(null)}>
                {t('result.aiPreview')}
              </button>
            </div>
          ) : null}
          <div className="lightbox__links">
            {item.downloadUrl ? (
              <a
                className="link-button lightbox__link"
                href={item.downloadUrl}
                download
                target="_blank"
                rel="noopener"
                onClick={(event) => void onDownload(event)}
              >
                {t('result.download')}
              </a>
            ) : null}
            <Link to={`/p/${item.projectId}`} className="button button--primary lightbox__open">
              {t('gallery.openPlace')}
            </Link>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
