import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublicExperience } from '../experience/payload';
import { LegalPage } from '../features/legal/LegalPage';
import { useAppStore } from '../state/appStore';
import { COPY_DECK } from './deck';
import { retentionText, type RetentionLine } from './retention';

vi.mock('../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));

const LINES: RetentionLine[] = ['upload', 'longWait', 'save', 'privacy'];

function withRetention(timeBasedDeletion: boolean) {
  useAppStore.setState({
    experience: {
      holidays: [],
      clientConfig: { retention: { timeBasedDeletion } },
    } as unknown as PublicExperience,
  });
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ experience: null });
});

describe('retention lines', () => {
  it('promise no deletion while time-based deletion is off', () => {
    for (const line of LINES) {
      const text = retentionText(line, false);
      expect(text, line).not.toMatch(/deleted after|24 hours|13 months|\{/);
    }
    expect(retentionText('upload', false)).toBe(
      'Your photo is private. We keep your looks so you can come back to them.',
    );
  });

  it('name the schedule while time-based deletion is on', () => {
    expect(retentionText('upload', true)).toBe(
      'Your photo is private. Unsaved projects are deleted after 24 hours.',
    );
    expect(retentionText('longWait', true)).toContain('for 24 hours');
    expect(retentionText('save', true)).toContain('for 13 months');
    expect(retentionText('privacy', true)).toContain('deleted after 24 hours');
  });

  it('follow the experience payload on the privacy page', () => {
    withRetention(false);
    const { unmount } = render(
      <MemoryRouter>
        <LegalPage page="privacy" />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(
        'Your photos stay private. We keep your places and looks until you delete them.',
      ),
    ).toBeTruthy();
    unmount();
    withRetention(true);
    render(
      <MemoryRouter>
        <LegalPage page="privacy" />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Unsaved projects are deleted after 24 hours/)).toBeTruthy();
  });
});

describe('street photo copy', () => {
  it('holds for contributor imagery and the display-only policy alike', () => {
    for (const key of [
      'interim.explain',
      'error.SOURCE_NOT_EDITABLE',
      'result.shareUnavailable',
    ] as const) {
      expect(COPY_DECK[key], key).not.toMatch(/\byet\b|licen[cs]/i);
    }
  });
});
