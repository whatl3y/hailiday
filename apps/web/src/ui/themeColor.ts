import { useEffect } from 'react';

/**
 * A page's surface: `paper` is the white page; `photo` opens on a full-viewport photograph with
 * the header laid over it; `stage` shows a picture on the ink stage under an ink header band.
 */
export type SurfaceTone = 'paper' | 'photo' | 'stage';

/** The browser chrome colour per surface (the server shell writes the same values). */
export const THEME_COLORS = {
  paper: '#ffffff',
  ink: '#0d0d0f',
} as const;

/** Photo and stage pages open on ink, so the browser chrome around them is ink too. */
export function themeColorFor(tone: SurfaceTone): string {
  return tone === 'paper' ? THEME_COLORS.paper : THEME_COLORS.ink;
}

/** Writes the `theme-color` meta tag, adding it when the document has none. */
export function applyThemeColor(color: string, doc: Document = document): void {
  let meta = doc.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'theme-color';
    doc.head.append(meta);
  }
  if (meta.content !== color) meta.content = color;
}

/** Keeps the document's `theme-color` in step with the surface of the page on screen. */
export function useThemeColor(tone: SurfaceTone): void {
  const color = themeColorFor(tone);
  useEffect(() => {
    applyThemeColor(color);
  }, [color]);
}
