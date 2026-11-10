import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { t, type CopyKey } from '../copy';
import { useAppStore } from '../state/appStore';
import { Icon } from './Icon';
import { usePageTitle } from './pageTitle';

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

export function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label={t('app.home')}>
      {t('app.wordmark')}
      <span className="wordmark__dot" aria-hidden="true" />
    </Link>
  );
}

export function SiteHeader({ overlay, end }: { overlay?: boolean; end?: ReactNode }) {
  return (
    <header className={overlay ? 'site-header site-header--overlay' : 'site-header'}>
      <Wordmark />
      <div className="site-header__end">{end}</div>
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
  /** The header sits over a full-bleed photograph (landing only). */
  overlayHeader?: boolean;
  /** Content placed before the header in the flow (the landing hero). */
  beforeMain?: ReactNode;
  footer?: boolean;
  /** The page places the paused-service banner itself. */
  hideBanner?: boolean;
}

export function PageShell({
  children,
  title,
  headerEnd,
  overlayHeader,
  beforeMain,
  footer = true,
  hideBanner,
}: PageShellProps) {
  usePageTitle(title);
  return (
    <div className="page">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <div style={{ position: 'relative' }}>
        <SiteHeader overlay={overlayHeader} end={headerEnd} />
        {beforeMain}
      </div>
      {hideBanner ? null : <BudgetBanner />}
      <main id="main" className="page__main" tabIndex={-1}>
        {children}
      </main>
      {footer ? <SiteFooter /> : null}
    </div>
  );
}
