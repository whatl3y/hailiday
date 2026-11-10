import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockReducedMotion, project, variant } from '../../test/fixtures';
import { nextSliderValue } from './slider';
import { REVEAL_FALLBACK_MS, VariantCard } from './VariantCard';

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

  it('opens a first result on the photo, then crossfades to the AI preview', () => {
    vi.useFakeTimers();
    const { container } = render(<VariantCard variant={variant()} project={project()} reveal />);
    expect(afterLayer(container).hasAttribute('data-revealed')).toBe(false);
    expect(screen.getByRole('button', { name: 'Before' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByText('AI preview', { selector: '.badge' })).toBeNull();
    act(() => {
      vi.advanceTimersByTime(REVEAL_FALLBACK_MS);
    });
    expect(afterLayer(container).hasAttribute('data-revealed')).toBe(true);
    expect(screen.getByText('AI preview', { selector: '.badge' })).toBeTruthy();
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

  it('crossfades to a new look, and swaps instantly under reduced motion', () => {
    const first = variant();
    const second = variant({ holidayId: 'halloween' });
    const { container, rerender } = render(<VariantCard variant={first} project={project()} />);
    rerender(<VariantCard variant={second} project={project()} />);
    expect(container.querySelector('.compare__outgoing')?.getAttribute('src')).toBe(first.imageUrl);
    cleanup();

    mockReducedMotion(true);
    const reduced = render(<VariantCard variant={first} project={project()} />);
    reduced.rerender(<VariantCard variant={second} project={project()} />);
    expect(reduced.container.querySelector('.compare__outgoing')).toBeNull();
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
      expect(element.classList.contains('image-card__corner--lower-left')).toBe(false);
    });

    it('moves to the lower-left corner of a Street View preview, off its burned-in credit', () => {
      const { container } = render(
        <VariantCard
          variant={variant({
            attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
          })}
          project={project()}
        />,
      );
      const element = corner(container);
      expect(element.classList.contains('image-card__corner--lower-left')).toBe(true);
      expect(element.classList.contains('image-card__corner--lower-right')).toBe(false);
    });

    it('treats a preview made from a fixture Street View frame as Street View origin', () => {
      const base = project();
      const { container } = render(
        <VariantCard
          variant={variant()}
          project={project({ activeSource: { ...base.activeSource!, kind: 'fixture' } })}
        />,
      );
      expect(corner(container).dataset.corner).toBe('lower-left');
    });

    it('stays pinned in its corner on the generated layer while the slider splits the image', () => {
      const { container } = render(
        <VariantCard
          variant={variant({
            attribution: { required: true, text: '© 2025 Google', logo: 'google_maps' },
          })}
          project={project()}
        />,
      );
      const slider = screen.getByRole('slider', { name: 'Compare before and after' });
      for (const key of ['PageUp', 'PageUp', 'PageUp', 'PageUp']) {
        fireEvent.keyDown(slider, { key });
        const element = corner(container);
        expect(afterLayer(container).contains(element)).toBe(true);
        expect(element.dataset.corner).toBe('lower-left');
        expect(element.getAttribute('style')).toBeNull();
      }
    });
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
