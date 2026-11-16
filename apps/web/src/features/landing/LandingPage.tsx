import { Fragment, useEffect, useId, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { t } from '../../copy';
import { useTimeBasedDeletion } from '../../copy/retention';
import { ensureSession } from '../../api/endpoints';
import { syncExperienceWithSelection } from '../../experience/load';
import { currentHolidayId, hasChosenHoliday, isOffSeason, useAppStore } from '../../state/appStore';
import { ExampleGallery } from '../../ui/Examples';
import { HeroDock } from '../../ui/HeroFrame';
import { BudgetBanner, PageShell } from '../../ui/Layout';
import { HolidayChip, HolidayOptions } from '../../ui/HolidayPicker';
import { chooseHolidayExplicitly, useHolidayTheme } from '../../ui/holidaySelection';
import { Icon } from '../../ui/Icon';
import { useIsFixtureAddressLookup } from '../../ui/fixture';
import { AddressCombobox } from '../address/AddressCombobox';
import { ManualEntry } from '../address/ManualEntry';
import { useResolveAddress } from '../address/useResolveAddress';
import { LandingHero } from './LandingHero';
import { serverDriftElapsed, serverPanelShown, serverRiseElapsed } from './serverHero';
import { TextWithLink } from '../../ui/TextWithLink';
import { CLIENT_DEFAULTS } from '../../config/values';
import './landing.css';

/**
 * While time-based deletion is on, a project left alone this long is past the anonymous
 * retention window, so the landing stops offering to continue it.
 */
const CONTINUE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How many examples the landing shows below the first viewport; the sheet holds the rest. */
const LANDING_EXAMPLES = 4;

/** Phones: the content block sits at the top and the suggestions open downward. */
const PHONE_QUERY = '(max-width: 599px)';

/**
 * On phones, focusing the address field lifts it to the top of the screen, so the field and the
 * first suggestions below it stay clear of the on-screen keyboard.
 */
function liftFieldOnPhones(target: EventTarget) {
  if (!(target instanceof HTMLInputElement) || !target.classList.contains('combo__input')) return;
  if (typeof window.matchMedia !== 'function' || !window.matchMedia(PHONE_QUERY).matches) return;
  const combo = target.closest('.combo');
  if (!combo || typeof combo.scrollIntoView !== 'function') return;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  requestAnimationFrame(() =>
    combo.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' }),
  );
}

/** The separator the eyebrow copy uses between its parts. */
const EYEBROW_SEPARATOR = ' · ';

/**
 * The link back to the last project, a pill on the photograph. While nothing is deleted by age it
 * stays for as long as the project is remembered; with time-based deletion on it goes after the
 * retention window. The server cannot know it, so it sits where it moves nothing: above the
 * bottom-anchored block on wide screens, after the dock on phones.
 */
function ContinueBanner() {
  const lastProject = useAppStore((state) => state.lastProject);
  const timeBasedDeletion = useTimeBasedDeletion();
  const [now] = useState(() => Date.now());
  if (!lastProject) return null;
  if (timeBasedDeletion && now - lastProject.at > CONTINUE_WINDOW_MS) return null;
  return (
    <Link className="landing__continue" to={`/p/${lastProject.id}`}>
      <span>{t('landing.continueBanner')}</span>
      <Icon name="arrowRight" />
    </Link>
  );
}

/** The eyebrow line, with quiet separators between its parts. */
function Eyebrow() {
  const parts = t('landing.eyebrow').split(EYEBROW_SEPARATOR);
  return (
    <p className="eyebrow landing__eyebrow">
      {parts.map((part, index) => (
        <Fragment key={part}>
          {index > 0 ? (
            <span className="sep" aria-hidden="true">
              ·
            </span>
          ) : null}
          <span>{part}</span>
        </Fragment>
      ))}
    </p>
  );
}

/**
 * Where the app continues a server-painted landing: the server's entrance progress, carried
 * on the landing so the app's blocks pick it up instead of rising a second time.
 */
interface ServerContinuation {
  panel: boolean;
  elapsedMs: number;
  /** How far the server photograph's drift has played. */
  driftMs: number;
}

function readServerContinuation(): ServerContinuation {
  const panel = serverPanelShown();
  return {
    panel,
    elapsedMs: panel ? serverRiseElapsed() : 0,
    driftMs: serverDriftElapsed(),
  };
}

export function LandingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const headingId = useId();
  const pickerId = useId();
  const examplesId = useId();
  const experience = useAppStore((state) => state.experience);
  const status = useAppStore((state) => state.experienceStatus);
  const holidayId = useAppStore(currentHolidayId);
  const offSeason = useAppStore(isOffSeason);
  const chosen = useAppStore(hasChosenHoliday);
  const openSheet = useAppStore((state) => state.openSheet);
  const [manual, setManual] = useState(false);
  const resolver = useResolveAddress();
  const sampleAddresses = useIsFixtureAddressLookup();
  const focusAddress = Boolean((location.state as { focusAddress?: boolean } | null)?.focusAddress);
  // Read before the hero frame retires the server region during the first commit.
  const [server] = useState(readServerContinuation);

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
  const frameStyle = {
    ...(server.panel ? { '--rise-elapsed': `${server.elapsedMs}ms` } : {}),
    ...(server.driftMs > 0 ? { '--drift-elapsed': `${server.driftMs}ms` } : {}),
  } as CSSProperties;

  return (
    <PageShell tone="photo" hideBanner headerEnd={<HolidayChip surface="landing" />}>
      <div className="landing">
        <LandingHero hero={experience?.hero ?? null} style={frameStyle}>
          <section
            className="landing__panel"
            aria-labelledby={headingId}
            data-continues={server.panel || undefined}
          >
            <BudgetBanner />
            <Eyebrow />
            <h1 id={headingId} className="landing__headline">
              {t('landing.headline')}
            </h1>
            <HeroDock className="landing__dock">
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
                onFocusCapture={(event) => {
                  void ensureSession().catch(() => undefined);
                  liftFieldOnPhones(event.target);
                }}
              >
                {manual ? (
                  <ManualEntry
                    busy={resolver.busy}
                    onChoose={(candidate) => void resolver.resolveCandidate(candidate)}
                    onCancel={() => setManual(false)}
                  />
                ) : (
                  <AddressCombobox
                    label={t('landing.addressLabel')}
                    placeholder={t('landing.addressPlaceholder')}
                    minChars={minChars}
                    debounceMs={debounceMs}
                    busy={resolver.busy}
                    message={resolver.message}
                    autoFocus={focusAddress}
                    sampleMode={sampleAddresses}
                    placement="above"
                    onSelect={(selection) => void resolver.resolveSuggestion(selection)}
                  />
                )}
                {manual && resolver.message ? (
                  <p className="message message--error" role="alert">
                    {resolver.message.text}
                  </p>
                ) : null}
                <div className="landing__routes">
                  {manual ? null : (
                    <button
                      type="button"
                      className="link-button landing__manual"
                      onClick={() => setManual(true)}
                    >
                      {t('address.manualEntry')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="link-button landing__upload"
                    onClick={() => navigate('/upload')}
                  >
                    {manual ? t('landing.uploadInstead') : t('landing.uploadInline')}
                  </button>
                  {hasExamples ? (
                    <button
                      type="button"
                      className="link-button landing__example"
                      onClick={() => openSheet({ kind: 'examples' })}
                    >
                      {t('landing.seeExample')}
                    </button>
                  ) : null}
                </div>
              </div>

              <p className="landing__age">
                <TextWithLink
                  text={t('landing.ageLine')}
                  linkText={t('footer.terms')}
                  to="/terms"
                />
              </p>

              {showInvite ? (
                <p className="landing__invite">{t('landing.thanksgivingInvite')}</p>
              ) : null}
            </HeroDock>
            <ContinueBanner />
          </section>
        </LandingHero>

        {hasExamples ? (
          <section className="landing__examples" aria-labelledby={examplesId}>
            <h2 id={examplesId} className="landing__examples-title">
              {t('landing.examplesTitle')}
            </h2>
            <p className="landing__examples-lede">{t('landing.examplesLede')}</p>
            <ExampleGallery holidayId={holidayId} limit={LANDING_EXAMPLES} />
          </section>
        ) : null}
      </div>
    </PageShell>
  );
}
