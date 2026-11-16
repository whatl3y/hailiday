import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Endpoints from '../../api/endpoints';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { LandingPage } from './LandingPage';

vi.mock('../../experience/load', () => ({ syncExperienceWithSelection: vi.fn() }));
vi.mock('../../api/endpoints', async (importOriginal) => ({
  ...(await importOriginal<typeof Endpoints>()),
  ensureSession: vi.fn(async () => undefined),
}));

const hero = {
  holidayId: 'christmas',
  sceneType: 'house_exterior',
  renditions: {
    landscape: [{ url: 'https://cdn.test/hero-1600.jpg', width: 1600, height: 1067 }],
    portrait: [{ url: 'https://cdn.test/hero-720.jpg', width: 720, height: 1080 }],
  },
  altKey: 'hero.christmas.alt',
};

function experience(overrides: Partial<PublicExperience> = {}): PublicExperience {
  return {
    holidays: [{ id: 'christmas', journeyEmphasis: 'exterior', inWindow: true }],
    hero,
    examples: [
      {
        holidayId: 'christmas',
        sceneType: 'house_exterior',
        style: 'classic',
        lightingMode: 'source',
        beforeUrl: 'https://cdn.test/before.jpg',
        afterUrl: 'https://cdn.test/after.jpg',
        width: 1600,
        height: 1200,
        captionKey: 'example.christmas.house_exterior',
      },
    ],
    clientConfig: { autocompleteMinChars: 3, autocompleteDebounceMs: 150 },
    fixtureCapabilities: [],
    ...overrides,
  } as unknown as PublicExperience;
}

function useExperience(value: PublicExperience) {
  useAppStore.setState({
    experience: value,
    experienceStatus: 'ready',
    clientDefaultHolidayId: 'christmas',
    pickerHolidayIds: ['christmas'],
    explicitHolidayId: null,
    deepLinkHolidayId: null,
  });
}

/** A server-painted landing region: the hero frame with its panel and, optionally, a photograph. */
function serverRegion({
  photo,
  elapsedMs,
  driftMs,
}: {
  photo: boolean;
  elapsedMs?: number;
  driftMs?: number;
}): HTMLElement {
  const container = document.createElement('div');
  container.id = 'ssr-hero';
  container.className = 'ssr-hero';
  container.innerHTML =
    '<header class="site-header site-header--photo ssr-hero__header"></header>' +
    '<div class="landing ssr-hero__landing"><div class="hero-frame landing__frame">' +
    '<div class="hero-frame__photo">' +
    (photo
      ? '<picture class="ssr-hero__picture">' +
        '<img class="ssr-hero__image" src="https://cdn.test/ssr.jpg" alt="" /></picture>'
      : '') +
    '</div><div class="hero-frame__scrim"></div><div class="hero-frame__content">' +
    '<section class="landing__panel ssr-hero__panel">' +
    '<p class="eyebrow landing__eyebrow">Your place</p>' +
    '<h1 class="landing__headline">Imagine your place for the holidays.</h1></section>' +
    '</div></div></div>';
  document.body.appendChild(container);
  if (elapsedMs !== undefined) {
    const eyebrow = container.querySelector<HTMLElement>('.landing__eyebrow')!;
    eyebrow.getAnimations = () =>
      [{ currentTime: elapsedMs, playState: 'running' }] as unknown as Animation[];
  }
  if (driftMs !== undefined) {
    const frame = container.querySelector<HTMLElement>('.hero-frame__photo')!;
    frame.getAnimations = () =>
      [{ currentTime: driftMs, playState: 'running' }] as unknown as Animation[];
  }
  return container;
}

function renderLanding() {
  return render(
    <MemoryRouter>
      <LandingPage />
    </MemoryRouter>,
  );
}

/** Whether `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

beforeEach(() => {
  useExperience(experience());
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the landing composition', () => {
  it('rests the eyebrow and the title on the photograph, the subhead first in the dock, then examples on paper', () => {
    const { container } = renderLanding();
    const frame = container.querySelector('.hero-frame.landing__frame')!;
    expect(frame).not.toBeNull();
    expect(frame.querySelector('.hero-frame__photo img')?.getAttribute('sizes')).toBe('100vw');
    const order = [
      container.querySelector('.landing__eyebrow')!,
      screen.getByRole('heading', { level: 1, name: 'Imagine your place for the holidays.' }),
      container.querySelector('.landing__subhead')!,
      screen.getByRole('combobox', { name: 'Enter a US address' }),
      screen.getByRole('button', { name: "Can't find it? Enter the address manually" }),
      screen.getByRole('button', { name: 'Or upload a photo' }),
      screen.getByRole('button', { name: 'See an example' }),
      container.querySelector('.landing__age')!,
      screen.getByRole('heading', { level: 2, name: 'From an everyday photo to a holiday look' }),
    ];
    for (const element of order) expect(element).toBeTruthy();
    for (let index = 1; index < order.length; index += 1) {
      expect(precedes(order[index - 1]!, order[index]!), `block ${index}`).toBe(true);
    }
    // The eyebrow and the headline rest on the photograph; the subhead opens the white dock,
    // with the field, routes and age line after it; the examples continue below the frame.
    const dock = frame.querySelector('.hero-dock.landing__dock')!;
    expect(frame.contains(order[1]!)).toBe(true);
    expect(dock.contains(order[0]!)).toBe(false);
    expect(dock.contains(order[1]!)).toBe(false);
    expect(dock.firstElementChild).toBe(order[2]);
    for (const element of order.slice(2, 8)) expect(dock.contains(element)).toBe(true);
    expect(frame.contains(order[8]!)).toBe(false);
    expect(container.querySelector('.landing__examples .example-card')).not.toBeNull();
  });

  it('lays the header over the photograph and opens the suggestions upward on wide screens', () => {
    const { container } = renderLanding();
    expect(container.querySelector('.page')?.className).toBe('page page--photo');
    expect(container.querySelector('header')?.className).toBe('site-header site-header--photo');
    expect(container.querySelector('.combo')?.getAttribute('data-placement')).toBe('above');
  });

  it('keeps the routes in one row of quiet links, with manual entry offering the upload instead', () => {
    const { container } = renderLanding();
    const routes = container.querySelector('.landing__routes')!;
    expect([...routes.children].map((child) => child.className)).toEqual([
      'link-button landing__manual',
      'link-button landing__upload',
      'link-button landing__example',
    ]);
    screen.getByRole('button', { name: "Can't find it? Enter the address manually" }).click();
    return Promise.resolve().then(() => {
      expect(screen.queryByRole('button', { name: 'Or upload a photo' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Upload a photo instead' }).className).toBe(
        'link-button landing__upload',
      );
    });
  });

  it('draws the eyebrow parts with separators kept from assistive technology', () => {
    const { container } = renderLanding();
    const eyebrow = container.querySelector('.landing__eyebrow')!;
    const parts = [...eyebrow.querySelectorAll(':scope > span:not(.sep)')].map(
      (part) => part.textContent,
    );
    expect(parts).toEqual(['Your place', 'Your photo', 'AI preview']);
    const separators = eyebrow.querySelectorAll('.sep');
    expect(separators).toHaveLength(2);
    for (const separator of separators) expect(separator.getAttribute('aria-hidden')).toBe('true');
  });

  it('keeps the address field the only primary control', () => {
    const { container } = renderLanding();
    expect(container.querySelector('.button--primary')).toBeNull();
  });

  it('shows the holiday picker in the header as a label with its dot', () => {
    const { container } = renderLanding();
    const chip = screen.getByRole('button', { name: /^Holiday:/ });
    expect(chip.className).toBe('holiday-chip');
    expect(chip.getAttribute('data-holiday')).toBe('christmas');
    expect(chip.querySelector('.holiday-chip__dot')).not.toBeNull();
    expect(container.querySelector('.site-header')?.contains(chip)).toBe(true);
  });

  it('puts the link back to the last place after the dock, outside it, as a pill on the photograph', () => {
    useAppStore.setState({ lastProject: { id: 'project-1', at: Date.now() } });
    try {
      const { container } = renderLanding();
      const link = screen.getByRole('link', { name: 'Continue with your last place' });
      expect(link.getAttribute('href')).toBe('/p/project-1');
      expect(link.className).toBe('landing__continue');
      expect(container.querySelector('.landing__panel')?.lastElementChild).toBe(link);
      expect(container.querySelector('.landing__dock')?.contains(link)).toBe(false);
    } finally {
      useAppStore.setState({ lastProject: null });
    }
  });

  it('keeps the frame on its ink ground and leaves out the examples when there are neither', () => {
    useExperience(experience({ hero: null, examples: [] }));
    const { container } = renderLanding();
    const frame = container.querySelector('.hero-frame')!;
    expect(frame.hasAttribute('data-photo')).toBe(false);
    expect(frame.querySelector('img')).toBeNull();
    expect(container.querySelector('.landing__examples')).toBeNull();
    expect(screen.queryByRole('button', { name: 'See an example' })).toBeNull();
  });
});

describe('the address field on phones', () => {
  function withViewport(phone: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(max-width: 599px)' ? phone : false,
      media: query,
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  }

  it('lifts the field to the top on focus, so the suggestions below it clear the keyboard', async () => {
    const restore = withViewport(true);
    const lifted = vi.fn();
    Element.prototype.scrollIntoView = lifted;
    try {
      renderLanding();
      screen.getByRole('combobox', { name: 'Enter a US address' }).focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(lifted).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
      expect(lifted.mock.contexts[0]).toHaveProperty('className', 'combo');
    } finally {
      restore();
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('leaves the page where it is on wider screens', async () => {
    const restore = withViewport(false);
    const lifted = vi.fn();
    Element.prototype.scrollIntoView = lifted;
    try {
      renderLanding();
      screen.getByRole('combobox', { name: 'Enter a US address' }).focus();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(lifted).not.toHaveBeenCalled();
    } finally {
      restore();
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });
});

describe('taking over the server-painted landing', () => {
  it('continues the server entrance where it was and adopts the photograph', () => {
    const region = serverRegion({ photo: true, elapsedMs: 420, driftMs: 1300 });
    const { container } = renderLanding();
    const frame = container.querySelector<HTMLElement>('.hero-frame')!;
    expect(frame.style.getPropertyValue('--rise-elapsed')).toBe('420ms');
    expect(frame.style.getPropertyValue('--drift-elapsed')).toBe('1300ms');
    expect(container.querySelector('.landing__panel')?.hasAttribute('data-continues')).toBe(true);
    expect(container.querySelector('.hero__layer--server img')?.getAttribute('src')).toBe(
      'https://cdn.test/ssr.jpg',
    );
    expect(region.hidden).toBe(true);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('lands at once when the server entrance has already played', () => {
    serverRegion({ photo: true });
    const { container } = renderLanding();
    const frame = container.querySelector<HTMLElement>('.hero-frame')!;
    expect(frame.style.getPropertyValue('--rise-elapsed')).toBe('60000ms');
  });

  it('retires a server panel without a photograph', () => {
    useExperience(experience({ hero: null }));
    const region = serverRegion({ photo: false });
    const { container } = renderLanding();
    expect(container.querySelector('.hero-frame img')).toBeNull();
    expect(region.hidden).toBe(true);
    expect(region.childNodes).toHaveLength(0);
    expect(document.querySelectorAll('h1')).toHaveLength(1);
  });

  it('rises in afresh after a client-side arrival', () => {
    const { container } = renderLanding();
    const frame = container.querySelector<HTMLElement>('.hero-frame')!;
    expect(frame.style.getPropertyValue('--rise-elapsed')).toBe('');
    expect(frame.style.getPropertyValue('--drift-elapsed')).toBe('');
    expect(container.querySelector('.landing__panel')?.hasAttribute('data-continues')).toBe(false);
  });
});
