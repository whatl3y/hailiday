import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { AttributionLogo, Candidate, HolidayId, Project } from '@hailiday/core';
import { t } from '../../copy';
import { StreetViewAttribution } from '../../ui/Attribution';
import { FixtureBadge } from '../../ui/ImageCard';
import { useIsFixtureImage, useIsFixtureStreetView } from '../../ui/fixture';
import { LightString } from '../../ui/LightString';
import { useReducedMotion } from '../../ui/motion';
import {
  CARD_TOP_BELOW_SWITCH,
  STATUS_CARD_WIDTH,
  STRING_TIERS,
  useStringTier,
} from '../../ui/stringGeometry';
import { Stage } from '../../ui/Stage';
import { stageStyle } from '../../ui/stageStyle';
import { useProjectStore } from '../../state/projectStore';
import {
  STREET_VIEW_WORKING_SIZE,
  streetViewLayoutSize,
  useControlsBelowStage,
} from './stageLayout';

/** The natural size used to reserve a source's stage when the source does not report one. */
const FALLBACK_SIZE = { width: 1024, height: 1024 };

/** The cross-fade from a source's picture to a new frame of the same source. */
export const SOURCE_FADE_MS = 400;

/**
 * A source's picture on the stage. When the source answers a new frame (a Street View frame
 * zoomed in on the home after the first look's framing step), the new picture loads under
 * cover and then cross-fades over the one on screen, at once under reduced motion. Both fill
 * the same box, so nothing moves. A new picture that fails to load leaves the old one.
 */
export function SourcePicture({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
}) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(src);
  const [failed, setFailed] = useState<string | null>(null);
  const [fading, setFading] = useState<string | null>(null);
  const incoming = src === shown || src === failed ? null : src;

  function settle(url: string) {
    setShown(url);
    setFading(null);
  }

  useEffect(() => {
    if (!fading || fading !== incoming) return;
    // The fade ends on its animation's end, or after its length when no event arrives.
    const timer = window.setTimeout(() => {
      setShown(fading);
      setFading(null);
    }, SOURCE_FADE_MS + 100);
    return () => window.clearTimeout(timer);
  }, [fading, incoming]);

  const layers = incoming ? [shown, incoming] : [shown];
  return (
    <>
      {layers.map((url) => {
        const coming = url === incoming;
        return (
          <img
            key={url}
            className={coming ? 'stage__image stage__image--incoming' : 'stage__image'}
            data-fading={(coming && fading === url) || undefined}
            src={url}
            alt={coming ? '' : alt}
            aria-hidden={coming || undefined}
            width={width}
            height={height}
            draggable={false}
            onLoad={
              coming
                ? () => {
                    if (reducedMotion) settle(url);
                    else setFading(url);
                  }
                : undefined
            }
            onError={coming ? () => setFailed(url) : undefined}
            onAnimationEnd={coming ? () => settle(url) : undefined}
          />
        );
      })}
    </>
  );
}

/**
 * A picture on a stage with its caption line on the paper directly beneath it (the attribution
 * or "Your photo"), then the screen's line under that: its title and its actions. The paper under
 * the stage lines up with the picture's edges. The stage's controls (`overlay`) rest in its upper
 * right corner from 600px wide; on phones they sit alone at the end of a row on the paper directly
 * under the picture, so nothing but the marks and the divider's handle lies on it. On phones that
 * row can also hold `controls` (shown there only), or be kept empty (`reserveControls`), so a
 * screen keeps its layout when another screen with a switch replaces it.
 *
 * While a look is being made (`pending`) a slow sheen crosses the picture and the light string
 * hangs along the stage's top edge, with the status card (`stageCard`) hung from it when the
 * screen has room; the marks at the picture's top edge move down below the string.
 */
export function PictureStage({
  width,
  height,
  ambientSrc,
  overlay,
  controls,
  reserveControls = false,
  picture,
  caption,
  captionEnd,
  pending = false,
  stringHoliday = null,
  stageCard,
  controlsStart,
  markUpperLeft = false,
  className,
  children,
}: {
  width: number;
  height: number;
  ambientSrc?: string | null;
  overlay?: ReactNode;
  /** Shown in the row under the stage on phones only (where a switch would sit). */
  controls?: ReactNode;
  /** Keep the row under the stage on phones even when it holds nothing. */
  reserveControls?: boolean;
  /** The picture layer on the stage. */
  picture: ReactNode;
  /** The start of the caption line: the attribution or "Your photo". */
  caption: ReactNode;
  /**
   * The end of the caption line (the look, or what is happening to the picture). A phone that
   * shows the row under the stage leaves it out: the row holds the controls alone, and the
   * screen's own lines already name the holiday, the look or what is happening.
   */
  captionEnd?: ReactNode;
  /** The picture is being decorated: a sheen crosses it and the light string hangs over it. */
  pending?: boolean;
  /**
   * The holiday of the look being made: the light string hangs along the stage's top edge in its
   * colours (null: warm white). Read only while `pending`.
   */
  stringHoliday?: HolidayId | null;
  /** The status card, hung from the string. The screen passes it only when the stage has room. */
  stageCard?: ReactNode;
  /** At the start of the row under the stage on phones (Cancel while another look is made). */
  controlsStart?: ReactNode;
  /**
   * The picture carries a mark at its upper left (the "AI preview" mark of a Street View look),
   * which the status card must not cover.
   */
  markUpperLeft?: boolean;
  className?: string;
  /** The screen's line and everything below it, on paper. */
  children?: ReactNode;
}) {
  const phone = useControlsBelowStage();
  const tierName = useStringTier();
  const tier = STRING_TIERS[tierName];
  const controlsBelow =
    phone && (Boolean(overlay) || Boolean(controls) || Boolean(controlsStart) || reserveControls);
  const classes = ['picture-screen', 'stage-scope'];
  if (controlsBelow) classes.push('picture-screen--controls-below');
  if (className) classes.push(className);
  // From 600px the card hangs lower when the picture carries a mark at its upper left, and
  // between 600 and 1023px also when the switch rests on the stage, so the card never meets them.
  const hangLow =
    tierName !== 'compact' &&
    !phone &&
    (markUpperLeft || (tierName === 'medium' && Boolean(overlay)));
  const cardTop = hangLow ? CARD_TOP_BELOW_SWITCH : tier.cardTop;
  const style: CSSProperties = stageStyle(width, height);
  if (pending) {
    Object.assign(style, { '--string-clear': `${tier.clear}px`, '--card-top': `${cardTop}px` });
  }
  return (
    <div className={classes.join(' ')} style={style} data-pending={pending || undefined}>
      <figure className="picture-screen__figure">
        <Stage
          width={width}
          height={height}
          ambientSrc={ambientSrc}
          overlay={phone ? undefined : overlay}
          top={
            pending ? (
              <>
                <LightString
                  holidayId={stringHoliday}
                  tier={tier}
                  hang={stageCard ? { width: STATUS_CARD_WIDTH, top: cardTop } : null}
                />
                {stageCard}
              </>
            ) : null
          }
        >
          {picture}
          {pending ? <span className="stage__sheen" aria-hidden="true" /> : null}
        </Stage>
        {controlsBelow ? (
          <div className="stage-controls">
            {controlsStart ? <span className="stage-controls__start">{controlsStart}</span> : null}
            {overlay ?? controls}
          </div>
        ) : null}
        <figcaption className="picture-caption">
          {caption}
          {controlsBelow ? null : captionEnd}
        </figcaption>
      </figure>
      {children}
    </div>
  );
}

/** One fixture badge in the picture's upper right corner, when the picture is fixture evidence. */
function FixtureMark({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div className="image-card__badges">
      <span />
      <span>
        <FixtureBadge />
      </span>
    </div>
  );
}

/**
 * A Street View frame on a stage, shown exactly as it is (no ambient layer, no tint, no crop),
 * with its attribution on the line directly beneath it. It is laid out at the size its look will
 * have (the working grid), so the picture keeps its size from this screen to the result. `logo`
 * is the discovery's attribution requirement.
 */
export function StreetViewStage({
  candidate,
  logo,
  loading,
  className,
  children,
}: {
  candidate: Candidate;
  logo: AttributionLogo | null;
  loading?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const fixture = useIsFixtureImage('street_view', { url: candidate.displayUrl });
  const fixtureStreetView = useIsFixtureStreetView();
  return (
    <PictureStage
      width={STREET_VIEW_WORKING_SIZE.width}
      height={STREET_VIEW_WORKING_SIZE.height}
      className={className}
      picture={
        <>
          {candidate.displayUrl ? (
            <img
              key={candidate.displayUrl}
              className="stage__image fade-in"
              src={candidate.displayUrl}
              alt={t('result.streetViewAlt')}
              width={candidate.width}
              height={candidate.height}
              draggable={false}
            />
          ) : null}
          <FixtureMark show={fixture} />
          {loading ? <span className="stage-loading">{t('confirm.loadingView')}</span> : null}
        </>
      }
      caption={
        <StreetViewAttribution
          text={candidate.copyright}
          logo={logo}
          captureDate={candidate.captureDate}
          fixture={fixtureStreetView}
        />
      }
    >
      {children}
    </PictureStage>
  );
}

/**
 * The project's current source on a stage: a Street View frame with its attribution beneath it
 * (shown as it is, laid out at the size of its look), or the uploaded photo, with its blurred
 * ambient layer, and "Your photo".
 */
export function ProjectSourceStage({
  project,
  pending,
  stringHoliday,
  stageCard,
  captionEnd,
  controls,
  className,
  children,
}: {
  project: Project;
  pending?: boolean;
  /** The holiday whose colours the light string wears while `pending` (see PictureStage). */
  stringHoliday?: HolidayId | null;
  /** The status card on the stage (see PictureStage). */
  stageCard?: ReactNode;
  /** Shown in the row under the stage on phones (see PictureStage). */
  controls?: ReactNode;
  /** Shown at the end of the caption line (for example what is happening to the picture). */
  captionEnd?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const source = project.activeSource;
  const isStreetView = source?.kind === 'street_view' || source?.kind === 'fixture';
  const fixture = useIsFixtureImage(isStreetView ? 'street_view' : 'photo', {
    url: source?.displayUrl,
    sourceKind: source?.kind,
  });
  const fixtureStreetView = useIsFixtureStreetView(source?.kind);
  const variants = useProjectStore((state) => state.variants);
  if (!source?.displayUrl) {
    return children ? <div className={className}>{children}</div> : null;
  }
  // A Street View frame is laid out at the size of the look made from it, so nothing moves
  // when the look replaces it; an upload at its own size.
  const layout = isStreetView
    ? streetViewLayoutSize(variants, source.sourceAssetId)
    : { width: source.width || FALLBACK_SIZE.width, height: source.height || FALLBACK_SIZE.height };
  const { width, height } = layout;
  return (
    <PictureStage
      width={width}
      height={height}
      ambientSrc={isStreetView ? null : source.displayUrl}
      pending={pending}
      stringHoliday={stringHoliday}
      stageCard={stageCard}
      controls={controls}
      className={className}
      picture={
        <>
          <SourcePicture
            key={source.sourceAssetId}
            src={source.displayUrl}
            alt={isStreetView ? t('result.streetViewAlt') : t('upload.previewAltPending')}
            width={width}
            height={height}
          />
          <FixtureMark show={fixture} />
        </>
      }
      caption={
        isStreetView ? (
          <StreetViewAttribution
            text={source.copyright}
            logo="google_maps"
            captureDate={source.captureDate}
            fixture={fixtureStreetView}
          />
        ) : (
          <span>{t('result.yourPhoto')}</span>
        )
      }
      captionEnd={captionEnd}
    >
      {children}
    </PictureStage>
  );
}
