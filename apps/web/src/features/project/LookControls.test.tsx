import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import type { PublicExperience } from '../../experience/payload';
import { useAppStore } from '../../state/appStore';
import { INITIAL_PROJECT_FLOW, lookOf, useProjectStore } from '../../state/projectStore';
import { allowance, project, variant } from '../../test/fixtures';
import { LookControls } from './LookControls';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  createRender: vi.fn(),
  cancelRender: vi.fn(),
  listVariants: vi.fn(),
}));

const api = vi.mocked(endpoints);

const experience = {
  holidays: [
    { id: 'christmas', sceneTypes: { house_exterior: {} } },
    { id: 'halloween', sceneTypes: { house_exterior: {} } },
  ],
  examples: [],
  clientConfig: {},
} as unknown as PublicExperience;

const current = variant();

function onResult(making: boolean) {
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    project: project({ variantCount: 1 }),
    phase: 'result',
    variant: current,
    variants: [current],
    look: making ? { ...lookOf(current), style: 'abundant' } : lookOf(current),
    pending: making ? { look: { ...lookOf(current), style: 'abundant' }, render: null } : null,
  });
}

beforeEach(() => {
  useAppStore.setState({
    experience,
    allowance: allowance(3),
    pickerHolidayIds: ['christmas', 'halloween'],
    explicitHolidayId: null,
    deepLinkHolidayId: null,
    clientDefaultHolidayId: 'christmas',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('the look controls while a look is being made', () => {
  it('lock every choice, keep the choice being made filled and show the lock line', () => {
    onResult(true);
    const { container } = render(<LookControls />);
    const buttons = within(container).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(4);
    for (const button of buttons) {
      expect(button.getAttribute('aria-disabled'), button.textContent ?? '').toBe('true');
      expect(button.getAttribute('aria-describedby')).toBe('look-lock-hint');
    }
    expect(container.querySelector('.look-controls')?.hasAttribute('data-locked')).toBe(true);
    expect(screen.getByRole('button', { name: 'Abundant' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(container.querySelector('.look-controls__locked')?.textContent).toBe(
      'You can pick another look when this one is ready.',
    );
    expect(container.querySelector('.allowance-counter')).toBeNull();
  });

  it('change nothing when pressed, record no holiday and say why', () => {
    onResult(true);
    render(<LookControls />);
    fireEvent.click(screen.getByRole('button', { name: 'Halloween' }));
    fireEvent.click(screen.getByRole('button', { name: 'Subtle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Evening' }));
    const state = useProjectStore.getState();
    expect(state.lockedNotice).toBe(3);
    expect(state.pending?.look.style).toBe('abundant');
    expect(state.variant).toBe(current);
    expect(useAppStore.getState().explicitHolidayId).toBeNull();
    expect(api.createRender).not.toHaveBeenCalled();
    expect(api.listVariants).not.toHaveBeenCalled();
  });

  it('are unlocked, with the allowance counter, when no look is being made', () => {
    onResult(false);
    const { container } = render(<LookControls />);
    for (const button of within(container).getAllByRole('button')) {
      expect(button.hasAttribute('aria-disabled')).toBe(false);
      expect(button.hasAttribute('aria-describedby')).toBe(false);
    }
    expect(container.querySelector('.look-controls')?.hasAttribute('data-locked')).toBe(false);
    expect(container.querySelector('.look-controls__locked')).toBeNull();
    expect(container.querySelector('.allowance-counter')?.textContent).toBe('3 more looks today');
  });
});
