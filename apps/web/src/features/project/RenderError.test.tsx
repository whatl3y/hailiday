import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RenderStatus } from '@hailiday/core';
import {
  INITIAL_PROJECT_FLOW,
  useProjectStore,
  type ProjectFlowState,
} from '../../state/projectStore';
import { mockReducedMotion, project, renderStatus } from '../../test/fixtures';
import { discover, retryRender, showUpload } from './controller';
import { RenderError } from './RenderError';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({}));
vi.mock('./controller', () => ({
  retryRender: vi.fn(),
  showUpload: vi.fn(),
  discover: vi.fn(async () => undefined),
}));

const streetPlace = project({
  activeSource: {
    ...project().activeSource!,
    kind: 'street_view',
    sourceMode: 'persist',
    isGoogleImagery: true,
    copyright: '© 2026 Google',
  },
});

function renderEnded(status: Partial<RenderStatus>, extra: Partial<ProjectFlowState> = {}) {
  mockReducedMotion(true);
  useProjectStore.setState({
    ...INITIAL_PROJECT_FLOW,
    phase: 'render_error',
    project: project(),
    render: renderStatus(status),
    ...extra,
  });
  return render(
    <MemoryRouter>
      <RenderError />
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

describe('a first look that ended with nothing to show', () => {
  it("keeps the place's photo and says so calmly, with no sheet and a way forward", () => {
    renderEnded({ state: 'rejected', rejectionReason: 'qa_critical' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Your place' })).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy();
    expect(
      screen.getByText(
        "We couldn't finish this look. Nothing was counted against your looks today.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/error|didn't work out|happy with/i)).toBeNull();
    const tryAgain = screen.getByRole('button', { name: 'Try again' });
    expect(tryAgain.className).toContain('button--primary');
    fireEvent.click(tryAgain);
    expect(vi.mocked(retryRender)).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Use another photo' }));
    expect(vi.mocked(showUpload)).toHaveBeenCalledWith('replace');
  });

  it('says the same after a failure of the decorating service', () => {
    renderEnded({ state: 'failed', failureKind: 'timeout' });
    expect(
      screen.getByText(
        "We couldn't finish this look. Nothing was counted against your looks today.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/having trouble/)).toBeNull();
  });

  it('says why a photo cannot be decorated, without "Try again"', () => {
    renderEnded({ state: 'failed', failureKind: 'policy_denied' });
    expect(screen.getByText("We can't decorate this photo. Try a different photo.")).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Use another photo' })).toBeTruthy();
  });

  it('says why another request could not start, above the notice', () => {
    renderEnded(
      { state: 'rejected', rejectionReason: 'qa_critical' },
      {
        inlineError: "You're moving fast. Give it a moment and try again.",
        inlineRetry: { id: 1, retryAfterSeconds: 30, retry: () => undefined },
      },
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe("You're moving fast. Give it a moment and try again.");
    const notice = screen.getByText(
      "We couldn't finish this look. Nothing was counted against your looks today.",
    );
    expect(alert.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('asks for the views to choose from when the page holds none, and decorates nothing', () => {
    renderEnded(
      { state: 'failed', failureKind: 'source_rejected', failureDetail: 'house_number_mismatch' },
      { project: streetPlace },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use another view' }));
    expect(vi.mocked(discover)).toHaveBeenCalledWith(undefined, { confirmFirst: true });
  });

  it('opens the views the page holds without asking again', () => {
    renderEnded(
      { state: 'failed', failureKind: 'source_rejected', failureDetail: 'house_number_mismatch' },
      { project: streetPlace, candidates: [{ candidateId: 'c-1' } as never] },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Use another view' }));
    expect(useProjectStore.getState().phase).toBe('confirm');
    expect(vi.mocked(discover)).not.toHaveBeenCalled();
  });

  it('says a street photo has no clear view of the home, with another view or photo', () => {
    renderEnded(
      { state: 'failed', failureKind: 'source_rejected', failureDetail: 'facade_not_in_frame' },
      { project: streetPlace },
    );
    expect(
      screen.getByText(
        "We couldn't get a clear view of your home from the street. Choose another view or upload a photo.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/anything to decorate/)).toBeNull();
    const actions = screen.getAllByRole('button').map((button) => button.textContent);
    expect(actions).toEqual(['Use another view', 'Use another photo']);
  });

  it('keeps the line about nothing to decorate for an uploaded photo out of frame', () => {
    renderEnded({
      state: 'failed',
      failureKind: 'source_rejected',
      failureDetail: 'facade_not_in_frame',
    });
    expect(screen.getByText(/We couldn't find anything to decorate in this photo/)).toBeTruthy();
    expect(screen.queryByText(/clear view of your home/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Use another view' })).toBeNull();
  });
});
