import { useMemo } from 'react';
import { t } from '../../copy';
import { retentionText, useTimeBasedDeletion } from '../../copy/retention';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import { activeLookStatus, useProjectStore } from '../../state/projectStore';
import { ExampleGallery } from '../../ui/Examples';
import { useCardOnStage } from '../../ui/stringGeometry';
import { notYourPlace } from './controller';
import { ProjectInlineError } from './InlineError';
import { CancelLook, LookCard, LookNotes, useLongWait } from './LookProgress';
import { ProjectSourceStage } from './SourceImage';
import { useControlsBelowStage } from './stageLayout';
import { trailFor } from './stageTrail';

/**
 * The waiting screen: the source photo on the same stage the result will use, with a slow sheen
 * across it and the light string along its top edge in the colours of the look's holiday, and
 * the status card (the stage the job reports, the trail of stages, the usual time and Cancel).
 * From 600px wide on a screen at least 560px tall the card hangs from the string on the stage
 * and the notes take the title line's place under the caption; otherwise the card sits on paper
 * where the title will be, with the notes under it. On phones Cancel sits in the row under the
 * picture where the result's Before / AI preview switch will be, so nothing moves when the result
 * arrives. The screen's heading is for assistive technology only: the card states the stage.
 */
export function Waiting() {
  const project = useProjectStore((state) => state.project);
  const autoStarted = useProjectStore((state) => state.autoStarted);
  const holidayId = useAppStore(currentHolidayId);
  const hasExamples = useAppStore((state) => (state.experience?.examples.length ?? 0) > 0);
  const timeBasedDeletion = useTimeBasedDeletion();
  const phone = useControlsBelowStage();
  const cardRoom = useCardOnStage();
  const status = useProjectStore(activeLookStatus);
  const stored = useProjectStore((state) => state.trail);
  const trail = useMemo(() => trailFor(stored, status), [stored, status]);
  const longWait = useLongWait(status);

  if (!project) return null;
  // A saved place is kept on the saved schedule, so the line names no anonymous period.
  const longWaitLine = retentionText('longWait', timeBasedDeletion && !project.saved);
  const hasPicture = Boolean(project.activeSource?.displayUrl);
  const onStage = hasPicture && cardRoom;
  const streetView = project.activeSource?.kind !== 'upload';
  // Until the job answers, the lighting the request asked for: the offered default before the
  // place's first preview, the remembered look after it.
  const lightingMode =
    status?.lightingMode ??
    (project.variantCount === 0 ? project.offered?.defaultLightingMode : project.lightingMode) ??
    null;
  const escape =
    autoStarted && streetView ? (
      <button
        type="button"
        className="link-button waiting__escape"
        onClick={() => void notYourPlace()}
      >
        {t('wait.notYourPlace')}
      </button>
    ) : null;

  return (
    <section className="waiting" aria-labelledby="waiting-heading">
      <ProjectSourceStage
        project={project}
        pending
        className="waiting__stage"
        stringHoliday={status?.holidayId ?? holidayId}
        stageCard={onStage ? <LookCard placement="stage" /> : undefined}
        controls={phone && hasPicture ? <CancelLook /> : undefined}
      >
        <h1 id="waiting-heading" tabIndex={-1} className="sr-only project__heading">
          {t('wait.heading')}
        </h1>
        <div className="picture-head waiting__head">
          {onStage ? null : (
            <div className="picture-head__title">
              <LookCard placement="paper" cancel={!(phone && hasPicture)} escape={escape} />
            </div>
          )}
          <LookNotes
            lightingMode={lightingMode}
            stageKeys={trail.keys}
            timeBasedDeletion={timeBasedDeletion}
            saved={project.saved}
          />
          {onStage && escape ? <div className="picture-head__actions">{escape}</div> : null}
        </div>
        <div className="result__rail waiting__rail">
          <ProjectInlineError />
          {longWait ? <p className="message">{longWaitLine}</p> : null}
          {hasExamples ? (
            <div className="waiting__examples">
              <p className="eyebrow">{t('wait.examplesHeading')}</p>
              <ExampleGallery holidayId={holidayId} sceneType={project.sceneType} limit={3} />
            </div>
          ) : null}
        </div>
      </ProjectSourceStage>
    </section>
  );
}
