import { useId, useRef, useState, type FormEvent } from 'react';
import { MagicLinkRequestSchema } from '@holiday/core';
import { requestMagicLink } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { DISPLAY_VALUES } from '../../config/values';
import { Sheet } from '../../ui/Sheet';

type SaveState = { kind: 'form' } | { kind: 'sending' } | { kind: 'sent'; email: string };

/**
 * "Save" is also sign-in: an email field that sends a magic link. The link returns to
 * `returnTo` after `/auth/verify` signs the person in and attaches the session's places.
 */
export function SaveForm({ returnTo, autoFocus }: { returnTo: string; autoFocus?: boolean }) {
  const id = useId();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<SaveState>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (state.kind === 'sending') return;
    const parsed = MagicLinkRequestSchema.safeParse({ email: email.trim(), returnTo });
    if (!parsed.success) {
      setError(t('save.emailInvalid'));
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setState({ kind: 'sending' });
    try {
      await requestMagicLink(parsed.data.email, parsed.data.returnTo);
      setState({ kind: 'sent', email: parsed.data.email });
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
      setState({ kind: 'form' });
    }
  }

  if (state.kind === 'sent') {
    return (
      <div className="stack">
        <p className="lede" role="status">
          {t('save.sent', { linkLifetime: DISPLAY_VALUES.linkLifetime })}
        </p>
        <p className="save__email">{state.email}</p>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setState({ kind: 'form' });
            setEmail('');
          }}
        >
          {t('save.differentEmail')}
        </button>
      </div>
    );
  }

  return (
    <form className="stack" onSubmit={(event) => void onSubmit(event)} noValidate>
      <p className="lede">{t('save.body', { savedRetention: DISPLAY_VALUES.savedRetention })}</p>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-email`}>
          {t('save.emailLabel')}
        </label>
        <input
          ref={inputRef}
          id={`${id}-email`}
          className="input"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus={autoFocus}
          required
          value={email}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error ? (
          <p id={`${id}-error`} className="field__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <button
        type="submit"
        className="button button--primary button--block"
        aria-disabled={state.kind === 'sending' || undefined}
      >
        {t('save.send')}
      </button>
    </form>
  );
}

/** The save sheet over the result. */
export function SaveSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  return (
    <Sheet title={t('save.heading')} onClose={onClose}>
      <SaveForm returnTo={`/p/${projectId}`} />
    </Sheet>
  );
}
