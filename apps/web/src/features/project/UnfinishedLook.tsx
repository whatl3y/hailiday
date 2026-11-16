import type { RenderStatus } from '@hailiday/core';
import { t, type CopyKey } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { discover, showUpload } from './controller';
import { renderErrorPlan, type RenderErrorAction } from './plans';

const ACTION_LABELS: Record<RenderErrorAction, CopyKey> = {
  try_again: 'common.tryAgain',
  another_photo: 'common.useAnotherPhoto',
  another_view: 'common.useAnotherView',
};

export interface UnfinishedLookProps {
  /** The status the look ended with. */
  failed: RenderStatus;
  /** "Try again": asks for the look again. */
  onTryAgain: () => void;
}

/**
 * The one notice under the picture for a look that ended with nothing to show: what happened,
 * calmly, and the way forward ("Try again" first where a new try can help, then another photo or
 * view). The picture on screen stays.
 */
export function UnfinishedLook({ failed, onTryAgain }: UnfinishedLookProps) {
  const project = useProjectStore((state) => state.project);
  const candidates = useProjectStore((state) => state.candidates);
  if (!project) return null;
  const streetView =
    project.activeSource?.kind === 'street_view' || project.activeSource?.kind === 'fixture';
  const plan = renderErrorPlan(failed, streetView);

  function run(action: RenderErrorAction) {
    switch (action) {
      case 'try_again':
        onTryAgain();
        return;
      case 'another_photo':
        showUpload('replace');
        return;
      case 'another_view':
        if (candidates.length > 0 && failed.failureKind !== 'source_unavailable') {
          useProjectStore.setState({ phase: 'confirm', autoStarted: false, pendingError: null });
        } else {
          // A page that holds no views asks for them, and never decorates the same view again.
          useProjectStore.setState({ pendingError: null });
          void discover(undefined, { confirmFirst: true });
        }
        return;
    }
  }

  return (
    <div className="look-notice" role="status">
      <p className="look-notice__text">{t(plan.messageKey)}</p>
      <div className="look-notice__actions">
        {plan.actions.map((action, index) => (
          <button
            key={action}
            type="button"
            className={index === 0 ? 'button button--primary' : 'button'}
            onClick={() => run(action)}
          >
            {t(ACTION_LABELS[action])}
          </button>
        ))}
      </div>
    </div>
  );
}
