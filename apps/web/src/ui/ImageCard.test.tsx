import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AiPreviewBadge, ImageCard } from './ImageCard';

afterEach(() => {
  cleanup();
});

/** The number of fixture badges on each side of the upper badge row: [left, right]. */
function fixtureSides(container: HTMLElement): [number, number] {
  const row = container.querySelectorAll('.image-card__badges > span');
  expect(row).toHaveLength(2);
  return [
    row[0]!.querySelectorAll('.badge--fixture').length,
    row[1]!.querySelectorAll('.badge--fixture').length,
  ];
}

describe('ImageCard corner marks', () => {
  it('moves the fixture badge to the upper right when the corner mark takes the upper left', () => {
    const { container } = render(
      <ImageCard fixture corner={<AiPreviewBadge />} cornerPlacement="upper-left">
        <img src="https://cdn.test/a.jpg" alt="" />
      </ImageCard>,
    );
    expect(fixtureSides(container)).toEqual([0, 1]);
    const corner = container.querySelector<HTMLElement>('.image-card__corner');
    expect(corner?.dataset.corner).toBe('upper-left');
    expect(corner?.classList.contains('image-card__corner--upper-left')).toBe(true);
  });

  it('keeps the fixture badge at the upper left with a lower-right corner mark', () => {
    const { container } = render(
      <ImageCard fixture corner={<AiPreviewBadge />}>
        <img src="https://cdn.test/a.jpg" alt="" />
      </ImageCard>,
    );
    expect(fixtureSides(container)).toEqual([1, 0]);
    expect(container.querySelector<HTMLElement>('.image-card__corner')?.dataset.corner).toBe(
      'lower-right',
    );
  });
});
