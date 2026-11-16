import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link } from 'react-router';
import type { GalleryItem } from '@hailiday/core';
import { listGallery } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { StreetViewAttribution } from '../../ui/Attribution';
import { attributionParts } from '../../ui/attributionText';
import { aiBadgeCorner, cornerClassName, thumbClassName } from '../../ui/badgeCorner';
import { useIsFixtureStreetView } from '../../ui/fixture';
import { PageShell } from '../../ui/Layout';
import {
  GALLERY_PAGE_SIZE,
  GALLERY_REFRESH_AFTER_MS,
  appendPage,
  formatGalleryDate,
  galleryAttribution,
  galleryLookLabel,
  galleryOrder,
  groupGallery,
  nextRetryDelay,
} from './gallery';
import { GalleryViewer } from './GalleryViewer';
import './gallery.css';

interface Loaded {
  items: GalleryItem[];
  nextCursor: string | null;
  /** When the signed URLs of `items` were minted (epoch milliseconds). */
  fetchedAt: number;
}

/** Refusals that mean there is no session to read a gallery for. */
function isNoSession(error: unknown): boolean {
  return (
    isApiError(error) &&
    (error.code === 'VERIFICATION_REQUIRED' ||
      error.code === 'FORBIDDEN' ||
      error.code === 'NOT_FOUND')
  );
}

/** Reads pages from the start until at least `count` items (or every item) are loaded. */
async function readFromStart(count: number): Promise<Loaded> {
  let items: GalleryItem[] = [];
  let cursor: string | null = null;
  do {
    const page = await listGallery(cursor, GALLERY_PAGE_SIZE);
    items = appendPage(items, page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < count);
  return { items, nextCursor: cursor, fetchedAt: Date.now() };
}

/** The Street View credit under a tile; nothing for an uploaded photo. */
function TileCredit({ item }: { item: GalleryItem }) {
  const attribution = galleryAttribution(item);
  const fixture = useIsFixtureStreetView(null);
  if (!attribution) return null;
  const { showLogo, credit } = attributionParts({ ...attribution, fixture });
  if (!showLogo && !credit) return null;
  return (
    <span className="gallery__credit">
      <StreetViewAttribution
        text={attribution.text}
        logo={attribution.logo}
        captureDate={null}
        showCaptureDate={false}
        fixture={fixture}
      />
    </span>
  );
}

function Tile({
  item,
  onOpen,
  buttonRef,
}: {
  item: GalleryItem;
  onOpen: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const holidays = useAppStore((state) => state.experience?.holidays ?? null);
  const streetView = item.sourceKind === 'street_view';
  const corner = aiBadgeCorner(streetView);
  // One column shows each picture whole at its own proportions; the stylesheet crops the
  // pictures of a multi-column grid to one shape.
  const thumbStyle = {
    '--tile-ratio': `${item.width > 0 ? item.width : 1} / ${item.height > 0 ? item.height : 1}`,
  } as CSSProperties;
  return (
    <li className="gallery__item">
      <button type="button" className="gallery__tile" onClick={onOpen} ref={buttonRef}>
        <span className={thumbClassName('gallery__thumb', streetView)} style={thumbStyle}>
          <img
            src={item.imageUrl}
            width={item.width}
            height={item.height}
            loading="lazy"
            decoding="async"
            alt={t('places.thumbAlt', { holiday: holidayName(item.holidayId) })}
          />
          <span className={cornerClassName('gallery__badge', corner)} data-corner={corner}>
            {t('result.aiPreview')}
          </span>
        </span>
        <span className="gallery__caption">
          <TileCredit item={item} />
          <span className="gallery__line">
            <span className="gallery__look">{galleryLookLabel(item, holidays)}</span>
            <span className="gallery__date">{formatGalleryDate(item.createdAt)}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

interface Retry {
  /** When the failed refresh is tried again (epoch milliseconds). */
  at: number;
  /** The wait that led to `at`, doubled after the next failure. */
  delay: number;
}

/**
 * `/gallery`: every rendering the person has made, newest first, grouped by place for address
 * projects and by project for uploaded photos. Signed image URLs are read again once they are
 * 12 minutes old: on a timer while the tab is in view, and when the tab comes back into view
 * after that age. A failed refresh is tried again after 30 seconds, doubling up to 5 minutes.
 * Without a session the gallery is empty: reading it never starts one.
 */
export function GalleryPage() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [retry, setRetry] = useState<Retry | null>(null);
  const loadedRef = useRef<Loaded | null>(null);
  const retryRef = useRef<Retry | null>(null);
  const busyRef = useRef(false);
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());
  const focusAfterLoadRef = useRef<string | null>(null);

  const apply = useCallback((next: Loaded) => {
    loadedRef.current = next;
    setLoaded(next);
    setError(null);
  }, []);

  const scheduleRetry = useCallback((next: Retry | null) => {
    retryRef.current = next;
    setRetry(next);
  }, []);

  const applyRefresh = useCallback(
    (next: Loaded) => {
      apply(next);
      scheduleRetry(null);
    },
    [apply, scheduleRetry],
  );

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      applyRefresh(await readFromStart(Math.max(loadedRef.current?.items.length ?? 0, 1)));
    } catch (failure) {
      if (isNoSession(failure))
        applyRefresh({ items: [], nextCursor: null, fetchedAt: Date.now() });
      else if (loadedRef.current) {
        const delay = nextRetryDelay(retryRef.current?.delay ?? null);
        scheduleRetry({ at: Date.now() + delay, delay });
      } else setError(presentError(failure)?.message ?? t('error.unknown'));
    } finally {
      busyRef.current = false;
    }
  }, [applyRefresh, scheduleRetry]);

  const freshDownloadUrl = useCallback(
    async (id: string) => {
      const next = await readFromStart(Math.max(loadedRef.current?.items.length ?? 0, 1));
      applyRefresh(next);
      return next.items.find((item) => item.id === id)?.downloadUrl ?? null;
    },
    [applyRefresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const current = loadedRef.current;
      const waiting = retryRef.current;
      if (waiting && Date.now() < waiting.at) return;
      if (!current || Date.now() - current.fetchedAt >= GALLERY_REFRESH_AFTER_MS) void refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh]);

  useEffect(() => {
    if (!loaded || loaded.items.length === 0) return;
    const due = retry ? retry.at : loaded.fetchedAt + GALLERY_REFRESH_AFTER_MS;
    const timer = window.setTimeout(
      () => {
        // A hidden tab is caught up when it comes back into view.
        if (document.visibilityState === 'hidden') return;
        void refresh();
      },
      Math.max(0, due - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [loaded, retry, refresh]);

  useEffect(() => {
    const id = focusAfterLoadRef.current;
    if (!id) return;
    focusAfterLoadRef.current = null;
    tileRefs.current.get(id)?.focus();
  }, [loaded]);

  async function loadMore() {
    const current = loadedRef.current;
    if (!current?.nextCursor || busyRef.current) return;
    busyRef.current = true;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await listGallery(current.nextCursor, GALLERY_PAGE_SIZE);
      const items = appendPage(current.items, page.items);
      // Focus moves to the first new tile, or to the last tile when the page added none.
      focusAfterLoadRef.current = (items[current.items.length] ?? items.at(-1))?.id ?? null;
      apply({ items, nextCursor: page.nextCursor, fetchedAt: current.fetchedAt });
    } catch (failure) {
      setMoreError(presentError(failure)?.message ?? t('error.unknown'));
    } finally {
      busyRef.current = false;
      setLoadingMore(false);
    }
  }

  function tileRef(id: string) {
    return (node: HTMLButtonElement | null) => {
      if (node) tileRefs.current.set(id, node);
      else tileRefs.current.delete(id);
    };
  }

  function closeViewer() {
    const id = openId;
    setOpenId(null);
    // Focus returns to the tile of the picture last on view.
    if (id) tileRefs.current.get(id)?.focus();
  }

  const items = loaded?.items ?? [];
  const groups = groupGallery(items);
  const order = galleryOrder(groups);
  const openIndex = openId ? order.findIndex((item) => item.id === openId) : -1;
  const loadingFirst = !loaded && !error;

  return (
    <PageShell title={t('gallery.title')}>
      <section className="gallery" aria-busy={loadingFirst || loadingMore || undefined}>
        <div className="gallery__head">
          <h1 className="gallery__title">{t('gallery.title')}</h1>
          <Link to="/places" className="link-button">
            {t('places.title')}
          </Link>
        </div>
        <p className="sr-only" role="status">
          {loadingFirst || loadingMore ? t('common.loading') : ''}
        </p>
        {error ? (
          <div className="stack gallery__note">
            <p className="message message--error" role="alert">
              {error}
            </p>
            <button type="button" className="link-button" onClick={() => void refresh()}>
              {t('common.tryAgain')}
            </button>
          </div>
        ) : null}
        {loadingFirst ? (
          <div className="gallery__note">
            <div className="indeterminate" aria-hidden="true" />
          </div>
        ) : null}
        {loaded && items.length === 0 ? (
          <div className="stack gallery__note">
            <p className="lede">{t('gallery.empty')}</p>
            <Link to="/" className="link-button">
              {t('common.backHome')}
            </Link>
          </div>
        ) : null}
        {groups.map((group) => (
          <section key={group.key} className="gallery__group">
            <h2 className="gallery__heading">{group.heading}</h2>
            <ul className="gallery__wall">
              {group.items.map((item) => (
                <Tile
                  key={item.id}
                  item={item}
                  onOpen={() => setOpenId(item.id)}
                  buttonRef={tileRef(item.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        {loaded?.nextCursor ? (
          <div className="gallery__more-row">
            <button
              type="button"
              className="button button--quiet gallery__more"
              aria-disabled={loadingMore || undefined}
              onClick={() => void loadMore()}
            >
              {t('gallery.loadMore')}
            </button>
            {moreError ? (
              <p className="message message--error gallery__more-error" role="alert">
                {moreError}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>
      {openIndex >= 0 ? (
        <GalleryViewer
          items={order}
          index={openIndex}
          onNavigate={(next) => setOpenId(order[next]?.id ?? null)}
          onClose={closeViewer}
          freshDownloadUrl={freshDownloadUrl}
        />
      ) : null}
    </PageShell>
  );
}
