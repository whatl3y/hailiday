import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Me } from '@hailiday/core';
import { deleteMe, getMe, logout, resetSession } from '../../api/endpoints';
import { presentError } from '../../api/present';
import { t } from '../../copy';
import { clearOwnerLocalState } from '../../state/ownerState';
import { PageShell } from '../../ui/Layout';
import { Sheet } from '../../ui/Sheet';
import './account.css';

/** `/account`: email, sign out and account deletion. */
export function AccountPage() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let active = true;
    getMe()
      .then((result) => {
        if (active) setMe(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(presentError(failure)?.message ?? t('error.unknown'));
      });
    return () => {
      active = false;
    };
  }, []);

  async function signOut() {
    try {
      await logout();
      clearOwnerLocalState();
      resetSession();
      navigate('/');
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
    }
  }

  async function removeAccount() {
    setConfirming(false);
    try {
      await deleteMe();
      clearOwnerLocalState();
      resetSession();
      navigate('/');
    } catch (failure) {
      setError(presentError(failure)?.message ?? t('error.unknown'));
    }
  }

  return (
    <PageShell title={t('account.title')}>
      <section className="container container--narrow simple-page stack stack--loose">
        <h1 className="simple-page__title">{t('account.title')}</h1>
        {error ? (
          <p className="message message--error" role="alert">
            {error}
          </p>
        ) : null}
        {me === null && !error ? <div className="indeterminate" aria-hidden="true" /> : null}
        {me && !me.user ? <p className="lede">{t('account.signedOut')}</p> : null}
        {me?.user ? (
          <div className="card stack account__card">
            <p className="eyebrow">{t('account.emailLabel')}</p>
            <p className="account__email">{me.user.email}</p>
            <div className="row account__actions">
              <Link to="/places" className="button button--small button--quiet">
                {t('places.title')}
              </Link>
              <button
                type="button"
                className="button button--small button--quiet"
                onClick={() => void signOut()}
              >
                {t('account.signOut')}
              </button>
              <button
                type="button"
                className="button button--small button--quiet account__delete"
                onClick={() => setConfirming(true)}
              >
                {t('account.delete')}
              </button>
            </div>
          </div>
        ) : null}
      </section>
      {confirming ? (
        <Sheet title={t('account.delete')} hideTitle onClose={() => setConfirming(false)}>
          <p className="lede">{t('account.deleteConfirm')}</p>
          <div className="row">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void removeAccount()}
            >
              {t('delete.yes')}
            </button>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </button>
          </div>
        </Sheet>
      ) : null}
    </PageShell>
  );
}
