/**
 * Moves focus to the new page after a client-side navigation: the main heading, or the main
 * region when the page has no heading yet. A page that already placed focus inside its main
 * region (a focused result heading, an autofocused field) or an open dialog keeps it.
 */
export function focusMainContent(): void {
  const main = document.getElementById('main');
  if (!main) return;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    (main.contains(active) || active.closest('[role="dialog"]'))
  ) {
    return;
  }
  const heading = main.querySelector<HTMLElement>('h1');
  if (heading && !heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  (heading ?? main).focus({ preventScroll: true });
}
