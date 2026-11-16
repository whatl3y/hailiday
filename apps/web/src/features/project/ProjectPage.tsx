import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { t } from '../../copy';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import {
  makingLook,
  noteLocked,
  selectedCandidate,
  useProjectStore,
} from '../../state/projectStore';
import { HolidayChip } from '../../ui/HolidayPicker';
import { useHolidayTheme } from '../../ui/holidaySelection';
import { PageShell } from '../../ui/Layout';
import { UploadPanel, type UploadSurface } from '../upload/UploadPanel';
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
import { LOCK_HINT_ID, LookAnnouncer } from './LookProgress';
import { holidaysForScene } from './looks';
import { NoStreetView } from './NoStreetView';
import { projectPageTitle } from './pageTitle';
import { routeStateAfterOpen } from './routeState';
import { projectTone } from './pageTone';
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
      <p className="lede">{t(forbidden ? 'error.FORBIDDEN' : 'notFound.body')}</p>
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

/** The upload step owns the page: its dock on the holiday's photograph, then the photo's stage. */
function UploadStep({ onSurfaceChange }: { onSurfaceChange: (surface: UploadSurface) => void }) {
  const project = useProjectStore((state) => state.project);
  const canCancel = useProjectStore((state) => state.uploadReturnPhase !== null);
  if (!project) return null;
  return (
    <UploadPanel
      project={project}
      layout="screen"
      lead={<ProjectInlineError />}
      trail={
        canCancel ? (
          <button type="button" className="button button--quiet" onClick={cancelUpload}>
            {t('common.cancel')}
          </button>
        ) : null
      }
      onSurfaceChange={onSurfaceChange}
      onAttached={(next) => void onUploadAttached(next)}
    />
  );
}

/**
 * `/p/:projectId`: mounts the project page once per place, so going from one place straight to
 * another (a link, Back or Forward) opens the new place from its own history entry.
 */
export function ProjectRoute() {
  const { projectId } = useParams();
  return <ProjectPage key={projectId} />;
}

/**
 * One project; the screen follows the project and render job state. It reads the history entry
 * it was opened from once, so it is mounted per place (see `ProjectRoute`).
 */
export function ProjectPage() {
  const { projectId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const routeState = (location.state as ProjectRouteState | null) ?? null;
  const routeStateRef = useRef(routeState);
  const locationRef = useRef(location);
  const [uploadSurface, setUploadSurface] = useState<UploadSurface>('photo');
  const phase = useProjectStore((state) => state.phase);
  const projectHoliday = useProjectStore(
    (state) => state.look?.holidayId ?? state.variant?.holidayId ?? null,
  );
  const selected = useAppStore(currentHolidayId);
  const sceneType = useProjectStore((state) => state.project?.sceneType ?? null);
  const hasVariant = useProjectStore((state) => state.variant !== null);
  const hasSourcePicture = useProjectStore((state) =>
    Boolean(state.project?.activeSource?.displayUrl),
  );
  const hasCandidate = useProjectStore((state) => selectedCandidate(state) !== null);
  const locked = useProjectStore(makingLook);
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
    const opened = locationRef.current;
    const kept = routeStateAfterOpen(opened.state);
    if (kept !== undefined) {
      void navigate(
        { pathname: opened.pathname, search: opened.search, hash: opened.hash },
        { replace: true, state: kept },
      );
    }
    return () => closeProject();
  }, [projectId, navigate]);

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
      content = <NoStreetView onSurfaceChange={setUploadSurface} />;
      break;
    case 'upload':
      content = <UploadStep onSurfaceChange={setUploadSurface} />;
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
      tone={projectTone({ phase, uploadSurface, hasVariant, hasSourcePicture, hasCandidate })}
      headerEnd={
        <HolidayChip
          surface="result"
          holidayIds={chipHolidayIds}
          shown={showsLook ? projectHoliday : undefined}
          onChange={changeHoliday}
          locked={locked}
          onLockedPress={noteLocked}
          describedBy={LOCK_HINT_ID}
        />
      }
    >
      <div className="project">
        {content}
        <LookAnnouncer />
        {locked ? (
          <p id={LOCK_HINT_ID} hidden>
            {t('controls.locked')}
          </p>
        ) : null}
      </div>
    </PageShell>
  );
}
