import { cleanup, render } from '@testing-library/react';
import type { Hero } from '@hailiday/core';
import { afterEach, describe, expect, it } from 'vitest';
import { LandingHero } from './LandingHero';

const landingPanel =
  '<div class="hero-frame__content"><section class="landing__panel ssr-hero__panel">' +
  '<h1 class="landing__headline ssr-hero__headline">Imagine your place</h1></section></div>';

function serverRegion(withPhoto: boolean): HTMLElement {
  const container = document.createElement('div');
  container.id = 'ssr-hero';
  container.className = 'ssr-hero';
  container.innerHTML =
    '<div class="landing ssr-hero__landing"><div class="hero-frame landing__frame">' +
    '<div class="hero-frame__photo">' +
    (withPhoto
      ? '<picture class="ssr-hero__picture"><img class="ssr-hero__image" src="l.jpg" alt="" /></picture>'
      : '') +
    '</div>' +
    landingPanel +
    '</div></div>';
  document.body.appendChild(container);
  return container;
}

const hero: Hero = {
  holidayId: 'christmas',
  sceneType: 'house_exterior',
  renditions: {
    landscape: [{ url: 'l.jpg', width: 2400, height: 1600 }],
    portrait: [{ url: 'p.jpg', width: 1080, height: 1620 }],
  },
  altKey: 'hero.christmas.alt',
};

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('LandingHero', () => {
  it('adopts the server photograph into its frame and retires the server panel before paint', () => {
    const container = serverRegion(true);
    const { container: app } = render(
      <LandingHero hero={null}>
        <p>content</p>
      </LandingHero>,
    );
    expect(
      app.querySelector('.hero-frame__photo > .hero__layer--server img')?.getAttribute('src'),
    ).toBe('l.jpg');
    expect(app.querySelector('.hero-frame__content')?.textContent).toBe('content');
    expect(container.hidden).toBe(true);
    expect(container.childNodes).toHaveLength(0);
  });

  it('never fetches the adopted photograph a second time', () => {
    serverRegion(true);
    const { container: app } = render(
      <LandingHero hero={hero}>
        <p>content</p>
      </LandingHero>,
    );
    expect(app.querySelectorAll('img')).toHaveLength(1);
    expect(app.querySelectorAll('.hero__layer:not(.hero__layer--server)')).toHaveLength(0);
  });

  it('places the focal point of each crop on the frame', () => {
    const { container: app } = render(
      <LandingHero hero={hero}>
        <p>content</p>
      </LandingHero>,
    );
    const frame = app.querySelector<HTMLElement>('.hero-frame')!;
    expect(frame.style.getPropertyValue('--hero-x')).toBe('62%');
    expect(frame.style.getPropertyValue('--hero-y')).toBe('50%');
    expect(frame.style.getPropertyValue('--hero-portrait-x')).toBe('50%');
  });

  it('retires a server panel painted without a photograph, so no second headline stays', () => {
    const container = serverRegion(false);
    render(
      <LandingHero hero={null}>
        <p>content</p>
      </LandingHero>,
    );
    expect(container.hidden).toBe(true);
    expect(document.querySelectorAll('.ssr-hero__panel')).toHaveLength(0);
  });
});
