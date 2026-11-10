import { stageLabelKeyFor } from '@holiday/core';
import { holidayName, t, type CopyKey } from '../../copy';
import { lookOf, useProjectStore } from '../../state/projectStore';
import { Sheet } from '../../ui/Sheet';
import {
  cancelPendingLook,
  chooseLook,
  discover,
  dismissPendingError,
  requestRender,
  showUpload,
} from './controller';
import { renderErrorPlan, type RenderErrorAction } from './plans';

/**
 * "Decorating the {holiday} look…": the band over the current preview while a new look is
 * decorated, with the canonical stage label (announced once per change) and Cancel.
 */
export function PendingBand() {
  const pending = useProjectStore((state) => state.pending);
  if (!pending) return null;
  const render = pending.render;
  const labelKey =
    (render ? (render.stageLabelKey ?? stageLabelKeyFor(render.state)) : null) ?? 'stage.preparing';
  const queue = render?.queuePosition ?? null;
  return (
    <div className="pending-band" role="status" aria-live="polite" aria-atomic="true">
      <div className="pending-band__text">
        <p className="pending-band__title">
          {t('result.decoratingLook', { holiday: holidayName(pending.look.holidayId) })}
        </p>
        <p className="pending-band__stage">
          {t(labelKey)}
          {queue !== null && queue > 0 ? ` · ${t('wait.queuePosition', { n: queue })}` : null}
        </p>
        {render?.state === 'needs_review' ? (
          <p className="pending-band__stage">{t('wait.reviewNote')}</p>
        ) : null}
        <div className="indeterminate" aria-hidden="true" />
      </div>
      <button
        type="button"
        className="button button--small"
        onClick={() => void cancelPendingLook()}
      >
        {t('wait.cancel')}
      </button>
    </div>
  );
}

const ACTION_LABELS: Record<RenderErrorAction, CopyKey> = {
  try_again: 'common.tryAgain',
  another_photo: 'common.useAnotherPhoto',
  another_view: 'common.useAnotherView',
  show_as_photographed: 'common.showAsPhotographed',
};

/** A new look failed: the current preview stays and this sheet says what happened. */
export function PendingErrorSheet() {
  const failed = useProjectStore((state) => state.pendingError);
  const project = useProjectStore((state) => state.project);
  const candidates = useProjectStore((state) => state.candidates);
  if (!failed || !project) return null;
  const streetView =
    project.activeSource?.kind === 'street_view' || project.activeSource?.kind === 'fixture';
  const plan = renderErrorPlan(failed, streetView);

  function run(action: RenderErrorAction) {
    if (!failed) return;
    dismissPendingError();
    switch (action) {
      case 'try_again':
        void requestRender({ look: lookOf(failed) });
        return;
      case 'another_photo':
        showUpload('replace');
        return;
      case 'another_view':
        if (candidates.length > 0 && failed.failureKind !== 'source_unavailable') {
          useProjectStore.setState({ phase: 'confirm', autoStarted: false });
        } else {
          void discover();
        }
        return;
      case 'show_as_photographed':
        chooseLook({ ...lookOf(failed), lightingMode: 'source' });
        return;
    }
  }

  return (
    <Sheet title={t('result.errorHeading')} onClose={dismissPendingError}>
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
    </Sheet>
  );
}
