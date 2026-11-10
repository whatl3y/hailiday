import { ShareViewSchema, type ShareView } from '@holiday/core';

export type ShareData =
  | { status: 'active'; token: string; view: ShareView }
  | { status: 'gone' }
  | { status: 'not_found' };

/** Reads the share page's inline `<script type="application/json" id="share">`, if any. */
export function readInlineShare(token: string, doc: Document = document): ShareData | null {
  const text = doc.getElementById('share')?.textContent;
  if (!text?.trim()) return null;
  try {
    const raw = JSON.parse(text) as { status?: unknown; token?: unknown; view?: unknown };
    if (raw.status === 'gone') return { status: 'gone' };
    if (raw.status === 'not_found') return { status: 'not_found' };
    if (raw.status !== 'active' || raw.token !== token) return null;
    const view = ShareViewSchema.safeParse(raw.view);
    return view.success ? { status: 'active', token, view: view.data } : null;
  } catch {
    return null;
  }
}
