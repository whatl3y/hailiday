import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedBox } from '@holiday/core';
import { straightenScale } from '@holiday/core';
import { PeopleSheet } from './PeopleSheet';

afterEach(cleanup);

function open(suggestedCropBox: NormalizedBox | null) {
  const onCrop = vi.fn<(box: NormalizedBox, rotation: number) => void>();
  render(
    <PeopleSheet
      imageUrl="blob:preview"
      width={1600}
      height={1200}
      boxes={[[0.1, 0.1, 0.9, 0.9]]}
      suggestedCropBox={suggestedCropBox}
      onCrop={onCrop}
      onKeep={vi.fn()}
      onReplace={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onCrop;
}

describe('PeopleSheet', () => {
  it('offers "Crop them out" with the whole photo when no crop could be suggested', () => {
    const onCrop = open(null);
    fireEvent.click(screen.getByRole('button', { name: 'Crop them out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this crop' }));
    expect(onCrop).toHaveBeenCalledWith([0, 0, 1, 1], 0);
  });

  it('starts the frame on the suggested crop', () => {
    const onCrop = open([0.4, 0, 1, 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Crop them out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use this crop' }));
    expect(onCrop).toHaveBeenCalledWith([0.4, 0, 1, 1], 0);
  });

  it('straightens the photo with an accessible slider and sends the angle with the frame', () => {
    const onCrop = open([0.4, 0, 1, 1]);
    fireEvent.click(screen.getByRole('button', { name: 'Crop them out' }));
    const slider = screen.getByRole('slider', { name: 'Straighten' });
    expect(slider.getAttribute('tabindex')).toBe('0');
    expect(slider.getAttribute('aria-valuemin')).toBe('-15');
    expect(slider.getAttribute('aria-valuemax')).toBe('15');
    expect(slider.getAttribute('aria-valuenow')).toBe('0');
    expect(slider.getAttribute('aria-valuetext')).toBe('Level');

    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(slider.getAttribute('aria-valuenow')).toBe('1');
    expect(slider.getAttribute('aria-valuetext')).toBe('1° clockwise');
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(slider.getAttribute('aria-valuetext')).toBe('4° counterclockwise');
    fireEvent.keyDown(slider, { key: 'Home' });
    expect(slider.getAttribute('aria-valuenow')).toBe('-15');
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(slider.getAttribute('aria-valuenow')).toBe('-15');
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.keyDown(slider, { key: 'PageDown' });
    expect(slider.getAttribute('aria-valuenow')).toBe('10');

    // The preview turns and zooms the photo exactly as the server will.
    const image = document.querySelector<HTMLImageElement>('.crop__image');
    const transform = /^rotate\(10deg\) scale\(([\d.]+)\)$/.exec(image?.style.transform ?? '');
    expect(Number(transform?.[1])).toBeCloseTo(straightenScale(10, 1600, 1200), 4);

    fireEvent.click(screen.getByRole('button', { name: 'Use this crop' }));
    expect(onCrop).toHaveBeenCalledWith([0.4, 0, 1, 1], 10);
  });
});
