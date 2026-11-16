import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { deleteProject } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { useShareStore } from '../../state/shares';
import { Sheet } from '../../ui/Sheet';

/** How long "Deleted." stays on screen before returning to the start. */
const DONE_MS = 1400;

/**
 * "Delete this place?": deleting removes the photo, every preview and any share links, then
 * returns to the start.
 */
export function DeleteSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const forgetProject = useAppStore((state) => state.forgetProject);
  const forgetShares = useShareStore((state) => state.forgetProject);
  const [state, setState] = useState<'confirm' | 'deleting' | 'done'>('confirm');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state !== 'done') return;
    const timer = window.setTimeout(() => navigate('/', { replace: true }), DONE_MS);
    return () => window.clearTimeout(timer);
  }, [state, navigate]);

  async function onDelete() {
    if (state !== 'confirm') return;
    setState('deleting');
    setError(null);
    try {
      await deleteProject(projectId);
      forgetProject(projectId);
      forgetShares(projectId);
      setState('done');
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
      setState('confirm');
    }
  }

  return (
    <Sheet
      title={t('result.delete')}
      hideTitle
      onClose={() => (state === 'done' ? navigate('/', { replace: true }) : onClose())}
    >
      {state === 'done' ? (
        <p className="lede" role="status">
          {t('delete.done')}
        </p>
      ) : (
        <>
          <p className="lede">{t('delete.confirm')}</p>
          {error ? (
            <p className="message message--error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              aria-disabled={state === 'deleting' || undefined}
              onClick={() => void onDelete()}
            >
              {state === 'deleting' ? t('delete.deleting') : t('delete.yes')}
            </button>
            <button type="button" className="button button--quiet" onClick={onClose}>
              {t('common.cancel')}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
