import { describe, expect, it } from 'vitest';
import { allowance } from '../test/fixtures';
import { useAppStore } from './appStore';

describe('budget banner', () => {
  it('follows the latest allowance gate, so it clears once generation resumes', () => {
    useAppStore.setState({ budgetPaused: false });
    useAppStore.getState().setAllowance({ ...allowance(3), gate: 'budget_paused' });
    expect(useAppStore.getState().budgetPaused).toBe(true);
    useAppStore.getState().setAllowance(allowance(3));
    expect(useAppStore.getState().budgetPaused).toBe(false);
  });
});
