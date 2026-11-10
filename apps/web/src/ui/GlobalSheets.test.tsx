import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../state/appStore';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../state/projectStore';
import { project, variant } from '../test/fixtures';
import { GlobalSheets } from './GlobalSheets';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useAppStore.setState({ sheet: null });
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('the capacity sheet', () => {
  it('keeps the ticking countdown out of live regions and announces readiness once', () => {
    useAppStore.setState({ sheet: { kind: 'capacity', retryAfterSeconds: 3, onRetry: null } });
    render(<GlobalSheets />);
    const dialog = screen.getByRole('dialog');
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    const countdown = screen.getByText(/Lots of people are decorating right now/, {
      selector: 'p.lede',
    });
    expect(countdown.closest('[aria-live]')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(status.textContent).toBe('');
    for (let second = 0; second < 2; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(status.textContent).toBe('You can try again now.');
    expect(dialog.querySelectorAll('[aria-live]').length).toBe(0);
  });
});

describe('the allowance sheet', () => {
  const sheet = { kind: 'allowance', scope: 'variants', resetsAt: null } as const;

  it('promises the previews only when the project has one', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: project(), variant: variant() });
    useAppStore.setState({ sheet });
    render(<GlobalSheets />);
    expect(screen.getByText(/Your previews stay here/)).toBeTruthy();
  });

  it('speaks of the attached photo over a project with no preview yet', () => {
    useProjectStore.setState({ ...INITIAL_PROJECT_FLOW, project: project(), variant: null });
    useAppStore.setState({ sheet });
    render(<GlobalSheets />);
    expect(screen.queryByText(/Your previews stay here/)).toBeNull();
    expect(screen.getByText(/Your place stays here, ready to decorate then\./)).toBeTruthy();
  });
});
