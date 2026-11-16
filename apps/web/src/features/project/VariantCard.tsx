import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { CompareMode, HolidayId, Project, Variant } from '@hailiday/core';
import { analytics } from '../../analytics';
import { sceneTypeLabel, t } from '../../copy';
import { useAppStore } from '../../state/appStore';
import { useProjectStore } from '../../state/projectStore';
import { StreetViewAttribution } from '../../ui/Attribution';
import { FixtureBadge, ImageCorner } from '../../ui/ImageCard';
import { aiBadgeCorner, isStreetViewVariant } from '../../ui/badgeCorner';
import { useIsFixtureImage, useIsFixtureStreetView } from '../../ui/fixture';
import { useReducedMotion } from '../../ui/motion';
import { CompareSlider } from './CompareSlider';
import { generatedAlt } from './generatedAlt';
import { lookLabel, offeredForHoliday } from './looks';
import { PictureStage } from './SourceImage';

/** How long the photo rests on screen before the divider sweeps to the AI preview. */
export const REVEAL_HOLD_MS = 700;
/** The reveal starts even if the preview's load event never arrives. */
export const REVEAL_FALLBACK_MS = 2600;
/** The sweep's length (`--dur-reveal`) plus a margin: the sweep ends even without its event. */
export const SWEEP_MS = 1200;

/** Variants already displayed in this page session (a later display is a cached view). */
const viewedVariants = new Set<string>();

/**
 * A divider sweep across the picture: `reveal` uncovers the first preview over the photo,
 * `change` uncovers a look that arrived while the person watched over the one it replaces.
 */
type Sweep = 'reveal' | 'change';

export interface VariantCardProps {
  variant: Variant;
  project: Project;
  /** The project's first preview: open on the photo, then sweep the divider to the AI preview. */
  reveal?: boolean;
  /** A new look is being decorated: a sheen crosses the picture and the light string hangs over it. */
  pending?: boolean;
  /** The holiday of the look being made, whose colours the light string wears. */
  stringHoliday?: HolidayId | null;
  /** The status card of the look being made, hung on the stage when the screen has room. */
  stageCard?: ReactNode;
  /** At the start of the row under the stage on phones (Cancel while another look is made). */
  controlsStart?: ReactNode;
  /** Laid over the title while a new look is decorated (the status card as a band). */
  bar?: ReactNode;
  /** The screen's title, on the line under the picture. */
  heading?: ReactNode;
  /** The action row at the end of the title line. */
  actions?: ReactNode;
  /** Everything under the title line, on paper. */
  children?: ReactNode;
}

/**
 * The result picture on a stage that fills the first viewport: before and after at the same
 * rendered size, the Before / AI preview switch in the stage's upper right corner (always
 * present), the comparison slider on the picture, and the "AI preview" badge on the generated
 * layer (lower-right for uploads; upper-left for Street View frames, whose burned-in logo and
 * copyright hold both lower corners, where it moves along the top with the divider). Under the
 * stage, on paper: the caption line (the attribution or "Your photo", and the look's label), then
 * the title with the action row.
 *
 * A look that arrives while the person watches is revealed by the divider sweeping once across
 * the picture; a look chosen from those already made replaces the current one with a short
 * crossfade. Under reduced motion both are instant swaps.
 */
export function VariantCard({
  variant,
  project,
  reveal = false,
  pending = false,
  stringHoliday = null,
  stageCard,
  controlsStart,
  bar,
  heading,
  actions,
  children,
}: VariantCardProps) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(variant);
  const [outgoing, setOutgoing] = useState<{ variant: Variant; wipe: boolean } | null>(null);
  /** Percentage of the width, from the left, that shows the before photo. */
  const [value, setValue] = useState(0);
  const [revealDone, setRevealDone] = useState(() => !reveal);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  // Under reduced motion the reveal is an instant swap.
  const revealed = revealDone || reducedMotion;
  const [afterLoaded, setAfterLoaded] = useState(false);
  const comparedFor = useRef<string | null>(null);
  // Whether a new look was being decorated at the previous render: the look that replaces the
  // current one then arrived while the person watched.
  const [wasPending, setWasPending] = useState(pending);

  if (variant.renderAssetId !== shown.renderAssetId) {
    const arrived = wasPending && !reducedMotion;
    setOutgoing(reducedMotion ? null : { variant: shown, wipe: arrived });
    setSweep(arrived ? 'change' : null);
    setShown(variant);
    setValue(0);
    setRevealDone(true);
  }
  if (pending !== wasPending) setWasPending(pending);

  useEffect(() => {
    if (revealed) return;
    const timer = window.setTimeout(
      () => {
        setRevealDone(true);
        setSweep('reveal');
      },
      afterLoaded ? REVEAL_HOLD_MS : REVEAL_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [revealed, afterLoaded]);

  // The sweep ends on its animation's end, or after its length when no event arrives.
  useEffect(() => {
    if (!sweep) return;
    const timer = window.setTimeout(() => endSweep(), SWEEP_MS);
    return () => window.clearTimeout(timer);
  }, [sweep]);

  function endSweep() {
    setSweep(null);
    setOutgoing((current) => (current?.wipe ? null : current));
  }

  const source = project.activeSource;
  // The project's active source describes this variant only when the variant was made from it.
  const ownSource = source && source.sourceAssetId === shown.sourceAssetId ? source : null;
  const isStreetView = isStreetViewVariant(shown, source);
  const beforeUrl = shown.beforeImageUrl ?? ownSource?.displayUrl ?? null;
  const generatedFixture = useIsFixtureImage('generated');
  const beforeFixture = useIsFixtureImage(isStreetView ? 'street_view' : 'photo', {
    url: beforeUrl,
    sourceKind: ownSource?.kind,
  });
  const fixtureStreetView = useIsFixtureStreetView(ownSource?.kind);
  const storeOffered = useProjectStore((state) => state.offered);
  const holidays = useAppStore((state) => state.experience?.holidays ?? null);

  useEffect(() => {
    const id = shown.renderAssetId;
    const cached = viewedVariants.has(id);
    viewedVariants.add(id);
    analytics.track(
      'variant_viewed',
      { cached, style: shown.style, lightingMode: shown.lightingMode },
      {
        holidayId: shown.holidayId,
        sceneType: project.sceneType,
        sourceKind: source?.kind ?? null,
      },
    );
  }, [shown, project.sceneType, source?.kind]);

  function compare(next: number, mode: CompareMode) {
    setRevealDone(true);
    if (sweep === 'reveal') setSweep(null);
    setValue(next);
    if (comparedFor.current !== shown.renderAssetId) {
      comparedFor.current = shown.renderAssetId;
      analytics.track('compare_used', { mode }, { holidayId: shown.holidayId });
    }
  }

  // Until the reveal, the photo is shown fully; afterwards the slider value decides.
  const beforePercent = revealed ? value : 100;
  const beforeVisible = beforeUrl !== null && beforePercent > 0;
  const afterVisible = beforePercent < 100 || beforeUrl === null;
  // The badge and the handle arrive once the reveal's sweep has crossed the picture.
  const settled = revealed && sweep !== 'reveal';
  const scene = project.sceneType
    ? sceneTypeLabel(project.sceneType, project.roomType)
    : t('scene.label.room');
  const offered = offeredForHoliday({
    holidayId: shown.holidayId,
    projectHolidayId: project.holidayId,
    projectOffered: storeOffered ?? project.offered,
    sceneType: project.sceneType,
    holidays: holidays ?? [],
  });
  const label = lookLabel(shown, offered.lightingModes);
  const frameStyle = { '--before': `${beforePercent}%` } as CSSProperties;

  const toggle = beforeUrl ? (
    <div
      className="segmented segmented--on-stage variant__toggle"
      role="group"
      aria-label={t('result.compareLabel')}
    >
      <button
        type="button"
        aria-pressed={beforePercent === 100}
        onClick={() => compare(100, 'toggle')}
      >
        {t('result.before')}
      </button>
      <button type="button" aria-pressed={beforePercent === 0} onClick={() => compare(0, 'toggle')}>
        {t('result.aiPreview')}
      </button>
    </div>
  ) : null;

  return (
    <PictureStage
      width={shown.width}
      height={shown.height}
      ambientSrc={shown.imageUrl}
      overlay={toggle}
      reserveControls
      pending={pending}
      stringHoliday={stringHoliday}
      stageCard={stageCard}
      controlsStart={controlsStart}
      markUpperLeft={isStreetView}
      className={isStreetView ? 'variant variant--street-view' : 'variant'}
      picture={
        <div
          className="compare"
          style={frameStyle}
          data-split={(beforePercent > 0 && beforePercent < 100) || undefined}
          data-sweep={sweep ?? undefined}
        >
          {beforeUrl ? (
            <img
              className="compare__before"
              src={beforeUrl}
              width={shown.width}
              height={shown.height}
              alt={
                isStreetView
                  ? t('result.streetViewAlt')
                  : t('upload.previewAlt', { sceneTypeLabel: scene })
              }
              aria-hidden={!beforeVisible || undefined}
              draggable={false}
            />
          ) : null}
          <div
            className="compare__after"
            data-revealed={revealed || undefined}
            data-instant={reducedMotion || undefined}
          >
            <img
              src={shown.imageUrl}
              width={shown.width}
              height={shown.height}
              alt={generatedAlt(shown, scene)}
              aria-hidden={!afterVisible || undefined}
              draggable={false}
              onLoad={() => setAfterLoaded(true)}
            />
            {outgoing ? (
              <img
                key={outgoing.variant.renderAssetId}
                className="compare__outgoing"
                data-wipe={outgoing.wipe || undefined}
                src={outgoing.variant.imageUrl}
                alt=""
                aria-hidden="true"
                draggable={false}
                onAnimationEnd={() => setOutgoing(null)}
              />
            ) : null}
            {/* Clipped with the generated pixels, so it never labels the before photo; the
                stylesheet keeps an upper-left badge just right of the divider, along the top
                edge, where no burned-in credit sits. */}
            {afterVisible && settled ? <ImageCorner corner={aiBadgeCorner(isStreetView)} /> : null}
          </div>
          {isStreetView ? (
            // The upper-left corner belongs to the "AI preview" badge, so a Street View frame
            // shows one fixture badge at the upper right for whichever layer is fixture evidence.
            <div className="image-card__badges">
              <span />
              <span>
                {(beforeVisible && beforeFixture) ||
                (afterVisible && generatedFixture && settled) ? (
                  <FixtureBadge />
                ) : null}
              </span>
            </div>
          ) : (
            <div className="image-card__badges">
              <span>{beforeVisible && beforeFixture ? <FixtureBadge /> : null}</span>
              <span>{afterVisible && generatedFixture && settled ? <FixtureBadge /> : null}</span>
            </div>
          )}
          {sweep ? (
            <span
              className="compare__sweep"
              aria-hidden="true"
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) endSweep();
              }}
            />
          ) : null}
          {beforeUrl && settled && sweep === null ? (
            <CompareSlider value={value} onChange={(next, mode) => compare(next, mode)} />
          ) : null}
        </div>
      }
      caption={
        isStreetView ? (
          <StreetViewAttribution
            text={shown.attribution?.text || ownSource?.copyright || null}
            logo={shown.attribution ? shown.attribution.logo : 'google_maps'}
            captureDate={ownSource?.captureDate ?? null}
            showCaptureDate={ownSource !== null}
            fixture={fixtureStreetView}
          />
        ) : (
          <span>{t('result.yourPhoto')}</span>
        )
      }
      captionEnd={<span className="variant__label">{label}</span>}
    >
      {heading || actions || bar ? (
        <div className="picture-head variant__head">
          <div className="picture-head__title">
            {heading}
            {bar}
          </div>
          {actions}
        </div>
      ) : null}
      {children}
    </PictureStage>
  );
}
