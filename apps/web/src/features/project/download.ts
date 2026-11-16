import { assignLocation } from './navigate';

/** Seconds of margin before a signed link's expiry at which it is treated as expired. */
const EXPIRY_MARGIN_S = 30;

/**
 * When a presigned URL stops working, read from its `X-Amz-Date` and `X-Amz-Expires`
 * parameters (or `Expires` as epoch seconds). Null when the URL does not say.
 */
export function signedUrlExpiry(url: string): number | null {
  let parsed: URL;
  try {
    parsed = new URL(url, 'http://localhost');
  } catch {
    return null;
  }
  const params = parsed.searchParams;
  const amzDate = params.get('X-Amz-Date');
  const amzExpires = params.get('X-Amz-Expires');
  if (amzDate && amzExpires) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(amzDate);
    const seconds = Number(amzExpires);
    if (match && Number.isFinite(seconds)) {
      const [y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0] = match.slice(1).map(Number);
      return Date.UTC(y, mo - 1, d, h, mi, s) + seconds * 1000;
    }
  }
  const expires = params.get('Expires');
  if (expires && /^\d+$/.test(expires)) return Number(expires) * 1000;
  return null;
}

/** Whether a signed link has expired (or is about to). */
export function isSignedUrlExpired(url: string, now: number = Date.now()): boolean {
  const expiry = signedUrlExpiry(url);
  return expiry !== null && expiry - EXPIRY_MARGIN_S * 1000 <= now;
}

/**
 * Follows a download link read again after the signed one expired: in the window opened when
 * Download was pressed, or in this tab when the browser blocked that window. Closes the opened
 * window when there is no link to follow.
 */
export function followFreshDownload(opened: Window | null, fresh: string | null | undefined): void {
  if (fresh && opened) opened.location.href = fresh;
  else if (fresh) assignLocation(fresh);
  else opened?.close();
}
