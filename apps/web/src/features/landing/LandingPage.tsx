import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { t } from '../../copy';
import { ensureSession } from '../../api/endpoints';
import { syncExperienceWithSelection } from '../../experience/load';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import { BudgetBanner, PageShell } from '../../ui/Layout';
import { HolidayChip, HolidayOptions } from '../../ui/HolidayPicker';
import { chooseHolidayExplicitly, useHolidayTheme } from '../../ui/holidaySelection';
import { Icon } from '../../ui/Icon';
import { AddressCombobox } from '../address/AddressCombobox';
import { ManualEntry } from '../address/ManualEntry';
import { useResolveAddress } from '../address/useResolveAddress';
import { LandingHero } from './LandingHero';
import { serverPanelShown } from './serverHero';
import { TextWithLink } from '../../ui/TextWithLink';
import { CLIENT_DEFAULTS } from '../../config/values';
import './landing.css';

/** Projects older than this are past the anonymous retention window. */
const CONTINUE_WINDOW_MS = 24 * 60 * 60 * 1000;

function ContinueBanner() {
  const lastProject = useAppStore((state) => state.lastProject);
  const [now] = useState(() => Date.now());
  if (!lastProject || now - lastProject.at > CONTINUE_WINDOW_MS) return null;
  return (
    <Link className="landing__continue" to={`/p/${lastProject.id}`}>
      <span>{t('landing.continueBanner')}</span>
      <Icon name="arrowRight" />
    </Link>
  );
}

export function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const headingId = useId();
  const pickerId = useId();
  const experience = useAppStore((state) => state.experience);
  const status = useAppStore((state) => state.experienceStatus);
  const holidayId = useAppStore(currentHolidayId);
  const offSeason = useAppStore(isOffSeason);
  const chosen = useAppStore(hasChosenHoliday);
  const openSheet = useAppStore((state) => state.openSheet);
  const [manual, setManual] = useState(false);
  const resolver = useResolveAddress();
  const focusAddress = Boolean((location.state as { focusAddress?: boolean } | null)?.focusAddress);
  // Read before the hero retires the server region during the first commit.
  const [continuesServerPanel] = useState(serverPanelShown);

  useHolidayTheme(holidayId);

  useEffect(() => {
    syncExperienceWithSelection();
  }, [holidayId, status]);

  const minChars =
    experience?.clientConfig.autocompleteMinChars ?? CLIENT_DEFAULTS.autocompleteMinChars;
  const debounceMs =
    experience?.clientConfig.autocompleteDebounceMs ?? CLIENT_DEFAULTS.autocompleteDebounceMs;
  const holiday = experience?.holidays.find((item) => item.id === holidayId) ?? null;
  const showInvite = holiday?.journeyEmphasis === 'interior' && holiday.inWindow;
  const hasExamples = (experience?.examples.length ?? 0) > 0;
  const pickerOpen = offSeason && !chosen;

  return (
    <PageShell
      overlayHeader
      hideBanner
      headerEnd={<HolidayChip surface="landing" onPhoto />}
      beforeMain={<LandingHero hero={experience?.hero ?? null} />}
    >
      <div className="landing">
        <section
          className="landing__panel"
          aria-labelledby={headingId}
          data-continues={continuesServerPanel || undefined}
        >
          <ContinueBanner />
          <BudgetBanner />
          <h1 id={headingId} className="landing__headline">
            {t('landing.headline')}
          </h1>
          <p className="landing__subhead">
            {pickerOpen ? t('landing.subheadOffSeason') : t('landing.subhead')}
          </p>

          {pickerOpen ? (
            <div className="landing__picker">
              <p id={pickerId} className="eyebrow">
                {t('landing.chooseHoliday')}
              </p>
              <HolidayOptions
                compact
                selected={holidayId}
                labelledBy={pickerId}
                onChoose={(id) => chooseHolidayExplicitly(id, 'landing')}
              />
            </div>
          ) : null}

          {status === 'error' ? (
            <p className="message message--error" role="alert">
              {t('landing.unavailable')}
            </p>
          ) : null}

          <div
            className="landing__address"
            onFocusCapture={() => void ensureSession().catch(() => undefined)}
          >
            {manual ? (
              <ManualEntry
                busy={resolver.busy}
                onChoose={(candidate) => void resolver.resolveCandidate(candidate)}
                onCancel={() => setManual(false)}
              />
            ) : (
              <>
                <AddressCombobox
                  label={t('landing.addressLabel')}
                  placeholder={t('landing.addressPlaceholder')}
                  minChars={minChars}
                  debounceMs={debounceMs}
                  busy={resolver.busy}
                  message={resolver.message}
                  autoFocus={focusAddress}
                  onSelect={(selection) => void resolver.resolveSuggestion(selection)}
                />
                <div className="landing__routes">
                  <button
                    type="button"
                    className="link-button landing__manual"
                    onClick={() => setManual(true)}
                  >
                    {t('address.manualEntry')}
                  </button>
                  <button
                    type="button"
                    className="link-button landing__upload-inline"
                    onClick={() => navigate('/upload')}
                  >
                    {t('landing.uploadInline')}
                  </button>
                </div>
              </>
            )}
            {manual && resolver.message ? (
              <p className="message message--error" role="alert">
                {resolver.message.text}
              </p>
            ) : null}
          </div>

          <p className="landing__age">
            <TextWithLink text={t('landing.ageLine')} linkText={t('footer.terms')} to="/terms" />
          </p>

          {showInvite ? <p className="landing__invite">{t('landing.thanksgivingInvite')}</p> : null}

          <div className="landing__secondary">
            <button
              type="button"
              className="button landing__upload"
              onClick={() => navigate('/upload')}
            >
              <Icon name="photo" />
              {t('landing.uploadInstead')}
            </button>
            {hasExamples ? (
              <button
                type="button"
                className="link-button"
                onClick={() => openSheet({ kind: 'examples' })}
              >
                {t('landing.seeExample')}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </PageShell>
  );
}
