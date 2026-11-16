import type { CSSProperties } from 'react';
import type { Hero, HolidayId, Rendition } from '@hailiday/core';

/**
 * The hero photograph always spans the viewport's width, so the browser picks the rendition for
 * the full viewport. The server shell's preload and picture use the same value.
 */
export const HERO_SIZES = '100vw';

/** Any viewport taller than wide shows the art-directed portrait crop, as in the server shell. */
export const PORTRAIT_MEDIA = '(orientation: portrait)';

/** A point in 0-1 coordinates of a crop. */
type Point = readonly [number, number];

/**
 * Each hero crop's focal point (from the hero manifest, in coordinates of that crop). The
 * photograph covers the frame around it, so the subject stays in view at every aspect ratio.
 */
export const HERO_FOCUS: Record<HolidayId | 'neutral', { landscape: Point; portrait: Point }> = {
  halloween: { landscape: [0.5, 0.56], portrait: [0.5, 0.56] },
  thanksgiving_us: { landscape: [0.46, 0.5], portrait: [0.41, 0.5] },
  christmas: { landscape: [0.62, 0.5], portrait: [0.5, 0.5] },
  new_years_eve: { landscape: [0.55, 0.5], portrait: [0.5, 0.5] },
  neutral: { landscape: [0.5, 0.6], portrait: [0.613, 0.6] },
};

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/** The frame's custom properties that place the photograph's focal point, per crop. */
export function heroFocusStyle(hero: Hero | null): CSSProperties | undefined {
  if (!hero) return undefined;
  const focus = HERO_FOCUS[hero.holidayId ?? 'neutral'];
  return {
    '--hero-x': percent(focus.landscape[0]),
    '--hero-y': percent(focus.landscape[1]),
    '--hero-portrait-x': percent(focus.portrait[0]),
    '--hero-portrait-y': percent(focus.portrait[1]),
  } as CSSProperties;
}

function largest(renditions: readonly Rendition[]): Rendition | undefined {
  return [...renditions].sort((a, b) => b.width - a.width)[0];
}

/** A stable identity for a hero: its largest rendition's URL. */
export function heroKey(hero: Hero | null): string {
  if (!hero) return 'none';
  return (
    largest(hero.renditions.landscape)?.url ?? largest(hero.renditions.portrait)?.url ?? hero.altKey
  );
}
