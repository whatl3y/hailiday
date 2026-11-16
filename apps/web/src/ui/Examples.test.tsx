import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicExperience } from '../experience/payload';
import { useAppStore } from '../state/appStore';
import { ExampleGallery } from './Examples';

const experience = {
  examples: [
    {
      holidayId: 'christmas',
      sceneType: 'house_exterior',
      style: 'classic',
      lightingMode: 'evening',
      beforeUrl: 'https://cdn.test/example-before.jpg',
      afterUrl: 'https://cdn.test/example-after.jpg',
      width: 1600,
      height: 1200,
      captionKey: 'example.christmas.house_exterior',
    },
  ],
} as unknown as PublicExperience;

beforeEach(() => {
  useAppStore.setState({ experience });
});

afterEach(() => {
  cleanup();
});

describe('example cards', () => {
  it('keep the AI preview badge in the lower-right corner (examples are never Street View frames)', () => {
    const { container } = render(<ExampleGallery holidayId="christmas" />);
    const corner = container.querySelector<HTMLElement>('.image-card__corner');
    expect(corner?.textContent).toBe('AI preview');
    expect(corner?.classList.contains('image-card__corner--lower-right')).toBe(true);
    expect(corner?.classList.contains('image-card__corner--upper-left')).toBe(false);
  });

  it('describe the before and AI preview images differently from the caption and toggle', () => {
    render(<ExampleGallery holidayId="christmas" />);
    const group = screen.getByRole('group');
    const image = screen.getByRole('img');
    const afterAlt = image.getAttribute('alt');
    expect(afterAlt).toBe('Example AI preview: a house exterior decorated for Christmas');
    expect(screen.getByText('Example: Christmas house exterior')).toBeTruthy();
    expect(group.getAttribute('aria-label')).not.toBe(afterAlt);
    expect(group.getAttribute('aria-label')).not.toBe('Example: Christmas house exterior');

    fireEvent.click(within(group).getByRole('button', { name: 'Before' }));
    const beforeAlt = screen.getByRole('img').getAttribute('alt');
    expect(screen.getByRole('img').getAttribute('src')).toBe('https://cdn.test/example-before.jpg');
    expect(beforeAlt).toBe('Example photo: the same house exterior before decorating');
    expect(beforeAlt).not.toBe(afterAlt);
  });
});
