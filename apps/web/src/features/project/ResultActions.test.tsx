import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as endpoints from '../../api/endpoints';
import { INITIAL_PROJECT_FLOW, lookOf, useProjectStore } from '../../state/projectStore';
import { project, variant } from '../../test/fixtures';
import { assignLocation } from './navigate';
import { ResultActions, ResultMore } from './ResultActions';

vi.mock('../../analytics', () => ({ analytics: { track: vi.fn(() => true) } }));
vi.mock('../../api/endpoints', () => ({ listVariants: vi.fn() }));
vi.mock('./navigate', () => ({ assignLocation: vi.fn() }));

const api = vi.mocked(endpoints);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  useProjectStore.setState({ ...INITIAL_PROJECT_FLOW });
});

/** A presigned URL that expired a minute ago, or that is valid for 15 minutes from now. */
function signedUrl(path: string, expired: boolean): string {
  const signedAt = new Date(Date.now() - (expired ? 16 : 0) * 60 * 1000);
  const stamp = signedAt
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `https://cdn.test/${path}?X-Amz-Date=${stamp}&X-Amz-Expires=900&X-Amz-Signature=abc`;
}

async function pressDownload(stale: ReturnType<typeof variant>, fresh: string | null) {
  api.listVariants.mockResolvedValue({
    items: [{ ...stale, downloadUrl: fresh }],
    activeRender: null,
    offered: null,
  });
  render(
    <MemoryRouter>
      <ResultActions project={project()} variant={stale} onOpen={() => undefined} />
    </MemoryRouter>,
  );
  const actions = screen.getByRole('group', { name: 'Keep this preview' });
  const link = within(actions).getByRole('link', { name: 'Download' });
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    link.dispatchEvent(click);
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return click;
}

describe('Download on the result with an expired signed link', () => {
  it('follows the fresh link in the window opened for it', async () => {
    const stale = variant({ downloadUrl: signedUrl('stale.jpg', true) });
    const fresh = signedUrl('fresh.jpg', false);
    const opened = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => opened),
    );
    const click = await pressDownload(stale, fresh);
    expect(click.defaultPrevented).toBe(true);
    expect(opened.location.href).toBe(fresh);
    expect(vi.mocked(assignLocation)).not.toHaveBeenCalled();
  });

  it('opens the fresh link in this tab when the browser blocks the new window', async () => {
    const stale = variant({ downloadUrl: signedUrl('stale.jpg', true) });
    const fresh = signedUrl('fresh.jpg', false);
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const click = await pressDownload(stale, fresh);
    expect(click.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith('', '_blank');
    expect(vi.mocked(assignLocation)).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it('closes the opened window when no fresh link comes back', async () => {
    const stale = variant({ downloadUrl: signedUrl('stale.jpg', true) });
    const opened = { location: { href: '' }, close: vi.fn() };
    vi.stubGlobal(
      'open',
      vi.fn(() => opened),
    );
    await pressDownload(stale, null);
    expect(opened.close).toHaveBeenCalledOnce();
    expect(vi.mocked(assignLocation)).not.toHaveBeenCalled();
  });
});

describe('the More panel while a look is being made', () => {
  const shown = variant();

  function onResult(place: ReturnType<typeof project>, making: boolean) {
    useProjectStore.setState({
      ...INITIAL_PROJECT_FLOW,
      project: place,
      phase: 'result',
      variant: shown,
      variants: [shown],
      look: lookOf(shown),
      pending: making ? { look: { ...lookOf(shown), style: 'abundant' }, render: null } : null,
    });
  }

  function renderMore(place: ReturnType<typeof project>, onOpen = vi.fn()) {
    render(
      <MemoryRouter initialEntries={['/p/1']}>
        <Routes>
          <Route
            path="/p/:id"
            element={<ResultMore project={place} variant={shown} onOpen={onOpen} />}
          />
          <Route path="/" element={<p>Home</p>} />
        </Routes>
      </MemoryRouter>,
    );
    return onOpen;
  }

  it('locks Replace photo and Delete: they do nothing and say why', () => {
    const place = project({ kind: 'upload' });
    onResult(place, true);
    const onOpen = renderMore(place);
    const replace = screen.getByRole('button', { name: 'Replace photo' });
    const remove = screen.getByRole('button', { name: 'Delete' });
    for (const button of [replace, remove]) {
      expect(button.getAttribute('aria-disabled')).toBe('true');
      expect(button.getAttribute('aria-describedby')).toBe('look-lock-hint');
    }
    fireEvent.click(replace);
    fireEvent.click(remove);
    expect(useProjectStore.getState().phase).toBe('result');
    expect(useProjectStore.getState().pending).not.toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
    expect(useProjectStore.getState().lockedNotice).toBe(2);
  });

  it('locks Change address: it stays on the place', () => {
    const place = project({
      kind: 'address',
      activeSource: { ...project().activeSource!, kind: 'street_view' },
    });
    onResult(place, true);
    renderMore(place);
    const change = screen.getByRole('button', { name: 'Change address' });
    expect(change.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(change);
    expect(screen.queryByText('Home')).toBeNull();
    expect(useProjectStore.getState().lockedNotice).toBe(1);
  });

  it('works as before when no look is being made', () => {
    const place = project({ kind: 'upload' });
    onResult(place, false);
    const onOpen = renderMore(place);
    const remove = screen.getByRole('button', { name: 'Delete' });
    expect(remove.hasAttribute('aria-disabled')).toBe(false);
    fireEvent.click(remove);
    expect(onOpen).toHaveBeenCalledWith('delete');
    fireEvent.click(screen.getByRole('button', { name: 'Replace photo' }));
    expect(useProjectStore.getState().phase).toBe('upload');
    expect(useProjectStore.getState().lockedNotice).toBe(0);
  });
});
