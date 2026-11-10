/**
 * Bot-check tokens for session creation, reports and `VERIFICATION_REQUIRED` retries. The API
 * shell names the mode in `<meta name="holiday:turnstile-mode">` and, in live mode, the site key
 * in `<meta name="holiday:turnstile-site-key">`. In fixture mode the fixture token is used; in
 * live mode the Cloudflare widget runs (invisibly unless it needs the person) and yields a token,
 * and a missing site key is an error rather than a silent fixture token.
 */
export const FIXTURE_TURNSTILE_TOKEN = 'fixture-pass';

export const TURNSTILE_SITE_KEY_META = 'holiday:turnstile-site-key';
export const TURNSTILE_MODE_META = 'holiday:turnstile-mode';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const TOKEN_TIMEOUT_MS = 30_000;

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'error-callback'?: () => void;
      'expired-callback'?: () => void;
      'before-interactive-callback'?: () => void;
      appearance?: 'always' | 'execute' | 'interaction-only';
      size?: 'normal' | 'compact' | 'flexible';
    },
  ): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export type TurnstileMode = 'fixture' | 'live';

function metaContent(doc: Document, name: string): string | null {
  const content = doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
  return content && content.trim() ? content.trim() : null;
}

/** The live site key from the shell's meta tag; an empty value means no key. */
export function readSiteKey(doc: Document = document): string | null {
  return metaContent(doc, TURNSTILE_SITE_KEY_META);
}

/**
 * The verification mode the API runs in. Without the mode meta (the Vite development server
 * serves the page without the API shell) a site key implies live mode and its absence fixture
 * mode.
 */
export function readTurnstileMode(doc: Document = document): TurnstileMode {
  const mode = metaContent(doc, TURNSTILE_MODE_META);
  if (mode === 'live' || mode === 'fixture') return mode;
  return readSiteKey(doc) ? 'live' : 'fixture';
}

/** Raised when a live bot check cannot produce a token. */
export class TurnstileError extends Error {
  constructor(readonly reason: 'unconfigured' | 'script' | 'widget' | 'timeout') {
    super(`turnstile_${reason}`);
    this.name = 'TurnstileError';
  }
}

let scriptPromise: Promise<TurnstileApi> | null = null;

/** How long the challenge script may take to load before the check counts as failed. */
export const SCRIPT_TIMEOUT_MS = 15_000;

function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  scriptPromise ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    // A script that never answers fails like one that errors, so no caller waits forever.
    const fail = () => {
      window.clearTimeout(timer);
      script.remove();
      scriptPromise = null;
      reject(new TurnstileError('script'));
    };
    const timer = window.setTimeout(fail, SCRIPT_TIMEOUT_MS);
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => {
      window.clearTimeout(timer);
      if (window.turnstile) resolve(window.turnstile);
      else fail();
    };
    script.onerror = fail;
    document.head.appendChild(script);
  });
  return scriptPromise;
}

/**
 * Places where a challenge may appear, innermost last. A surface (the address field, a report
 * form) registers its slot while it is on screen so a challenge triggered from it shows inline
 * there; without one the challenge shows in a centered overlay.
 */
const slots: HTMLElement[] = [];

export function registerChallengeSlot(element: HTMLElement): () => void {
  slots.push(element);
  return () => {
    const index = slots.lastIndexOf(element);
    if (index >= 0) slots.splice(index, 1);
  };
}

function challengeHost(container: HTMLElement | null | undefined): {
  host: HTMLElement;
  overlay: boolean;
} {
  const slot = container ?? slots.filter((element) => element.isConnected).at(-1) ?? null;
  const host = document.createElement('div');
  host.className = slot ? 'turnstile-host' : 'turnstile-host turnstile-host--overlay';
  (slot ?? document.body).appendChild(host);
  return { host, overlay: !slot };
}

export interface TurnstileOptions {
  /** Where the challenge appears if it needs the person; defaults to the active slot. */
  container?: HTMLElement | null;
}

/** Runs the challenge (or returns the fixture token in fixture mode) and resolves with a token. */
export async function getTurnstileToken(options: TurnstileOptions = {}): Promise<string> {
  if (readTurnstileMode() === 'fixture') return FIXTURE_TURNSTILE_TOKEN;
  const siteKey = readSiteKey();
  if (!siteKey) throw new TurnstileError('unconfigured');
  const api = await loadScript();
  return new Promise<string>((resolve, reject) => {
    const { host, overlay } = challengeHost(options.container);
    let widgetId: string | null = null;
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (widgetId) api.remove(widgetId);
      host.remove();
      fn();
    };
    const timer = window.setTimeout(
      () => finish(() => reject(new TurnstileError('timeout'))),
      TOKEN_TIMEOUT_MS,
    );
    widgetId = api.render(host, {
      sitekey: siteKey,
      appearance: 'interaction-only',
      size: 'flexible',
      callback: (token) => finish(() => resolve(token)),
      'error-callback': () => finish(() => reject(new TurnstileError('widget'))),
      'expired-callback': () => finish(() => reject(new TurnstileError('timeout'))),
      'before-interactive-callback': () => {
        host.dataset.interactive = 'true';
        if (!overlay) host.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      },
    });
  });
}
