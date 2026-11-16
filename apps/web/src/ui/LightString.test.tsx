import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReducedMotion } from '../test/fixtures';
import { LightString } from './LightString';
import lightStringCss from './light-string.css?raw';
import { STRING_TIERS, stringGeometry } from './stringGeometry';

const plain = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first `@media` block with this exact condition. */
function media(css: string, condition: string): string {
  const source = plain(css);
  const start = source.indexOf(`@media ${condition} {`);
  if (start < 0) throw new Error(`no @media ${condition}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0)
      return source.slice(source.indexOf('{', start) + 1, index).replace(/\s+/g, ' ');
  }
  throw new Error('unclosed @media');
}

const tier = STRING_TIERS.wide;
/** jsdom reports no layout, so the string takes the 1024px fallback width. */
const WIDTH = 1024;

function bodyFill(container: HTMLElement, index: number): string {
  const body = container.querySelector<SVGElement>(`.bulb[data-index="${index}"] .bulb__body`)!;
  return body.style.fill;
}

beforeEach(() => mockReducedMotion(false));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('LightString', () => {
  it('is decoration only: hidden, never focusable, no role', () => {
    const { container } = render(<LightString holidayId="christmas" tier={tier} />);
    const root = container.querySelector<HTMLElement>('.light-string')!;
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.getAttribute('role')).toBeNull();
    expect(root.querySelector('svg')?.getAttribute('focusable')).toBe('false');
    expect(root.querySelectorAll('[role], [tabindex], a, button, input')).toHaveLength(0);
  });

  it('draws one bulb per bulb of the geometry, in the three colours in turn', () => {
    const { container } = render(<LightString holidayId="christmas" tier={tier} />);
    const geometry = stringGeometry(WIDTH, tier);
    const bulbs = container.querySelectorAll('.bulb');
    expect(bulbs).toHaveLength(geometry.bulbs.length);
    expect(bodyFill(container, 0)).toBe('var(--bulb-1)');
    expect(bodyFill(container, 1)).toBe('var(--bulb-2)');
    expect(bodyFill(container, 2)).toBe('var(--bulb-3)');
    expect(bodyFill(container, 3)).toBe('var(--bulb-1)');
    expect((bulbs[5] as SVGElement).style.getPropertyValue('--i')).toBe('5');
    expect(container.querySelector('svg')?.getAttribute('height')).toBe(String(tier.clear));
  });

  it("wears the holiday's colours, and warm white without a holiday", () => {
    const { container, rerender } = render(<LightString holidayId="halloween" tier={tier} />);
    expect(container.querySelector('.light-string')?.getAttribute('data-holiday')).toBe(
      'halloween',
    );
    rerender(<LightString holidayId={null} tier={tier} />);
    expect(container.querySelector('.light-string')?.hasAttribute('data-holiday')).toBe(false);
  });

  it('changes the colour of a poked bulb and ripples to its neighbours within 8', () => {
    const { container } = render(<LightString holidayId="christmas" tier={tier} />);
    expect(container.querySelectorAll('.bulb__flash')).toHaveLength(0);
    const target = container.querySelector('.bulb[data-index="10"] .bulb__hit')!;
    fireEvent.pointerDown(target);
    expect(bodyFill(container, 10)).toBe('var(--bulb-3)');
    expect(bodyFill(container, 11)).toBe('var(--bulb-3)');
    const flashes = [...container.querySelectorAll<SVGElement>('.bulb__flash')];
    expect(flashes).toHaveLength(17);
    const indices = flashes.map((flash) =>
      Number(flash.closest('.bulb')?.getAttribute('data-index')),
    );
    expect(Math.min(...indices)).toBe(2);
    expect(Math.max(...indices)).toBe(18);
    const centre = container.querySelector<SVGElement>('.bulb[data-index="10"] .bulb__flash')!;
    expect(centre.style.getPropertyValue('--d')).toBe('0');
    expect(centre.style.getPropertyValue('--a')).toBe('1');
    const edge = container.querySelector<SVGElement>('.bulb[data-index="18"] .bulb__flash')!;
    expect(edge.style.getPropertyValue('--d')).toBe('8');
  });

  it('takes a touch, which sends a pass and a press, as one poke', () => {
    vi.useFakeTimers();
    const { container } = render(<LightString holidayId="christmas" tier={tier} />);
    const target = container.querySelector('.bulb[data-index="4"] .bulb__hit')!;
    fireEvent.pointerOver(target);
    fireEvent.pointerDown(target);
    // Bulb 4 starts at colour 2 and moved on once.
    expect(bodyFill(container, 4)).toBe('var(--bulb-3)');
    vi.advanceTimersByTime(300);
    fireEvent.pointerDown(target);
    expect(bodyFill(container, 4)).toBe('var(--bulb-1)');
  });

  it('only changes the colour under reduced motion: no ripple', () => {
    mockReducedMotion(true);
    const { container } = render(<LightString holidayId="christmas" tier={tier} />);
    fireEvent.pointerDown(container.querySelector('.bulb[data-index="0"] .bulb__hit')!);
    expect(bodyFill(container, 0)).toBe('var(--bulb-2)');
    expect(container.querySelectorAll('.bulb__flash')).toHaveLength(0);
  });

  it('hangs two hangers from the wire down to the card', () => {
    const { container, rerender } = render(<LightString holidayId="christmas" tier={tier} />);
    expect(container.querySelectorAll('.light-string__hanger')).toHaveLength(0);
    rerender(<LightString holidayId="christmas" tier={tier} hang={{ width: 368, top: 50 }} />);
    const geometry = stringGeometry(WIDTH, tier);
    const lines = [...container.querySelectorAll('.light-string__hanger-wire')];
    expect(lines).toHaveLength(2);
    const xs = lines.map((line) => Number(line.getAttribute('x1')));
    expect(xs).toEqual([WIDTH / 2 - (184 - 32), WIDTH / 2 + (184 - 32)]);
    for (const line of lines) {
      const x = Number(line.getAttribute('x1'));
      expect(Number(line.getAttribute('y1'))).toBeCloseTo(geometry.wireY(x), 6);
      expect(line.getAttribute('y2')).toBe('50');
    }
  });
});

describe('the light string stylesheet', () => {
  it('lights the bulbs and holds them still under reduced motion', () => {
    const reduced = media(lightStringCss, '(prefers-reduced-motion: reduce)');
    expect(reduced).toMatch(/\.light-string \{ animation: none; \}/);
    expect(reduced).toMatch(/\.bulb__glow \{ animation: none; opacity: 0\.8; \}/);
    expect(reduced).toMatch(/\.bulb__body \{ animation: none; opacity: 1;/);
    expect(reduced).toMatch(/\.bulb__flash \{ display: none; \}/);
  });

  it('twinkles in a wave along the string', () => {
    expect(plain(lightStringCss)).toContain('animation-delay: calc(var(--i) * -120ms);');
    expect(plain(lightStringCss)).toContain('animation-delay: calc(var(--d) * 45ms);');
  });

  it('carries no colour of its own but the bulbs, white and the scrim', () => {
    const source = plain(lightStringCss);
    expect(source).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const match of source.matchAll(/\b(?:rgba?|hsla?|color)\([^)]*\)?/g)) {
      expect(match[0]).toMatch(/^rgb\((255 255 255 \/|var\(--scrim-rgb\))/);
    }
    for (const match of source.matchAll(/var\(--([a-z0-9-]+)\)/g)) {
      expect(match[1]).toMatch(/^(bulb-|scrim-rgb|ease-|i$|d$|a$)/);
    }
  });
});
