import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INITIAL_PROJECT_FLOW, useProjectStore } from '../../state/projectStore';
import { mockReducedMotion, project, variant } from '../../test/fixtures';
import type * as Controller from './controller';
import { Result } from './Result';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({
  createClick: vi.fn(async () => undefined),
  createFeedback: vi.fn(async () => undefined),
  deleteProject: vi.fn(async () => undefined),
  getProducts: vi.fn(() => new Promise(() => undefined)),
  listVariants: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock('./controller', async (importOriginal) => ({
  ...(await importOriginal<typeof Controller>()),
  changeSceneType: vi.fn(async () => undefined),
}));

function renderFirstResult() {
  const first = variant();
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'result',
    project: project(),
    variant: first,
    revealFor: first.renderAssetId,
  });
  return render(
    <MemoryRouter>
      <Result />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('the first-result reveal', () => {
  it('holds the rest of the screen back for the reveal', () => {
    mockReducedMotion(false);
    const { container } = renderFirstResult();
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(true);
  });

  it('does not hold the screen back once the reveal is over', () => {
    mockReducedMotion(false);
    const { container } = renderFirstResult();
    act(() => useProjectStore.setState({ revealFor: null }));
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(false);
  });

  it('shows everything at once under reduced motion', () => {
    mockReducedMotion(true);
    const { container } = renderFirstResult();
    expect(container.querySelector('.result')?.hasAttribute('data-revealing')).toBe(false);
  });
});
