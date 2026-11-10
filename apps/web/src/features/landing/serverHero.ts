/**
 * Moves the server-rendered photograph (its `<picture>`, or a bare `<img>`) from `container`
 * into `slot` and empties the container. The rest of the server markup (the headline and
 * address field painted before the script runs) is discarded, because the app renders its own,
 * so the page never carries two headlines or two address fields.
 */
export function adoptServerHero(container: HTMLElement, slot: HTMLElement): void {
  // A region without a photograph is emptied all the same, so its panel never stays on screen.
  const image = container.querySelector('img');
  const photo = image?.closest('picture') ?? image;
  if (photo && container.contains(photo)) slot.appendChild(photo);
  container.replaceChildren();
  container.hidden = true;
}

/**
 * Whether the server painted its headline panel and it is still on screen: the app's panel
 * then continues it in place instead of rising in a second time.
 */
export function serverPanelShown(doc: Document = document): boolean {
  const container = doc.getElementById('ssr-hero');
  return Boolean(container && !container.hidden && container.querySelector('.ssr-hero__panel'));
}
