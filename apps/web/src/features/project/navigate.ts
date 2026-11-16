/** Loads `url` in this tab. Kept in a module of its own so tests can replace it. */
export function assignLocation(url: string): void {
  window.location.assign(url);
}
