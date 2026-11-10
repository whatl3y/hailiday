import { useEffect, useRef } from 'react';
import { t, type CopyKey } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { discover, requestRender, retryRender, showUpload } from './controller';
import { ProjectSourceCard } from './SourceImage';
import { VariantCard } from './VariantCard';
import { renderErrorPlan, type RenderErrorAction } from './plans';

const ACTION_LABELS: Record<RenderErrorAction, CopyKey> = {
  try_again: 'common.tryAgain',
  another_photo: 'common.useAnotherPhoto',
  another_view: 'common.useAnotherView',
  show_as_photographed: 'common.showAsPhotographed',
};

/** A render that failed or was rejected: what happened and what the person can do next. */
export function RenderError() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const project = useProjectStore((state) => state.project);
  const render = useProjectStore((state) => state.render);
  const variant = useProjectStore((state) => state.variant);
  const candidates = useProjectStore((state) => state.candidates);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (!project || !render) return null;
  const streetView =
    project.activeSource?.kind === 'street_view' || project.activeSource?.kind === 'fixture';
  const plan = renderErrorPlan(render, streetView);

  function run(action: RenderErrorAction) {
    switch (action) {
      case 'try_again':
        retryRender();
        return;
      case 'another_photo':
        showUpload('replace');
        return;
      case 'another_view':
        if (candidates.length > 0 && render?.failureKind !== 'source_unavailable') {
          useProjectStore.setState({ phase: 'confirm', autoStarted: false });
        } else {
          void discover();
        }
        return;
      case 'show_as_photographed':
        void requestRender({ lightingMode: 'source' });
        return;
    }
  }

  return (
    <section className="project-grid" aria-labelledby="render-error-heading">
      <div className="project-grid__media">
        {variant ? (
          <VariantCard variant={variant} project={project} />
        ) : (
          <ProjectSourceCard project={project} />
        )}
      </div>
      <div className="project-grid__side stack">
        <h1
          id="render-error-heading"
          ref={headingRef}
          tabIndex={-1}
          className="title-section project__heading"
        >
          {t('result.errorHeading')}
        </h1>
        <p className="lede">{t(plan.messageKey)}</p>
        <div className="project__actions">
          {plan.actions.map((action, index) => (
            <button
              key={action}
              type="button"
              className={
                index === 0 ? 'button button--primary button--block' : 'button button--block'
              }
              onClick={() => run(action)}
            >
              {t(ACTION_LABELS[action])}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
