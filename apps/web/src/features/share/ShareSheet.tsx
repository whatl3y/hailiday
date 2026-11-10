import { useId, useRef, useState } from 'react';
import type { Project, Variant } from '@holiday/core';
import { createShare, deleteShare } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { holidayName, t } from '../../copy';
import { DISPLAY_VALUES } from '../../config/values';
import { useShareStore, type ShareRecord } from '../../state/shares';
import { AiPreviewBadge } from '../../ui/ImageCard';
import { aiBadgeCorner, cornerClassName, isStreetViewVariant } from '../../ui/badgeCorner';
import { Sheet } from '../../ui/Sheet';
import './share.css';

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

async function copyText(text: string, fallback: HTMLInputElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!fallback) return false;
    fallback.focus();
    fallback.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

/** The share card preview: the generated card when it is ready, else the preview itself. */
function CardPreview({
  variant,
  record,
  streetView,
}: {
  variant: Variant;
  record: ShareRecord | null;
  streetView: boolean;
}) {
  const [cardFailed, setCardFailed] = useState(false);
  const src = record?.cardUrl && !cardFailed ? record.cardUrl : variant.imageUrl;
  const corner = aiBadgeCorner(streetView);
  return (
    <figure className="share-card">
      <div className="share-card__frame">
        <img
          src={src}
          alt={t('share.cardAlt', { holiday: holidayName(variant.holidayId) })}
          onError={() => setCardFailed(true)}
        />
        {src === variant.imageUrl ? (
          <span className={cornerClassName('share-card__badge', corner)} data-corner={corner}>
            <AiPreviewBadge />
          </span>
        ) : null}
      </div>
      <figcaption className="fine">{t('share.cardNote')}</figcaption>
    </figure>
  );
}

/**
 * "Share": a preview of the share card, the before-photo option for upload-origin previews,
 * the link's lifetime, Copy link and the native share sheet where the browser offers it. An
 * existing link shows its expiry and "Stop sharing".
 */
export function ShareSheet({
  project,
  variant,
  onClose,
}: {
  project: Project;
  variant: Variant;
  onClose: () => void;
}) {
  const id = useId();
  const record = useShareStore((state) => state.byVariant[variant.renderAssetId] ?? null);
  const remember = useShareStore((state) => state.remember);
  const forget = useShareStore((state) => state.forget);
  const [includeBefore, setIncludeBefore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkRef = useRef<HTMLInputElement>(null);
  // One key per link: a retry of the same create reuses it, while a new link (after Stop
  // sharing, or with other options) gets a fresh key so a revoked link is never replayed.
  const idempotencyKey = useRef(crypto.randomUUID());
  const freshKey = () => {
    idempotencyKey.current = crypto.randomUUID();
  };
  const uploadOrigin = variant.attribution === null;
  const canIncludeBefore = uploadOrigin && !variant.privateOnly && variant.beforeImageUrl !== null;
  const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function ensureLink(): Promise<ShareRecord | null> {
    if (record) return record;
    setBusy(true);
    setError(null);
    try {
      const created = await createShare(
        { renderAssetId: variant.renderAssetId, includeBefore: canIncludeBefore && includeBefore },
        idempotencyKey.current,
      );
      const next: ShareRecord = {
        ...created,
        renderAssetId: variant.renderAssetId,
        projectId: project.id,
        includeBefore: canIncludeBefore && includeBefore,
      };
      remember(next);
      freshKey();
      return next;
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (busy) return;
    const link = await ensureLink();
    if (!link) return;
    setCopied(await copyText(link.url, linkRef.current));
  }

  async function onNativeShare() {
    if (busy) return;
    const link = await ensureLink();
    if (!link) return;
    try {
      await navigator.share({ title: t('share.title'), url: link.url });
    } catch {
      // The person closed the share sheet; the link stays available to copy.
    }
  }

  async function onStop() {
    if (!record || busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteShare(record.token);
      forget(variant.renderAssetId);
      freshKey();
      setStopped(true);
      setConfirmStop(false);
    } catch (failure) {
      if (isApiError(failure) && failure.code === 'SHARE_REVOKED') {
        forget(variant.renderAssetId);
        freshKey();
        setStopped(true);
        setConfirmStop(false);
      } else {
        setError(presentError(failure)?.message ?? t('error.unknown'));
      }
    } finally {
      setBusy(false);
    }
  }

  if (confirmStop && record) {
    return (
      <Sheet key="stop" title={t('share.stop')} onClose={() => setConfirmStop(false)}>
        <p className="lede">{t('share.stopConfirm')}</p>
        {error ? (
          <p className="message message--error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <button
            type="button"
            className="button button--primary"
            aria-disabled={busy || undefined}
            onClick={() => void onStop()}
          >
            {t('share.stop')}
          </button>
          <button type="button" className="button" onClick={() => setConfirmStop(false)}>
            {t('common.cancel')}
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet key="share" title={t('share.heading')} onClose={onClose}>
      <CardPreview
        variant={variant}
        record={record}
        streetView={isStreetViewVariant(variant, project.activeSource)}
      />
      {stopped && !record ? (
        <p className="message" role="status">
          {t('share.stopped')}
        </p>
      ) : null}
      {canIncludeBefore && !record ? (
        <label className="check">
          <input
            type="checkbox"
            checked={includeBefore}
            onChange={(event) => {
              setIncludeBefore(event.target.checked);
              freshKey();
            }}
          />
          <span className="check__text">{t('share.includeBefore')}</span>
        </label>
      ) : null}
      {record ? (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-link`}>
            {t('share.linkLabel')}
          </label>
          <input
            ref={linkRef}
            id={`${id}-link`}
            className="input share__link"
            readOnly
            value={record.url}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      <p className="fine">
        {record
          ? t('share.expiresOn', { date: formatDate(record.expiresAt) })
          : t('share.expiry', { shareLifetime: DISPLAY_VALUES.shareLifetime })}
      </p>
      {error ? (
        <p className="message message--error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="share__buttons">
        <button
          type="button"
          className="button button--primary"
          aria-disabled={busy || undefined}
          onClick={() => void onCopy()}
        >
          {busy && !record ? t('share.creating') : t('share.copyLink')}
        </button>
        {canNativeShare ? (
          <button
            type="button"
            className="button"
            aria-disabled={busy || undefined}
            onClick={() => void onNativeShare()}
          >
            {t('share.shareVia')}
          </button>
        ) : null}
      </div>
      <p className="share__copied" role="status" aria-live="polite">
        {copied ? t('share.copied') : ''}
      </p>
      {record ? (
        <button
          type="button"
          className="button button--quiet share__stop"
          onClick={() => setConfirmStop(true)}
        >
          {t('share.stop')}
        </button>
      ) : null}
    </Sheet>
  );
}
