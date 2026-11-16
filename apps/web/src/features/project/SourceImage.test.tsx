import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { mockReducedMotion, project } from '../../test/fixtures';
import projectCss from './project.css?raw';
import { ProjectSourceStage, SOURCE_FADE_MS } from './SourceImage';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

const WIDE = 'https://cdn.test/wide.jpg';
const ZOOMED = 'https://cdn.test/zoomed.jpg';

function streetPlace(displayUrl: string, sourceAssetId?: string) {
  const base = project({ variantCount: 0 });
  return project({
    variantCount: 0,
    activeSource: {
      ...base.activeSource!,
      ...(sourceAssetId ? { sourceAssetId } : {}),
      kind: 'street_view',
      displayUrl,
      width: 640,
      height: 640,
    },
  });
}

/**
 * Ends a CSS animation on an element. Without `AnimationEvent` in the test DOM, React listens for
 * the prefixed event name, so both names are sent.
 */
function endAnimation(element: Element): void {
  act(() => {
    element.dispatchEvent(new Event('animationend', { bubbles: true }));
    element.dispatchEvent(new Event('webkitAnimationEnd', { bubbles: true }));
  });
}

function images(container: HTMLElement): HTMLImageElement[] {
  return [...container.querySelectorAll<HTMLImageElement>('.stage__picture img.stage__image')];
}

beforeEach(() => {
  mockReducedMotion(false);
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the source picture on the waiting stage', () => {
  it('loads the zoomed frame unseen, then cross-fades it over the wide one', () => {
    const view = render(<ProjectSourceStage project={streetPlace(WIDE)} pending />);
    const stage = view.container.querySelector('.stage__picture')!;
    const box = stage.getAttribute('style');
    expect(images(view.container).map((image) => image.getAttribute('src'))).toEqual([WIDE]);

    view.rerender(<ProjectSourceStage project={streetPlace(ZOOMED)} pending />);
    let [wide, zoomed] = images(view.container);
    expect(wide?.getAttribute('src')).toBe(WIDE);
    expect(wide?.getAttribute('alt')).not.toBe('');
    // The new frame waits over the old one, hidden from assistive technology, until it loads.
    expect(zoomed?.getAttribute('src')).toBe(ZOOMED);
    expect(zoomed?.classList.contains('stage__image--incoming')).toBe(true);
    expect(zoomed?.getAttribute('aria-hidden')).toBe('true');
    expect(zoomed?.hasAttribute('data-fading')).toBe(false);

    fireEvent.load(zoomed!);
    [wide, zoomed] = images(view.container);
    expect(zoomed?.hasAttribute('data-fading')).toBe(true);
    expect(wide?.getAttribute('src')).toBe(WIDE);

    endAnimation(zoomed!);
    const [only, ...rest] = images(view.container);
    expect(rest).toHaveLength(0);
    expect(only?.getAttribute('src')).toBe(ZOOMED);
    // The same element stays on screen, now the picture itself.
    expect(only).toBe(zoomed);
    expect(only?.classList.contains('stage__image--incoming')).toBe(false);
    expect(only?.hasAttribute('aria-hidden')).toBe(false);
    expect(only?.getAttribute('alt')).toBe(wide?.getAttribute('alt'));
    // Both frames fill the same box: nothing moves.
    expect(view.container.querySelector('.stage__picture')!.getAttribute('style')).toBe(box);
  });

  it('ends the fade after its length when no animation event arrives', () => {
    vi.useFakeTimers();
    const view = render(<ProjectSourceStage project={streetPlace(WIDE)} pending />);
    view.rerender(<ProjectSourceStage project={streetPlace(ZOOMED)} pending />);
    fireEvent.load(images(view.container)[1]!);
    act(() => {
      vi.advanceTimersByTime(SOURCE_FADE_MS + 100);
    });
    expect(images(view.container).map((image) => image.getAttribute('src'))).toEqual([ZOOMED]);
  });

  it('swaps at once under reduced motion', () => {
    mockReducedMotion(true);
    const view = render(<ProjectSourceStage project={streetPlace(WIDE)} pending />);
    view.rerender(<ProjectSourceStage project={streetPlace(ZOOMED)} pending />);
    const [, zoomed] = images(view.container);
    fireEvent.load(zoomed!);
    const shown = images(view.container);
    expect(shown.map((image) => image.getAttribute('src'))).toEqual([ZOOMED]);
    expect(shown[0]?.hasAttribute('data-fading')).toBe(false);
  });

  it('keeps the wide frame when the zoomed one fails to load', () => {
    const view = render(<ProjectSourceStage project={streetPlace(WIDE)} pending />);
    view.rerender(<ProjectSourceStage project={streetPlace(ZOOMED)} pending />);
    fireEvent.error(images(view.container)[1]!);
    expect(images(view.container).map((image) => image.getAttribute('src'))).toEqual([WIDE]);
  });

  it('shows another source at once, with no cross-fade', () => {
    const view = render(<ProjectSourceStage project={streetPlace(WIDE)} pending />);
    view.rerender(
      <ProjectSourceStage
        project={streetPlace(ZOOMED, '018f0000-0000-7000-8000-cccccccccccc')}
        pending
      />,
    );
    const shown = images(view.container);
    expect(shown.map((image) => image.getAttribute('src'))).toEqual([ZOOMED]);
    expect(shown[0]?.classList.contains('stage__image--incoming')).toBe(false);
  });

  it('fades over 400ms and keeps the frame hidden until then, with no fade under reduced motion', () => {
    const plain = projectCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(SOURCE_FADE_MS).toBe(400);
    expect(plain).toMatch(/\.stage__image--incoming \{\s*opacity: 0;\s*\}/);
    expect(plain).toMatch(
      /\.stage__image--incoming\[data-fading\] \{\s*opacity: 1;\s*animation: fade-in 400ms var\(--ease-out\);\s*\}/,
    );
    expect(plain).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{\s*\.stage__image--incoming\[data-fading\] \{\s*animation: none;\s*\}\s*\}/,
    );
  });
});
