import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RetryAfterButton } from './RetryAfterButton';

describe('RetryAfterButton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('stays disabled until the wait has passed, then retries', () => {
    const onRetry = vi.fn();
    render(<RetryAfterButton retryAfterSeconds={3} onRetry={onRetry} />);
    const button = screen.getByRole('button', { name: 'Try again' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(onRetry).not.toHaveBeenCalled();
    for (let second = 0; second < 3; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(button.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
