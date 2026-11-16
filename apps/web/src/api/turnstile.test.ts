import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FIXTURE_TURNSTILE_TOKEN,
  SCRIPT_TIMEOUT_MS,
  TurnstileError,
  getTurnstileToken,
  readSiteKey,
  readTurnstileMode,
  registerChallengeSlot,
} from './turnstile';

function setMeta(mode: string | null, siteKey: string | null) {
  document.head.innerHTML = [
    mode === null ? '' : `<meta name="hailiday:turnstile-mode" content="${mode}" />`,
    siteKey === null ? '' : `<meta name="hailiday:turnstile-site-key" content="${siteKey}" />`,
  ].join('');
}

function fakeTurnstile() {
  const parents: Array<HTMLElement | null> = [];
  const render = vi.fn(
    (
      container: HTMLElement,
      options: { callback: (token: string) => void; 'before-interactive-callback'?: () => void },
    ) => {
      options['before-interactive-callback']?.();
      queueMicrotask(() => options.callback('live-token'));
      parents.push(container.parentElement);
      return 'widget-1';
    },
  );
  const remove = vi.fn();
  window.turnstile = { render, remove };
  return { render, remove, parents };
}

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  delete window.turnstile;
});

describe('bot check', () => {
  it('reads the meta names the API shell emits', () => {
    setMeta('live', 'site-key-1');
    expect(readSiteKey()).toBe('site-key-1');
    expect(readTurnstileMode()).toBe('live');
    setMeta('fixture', '');
    expect(readSiteKey()).toBeNull();
    expect(readTurnstileMode()).toBe('fixture');
  });

  it('uses the fixture token in fixture mode and without any meta', async () => {
    setMeta('fixture', '');
    await expect(getTurnstileToken()).resolves.toBe(FIXTURE_TURNSTILE_TOKEN);
    setMeta(null, null);
    await expect(getTurnstileToken()).resolves.toBe(FIXTURE_TURNSTILE_TOKEN);
  });

  it('never falls back to the fixture token in live mode', async () => {
    setMeta('live', '');
    await expect(getTurnstileToken()).rejects.toBeInstanceOf(TurnstileError);
  });

  it('fails a challenge script that never loads instead of waiting forever', async () => {
    vi.useFakeTimers();
    try {
      setMeta('live', 'site-key-1');
      const pending = getTurnstileToken().catch((error: unknown) => error);
      expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).not.toBeNull();
      await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
      const failure = await pending;
      expect(failure).toBeInstanceOf(TurnstileError);
      expect((failure as TurnstileError).reason).toBe('script');
      expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the widget with the site key inside the given container and cleans up', async () => {
    setMeta('live', 'site-key-1');
    const { render, remove, parents } = fakeTurnstile();
    const container = document.createElement('div');
    document.body.appendChild(container);
    await expect(getTurnstileToken({ container })).resolves.toBe('live-token');
    expect(parents[0]).toBe(container);
    expect(render.mock.calls[0]![1]).toMatchObject({ sitekey: 'site-key-1' });
    expect(remove).toHaveBeenCalledWith('widget-1');
    expect(container.childElementCount).toBe(0);
  });

  it('renders into the registered slot, or an overlay when no slot is on screen', async () => {
    setMeta('live', 'site-key-1');
    const { render, parents } = fakeTurnstile();
    const slot = document.createElement('div');
    document.body.appendChild(slot);
    const unregister = registerChallengeSlot(slot);
    await getTurnstileToken();
    expect(parents[0]).toBe(slot);
    unregister();
    await getTurnstileToken();
    const host = render.mock.calls[1]![0];
    expect(host.className).toContain('turnstile-host--overlay');
    expect(parents[1]).toBe(document.body);
    expect(host.isConnected).toBe(false);
  });
});
