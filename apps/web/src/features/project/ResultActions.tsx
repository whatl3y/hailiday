import { useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Project, Variant } from '@holiday/core';
import { listVariants } from '../../api/endpoints';
import { t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { STORAGE_KEYS, readStored, writeStored } from '../../state/persist';
import { Icon } from '../../ui/Icon';
import { showUpload } from './controller';
import { isSignedUrlExpired } from './download';
import { shareAvailability } from './looks';

export type ResultSheet = 'save' | 'share' | 'delete' | 'report';

function OverflowMenu({
  onDelete,
  shareUnavailable,
}: {
  onDelete: () => void;
  shareUnavailable: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    firstRef.current?.focus();
    function onDocument(event: Event) {
      if (event instanceof KeyboardEvent) {
        if (event.key !== 'Escape') return;
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('keydown', onDocument);
    document.addEventListener('pointerdown', onDocument);
    return () => {
      document.removeEventListener('keydown', onDocument);
      document.removeEventListener('pointerdown', onDocument);
    };
  }, [open]);

  return (
    <div className="overflow" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button overflow__toggle"
        aria-label={t('result.more')}
        aria-expanded={open}
        aria-controls={`${id}-menu`}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" />
      </button>
      {open ? (
        <div id={`${id}-menu`} className="overflow__panel">
          {shareUnavailable ? (
            <p className="overflow__note">{t('result.shareUnavailable')}</p>
          ) : null}
          <button
            ref={firstRef}
            type="button"
            className="overflow__item"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Icon name="trash" />
            {t('result.delete')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Save, Share, Download (only when the variant carries `downloadUrl`) and Delete in the
 * overflow menu, then "Change address" or "Replace photo". A private-only preview has no
 * Share or Download.
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
  const navigate = useNavigate();
  const sharingEnabled = useAppStore((state) => state.experience?.capabilities.sharing ?? true);
  const [downloadNote, setDownloadNote] = useState(false);
  const { canShare, unavailableNote } = shareAvailability(variant, sharingEnabled);
  const uploadOrigin = project.activeSource?.kind === 'upload' || project.kind === 'upload';

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
      if (fresh?.downloadUrl && opened) opened.location.href = fresh.downloadUrl;
      else opened?.close();
    } catch {
      opened?.close();
    }
  }

  return (
    <div className="result-actions">
      <div className="result-actions__row" role="group" aria-label={t('result.actionsLabel')}>
        {project.saved ? (
          <Link to="/places" className="button button--small result-actions__saved">
            <Icon name="check" />
            {t('result.saved')}
          </Link>
        ) : (
          <button
            type="button"
            className="button button--small button--primary"
            onClick={() => onOpen('save')}
          >
            <Icon name="bookmark" />
            {t('result.save')}
          </button>
        )}
        {canShare ? (
          <button type="button" className="button button--small" onClick={() => onOpen('share')}>
            <Icon name="share" />
            {t('result.share')}
          </button>
        ) : null}
        {variant.downloadUrl && !variant.privateOnly ? (
          <a
            className="button button--small"
            href={variant.downloadUrl}
            download
            target="_blank"
            rel="noopener"
            onClick={(event) => void onDownload(event)}
          >
            <Icon name="download" />
            {t('result.download')}
          </a>
        ) : null}
        <OverflowMenu onDelete={() => onOpen('delete')} shareUnavailable={unavailableNote} />
      </div>
      {downloadNote ? (
        <p className="fine" role="status">
          {t('result.downloadNote')}
        </p>
      ) : null}
      <div className="result-actions__secondary">
        {uploadOrigin ? (
          <button type="button" className="link-button" onClick={() => showUpload('replace')}>
            {t('result.replacePhoto')}
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            onClick={() => navigate('/', { state: { focusAddress: true } })}
          >
            {t('result.changeAddress')}
          </button>
        )}
      </div>
    </div>
  );
}
