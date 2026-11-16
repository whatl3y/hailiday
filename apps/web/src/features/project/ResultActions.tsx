import { useState, type MouseEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Project, Variant } from '@hailiday/core';
import { listVariants } from '../../api/endpoints';
import { t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { makingLook, refuseWhileMakingLook, useProjectStore } from '../../state/projectStore';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/persist';
import { Icon } from '../../ui/Icon';
import { replacePhoto } from './controller';
import { followFreshDownload, isSignedUrlExpired } from './download';
import { LOCK_HINT_ID } from './LookProgress';
import { shareAvailability } from './looks';

export type ResultSheet = 'save' | 'share' | 'delete' | 'report';

/**
 * The one action row under the picture: Save as the single primary action (or "Saved" once the
 * project is saved), then Share, Download (only when the variant carries `downloadUrl`) and
 * Gallery as quiet links. A private-only preview has no Share or Download.
 */
export function ResultActions({
  project,
  variant,
  onOpen,
}: {
  project: Project;
  variant: Variant;
  onOpen: (sheet: ResultSheet) => void;
}) {
  const sharingEnabled = useAppStore((state) => state.experience?.capabilities.sharing ?? true);
  const [downloadNote, setDownloadNote] = useState(false);
  const { canShare } = shareAvailability(variant, sharingEnabled);

  async function onDownload(event: MouseEvent<HTMLAnchorElement>) {
    if (!readStored('session', STORAGE_KEYS.downloadNoteShown)) {
      writeStored('session', STORAGE_KEYS.downloadNoteShown, '1');
      setDownloadNote(true);
    }
    const url = variant.downloadUrl;
    if (!url || !isSignedUrlExpired(url)) return;
    // Signed links are short-lived: read the variants again for a fresh one.
    event.preventDefault();
    const opened = window.open('', '_blank');
    try {
      const list = await listVariants(project.id);
      const fresh = list.items.find((item) => item.renderAssetId === variant.renderAssetId);
      followFreshDownload(opened, fresh?.downloadUrl);
    } catch {
      opened?.close();
    }
  }

  return (
    <div className="result-actions">
      <div className="result-actions__row" role="group" aria-label={t('result.actionsLabel')}>
        {project.saved ? (
          <Link to="/places" className="link-button result-actions__saved">
            <Icon name="check" />
            {t('result.saved')}
          </Link>
        ) : (
          <button
            type="button"
            className="button button--primary result-actions__save"
            onClick={() => onOpen('save')}
          >
            {t('result.save')}
          </button>
        )}
        {canShare ? (
          <button type="button" className="link-button" onClick={() => onOpen('share')}>
            {t('result.share')}
          </button>
        ) : null}
        {variant.downloadUrl && !variant.privateOnly ? (
          <a
            className="link-button"
            href={variant.downloadUrl}
            download
            target="_blank"
            rel="noopener"
            onClick={(event) => void onDownload(event)}
          >
            {t('result.download')}
          </a>
        ) : null}
        <Link to="/gallery" className="link-button">
          {t('gallery.title')}
        </Link>
      </div>
      {downloadNote ? (
        <p className="fine" role="status">
          {t('result.downloadNote')}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The "More" panel: why sharing is unavailable (when it is), the scene type of an uploaded
 * photo, "Replace photo" or "Change address", and Delete. While a look is being made the three
 * links are locked: they stay focusable, say why, and do nothing.
 */
export function ResultMore({
  project,
  variant,
  sceneChip,
  onOpen,
}: {
  project: Project;
  variant: Variant;
  /** The "Looks like a … · Change" control of an uploaded photo. */
  sceneChip?: ReactNode;
  onOpen: (sheet: ResultSheet) => void;
}) {
  const navigate = useNavigate();
  const sharingEnabled = useAppStore((state) => state.experience?.capabilities.sharing ?? true);
  const { unavailableNote } = shareAvailability(variant, sharingEnabled);
  const uploadOrigin = project.activeSource?.kind === 'upload' || project.kind === 'upload';
  const locked = useProjectStore(makingLook);
  const lockProps = {
    'aria-disabled': locked || undefined,
    'aria-describedby': locked ? LOCK_HINT_ID : undefined,
  };

  return (
    <div className="result-more">
      {unavailableNote ? <p className="fine">{t('result.shareUnavailable')}</p> : null}
      {sceneChip}
      <div className="result-more__links">
        {uploadOrigin ? (
          <button type="button" className="link-button" {...lockProps} onClick={replacePhoto}>
            {t('result.replacePhoto')}
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            {...lockProps}
            onClick={() => {
              if (refuseWhileMakingLook()) return;
              void navigate('/', { state: { focusAddress: true } });
            }}
          >
            {t('result.changeAddress')}
          </button>
        )}
        <button
          type="button"
          className="link-button result-more__delete"
          {...lockProps}
          onClick={() => {
            if (refuseWhileMakingLook()) return;
            onOpen('delete');
          }}
        >
          {t('result.delete')}
        </button>
      </div>
    </div>
  );
}
