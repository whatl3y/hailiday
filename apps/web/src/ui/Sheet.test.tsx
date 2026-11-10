import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

/** A sheet whose first control replaces itself with other content when used. */
function SwappingSheet() {
  const [swapped, setSwapped] = useState(false);
  return (
    <>
      <button type="button">Behind the sheet</button>
      <Sheet title="People in the photo" onClose={vi.fn()}>
        {swapped ? (
          <>
            <p>Drag the corners to adjust the frame.</p>
            <button type="button">Use this crop</button>
          </>
        ) : (
          <button type="button" onClick={() => setSwapped(true)}>
            Crop them out
          </button>
        )}
        <button type="button">Keep as is</button>
      </Sheet>
    </>
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

function tab(shiftKey = false) {
  fireEvent.keyDown(document, { key: 'Tab', shiftKey });
}

afterEach(() => {
  cleanup();
  document.getElementById('root')?.remove();
});

describe('Sheet focus containment', () => {
  it('brings focus back into the sheet when the focused control unmounts', async () => {
    render(<SwappingSheet />);
    const dialog = screen.getByRole('dialog');
    const crop = screen.getByRole('button', { name: 'Crop them out' });
    expect(document.activeElement).toBe(crop);
    fireEvent.click(crop);
    await settle();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(dialog);
  });

  it('re-enters the sheet on Tab when focus has fallen out of it', () => {
    render(<SwappingSheet />);
    const dialog = screen.getByRole('dialog');
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('moves Shift+Tab from the dialog itself to the last control', () => {
    render(<SwappingSheet />);
    const dialog = screen.getByRole('dialog');
    dialog.focus();
    tab(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep as is' }));
  });

  it('still wraps from the last control to the first', () => {
    render(<SwappingSheet />);
    screen.getByRole('button', { name: 'Keep as is' }).focus();
    tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
  });

  it('makes the app root inert while open and restores it on close', () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    function Toggle() {
      const [open, setOpen] = useState(true);
      return open ? (
        <Sheet title="Examples" onClose={() => setOpen(false)}>
          <button type="button">Got it</button>
        </Sheet>
      ) : null;
    }
    render(<Toggle />, { container: root.appendChild(document.createElement('div')) });
    expect(root.hasAttribute('inert')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('lets only the newest of two open sheets handle Tab and Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <>
        <Sheet title="Share this preview" onClose={closeOuter}>
          <button type="button">Copy link</button>
        </Sheet>
        <Sheet title="Lots of people" onClose={closeInner}>
          <button type="button">Try again</button>
        </Sheet>
      </>,
    );
    const [, inner] = screen.getAllByRole('dialog');
    const retry = screen.getByRole('button', { name: 'Try again' });
    retry.focus();
    tab();
    expect(inner!.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });
});
