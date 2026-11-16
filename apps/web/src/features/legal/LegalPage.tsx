import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { t } from '../../copy';
import { useRetentionText } from '../../copy/retention';
import { DISPLAY_VALUES } from '../../config/values';
import { useAppStore } from '../../state/appStore';
import { HeroDock, HeroFrame } from '../../ui/HeroFrame';
import { BudgetBanner, PageShell } from '../../ui/Layout';
import { LEGAL_PAGES, type LegalPageId } from './pages';
import './legal.css';

/**
 * A legal or information page set as a document: a small "Draft" kicker, the title, the draft
 * notice and the plain-language summary in a framed note, until counsel's text lands.
 */
export function LegalPage({ page }: { page: LegalPageId }) {
  const entry = LEGAL_PAGES[page];
  const privacySummary = useRetentionText('privacy');
  return (
    <PageShell title={t(entry.title)}>
      <article
        className="container container--narrow simple-page legal"
        id={page === 'contentPolicy' ? 'report' : undefined}
      >
        <p className="legal__kicker">
          <span className="legal__dot" aria-hidden="true" />
          {t('legal.draftBadge')}
        </p>
        <h1 className="simple-page__title legal__title">{t(entry.title)}</h1>
        <p className="legal__notice">{t('legal.draftNotice')}</p>
        <div className="prose legal__prose">
          <p className="legal__lede">
            {page === 'privacy' ? privacySummary : t(entry.summary, DISPLAY_VALUES)}
          </p>
        </div>
      </article>
    </PageShell>
  );
}

/**
 * An address the app does not know: the season's photograph, edge to edge, with the message and
 * the way home in the white dock resting on it.
 */
export function NotFoundPage() {
  const hero = useAppStore((state) => state.experience?.hero ?? null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <PageShell title={t('notFound.heading')} tone="photo">
      <HeroFrame hero={hero} className="not-found">
        <HeroDock className="not-found__dock stack">
          <BudgetBanner />
          <h1 ref={headingRef} tabIndex={-1} className="title-section">
            {t('notFound.heading')}
          </h1>
          <p className="lede">{t('notFound.body')}</p>
          <Link to="/" className="button button--primary">
            {t('common.backHome')}
          </Link>
        </HeroDock>
      </HeroFrame>
    </PageShell>
  );
}
