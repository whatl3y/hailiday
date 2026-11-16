import { useState } from 'react';
import { Link } from 'react-router';
import type { Project, Variant } from '@hailiday/core';
import { holidayName, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { readStored, writeStored } from '../../state/persist';
import { Icon } from '../../ui/Icon';
import { retryLight } from './controller';
import { dismissLightFallback, useLightFallback } from './lookFallback';

const INVITE_DISMISSED = 'hailiday.thanksgivingInviteDismissed';

/**
 * One-line notices, each only when true: a relit look shown in the photo's own light because its
 * light did not arrive (with the light again as its action, dismissible), private-only, existing
 * decorations, a changed street photo, and the dismissible Thanksgiving dining invitation on
 * exterior results.
 */
export function ResultNotices({ project, variant }: { project: Project; variant: Variant }) {
  const holiday = useAppStore(
    (state) => state.experience?.holidays.find((item) => item.id === variant.holidayId) ?? null,
  );
  const ownLight = useLightFallback((state) =>
    !state.dismissed && state.fallback?.renderAssetId === variant.renderAssetId
      ? state.fallback.lightingMode
      : null,
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

  if (notices.length === 0 && !showInvite && !ownLight) return null;
  return (
    <div className="result-notices">
      {ownLight ? (
        <div className="look-notice look-notice--light" role="status">
          <p className="look-notice__text">
            {t(ownLight === 'bright' ? 'result.brightUnavailable' : 'result.eveningUnavailable')}
          </p>
          <div className="look-notice__actions">
            <button type="button" className="button button--small" onClick={retryLight}>
              {t(ownLight === 'bright' ? 'result.brightAgain' : 'result.eveningAgain')}
            </button>
          </div>
          <button
            type="button"
            className="icon-button look-notice__dismiss"
            aria-label={t('common.dismiss')}
            onClick={dismissLightFallback}
          >
            <Icon name="close" />
          </button>
        </div>
      ) : null}
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
