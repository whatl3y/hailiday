import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LandingHero } from './LandingHero';

const landingPanel =
  '<div class="landing ssr-hero__landing"><section class="landing__panel ssr-hero__panel">' +
  '<h1 class="landing__headline ssr-hero__headline">Imagine your place</h1></section></div>';

function serverRegion(withPhoto: boolean): HTMLElement {
  const container = document.createElement('div');
  container.id = 'ssr-hero';
  container.className = 'ssr-hero';
  container.innerHTML =
    (withPhoto
      ? '<picture class="ssr-hero__picture"><img class="ssr-hero__image" src="l.jpg" alt="" /></picture>'
      : '') + landingPanel;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('LandingHero', () => {
  it('adopts the server photograph and retires the server panel before paint', () => {
    const container = serverRegion(true);
    const { container: app } = render(<LandingHero hero={null} />);
    expect(app.querySelector('.hero__layer--server img')?.getAttribute('src')).toBe('l.jpg');
    expect(container.hidden).toBe(true);
    expect(container.childNodes).toHaveLength(0);
  });

  it('retires a server panel painted without a photograph, so no second headline stays', () => {
    const container = serverRegion(false);
    render(<LandingHero hero={null} />);
    expect(container.hidden).toBe(true);
    expect(document.querySelectorAll('.ssr-hero__panel')).toHaveLength(0);
  });
});
