import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { t } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { UploadPanel, type UploadSurface } from '../upload/UploadPanel';
import { discover, onUploadAttached } from './controller';
import { noStreetViewReasonKey } from './plans';

/**
 * "We can't use a street photo for this address": the holiday's photograph fills the screen and
 * its white dock holds the reason and the two routes on, uploading a photo (the upload step's
 * pickers) or trying another address. A chosen photo then fills a stage, as on the upload screen.
 */
export function NoStreetView({
  onSurfaceChange,
}: {
  /** Told whether the screen shows the holiday's photograph or a chosen photo on its stage. */
  onSurfaceChange?: (surface: UploadSurface) => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const project = useProjectStore((state) => state.project);
  const discovery = useProjectStore((state) => state.discovery);
  const inlineError = useProjectStore((state) => state.inlineError);
  const cause = useProjectStore((state) => state.nosvCause);
  const [surface, setSurface] = useState<UploadSurface>('photo');

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  if (!project) return null;
  // A panorama that disappeared after discovery reads as "no usable photo here"; a discovery
  // that failed reads as an error with Try again.
  const reason =
    cause === 'NO_STREET_VIEW'
      ? 'no_imagery'
      : (discovery?.reason ?? project.discovery?.reason ?? (inlineError ? 'error' : null));
  const line = cause === 'NEEDS_PHOTO' ? t('error.NEEDS_PHOTO') : t(noStreetViewReasonKey(reason));
  const canRetry = cause === null && (reason === 'error' || discovery?.retryable);

  // On the photograph the dock opens with the reason; once a photo is chosen the screen is the
  // upload step's own.
  const lead =
    surface === 'photo' ? (
      <div className="nosv__lead stack stack--tight">
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="title-section project__heading nosv__heading"
        >
          {t('nosv.heading')}
        </h1>
        <p className="lede">{line}</p>
        {canRetry ? (
          <button
            type="button"
            className="button button--small project__retry"
            onClick={() => void discover()}
          >
            {t('common.tryAgain')}
          </button>
        ) : null}
      </div>
    ) : null;

  return (
    <section className="nosv" aria-labelledby={surface === 'photo' ? headingId : undefined}>
      <UploadPanel
        project={project}
        layout="screen"
        showHeading={false}
        lead={lead}
        trail={
          <button
            type="button"
            className="link-button nosv__address"
            onClick={() => navigate('/', { state: { focusAddress: true } })}
          >
            {t('interim.changeAddress')}
          </button>
        }
        onSurfaceChange={(next) => {
          setSurface(next);
          onSurfaceChange?.(next);
        }}
        onAttached={(next) => void onUploadAttached(next)}
      />
    </section>
  );
}
