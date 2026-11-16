import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { createUploadProject } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { HeroDock, HeroFrame } from '../../ui/HeroFrame';
import { HolidayChip } from '../../ui/HolidayPicker';
import { BudgetBanner, PageShell } from '../../ui/Layout';
import { RetryAfterButton } from '../../ui/RetryAfterButton';
import type { ProjectRouteState } from '../address/useResolveAddress';
import './upload.css';

interface EntryFailure {
  id: number;
  message: string;
  /** The server's wait before a retry can succeed (0 when it named none). */
  retryAfterSeconds: number;
}

/**
 * `/upload`: creates an upload-first project carrying the current holiday selection and
 * continues at `/p/:projectId`, where the upload screen shows. Meanwhile the screen is already
 * the upload screen's own: the season's photograph with the step's heading in its dock. A
 * failure (including a session that cannot start) is said in place with "Try again", which
 * waits out any `Retry-After`.
 */
export function UploadEntryPage() {
  const navigate = useNavigate();
  const holidayId = useAppStore(currentHolidayId);
  const hero = useAppStore((state) => state.experience?.hero ?? null);
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
    <PageShell
      title={t('upload.heading')}
      tone="photo"
      headerEnd={<HolidayChip surface="landing" />}
    >
      <HeroFrame hero={hero} className="upload-hero">
        <HeroDock className="upload upload--dock upload--entry stack">
          <BudgetBanner />
          <header className="upload__header">
            <h1 className="title-section">{t('upload.heading')}</h1>
            <p className="lede">{t('upload.subline')}</p>
          </header>
          <div className="stack" aria-live="polite">
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
          </div>
        </HeroDock>
      </HeroFrame>
    </PageShell>
  );
}
