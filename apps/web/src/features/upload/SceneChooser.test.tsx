import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SceneChooser } from './SceneChooser';

afterEach(cleanup);

const pressed = () =>
  screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.textContent);

describe('SceneChooser', () => {
  it('marks the current scene type when the person may change it', () => {
    render(
      <SceneChooser
        value={{ sceneType: 'apartment_entry', roomType: null }}
        required={false}
        onChoose={vi.fn()}
      />,
    );
    expect(pressed()).toEqual(['Apartment entry']);
  });

  it('marks nothing when the choice is required, and a tap on the guessed type chooses it', () => {
    const onChoose = vi.fn();
    render(
      <SceneChooser
        value={{ sceneType: 'apartment_entry', roomType: null }}
        required
        onChoose={onChoose}
      />,
    );
    expect(screen.getByText("What's in this photo?")).toBeTruthy();
    expect(pressed()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Apartment entry' }));
    expect(onChoose).toHaveBeenCalledWith({ sceneType: 'apartment_entry', roomType: null });
  });

  it('asks the room only after "A room inside" is tapped when the choice is required', () => {
    const onChoose = vi.fn();
    render(
      <SceneChooser
        value={{ sceneType: 'interior', roomType: 'dining_room' }}
        required
        onChoose={onChoose}
      />,
    );
    expect(pressed()).toEqual([]);
    expect(screen.queryByRole('button', { name: /dining room/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'A room inside' }));
    expect(pressed()).toEqual(['A room inside']);
    fireEvent.click(screen.getByRole('button', { name: /dining room/i }));
    expect(onChoose).toHaveBeenCalledWith({ sceneType: 'interior', roomType: 'dining_room' });
  });
});
