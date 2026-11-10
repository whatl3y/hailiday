import { t } from '../../copy';
import { DISPLAY_VALUES } from '../../config/values';
import { PageShell } from '../../ui/Layout';
import { LEGAL_PAGES, type LegalPageId } from './pages';
import { NotFoundContent } from '../project/ProjectPage';

/** A legal or information page, clearly marked as a draft placeholder until counsel's text lands. */
export function LegalPage({ page }: { page: LegalPageId }) {
  const entry = LEGAL_PAGES[page];
  return (
    <PageShell title={t(entry.title)}>
      <article
        className="container container--narrow simple-page stack"
        id={page === 'contentPolicy' ? 'report' : undefined}
      >
        <span className="badge badge--draft">{t('legal.draftBadge')}</span>
        <h1 className="simple-page__title">{t(entry.title)}</h1>
        <div className="prose">
          <p>{t(entry.summary, DISPLAY_VALUES)}</p>
          <p className="fine">{t('legal.draftNotice')}</p>
        </div>
      </article>
    </PageShell>
  );
}

export function NotFoundPage() {
  return (
    <PageShell title={t('notFound.heading')}>
      <NotFoundContent />
    </PageShell>
  );
}
