import { describe, expect, it } from 'vitest';
import type { Hero } from '@hailiday/core';
import heroesJson from '../../../../packages/server/content/heroes.json?raw';
import { HERO_FOCUS, heroFocusStyle, heroKey } from './heroFocus';

interface HeroSpec {
  holidayId: string | null;
  crops: Record<'landscape' | 'portrait', { focalPoint: { x: number; y: number } }>;
}

const manifest = JSON.parse(heroesJson) as { heroes: HeroSpec[] };

describe('the hero focal points', () => {
  it('match every hero crop in the content manifest', () => {
    expect(Object.keys(HERO_FOCUS).sort()).toEqual(
      manifest.heroes.map((hero) => hero.holidayId ?? 'neutral').sort(),
    );
    for (const hero of manifest.heroes) {
      const focus = HERO_FOCUS[(hero.holidayId ?? 'neutral') as keyof typeof HERO_FOCUS];
      for (const crop of ['landscape', 'portrait'] as const) {
        const { x, y } = hero.crops[crop].focalPoint;
        expect(focus[crop], `${hero.holidayId} ${crop}`).toEqual([x, y]);
      }
    }
  });

  it('become the frame custom properties, the neutral hero when it has no holiday', () => {
    const neutral = {
      holidayId: null,
      sceneType: null,
      renditions: { landscape: [{ url: 'n.jpg', width: 2400, height: 1600 }], portrait: [] },
      altKey: 'hero.neutral.alt',
    } as Hero;
    expect(heroFocusStyle(neutral)).toEqual({
      '--hero-x': '50%',
      '--hero-y': '60%',
      '--hero-portrait-x': '61.3%',
      '--hero-portrait-y': '60%',
    });
    expect(heroFocusStyle(null)).toBeUndefined();
    expect(heroKey(neutral)).toBe('n.jpg');
    expect(heroKey(null)).toBe('none');
  });
});
