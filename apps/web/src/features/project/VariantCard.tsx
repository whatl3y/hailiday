import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { CompareMode, Project, Variant } from '@holiday/core';
import { analytics } from '../../analytics';
import { holidayName, lightingLabel, sceneTypeLabel, styleLabel, t } from '../../copy';
import { StreetViewAttribution } from '../../ui/Attribution';
import { FixtureBadge, ImageCorner } from '../../ui/ImageCard';
import { aiBadgeCorner, isStreetViewVariant } from '../../ui/badgeCorner';
import { useIsFixtureImage, useIsFixtureStreetView } from '../../ui/fixture';
import { useReducedMotion } from '../../ui/motion';
import { CompareSlider } from './CompareSlider';
import { generatedAlt } from './generatedAlt';

/** How long the photo rests on screen before the reveal crossfade starts. */
export const REVEAL_HOLD_MS = 700;
/** The reveal starts even if the preview's load event never arrives. */
export const REVEAL_FALLBACK_MS = 2600;

/** Variants already displayed in this page session (a later display is a cached view). */
const viewedVariants = new Set<string>();

export interface VariantCardProps {
  variant: Variant;
  project: Project;
  /** The project's first preview: open on the photo, then crossfade to the AI preview. */
  reveal?: boolean;
  /** Shown beside the comparison toggle (the pending band while a new look is decorated). */
  bar?: ReactNode;
}

/**
 * The result card: before and after at the same rendered size, the Before / AI preview toggle
 * (always present), the comparison slider on the image, the "AI preview" badge pinned to a lower
 * corner of the generated layer (lower-left for Street View frames, whose burned-in credit
 * holds the lower-right corner; the before photo covers it with the generated pixels in a
 * split) and the strip beneath the image with the
 * attribution or "Your photo" and the look's label. The first preview arrives as a reveal; a
 * later look replaces the current one with a short crossfade. Under reduced motion both are
 * instant swaps.
 */
export function VariantCard({ variant, project, reveal = false, bar }: VariantCardProps) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(variant);
  const [outgoing, setOutgoing] = useState<Variant | null>(null);
  /** Percentage of the width, from the left, that shows the before photo. */
  const [value, setValue] = useState(0);
  const [revealDone, setRevealDone] = useState(() => !reveal);
  // Under reduced motion the reveal is an instant swap.
  const revealed = revealDone || reducedMotion;
  const [afterLoaded, setAfterLoaded] = useState(false);
  const comparedFor = useRef<string | null>(null);

  if (variant.renderAssetId !== shown.renderAssetId) {
    setOutgoing(reducedMotion ? null : shown);
    setShown(variant);
    setValue(0);
    setRevealDone(true);
  }

  useEffect(() => {
    if (revealed) return;
    const timer = window.setTimeout(
      () => setRevealDone(true),
      afterLoaded ? REVEAL_HOLD_MS : REVEAL_FALLBACK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [revealed, afterLoaded]);

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
  const scene = project.sceneType
    ? sceneTypeLabel(project.sceneType, project.roomType)
    : t('scene.label.room');
  const label = t('result.holidayLabel', {
    holiday: holidayName(shown.holidayId),
    style: styleLabel(shown.style),
    lighting: lightingLabel(shown.lightingMode),
  });
  const frameStyle = {
    '--frame-ratio': String(shown.width / shown.height),
    '--before': `${beforePercent}%`,
  } as CSSProperties;

  return (
    <div className="variant">
      <div className="variant__bar">
        {beforeUrl ? (
          <div
            className="segmented variant__toggle"
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
            <button
              type="button"
              aria-pressed={beforePercent === 0}
              onClick={() => compare(0, 'toggle')}
            >
              {t('result.aiPreview')}
            </button>
          </div>
        ) : null}
        {bar}
      </div>
      <figure className="image-card variant-card">
        <div
          className="image-card__frame compare"
          style={frameStyle}
          data-split={(beforePercent > 0 && beforePercent < 100) || undefined}
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
              onLoad={() => setAfterLoaded(true)}
            />
            {outgoing ? (
              <img
                key={outgoing.renderAssetId}
                className="compare__outgoing"
                src={outgoing.imageUrl}
                alt=""
                aria-hidden="true"
                onAnimationEnd={() => setOutgoing(null)}
              />
            ) : null}
            {/* Pinned to its corner and clipped with the generated pixels: it never moves
                onto burned-in credit and never labels the before photo. */}
            {afterVisible && revealed ? <ImageCorner corner={aiBadgeCorner(isStreetView)} /> : null}
          </div>
          <div className="image-card__badges">
            <span>{beforeVisible && beforeFixture ? <FixtureBadge /> : null}</span>
            <span>{afterVisible && generatedFixture && revealed ? <FixtureBadge /> : null}</span>
          </div>
          {beforeUrl && revealed ? (
            <CompareSlider value={value} onChange={(next, mode) => compare(next, mode)} />
          ) : null}
        </div>
        <figcaption className="image-card__strip">
          {isStreetView ? (
            <StreetViewAttribution
              text={shown.attribution?.text || ownSource?.copyright || null}
              logo={shown.attribution ? shown.attribution.logo : 'google_maps'}
              captureDate={ownSource?.captureDate ?? null}
              showCaptureDate={ownSource !== null}
              fixture={fixtureStreetView}
            />
          ) : (
            <span>{t('result.yourPhoto')}</span>
          )}
          <span className="variant__label">{label}</span>
        </figcaption>
      </figure>
    </div>
  );
}
