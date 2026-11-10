import { useState } from 'react';
import { Link } from 'react-router';
import type { Project, Variant } from '@holiday/core';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { readStored, writeStored } from '../../state/persist';
import { Icon } from '../../ui/Icon';

const INVITE_DISMISSED = 'holiday.thanksgivingInviteDismissed';

/**
 * One-line notices, each only when true: private-only, existing decorations, a changed street
 * photo, and the dismissible Thanksgiving dining invitation on exterior results.
 */
export function ResultNotices({ project, variant }: { project: Project; variant: Variant }) {
  const holiday = useAppStore(
    (state) => state.experience?.holidays.find((item) => item.id === variant.holidayId) ?? null,
  );
  const [inviteDismissed, setInviteDismissed] = useState(
    () => readStored('session', INVITE_DISMISSED) === '1',
  );
  const showInvite =
    !inviteDismissed &&
    holiday?.journeyEmphasis === 'interior' &&
    holiday.inWindow &&
    project.sceneType !== null &&
    project.sceneType !== 'interior';

  const notices = [
    variant.privateOnly ? <p key="private">{t('result.privateOnly')}</p> : null,
    variant.existingDecorConflict ? (
      <p key="decor">{t('result.existingDecor', { holiday: holidayName(variant.holidayId) })}</p>
    ) : null,
    variant.sourceState === 'stale' ? <p key="stale">{t('result.stalePhoto')}</p> : null,
  ].filter(Boolean);

  if (notices.length === 0 && !showInvite) return null;
  return (
    <div className="result-notices">
      {notices.length > 0 ? <div className="result-notices__list">{notices}</div> : null}
      {showInvite ? (
        <div className="invite" data-holiday={variant.holidayId}>
          <p>
            {t('result.thanksgivingInvite')} <Link to="/upload">{t('result.thanksgivingCta')}</Link>
          </p>
          <button
            type="button"
            className="icon-button"
            aria-label={t('common.dismiss')}
            onClick={() => {
              writeStored('session', INVITE_DISMISSED, '1');
              setInviteDismissed(true);
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
