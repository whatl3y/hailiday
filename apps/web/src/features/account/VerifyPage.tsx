import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  RelativePathSchema,
  isVerifyConfirmationRequired,
  type VerifyMagicLinkSignedIn,
} from '@hailiday/core';
import { verifyMagicLink } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { PageShell } from '../../ui/Layout';
import { Sheet } from '../../ui/Sheet';
import { TextWithLink } from '../../ui/TextWithLink';
import { SaveForm } from './SaveSheet';

/**
 * One request per token and step, so a remount never spends a single-use link twice and never
 * repeats the confirmation. A request that fails is forgotten, so trying again asks the API
 * again instead of replaying the failure for the rest of the page's life.
 */
const verifications = new Map<string, ReturnType<typeof verifyMagicLink>>();

function verifyOnce(token: string, confirm: boolean) {
  const key = `${confirm ? 'confirm' : 'verify'}:${token}`;
  const cached = verifications.get(key);
  if (cached) return cached;
  const pending = verifyMagicLink(token, confirm);
  verifications.set(key, pending);
  pending.catch(() => {
    if (verifications.get(key) === pending) verifications.delete(key);
  });
  return pending;
}

function tokenFromLocation(search: URLSearchParams): string | null {
  return search.get('token') ?? new URLSearchParams(window.location.hash.slice(1)).get('token');
}

type VerifyState =
  | { kind: 'verifying' }
  | { kind: 'confirm'; emailHint: string; sending: boolean }
  | { kind: 'done' }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string };

/** Where a completed sign-in returns to: the saved project, when its path is a safe one. */
function returnPathOf(result: VerifyMagicLinkSignedIn): string | null {
  return result.returnTo && RelativePathSchema.safeParse(result.returnTo).success
    ? result.returnTo
    : null;
}

function failureState(failure: unknown): VerifyState {
  if (isApiError(failure) && failure.code === 'VALIDATION_FAILED') return { kind: 'invalid' };
  return { kind: 'error', message: presentError(failure)?.message ?? t('error.unknown') };
}

/**
 * `/auth/verify`: the magic-link landing. It verifies the token, attaches the session's
 * projects to the account and returns to the project the person saved. A link opened in a
 * browser other than the one that asked for it first asks "Sign in as t•••@example.com?";
 * "Not me" leaves without using the link.
 */
export function VerifyPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = tokenFromLocation(params);
  const [state, setState] = useState<VerifyState>(
    token ? { kind: 'verifying' } : { kind: 'invalid' },
  );
  /** Bumped by "Try again" to run the verification once more. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!token) return;
    let active = true;
    verifyOnce(token, false)
      .then((result) => {
        if (!active) return;
        if (isVerifyConfirmationRequired(result)) {
          setState({ kind: 'confirm', emailHint: result.emailHint, sending: false });
          return;
        }
        setState({ kind: 'done' });
        const returnTo = returnPathOf(result);
        if (returnTo) navigate(returnTo, { replace: true, state: { saved: true } });
      })
      .catch((failure: unknown) => {
        if (active) setState(failureState(failure));
      });
    return () => {
      active = false;
    };
  }, [token, navigate, attempt]);

  function retry() {
    setState({ kind: 'verifying' });
    setAttempt((n) => n + 1);
  }

  function confirm() {
    if (!token || state.kind !== 'confirm' || state.sending) return;
    setState({ ...state, sending: true });
    verifyOnce(token, true)
      .then((result) => {
        if (isVerifyConfirmationRequired(result)) {
          setState(failureState(null));
          return;
        }
        setState({ kind: 'done' });
        const returnTo = returnPathOf(result);
        if (returnTo) navigate(returnTo, { replace: true, state: { saved: true } });
      })
      .catch((failure: unknown) => setState(failureState(failure)));
  }

  function notMe() {
    navigate('/', { replace: true });
  }

  return (
    <PageShell title={t('pageTitle.signIn')}>
      <section className="container container--narrow simple-page stack" aria-live="polite">
        {state.kind === 'verifying' ? (
          <>
            <h1 className="title-section">{t('auth.verifying')}</h1>
            <div className="indeterminate" aria-hidden="true" />
          </>
        ) : null}
        {state.kind === 'done' ? (
          <>
            <h1 className="title-section">{t('auth.signedIn')}</h1>
            <p className="lede">
              <TextWithLink text={t('save.done')} linkText={t('places.title')} to="/places" />
            </p>
            <Link to="/places" className="button button--primary">
              {t('places.title')}
            </Link>
          </>
        ) : null}
        {state.kind === 'invalid' ? (
          <>
            <h1 className="title-section">{t('auth.linkInvalid')}</h1>
            <div className="card">
              <SaveForm returnTo="/places" />
            </div>
            <Link to="/" className="link-button">
              {t('common.backHome')}
            </Link>
          </>
        ) : null}
        {state.kind === 'error' ? (
          <>
            <p className="message message--error" role="alert">
              {state.message}
            </p>
            <button type="button" className="button button--primary" onClick={retry}>
              {t('common.tryAgain')}
            </button>
          </>
        ) : null}
      </section>
      {state.kind === 'confirm' ? (
        <Sheet title={t('auth.confirmHeading', { emailHint: state.emailHint })} onClose={notMe}>
          <p className="lede">{t('auth.confirmBody')}</p>
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              aria-disabled={state.sending || undefined}
              onClick={confirm}
            >
              {t('auth.confirmContinue')}
            </button>
            <button type="button" className="button button--quiet" onClick={notMe}>
              {t('auth.confirmNotMe')}
            </button>
          </div>
        </Sheet>
      ) : null}
    </PageShell>
  );
}
