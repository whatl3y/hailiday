import { useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  CreateReportRequestSchema,
  REPORT_DETAILS_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_REASON_LABEL_KEYS,
  type ReportReason,
  type ReportTarget,
} from '@holiday/core';
import { createReport } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { getTurnstileToken } from '../../api/turnstile';
import { presentError } from '../../api/present';
import { t, tDynamic } from '../../copy';
import { DISPLAY_VALUES } from '../../config/values';
import { ChallengeSlot } from '../../ui/ChallengeSlot';
import { RetryAfterButton } from '../../ui/RetryAfterButton';
import { Sheet } from '../../ui/Sheet';
import '../account/account.css';

/**
 * "Report this image": one reason, optional details and an optional contact email. Works for
 * anyone; the bot-check token is attached for visitors without a session.
 */
export function ReportSheet({
  target,
  onClose,
}: {
  target: Exclude<ReportTarget, { kind: 'address' }>;
  onClose: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [retry, setRetry] = useState<{ id: number; retryAfterSeconds: number | null } | null>(null);
  const challengeRef = useRef<HTMLDivElement>(null);

  async function send() {
    if (!reason || sending) return;
    setSending(true);
    setError(null);
    setRetry(null);
    try {
      let turnstileToken: string;
      try {
        turnstileToken = await getTurnstileToken({ container: challengeRef.current });
      } catch {
        setError(t('error.VERIFICATION_REQUIRED'));
        return;
      }
      const body = CreateReportRequestSchema.safeParse({
        target,
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(email.trim() ? { contactEmail: email.trim() } : {}),
        turnstileToken,
      });
      if (!body.success) {
        setError(t('error.VALIDATION_FAILED'));
        return;
      }
      await createReport(body.data);
      setSent(true);
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
      if (isApiError(failure) && failure.code === 'RATE_LIMITED') {
        setRetry({ id: Date.now(), retryAfterSeconds: failure.retryAfterSeconds });
      }
    } finally {
      setSending(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send();
  }

  return (
    <Sheet title={sent ? t('report.sent') : t('report.heading')} onClose={onClose}>
      {sent ? (
        <>
          <p className="lede" role="status">
            {t('report.thanks', { reportAckTarget: DISPLAY_VALUES.reportAckTarget })}
          </p>
          <button type="button" className="button button--primary" onClick={onClose}>
            {t('common.gotIt')}
          </button>
        </>
      ) : (
        <form className="stack" onSubmit={onSubmit}>
          <fieldset className="report-reasons">
            <legend>{t('report.reasonLegend')}</legend>
            {REPORT_REASONS.map((value) => (
              <label key={value} className="radio-row">
                <input
                  type="radio"
                  name={`${id}-reason`}
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                />
                <span>{tDynamic(REPORT_REASON_LABEL_KEYS[value], 'report.other')}</span>
              </label>
            ))}
          </fieldset>
          {reason === 'this_is_my_home' ? (
            <p className="fine">
              {t('report.myHomeNote')}{' '}
              <Link to="/dont-decorate-my-home">{t('optout.heading')}</Link>
            </p>
          ) : null}
          <div className="field">
            <label className="field__label" htmlFor={`${id}-details`}>
              {t('report.details')}
            </label>
            <textarea
              id={`${id}-details`}
              className="input"
              maxLength={REPORT_DETAILS_MAX_LENGTH}
              value={details}
              onChange={(event) => setDetails(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-email`}>
              {t('report.contact')}
            </label>
            <input
              id={`${id}-email`}
              className="input"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <ChallengeSlot elementRef={challengeRef} />
          {error ? (
            <p className="message message--error" role="alert">
              {error}
            </p>
          ) : null}
          {retry ? (
            <RetryAfterButton
              key={retry.id}
              retryAfterSeconds={retry.retryAfterSeconds}
              onRetry={() => void send()}
            />
          ) : null}
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={!reason || sending || undefined}
            aria-describedby={!reason ? `${id}-why` : undefined}
          >
            {t('report.submit')}
          </button>
          {!reason ? (
            <p id={`${id}-why`} className="fine">
              {t('report.chooseReason')}
            </p>
          ) : null}
        </form>
      )}
    </Sheet>
  );
}
