import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Disclosure } from './Disclosure';

afterEach(cleanup);

function Counter() {
  const [n, setN] = useState(0);
  return (
    <button type="button" onClick={() => setN(n + 1)}>
      Count {n}
    </button>
  );
}

describe('Disclosure', () => {
  it('starts collapsed, with a button that controls a labelled region', () => {
    render(
      <Disclosure label="Try another look" summary="Christmas · Abundant">
        <p>Panel content</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: /Try another look/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('role')).toBe('region');
    expect(panel.hidden).toBe(true);
    expect(screen.queryByText('Panel content')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    expect(button.closest('h2')).not.toBeNull();
    expect(screen.getByText('Christmas · Abundant')).toBeTruthy();
  });

  it('opens and closes the region, named by its label alone', () => {
    const onToggle = vi.fn();
    render(
      <Disclosure label="Shop the look" summary="3 items" onToggle={onToggle}>
        <p>Cards</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: /Shop the look/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('region', { name: 'Shop the look' })).toBeTruthy();
    expect(screen.getByText('Cards')).toBeTruthy();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('region')).toBeNull();
    expect(onToggle.mock.calls).toEqual([[true], [false]]);
  });

  it('mounts its content on the first opening and keeps it while collapsed', () => {
    render(
      <Disclosure label="More">
        <Counter />
      </Disclosure>,
    );
    const toggle = screen.getByRole('button', { name: 'More' });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Count 0' }));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Count 1' })).toBeTruthy();
  });

  it('leaves another row open when one opens', () => {
    render(
      <>
        <Disclosure label="First">
          <p>One</p>
        </Disclosure>
        <Disclosure label="Second">
          <p>Two</p>
        </Disclosure>
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'First' }));
    fireEvent.click(screen.getByRole('button', { name: 'Second' }));
    expect(screen.getByRole('button', { name: 'First' }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(screen.getAllByRole('region')).toHaveLength(2);
  });
});
