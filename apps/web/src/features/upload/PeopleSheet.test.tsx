import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedBox } from '@hailiday/core';
import { straightenScale } from '@hailiday/core';
import globalCss from '../../styles/global.css?raw';
import tokensCss from '../../styles/tokens.css?raw';
import { PeopleSheet } from './PeopleSheet';
import uploadCss from './upload.css?raw';

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

describe('the crop tool on the page', () => {
  const style = document.createElement('style');

  afterEach(() => style.remove());

  it('clips the photo and its shade on an inner layer, so no corner handle is clipped', () => {
    style.textContent = [tokensCss, globalCss.replace(/^@import [^;]+;$/gm, ''), uploadCss].join(
      '\n',
    );
    document.head.append(style);
    open(null);
    fireEvent.click(screen.getByRole('button', { name: 'Crop them out' }));
    const crop = document.querySelector<HTMLElement>('.crop')!;
    const clip = crop.querySelector<HTMLElement>(':scope > .crop__clip')!;
    expect(getComputedStyle(clip).overflow).toBe('hidden');
    expect(clip.querySelector('.crop__image')).not.toBeNull();
    // The frame's line and the dimming outside it are drawn inside the clipped layer.
    const shade = clip.querySelector<HTMLElement>('.crop__shade')!;
    expect(getComputedStyle(shade).borderTopWidth).toBe('2px');
    expect(getComputedStyle(shade).boxShadow).toMatch(
      /^rgba\(17, 17, 19, 0\.55\) 0px 0px 0px \d+px$/,
    );
    expect(shade.getAttribute('style')).toBe(
      crop.querySelector('.crop__frame')!.getAttribute('style'),
    );
    const handles = crop.querySelectorAll<HTMLElement>('.crop__handle');
    expect(handles).toHaveLength(4);
    for (const handle of handles) {
      expect(clip.contains(handle)).toBe(false);
      for (let node: HTMLElement | null = handle; node; node = node.parentElement) {
        expect(getComputedStyle(node).overflow, node.className).toBe('visible');
        if (node === crop) break;
      }
    }
  });
});
