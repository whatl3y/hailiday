import { useEffect } from 'react';
import { t } from '../copy';

/** The document title for a page: "{page} · Hailiday", or the bare name for the landing page. */
export function pageTitle(page?: string | null): string {
  return page ? t('pageTitle.template', { page }) : t('app.wordmark');
}

/**
 * Keeps `document.title` in step with the page on screen. Titles name the page or state and
 * never carry an address.
 */
export function usePageTitle(page?: string | null): void {
  const title = pageTitle(page);
  useEffect(() => {
    document.title = title;
  }, [title]);
}
