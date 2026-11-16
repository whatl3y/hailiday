import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Hero } from '@hailiday/core';
import { HeroFrame, HeroLayers } from '../../ui/HeroFrame';
import { heroKey } from '../../ui/heroFocus';
import { adoptServerHero, serverHeroPresent } from './serverHero';

/**
 * The landing's hero frame: the season's photograph filling the first viewport, with the
 * headline and the address dock resting on it. When the server rendered the photograph into the
 * shell, it is moved into this frame's server layer before paint, so it is never fetched or
 * painted twice. A later hero from a new experience payload crossfades over it in the same box.
 */
export function LandingHero({
  hero,
  children,
  style,
}: {
  hero: Hero | null;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [adoptedKey] = useState<string | null>(() => (serverHeroPresent() ? heroKey(hero) : null));

  // The server region is retired before the first paint: its photograph (when there is one)
  // moves into the slot, and its headline panel always gives way to the app's.
  useLayoutEffect(() => {
    const container = document.getElementById('ssr-hero');
    const slot = slotRef.current;
    if (!container || !slot || container.hidden) return;
    adoptServerHero(container, slot);
  }, []);

  return (
    <HeroFrame
      hero={hero}
      className="landing__frame"
      style={style}
      photo={
        <HeroLayers
          hero={hero}
          adoptedKey={adoptedKey}
          serverLayer={<div ref={slotRef} className="hero__layer hero__layer--server" />}
        />
      }
    >
      {children}
    </HeroFrame>
  );
}
