import { useEffect, useRef } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { t } from '../../copy';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import { HolidayChip } from '../../ui/HolidayPicker';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { PageShell } from '../../ui/Layout';
import { UploadPanel } from '../upload/UploadPanel';
import type { ProjectRouteState } from '../address/useResolveAddress';
import { ConfirmPlace } from './ConfirmPlace';
import {
  cancelUpload,
  changeHoliday,
  closeProject,
  onUploadAttached,
  openProject,
} from './controller';
import { ProjectInlineError } from './InlineError';
import { holidaysForScene } from './looks';
import { NoStreetView } from './NoStreetView';
import { projectPageTitle } from './pageTitle';
import { RenderError } from './RenderError';
import { Result } from './Result';
import { Waiting } from './Waiting';
import './project.css';

function Finding() {
  return (
    <section className="container container--narrow project-single stack" aria-live="polite">
      <p className="status-line__text">{t('confirm.finding')}</p>
      <div className="indeterminate" aria-hidden="true" />
    </section>
  );
}

function Loading() {
  return (
    <section className="container container--narrow project-single" aria-live="polite">
      <p className="fine">{t('common.loading')}</p>
    </section>
  );
}

export function NotFoundContent({ forbidden }: { forbidden?: boolean }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <section className="container container--narrow project-single stack">
      <h1 ref={headingRef} tabIndex={-1} className="title-section">
        {t('notFound.heading')}
      </h1>
      <p className="lede">{t(forbidden ? 'error.FORBIDDEN' : 'error.NOT_FOUND')}</p>
      <Link to="/" className="button button--primary">
        {t('common.backHome')}
      </Link>
    </section>
  );
}

function LoadError({ projectId }: { projectId: string }) {
  const inlineError = useProjectStore((state) => state.inlineError);
  const inlineRetry = useProjectStore((state) => state.inlineRetry);
  if (inlineError && inlineRetry) {
    return (
      <section className="container container--narrow project-single stack">
        <ProjectInlineError />
      </section>
    );
  }
  return (
    <section className="container container--narrow project-single stack">
      <p className="message message--error" role="alert">
        {inlineError ?? t('error.network')}
      </p>
      <button type="button" className="button" onClick={() => void openProject(projectId, null)}>
        {t('common.tryAgain')}
      </button>
    </section>
  );
}

function UploadStep() {
  const project = useProjectStore((state) => state.project);
  const canCancel = useProjectStore((state) => state.uploadReturnPhase !== null);
  if (!project) return null;
  return (
    <section className="container container--narrow project-single stack">
      <ProjectInlineError />
      <UploadPanel project={project} onAttached={(next) => void onUploadAttached(next)} />
      {canCancel ? (
        <button type="button" className="button button--quiet" onClick={cancelUpload}>
          {t('common.cancel')}
        </button>
      ) : null}
    </section>
  );
}

/** `/p/:projectId`: one project; the screen follows the project and render job state. */
export function ProjectPage() {
  const { projectId } = useParams();
  const location = useLocation();
  const routeState = (location.state as ProjectRouteState | null) ?? null;
  const routeStateRef = useRef(routeState);
  const phase = useProjectStore((state) => state.phase);
  const projectHoliday = useProjectStore(
    (state) => state.look?.holidayId ?? state.variant?.holidayId ?? null,
  );
  const selected = useAppStore(currentHolidayId);
  const sceneType = useProjectStore((state) => state.project?.sceneType ?? null);
  const hasVariant = useProjectStore((state) => state.variant !== null);
  const variantHoliday = useProjectStore((state) => state.variant?.holidayId ?? null);
  const pickerIds = useAppStore((state) => state.pickerHolidayIds);
  const holidays = useAppStore((state) => state.experience?.holidays ?? null);
  const chipHolidayIds = holidaysForScene(pickerIds, holidays, sceneType);
  // On a preview the chip names the look on screen, so it never disagrees with the card.
  const showsLook = hasVariant && (phase === 'result' || phase === 'render_error');

  useHolidayTheme(projectHoliday ?? selected);

  useEffect(() => {
    if (!projectId) return;
    void openProject(projectId, routeStateRef.current);
    return () => closeProject();
  }, [projectId]);

  let content;
  switch (phase) {
    case 'loading':
      content = <Loading />;
      break;
    case 'not_found':
      content = <NotFoundContent />;
      break;
    case 'error':
      content = projectId ? <LoadError projectId={projectId} /> : <NotFoundContent />;
      break;
    case 'finding':
      content = <Finding />;
      break;
    case 'confirm':
      content = <ConfirmPlace />;
      break;
    case 'nosv':
      content = <NoStreetView />;
      break;
    case 'upload':
      content = <UploadStep />;
      break;
    case 'starting':
    case 'waiting':
      content = <Waiting />;
      break;
    case 'result':
      content = <Result />;
      break;
    case 'render_error':
      content = <RenderError />;
      break;
  }

  return (
    <PageShell
      title={projectPageTitle(phase, variantHoliday)}
      headerEnd={
        <HolidayChip
          surface="result"
          holidayIds={chipHolidayIds}
          shown={showsLook ? projectHoliday : undefined}
          onChange={changeHoliday}
        />
      }
    >
      <div className="project">{content}</div>
    </PageShell>
  );
}
