import { useId, useRef, useState, type FormEvent } from 'react';
import { CreateReportRequestSchema } from '@holiday/core';
import { createReport } from '../../api/endpoints';
import { getTurnstileToken } from '../../api/turnstile';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { ChallengeSlot } from '../../ui/ChallengeSlot';
import { PageShell } from '../../ui/Layout';
import { AddressCombobox, type AddressSelection } from '../address/AddressCombobox';
import '../landing/landing.css';

/**
 * `/dont-decorate-my-home`: the homeowner opt-out. The same address combobox, a contact email
 * for verification, and a report with reason `this_is_my_home` for the resolved place.
 */
export function OptOutPage() {
  const id = useId();
  const [selection, setSelection] = useState<AddressSelection | null>(null);
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const challengeRef = useRef<HTMLDivElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (sending) return;
    if (!selection) {
      setError(t('optout.chooseAddress'));
      return;
    }
    const addressText = `${selection.suggestion.primaryText}, ${selection.suggestion.secondaryText}`;
    setSending(true);
    setError(null);
    try {
      let turnstileToken: string;
      try {
        turnstileToken = await getTurnstileToken({ container: challengeRef.current });
      } catch {
        setError(t('error.VERIFICATION_REQUIRED'));
        return;
      }
      const body = CreateReportRequestSchema.safeParse({
        target: { kind: 'address', placeId: selection.suggestion.placeId, addressText },
        reason: 'this_is_my_home',
        requestOptOut: true,
        contactEmail: email.trim(),
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
    } finally {
      setSending(false);
    }
  }

  return (
    <PageShell title={t('optout.heading')}>
      <section className="container container--narrow simple-page stack stack--loose">
        <div className="stack">
          <h1 className="simple-page__title">{t('optout.heading')}</h1>
          <p className="lede">{t('optout.body')}</p>
        </div>
        {sent ? (
          <p className="message" role="status">
            {t('optout.thanks')}
          </p>
        ) : (
          <form className="stack" onSubmit={(event) => void onSubmit(event)} noValidate>
            <AddressCombobox
              label={t('optout.addressLabel')}
              placeholder={t('landing.addressPlaceholder')}
              onSelect={(next) => {
                setSelection(next);
                setError(null);
              }}
              onTextChange={() => setSelection(null)}
            />
            <div className="field">
              <label className="field__label" htmlFor={`${id}-email`}>
                {t('optout.contactLabel')}
              </label>
              <input
                id={`${id}-email`}
                className="input"
                type="email"
                autoComplete="email"
                required
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
            <button
              type="submit"
              className="button button--primary"
              aria-disabled={sending || undefined}
            >
              {t('optout.submit')}
            </button>
          </form>
        )}
        <p className="fine">{t('optout.googleNote')}</p>
      </section>
    </PageShell>
  );
}
