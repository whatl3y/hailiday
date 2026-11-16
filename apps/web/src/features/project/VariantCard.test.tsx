import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../../state/appStore';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import { mockReducedMotion, plainSpaces, project, variant } from '../../test/fixtures';
import resultCss from './result.css?raw';
import { nextSliderValue } from './slider';
import { REVEAL_FALLBACK_MS, SWEEP_MS, VariantCard } from './VariantCard';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

function afterLayer(container: HTMLElement): HTMLElement {
  const layer = container.querySelector<HTMLElement>('.compare__after');
  if (!layer) throw new Error('after layer missing');
  return layer;
}

describe('comparison slider keyboard model', () => {
  it('moves 5 with arrows, 20 with Page keys, and jumps with Home and End', () => {
    expect(nextSliderValue(50, 'ArrowRight')).toBe(55);
    expect(nextSliderValue(50, 'ArrowUp')).toBe(55);
    expect(nextSliderValue(50, 'ArrowLeft')).toBe(45);
    expect(nextSliderValue(50, 'ArrowDown')).toBe(45);
    expect(nextSliderValue(50, 'PageUp')).toBe(70);
    expect(nextSliderValue(50, 'PageDown')).toBe(30);
    expect(nextSliderValue(37, 'Home')).toBe(0);
    expect(nextSliderValue(37, 'End')).toBe(100);
  });

  it('stays within 0 to 100 and ignores other keys', () => {
    expect(nextSliderValue(98, 'ArrowRight')).toBe(100);
    expect(nextSliderValue(3, 'ArrowLeft')).toBe(0);
    expect(nextSliderValue(90, 'PageUp')).toBe(100);
    expect(nextSliderValue(10, 'PageDown')).toBe(0);
    expect(nextSliderValue(50, 'Enter')).toBeNull();
  });
});

describe('VariantCard', () => {
  beforeEach(() => mockReducedMotion(false));
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('describes the generated image with the placements of its accepted plan', () => {
    render(
      <VariantCard
        variant={variant({ placements: ['mantel', 'interior_window'] })}
        project={project({ sceneType: 'interior', roomType: 'living_room' })}
      />,
    );
    expect(
      screen.getByAltText(
        'AI preview of your living room decorated for Christmas: decorations on your mantel and ' +
          'your windows',
      ),
    ).toBeTruthy();
  });

  it('exposes the slider pattern and updates it from the keyboard', () => {
    render(<VariantCard variant={variant()} project={project()} />);
    const slider = screen.getByRole('slider', { name: 'Compare before and after' });
    expect(slider.getAttribute('aria-valuemin')).toBe('0');
    expect(slider.getAttribute('aria-valuemax')).toBe('100');
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe('0% before photo');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('5');
    fireEvent.keyDown(slider, { key: 'PageUp' });
    expect(slider.getAttribute('aria-valuenow')).toBe('25');
    expect(slider.getAttribute('aria-valuetext')).toBe('25% before photo');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByRole('button', { name: 'Before' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByRole('button', { name: 'AI preview' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('keeps the toggle in step with the slider', () => {
    render(<VariantCard variant={variant()} project={project()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Before' }));
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('100');
    fireEvent.click(screen.getByRole('button', { name: 'AI preview' }));
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('0');
  });

  it('opens a first result on the photo, then sweeps the divider once to the AI preview', () => {
    vi.useFakeTimers();
    const { container } = render(<VariantCard variant={variant()} project={project()} reveal />);
    expect(afterLayer(container).hasAttribute('data-revealed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Before' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(container.querySelector('.compare__sweep')).toBeNull();
    expect(screen.queryByText('AI preview', { selector: '.badge' })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(REVEAL_FALLBACK_MS);
    });
    // The divider sweeps across the picture; the badge and the handle wait for it.
    expect(afterLayer(container).hasAttribute('data-revealed')).toBe(true);
    expect(container.querySelector('.compare')?.getAttribute('data-sweep')).toBe('reveal');
    expect(container.querySelector('.compare__sweep')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByText('AI preview', { selector: '.badge' })).toBeNull();
    expect(screen.queryByRole('slider')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SWEEP_MS);
    });
    expect(container.querySelector('.compare')?.hasAttribute('data-sweep')).toBe(false);
    expect(container.querySelector('.compare__sweep')).toBeNull();
    expect(screen.getByText('AI preview', { selector: '.badge' })).toBeTruthy();
    expect(screen.getByRole('slider').getAttribute('aria-valuenow')).toBe('0');
  });

  it('does not sweep on a revisit', () => {
    const { container } = render(<VariantCard variant={variant()} project={project()} />);
    expect(container.querySelector('.compare__sweep')).toBeNull();
    expect(container.querySelector('.compare')?.hasAttribute('data-sweep')).toBe(false);
  });

  it('makes the reveal an instant swap under reduced motion', () => {
    mockReducedMotion(true);
    const { container } = render(<VariantCard variant={variant()} project={project()} reveal />);
    const layer = afterLayer(container);
    expect(layer.hasAttribute('data-revealed')).toBe(true);
    expect(layer.hasAttribute('data-instant')).toBe(true);
    expect(screen.getByRole('button', { name: 'AI preview' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('AI preview', { selector: '.badge' })).toBeTruthy();
  });

  it('crossfades to a look chosen from those already made, and swaps instantly under reduced motion', () => {
    const first = variant();
    const second = variant({ holidayId: 'halloween' });
    const { container, rerender } = render(<VariantCard variant={first} project={project()} />);
    rerender(<VariantCard variant={second} project={project()} />);
    const outgoing = container.querySelector('.compare__outgoing');
    expect(outgoing?.getAttribute('src')).toBe(first.imageUrl);
    expect(outgoing?.hasAttribute('data-wipe')).toBe(false);
    expect(container.querySelector('.compare__sweep')).toBeNull();
    cleanup();

    mockReducedMotion(true);
    const reduced = render(<VariantCard variant={first} project={project()} />);
    reduced.rerender(<VariantCard variant={second} project={project()} />);
    expect(reduced.container.querySelector('.compare__outgoing')).toBeNull();
  });

  it('sweeps the divider over a look that arrives while the person watches', () => {
    vi.useFakeTimers();
    const first = variant();
    const second = variant({ holidayId: 'halloween' });
    const { container, rerender } = render(
      <VariantCard variant={first} project={project()} pending />,
    );
    expect(container.querySelector('.stage__sheen')).not.toBeNull();
    expect(container.querySelector('.stage .light-string')).not.toBeNull();
    expect(container.querySelector('.stage__progress')).toBeNull();
    rerender(<VariantCard variant={second} project={project()} pending={false} />);
    // The string leaves at once when the look arrives; the sweep follows.
    expect(container.querySelector('.light-string')).toBeNull();
    expect(container.querySelector('.compare')?.getAttribute('data-sweep')).toBe('change');
    const outgoing = container.querySelector('.compare__outgoing');
    expect(outgoing?.getAttribute('src')).toBe(first.imageUrl);
    expect(outgoing?.hasAttribute('data-wipe')).toBe(true);
    expect(container.querySelector('.stage__sheen')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(SWEEP_MS);
    });
    expect(container.querySelector('.compare__outgoing')).toBeNull();
    expect(container.querySelector('.compare')?.hasAttribute('data-sweep')).toBe(false);
  });

  it('swaps a look that arrives while watching instantly under reduced motion', () => {
    mockReducedMotion(true);
    const first = variant();
    const second = variant({ holidayId: 'halloween' });
    const { container, rerender } = render(
      <VariantCard variant={first} project={project()} pending />,
    );
    rerender(<VariantCard variant={second} project={project()} pending={false} />);
    expect(container.querySelector('.compare__outgoing')).toBeNull();
    expect(container.querySelector('.compare__sweep')).toBeNull();
  });

  describe('AI preview badge corner', () => {
    function corner(container: HTMLElement): HTMLElement {
      const element = container.querySelector<HTMLElement>('.image-card__corner');
      if (!element) throw new Error('badge corner missing');
      expect(element.textContent).toBe('AI preview');
      return element;
    }

    it('sits in the lower-right corner of an upload-origin preview', () => {
      const { container } = render(<VariantCard variant={variant()} project={project()} />);
      const element = corner(container);
      expect(element.classList.contains('image-card__corner--lower-right')).toBe(true);
      expect(element.classList.contains('image-card__corner--upper-left')).toBe(false);
    });

    it('moves to the upper-left corner of a Street View preview, off its logo and copyright', () => {
      const { container } = render(
        <VariantCard
          variant={variant({
            attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
          })}
          project={project()}
        />,
      );
      const element = corner(container);
      expect(element.classList.contains('image-card__corner--upper-left')).toBe(true);
      expect(element.classList.contains('image-card__corner--lower-right')).toBe(false);
      expect(element.dataset.corner).toBe('upper-left');
    });

    it('treats a preview made from a fixture Street View frame as Street View origin', () => {
      const base = project();
      const { container } = render(
        <VariantCard
          variant={variant()}
          project={project({ activeSource: { ...base.activeSource!, kind: 'fixture' } })}
        />,
      );
      expect(corner(container).dataset.corner).toBe('upper-left');
    });

    describe('while the slider splits the image', () => {
      // The base and result stylesheets in the document, so the computed style follows the
      // real cascade and the divider position the card sets.
      const style = document.createElement('style');
      beforeEach(() => {
        style.textContent = [
          tokensCss,
          globalCss.replace(/^@import [^;]+;$/gm, ''),
          resultCss,
        ].join('\n');
        document.head.append(style);
      });
      afterEach(() => style.remove());

      it('keeps a Street View badge on the generated pixels by riding with the divider', () => {
        const { container } = render(
          <VariantCard
            variant={variant({
              attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
            })}
            project={project()}
          />,
        );
        const slider = screen.getByRole('slider', { name: 'Compare before and after' });
        expect(getComputedStyle(corner(container)).left).toBe('calc(0% + 12px)');
        for (const [key, before] of [
          ['PageUp', 20],
          ['PageUp', 40],
          ['PageUp', 60],
          ['PageUp', 80],
        ] as const) {
          fireEvent.keyDown(slider, { key });
          const element = corner(container);
          // Still clipped with the generated layer, and always just right of the divider.
          expect(afterLayer(container).contains(element)).toBe(true);
          expect(element.dataset.corner).toBe('upper-left');
          expect(element.getAttribute('style')).toBeNull();
          expect(getComputedStyle(element).left).toBe(`calc(${before}% + 12px)`);
          expect(getComputedStyle(element).top).toBe('12px');
        }
      });

      it('leaves an upload badge pinned in its lower-right corner', () => {
        const { container } = render(<VariantCard variant={variant()} project={project()} />);
        const slider = screen.getByRole('slider', { name: 'Compare before and after' });
        for (const key of ['PageUp', 'PageUp']) {
          fireEvent.keyDown(slider, { key });
          const computed = getComputedStyle(corner(container));
          expect(computed.left).toBe('auto');
          expect(computed.right).toBe('12px');
          expect(computed.bottom).toBe('12px');
        }
      });
    });
  });

  describe('fixture badges', () => {
    const streetView = () =>
      variant({ attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' } });
    const fixtureProject = () => {
      const base = project();
      return project({ activeSource: { ...base.activeSource!, kind: 'fixture' } });
    };

    beforeEach(() => {
      useAppStore.setState({ fixtureCapabilities: ['image_editing', 'street_view_display'] });
    });
    afterEach(() => {
      useAppStore.setState({ fixtureCapabilities: [] });
    });

    /** The fixture badges by side of the upper badge row: [left, right]. */
    function sides(container: HTMLElement): [number, number] {
      const row = container.querySelectorAll('.image-card__badges > span');
      expect(row).toHaveLength(2);
      return [
        row[0]!.querySelectorAll('.badge--fixture').length,
        row[1]!.querySelectorAll('.badge--fixture').length,
      ];
    }

    it('keep a Street View frame fixture badge at the upper right, clear of the AI preview badge', () => {
      const { container } = render(
        <VariantCard variant={streetView()} project={fixtureProject()} />,
      );
      expect(sides(container)).toEqual([0, 1]);
      const slider = screen.getByRole('slider', { name: 'Compare before and after' });
      // Split: both layers are fixture evidence, one badge at the upper right covers them.
      fireEvent.keyDown(slider, { key: 'PageUp' });
      expect(sides(container)).toEqual([0, 1]);
      // The before photo alone.
      fireEvent.keyDown(slider, { key: 'End' });
      expect(sides(container)).toEqual([0, 1]);
      expect(container.querySelector('.image-card__corner')).toBeNull();
    });

    it('keep the generated layer fixture badge at the upper right of an upload preview', () => {
      const { container } = render(<VariantCard variant={variant()} project={project()} />);
      expect(sides(container)).toEqual([0, 1]);
      const slider = screen.getByRole('slider', { name: 'Compare before and after' });
      fireEvent.keyDown(slider, { key: 'PageUp' });
      expect(sides(container)).toEqual([0, 1]);
      fireEvent.keyDown(slider, { key: 'End' });
      expect(sides(container)).toEqual([0, 0]);
    });
  });

  it('labels the look with its lighting where the scene offers evening', () => {
    render(
      <VariantCard
        variant={variant({ style: 'abundant', lightingMode: 'evening' })}
        project={project()}
      />,
    );
    expect(screen.getByText('Christmas · Abundant · Evening')).toBeTruthy();
  });

  it('leaves the lighting out of the label where the scene offers one lighting mode', () => {
    const interior = project({
      sceneType: 'interior',
      offered: {
        styles: ['subtle', 'classic', 'abundant'],
        defaultStyle: 'abundant',
        lightingModes: ['source'],
        defaultLightingMode: 'source',
      },
    });
    const { container } = render(
      <VariantCard variant={variant({ style: 'abundant' })} project={interior} />,
    );
    expect(plainSpaces(container.querySelector('.variant__label')?.textContent)).toBe(
      'Christmas · Abundant',
    );
  });

  it('puts the switch in the stage corner and the title with the actions on the line under it', () => {
    const { container } = render(
      <VariantCard
        variant={variant()}
        project={project()}
        heading={<h1>Title</h1>}
        actions={<div className="actions">Save</div>}
      />,
    );
    expect(container.querySelector('.stage__overlay > .variant__toggle')).not.toBeNull();
    const head = container.querySelector('.picture-head')!;
    expect(head.querySelector('.picture-head__title')?.firstElementChild?.textContent).toBe(
      'Title',
    );
    expect(head.lastElementChild?.textContent).toBe('Save');
  });

  it('never puts anything over the lower corners of a Street View frame', () => {
    const { container } = render(
      <VariantCard
        variant={variant({
          attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
        })}
        project={project()}
      />,
    );
    // The switch rests in the upper corner and the badge at the upper left.
    expect(container.querySelector('.stage__overlay')).not.toBeNull();
    expect(container.querySelector('.image-card__corner--upper-left')).not.toBeNull();
    expect(container.querySelector('.image-card__corner--lower-right')).toBeNull();
    // The attribution prints once, on the paper under the picture.
    expect(container.querySelectorAll('.attribution')).toHaveLength(1);
    expect(container.querySelector('.stage .attribution')).toBeNull();
  });

  it('keeps "Your photo" or the attribution in the strip in every comparison state', () => {
    render(
      <VariantCard
        variant={variant({
          attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
        })}
        project={project()}
      />,
    );
    const slider = screen.getByRole('slider');
    for (const key of ['Home', 'PageUp', 'End']) {
      fireEvent.keyDown(slider, { key });
      expect(screen.getByText('Google Maps')).toBeTruthy();
      expect(screen.getByText('© 2025 Google')).toBeTruthy();
    }
  });
});
