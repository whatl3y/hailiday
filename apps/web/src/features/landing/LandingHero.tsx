import { useLayoutEffect, useRef, useState } from 'react';
import type { Hero, Rendition } from '@holiday/core';
import { tDynamic } from '../../copy';
import { adoptServerHero } from './serverHero';

function srcSet(renditions: readonly Rendition[]): string {
  return [...renditions]
    .sort((a, b) => a.width - b.width)
    .map((rendition) => `${rendition.url} ${rendition.width}w`)
    .join(', ');
}

function largest(renditions: readonly Rendition[]): Rendition | undefined {
  return [...renditions].sort((a, b) => b.width - a.width)[0];
}

function heroKey(hero: Hero | null): string {
  if (!hero) return 'none';
  return (
    largest(hero.renditions.landscape)?.url ?? largest(hero.renditions.portrait)?.url ?? hero.altKey
  );
}

/** The art-directed hero: the 2:3 crop on compact widths and the 3:2 crop elsewhere. */
function HeroPicture({ hero, onLoad }: { hero: Hero; onLoad: () => void }) {
  const fallback = largest(hero.renditions.landscape) ?? largest(hero.renditions.portrait);
  if (!fallback) return null;
  return (
    <picture>
      {hero.renditions.portrait.length > 0 ? (
        <source
          media="(max-width: 599px)"
          srcSet={srcSet(hero.renditions.portrait)}
          sizes="100vw"
        />
      ) : null}
      <img
        src={fallback.url}
        srcSet={
          hero.renditions.landscape.length > 0 ? srcSet(hero.renditions.landscape) : undefined
        }
        sizes="100vw"
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

function serverHeroPresent(): boolean {
  return Boolean(document.getElementById('ssr-hero')?.querySelector('img'));
}

/**
 * The landing hero. When the server rendered the hero into the shell, its photograph is moved
 * into this slot before paint, so it is never fetched or painted twice. A later hero from a
 * new experience payload crossfades over it inside the same reserved box, so the layout never
 * shifts.
 */
export function LandingHero({ hero }: { hero: Hero | null }) {
  const slotRef = useRef<HTMLDivElement>(null);
  const key = heroKey(hero);
  const [adoptedKey] = useState<string | null>(() => (serverHeroPresent() ? key : null));
  const [layers, setLayers] = useState<Layer[]>(() =>
    adoptedKey === null && hero ? [{ key, hero, loaded: false }] : [],
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

  // The server region is retired before the first paint: its photograph (when there is one)
  // moves into the slot, and its headline panel always gives way to the app's.
  useLayoutEffect(() => {
    const container = document.getElementById('ssr-hero');
    const slot = slotRef.current;
    if (!container || !slot || container.hidden) return;
    adoptServerHero(container, slot);
  }, []);

  return (
    <div className="hero">
      <div ref={slotRef} className="hero__layer hero__layer--server" />
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
    </div>
  );
}
