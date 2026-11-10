import { useEffect, useState } from 'react';
import { stageLabelKeyFor } from '@holiday/core';
import { t } from '../../copy';
import { CLIENT_DEFAULTS, DISPLAY_VALUES } from '../../config/values';
import { currentHolidayId, useAppStore } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import { ExampleGallery } from '../../ui/Examples';
import { cancelRender, notYourPlace } from './controller';
import { ProjectInlineError } from './InlineError';
import { ProjectSourceCard } from './SourceImage';

/**
 * The waiting screen: the source photo, one status line with the canonical stage label for
 * the job's state (announced once per change), the queue position when admitted under load,
 * the review note, Cancel, and the passive "Not your place?" after an auto-start.
 */
export function Waiting() {
  const project = useProjectStore((state) => state.project);
  const render = useProjectStore((state) => state.render);
  const autoStarted = useProjectStore((state) => state.autoStarted);
  const busy = useProjectStore((state) => state.busy);
  const phase = useProjectStore((state) => state.phase);
  const holidayId = useAppStore(currentHolidayId);
  const hasExamples = useAppStore((state) => (state.experience?.examples.length ?? 0) > 0);
  const [longWait, setLongWait] = useState(false);

  const requestedAt = render?.timestamps.requestedAt ?? null;
  useEffect(() => {
    if (!requestedAt) return;
    const elapsed = Date.now() - Date.parse(requestedAt);
    const timer = window.setTimeout(
      () => setLongWait(true),
      Math.max(0, CLIENT_DEFAULTS.longWaitMs - elapsed),
    );
    return () => window.clearTimeout(timer);
  }, [requestedAt]);

  if (!project) return null;
  const labelKey = render
    ? (render.stageLabelKey ?? stageLabelKeyFor(render.state))
    : 'stage.preparing';
  const label = t(busy ? 'wait.canceling' : (labelKey ?? 'stage.preparing'));
  const streetView = project.activeSource?.kind !== 'upload';
  const queue = render?.queuePosition ?? null;

  return (
    <section className="project-grid" aria-label={t('wait.heading')}>
      <div className="project-grid__media">
        <div className="waiting__media">
          <ProjectSourceCard project={project} />
        </div>
      </div>
      <div className="project-grid__side stack">
        <div className="status-line" role="status" aria-live="polite" aria-atomic="true">
          <p className="eyebrow">{t('wait.heading')}</p>
          <h1 className="status-line__text waiting__label">{label}</h1>
          <div className="indeterminate" aria-hidden="true" />
        </div>
        <ProjectInlineError />
        {queue !== null && queue > 0 ? (
          <p className="fine">{t('wait.queuePosition', { n: queue })}</p>
        ) : null}
        {render?.state === 'needs_review' ? <p className="fine">{t('wait.reviewNote')}</p> : null}
        {longWait ? (
          <p className="message">
            {t('wait.longWait', { anonymousRetention: DISPLAY_VALUES.anonymousRetention })}
          </p>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="button button--small"
            aria-disabled={busy || phase === 'starting' || undefined}
            onClick={() => {
              if (!busy && phase !== 'starting') void cancelRender();
            }}
          >
            {t('wait.cancel')}
          </button>
          {autoStarted && streetView ? (
            <button type="button" className="link-button" onClick={() => void notYourPlace()}>
              {t('wait.notYourPlace')}
            </button>
          ) : null}
        </div>
        {hasExamples ? (
          <div className="waiting__examples">
            <p className="eyebrow">{t('wait.examplesHeading')}</p>
            <ExampleGallery holidayId={holidayId} sceneType={project.sceneType} limit={3} />
          </div>
        ) : null}
      </div>
    </section>
  );
}
