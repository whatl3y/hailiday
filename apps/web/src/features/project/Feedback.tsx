import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  FEEDBACK_NOTE_MAX_LENGTH,
  FEEDBACK_REASONS,
  FEEDBACK_REASON_LABEL_KEYS,
  type FeedbackReason,
  type FeedbackVerdict,
} from '@hailiday/core';
import { createFeedback } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { t, tDynamic } from '../../copy';

function Thumb({ down }: { down?: boolean }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      style={down ? { transform: 'scaleY(-1)' } : undefined}
    >
      <path d="M7.5 10.5V20H5a1.5 1.5 0 0 1-1.5-1.5V12A1.5 1.5 0 0 1 5 10.5h2.5Zm0 0 3.6-6.3a1.6 1.6 0 0 1 2.9 1.2l-.8 4.1h5.2a1.8 1.8 0 0 1 1.8 2.1l-1.1 6.6A2 2 0 0 1 17.1 20H7.5" />
    </svg>
  );
}

type FeedbackState = 'idle' | 'reasons' | 'sending' | 'done';

/**
 * "Was this preview good?": thumbs up sends at once; thumbs down asks for reasons and an
 * optional note before sending. One submission per variant.
 */
export function Feedback({ renderAssetId }: { renderAssetId: string }) {
  const id = useId();
  const [state, setState] = useState<FeedbackState>('idle');
  const [verdict, setVerdict] = useState<FeedbackVerdict | null>(null);
  const [reasons, setReasons] = useState<FeedbackReason[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(crypto.randomUUID());
  const thanksRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (state === 'done') thanksRef.current?.focus();
  }, [state]);

  async function send(nextVerdict: FeedbackVerdict, nextReasons: FeedbackReason[]) {
    setState('sending');
    setError(null);
    try {
      await createFeedback(
        {
          renderAssetId,
          verdict: nextVerdict,
          reasons: nextReasons,
          ...(note.trim() ? { note: note.trim().slice(0, FEEDBACK_NOTE_MAX_LENGTH) } : {}),
        },
        idempotencyKey.current,
      );
      setState('done');
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
      setState(nextVerdict === 'down' ? 'reasons' : 'idle');
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state === 'sending') return;
    void send('down', reasons);
  }

  if (state === 'done') {
    return (
      <div className="feedback">
        <p ref={thanksRef} tabIndex={-1} className="feedback__thanks" role="status">
          {t('feedback.thanks')}
        </p>
      </div>
    );
  }

  return (
    <div className="feedback">
      <div className="feedback__prompt">
        <p id={`${id}-prompt`}>{t('feedback.prompt')}</p>
        <div className="feedback__thumbs" role="group" aria-labelledby={`${id}-prompt`}>
          <button
            type="button"
            className="icon-button"
            aria-label={t('feedback.up')}
            aria-pressed={verdict === 'up'}
            onClick={() => {
              if (state === 'sending') return;
              setVerdict('up');
              void send('up', []);
            }}
          >
            <Thumb />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={t('feedback.down')}
            aria-pressed={verdict === 'down'}
            aria-expanded={state === 'reasons'}
            aria-controls={`${id}-reasons`}
            onClick={() => {
              setVerdict('down');
              setState('reasons');
            }}
          >
            <Thumb down />
          </button>
        </div>
      </div>
      {state === 'reasons' || (state === 'sending' && verdict === 'down') ? (
        <form id={`${id}-reasons`} className="feedback__form stack" onSubmit={onSubmit}>
          <p id={`${id}-reasons-label`} className="fine">
            {t('feedback.reasonsLabel')}
          </p>
          <div className="holiday-inline" role="group" aria-labelledby={`${id}-reasons-label`}>
            {FEEDBACK_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                className="chip"
                aria-pressed={reasons.includes(reason)}
                onClick={() =>
                  setReasons((current) =>
                    current.includes(reason)
                      ? current.filter((item) => item !== reason)
                      : [...current, reason],
                  )
                }
              >
                {tDynamic(FEEDBACK_REASON_LABEL_KEYS[reason], 'feedback.other')}
              </button>
            ))}
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-note`}>
              {t('feedback.noteLabel')}
            </label>
            <textarea
              id={`${id}-note`}
              className="input"
              maxLength={FEEDBACK_NOTE_MAX_LENGTH}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <button
            type="submit"
            className="button button--small"
            aria-disabled={state === 'sending' || undefined}
          >
            {t('feedback.submit')}
          </button>
        </form>
      ) : null}
      {error ? (
        <p className="message message--error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
