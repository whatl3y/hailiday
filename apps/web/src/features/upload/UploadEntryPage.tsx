import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { createUploadProject } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { PageShell } from '../../ui/Layout';
import { RetryAfterButton } from '../../ui/RetryAfterButton';
import type { ProjectRouteState } from '../address/useResolveAddress';

interface EntryFailure {
  id: number;
  message: string;
  /** The server's wait before a retry can succeed (0 when it named none). */
  retryAfterSeconds: number;
}

/**
 * `/upload`: creates an upload-first project carrying the current holiday selection and
 * continues at `/p/:projectId`, where the upload screen shows. A failure (including a session
 * that cannot start) is said in place with "Try again", which waits out any `Retry-After`.
 */
export function UploadEntryPage() {
  const navigate = useNavigate();
  const holidayId = useAppStore(currentHolidayId);
  const [failure, setFailure] = useState<EntryFailure | null>(null);
  const failures = useRef(0);

  useHolidayTheme(holidayId);

  const start = useCallback(async () => {
    setFailure(null);
    try {
      const selected = currentHolidayId(useAppStore.getState());
      const project = await createUploadProject({
        kind: 'upload',
        ...(selected ? { holidayId: selected } : {}),
      });
      useAppStore.getState().setAllowance(project.allowance);
      const state: ProjectRouteState = { project, entry: 'upload', openUpload: true };
      navigate(`/p/${project.id}`, { replace: true, state });
    } catch (error) {
      failures.current += 1;
      setFailure({
        id: failures.current,
        message: presentError(error)?.message ?? t('error.unknown'),
        retryAfterSeconds:
          isApiError(error) && error.code === 'RATE_LIMITED' ? (error.retryAfterSeconds ?? 0) : 0,
      });
    }
  }, [navigate]);

  useEffect(() => {
    const timer = window.setTimeout(() => void start(), 0);
    return () => window.clearTimeout(timer);
  }, [start]);

  return (
    <PageShell title={t('upload.heading')}>
      <section className="container container--narrow simple-page stack" aria-live="polite">
        <h1 className="title-section">{t('upload.heading')}</h1>
        {failure ? (
          <>
            <p className="message message--error" role="alert">
              {failure.message}
            </p>
            <RetryAfterButton
              key={failure.id}
              className="button button--primary"
              retryAfterSeconds={failure.retryAfterSeconds}
              onRetry={() => void start()}
            />
          </>
        ) : (
          <div className="indeterminate" aria-hidden="true" />
        )}
      </section>
    </PageShell>
  );
}
