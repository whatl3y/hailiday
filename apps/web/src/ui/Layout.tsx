import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';
import { t, type CopyKey } from '../copy';
import { useAppStore } from '../state/appStore';
import { Icon } from './Icon';
import { usePageTitle } from './pageTitle';
import { useThemeColor, type SurfaceTone } from './themeColor';

const FOOTER_LINKS: ReadonlyArray<{ key: CopyKey; to: string }> = [
  { key: 'footer.terms', to: '/terms' },
  { key: 'footer.privacy', to: '/privacy' },
  { key: 'footer.contentPolicy', to: '/content-policy' },
  { key: 'footer.aiDisclosure', to: '/ai-disclosure' },
  { key: 'footer.affiliateDisclosure', to: '/affiliate-disclosure' },
  { key: 'footer.accessibility', to: '/accessibility' },
  { key: 'footer.report', to: '/content-policy#report' },
  { key: 'footer.optOut', to: '/dont-decorate-my-home' },
  { key: 'footer.contact', to: '/contact' },
];

/** The roofline glyph inside the brand mark (the server shell draws the same path). */
export const BRAND_GLYPH_PATH = 'M3.5 9.5 10 4l6.5 5.5M5.5 8v7.5h9V8M8.5 15.5v-4h3v4';

export function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label={t('app.home')}>
      <span className="wordmark__mark" aria-hidden="true">
        <svg viewBox="0 0 20 20" focusable="false">
          <path d={BRAND_GLYPH_PATH} />
        </svg>
      </span>
      <span className="wordmark__name">{t('app.wordmark')}</span>
    </Link>
  );
}

/**
 * The header's surface: `paper` sits on the white page; `photo` lies over the top of the page's
 * first element (a hero photograph), transparent, with its brand and links in white; `stage`
 * keeps its own band, on the ink ground of the picture stage below it, with white type.
 */
export type HeaderTone = SurfaceTone;

/** The header's class list for a surface (the server shell writes the same classes). */
function headerClass(tone: HeaderTone): string {
  return tone === 'paper' ? 'site-header' : `site-header site-header--${tone}`;
}

export function SiteHeader({ end, tone = 'paper' }: { end?: ReactNode; tone?: HeaderTone }) {
  return (
    <header className={headerClass(tone)}>
      <Wordmark />
      <div className="site-header__end">
        {end}
        <nav className="site-header__nav" aria-label={t('app.navLabel')}>
          <NavLink to="/gallery" end className={() => 'site-header__link'}>
            {t('gallery.title')}
          </NavLink>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container site-footer__inner">
        <span className="site-footer__mark">{t('app.wordmark')}</span>
        <nav aria-label={t('app.wordmark')}>
          <ul className="site-footer__links">
            {FOOTER_LINKS.map((link) => (
              <li key={link.key}>
                <Link to={link.to}>{t(link.key)}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}

/** The paused-service banner; viewing, comparing, saving and sharing keep working. */
export function BudgetBanner() {
  const paused = useAppStore((state) => state.budgetPaused);
  if (!paused) return null;
  return (
    <div className="banner" role="status">
      <Icon name="info" />
      <span>{t('error.BUDGET_PAUSED')}</span>
    </div>
  );
}

export interface PageShellProps {
  children: ReactNode;
  /** The page's name for the document title; omitted on the landing page (the bare name). */
  title?: string | null;
  headerEnd?: ReactNode;
  footer?: boolean;
  /**
   * The page places the paused-service banner itself. A `photo` page always does: its banner
   * belongs in the hero frame's content block, under the header laid over the photograph.
   */
  hideBanner?: boolean;
  /**
   * `photo` lays the header over the page's first element, a full-viewport photograph; `stage`
   * gives the header an ink band above the page's picture stage. Both set an ink `theme-color`.
   */
  tone?: HeaderTone;
}

export function PageShell({
  children,
  title,
  headerEnd,
  footer = true,
  hideBanner,
  tone = 'paper',
}: PageShellProps) {
  usePageTitle(title);
  useThemeColor(tone);
  return (
    <div className={tone === 'paper' ? 'page' : `page page--${tone}`}>
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <SiteHeader end={headerEnd} tone={tone} />
      {hideBanner || tone === 'photo' ? null : <BudgetBanner />}
      <main id="main" className="page__main" tabIndex={-1}>
        {children}
      </main>
      {footer ? <SiteFooter /> : null}
    </div>
  );
}
