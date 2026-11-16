import { useState, type CSSProperties, type ReactNode } from 'react';
import type { Hero, Rendition } from '@hailiday/core';
import { tDynamic } from '../copy';
import { HERO_SIZES, PORTRAIT_MEDIA, heroFocusStyle, heroKey } from './heroFocus';

function srcSet(renditions: readonly Rendition[]): string {
  return [...renditions]
    .sort((a, b) => a.width - b.width)
    .map((rendition) => `${rendition.url} ${rendition.width}w`)
    .join(', ');
}

function largest(renditions: readonly Rendition[]): Rendition | undefined {
  return [...renditions].sort((a, b) => b.width - a.width)[0];
}

/** The art-directed photograph: the portrait crop on viewports taller than wide, 3:2 elsewhere. */
export function HeroPicture({ hero, onLoad }: { hero: Hero; onLoad?: () => void }) {
  const fallback = largest(hero.renditions.landscape) ?? largest(hero.renditions.portrait);
  if (!fallback) return null;
  return (
    <picture>
      {hero.renditions.portrait.length > 0 ? (
        <source
          media={PORTRAIT_MEDIA}
          srcSet={srcSet(hero.renditions.portrait)}
          sizes={HERO_SIZES}
        />
      ) : null}
      <img
        src={fallback.url}
        srcSet={
          hero.renditions.landscape.length > 0 ? srcSet(hero.renditions.landscape) : undefined
        }
        sizes={HERO_SIZES}
        width={fallback.width}
        height={fallback.height}
        alt={tDynamic(hero.altKey, 'hero.neutral.alt')}
        decoding="async"
        fetchPriority="high"
        onLoad={onLoad}
      />
    </picture>
  );
}

interface Layer {
  key: string;
  hero: Hero;
  loaded: boolean;
}

/**
 * The photograph's layers. A new hero fades in over the one on screen once it has loaded, then
 * the older layer is dropped. `adoptedKey` names a hero already painted in `serverLayer` (the
 * server-rendered photograph the landing takes over), which then needs no layer of its own.
 */
export function HeroLayers({
  hero,
  adoptedKey = null,
  serverLayer,
}: {
  hero: Hero | null;
  adoptedKey?: string | null;
  serverLayer?: ReactNode;
}) {
  const key = heroKey(hero);
  const [layers, setLayers] = useState<Layer[]>(() =>
    adoptedKey === key || !hero ? [] : [{ key, hero, loaded: false }],
  );
  const [trackedKey, setTrackedKey] = useState(key);

  if (key !== trackedKey) {
    setTrackedKey(key);
    if (!hero || key === adoptedKey) {
      setLayers([]);
    } else {
      setLayers((current) => [
        ...current.filter((layer) => layer.loaded && layer.key !== key).slice(-1),
        { key, hero, loaded: false },
      ]);
    }
  }

  return (
    <>
      {serverLayer}
      {layers.map((layer, index) => (
        <div
          key={layer.key}
          className="hero__layer"
          data-loaded={layer.loaded || undefined}
          onTransitionEnd={() => {
            if (index === layers.length - 1 && layer.loaded && layers.length > 1) {
              setLayers((current) => current.slice(-1));
            }
          }}
        >
          <HeroPicture
            hero={layer.hero}
            onLoad={() =>
              setLayers((current) =>
                current.map((item) => (item.key === layer.key ? { ...item, loaded: true } : item)),
              )
            }
          />
        </div>
      ))}
    </>
  );
}

export interface HeroFrameProps {
  /** The experience's hero photograph; null shows the ink stage ground. */
  hero: Hero | null;
  /** The content block resting on the photograph (headline, dock). */
  children: ReactNode;
  className?: string;
  /** Replaces the photograph layer (the landing passes its server-adopting layers). */
  photo?: ReactNode;
  /** Extra custom properties on the frame (the landing's entrance and drift continuity). */
  style?: CSSProperties;
}

/**
 * A full-viewport photograph with content resting on it: at least the first viewport tall,
 * edge to edge, the photograph covering the frame around its focal point and drifting slowly
 * once. Gradient scrims sit only where the type is.
 */
export function HeroFrame({ hero, children, className, photo, style }: HeroFrameProps) {
  const focus = heroFocusStyle(hero);
  return (
    <div
      className={className ? `hero-frame ${className}` : 'hero-frame'}
      data-photo={hero ? '' : undefined}
      style={focus || style ? { ...focus, ...style } : undefined}
    >
      <div className="hero-frame__photo">{photo ?? <HeroLayers hero={hero} />}</div>
      <div className="hero-frame__scrim" aria-hidden="true" />
      <div className="hero-frame__content">{children}</div>
    </div>
  );
}

/** The white dock on a photograph: progy's paper, lifted, holding the frame's controls. */
export function HeroDock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `hero-dock ${className}` : 'hero-dock'}>{children}</div>;
}
