export { HERO_SIZES, PORTRAIT_MEDIA } from '../../ui/heroFocus';

/**
 * Moves the server-rendered photograph (its `<picture>`, or a bare `<img>`) from `container`
 * into `slot` and empties the container. The rest of the server markup (the header, headline
 * and address field painted before the script runs) is discarded, because the app renders its
 * own, so the page never carries two headlines or two address fields.
 */
export function adoptServerHero(container: HTMLElement, slot: HTMLElement): void {
  // A region without a photograph is emptied all the same, so its panel never stays on screen.
  const image = container.querySelector('img');
  const photo = image?.closest('picture') ?? image;
  if (photo && container.contains(photo)) slot.appendChild(photo);
  container.replaceChildren();
  container.hidden = true;
}

/** Whether the server shell carries a photograph the app can adopt. */
export function serverHeroPresent(doc: Document = document): boolean {
  const container = doc.getElementById('ssr-hero');
  return Boolean(container && !container.hidden && container.querySelector('img'));
}

/**
 * Whether the server painted its headline panel and it is still on screen: the app's panel
 * then continues it in place instead of rising in a second time.
 */
export function serverPanelShown(doc: Document = document): boolean {
  const container = doc.getElementById('ssr-hero');
  return Boolean(container && !container.hidden && container.querySelector('.ssr-hero__panel'));
}

/** Longer than the whole staggered entrance: blocks given this much progress land at once. */
export const RISE_SETTLED_MS = 60_000;

/**
 * How far, in milliseconds, the server landing's entrance has played. Every block's entrance
 * started together, so the current time of any one still playing is the progress of all of
 * them. When every block has landed, or the browser cannot say, the entrance counts as settled.
 */
export function serverRiseElapsed(doc: Document = document): number {
  const blocks = doc.querySelectorAll('#ssr-hero .ssr-hero__panel > *');
  for (const block of blocks) {
    if (typeof block.getAnimations !== 'function') return RISE_SETTLED_MS;
    const rise = block.getAnimations().find((animation) => animation.playState !== 'finished');
    const time = rise?.currentTime;
    if (time === null || time === undefined) continue;
    const ms = typeof time === 'number' ? time : time.to('ms').value;
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  }
  return RISE_SETTLED_MS;
}

/** Longer than the drift: a frame given this much progress rests at its final scale. */
export const DRIFT_SETTLED_MS = 600_000;

/**
 * How far, in milliseconds, the server photograph's slow drift has played, so the app's frame
 * continues it instead of starting over. Zero when the server painted no drifting photograph.
 */
export function serverDriftElapsed(doc: Document = document): number {
  const photo = doc.querySelector('#ssr-hero .hero-frame__photo');
  if (!photo || typeof photo.getAnimations !== 'function') return 0;
  const drift = photo.getAnimations()[0];
  if (!drift) return 0;
  if (drift.playState === 'finished') return DRIFT_SETTLED_MS;
  const time = drift.currentTime;
  if (time === null || time === undefined) return 0;
  const ms = typeof time === 'number' ? time : time.to('ms').value;
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}
