import { useEffect, useId, useRef } from 'react';
import { t } from '../../copy';
import { useProjectStore } from '../../state/projectStore';
import { UploadPanel } from '../upload/UploadPanel';
import { discover, onUploadAttached } from './controller';
import { noStreetViewReasonKey } from './plans';

/** "We can't use a street photo for this address", a reason line and the upload actions. */
export function NoStreetView() {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const project = useProjectStore((state) => state.project);
  const discovery = useProjectStore((state) => state.discovery);
  const inlineError = useProjectStore((state) => state.inlineError);
  const cause = useProjectStore((state) => state.nosvCause);

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

  return (
    <section
      className="container container--narrow project-single stack stack--loose"
      aria-labelledby={headingId}
    >
      <div className="stack">
        <h1
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="title-section project__heading"
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
      <UploadPanel project={project} onAttached={(next) => void onUploadAttached(next)} />
    </section>
  );
}
