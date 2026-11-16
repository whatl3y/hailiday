/** Storage helpers that never throw (private windows and blocked storage are normal). */

function storage(kind: 'session' | 'local'): Storage | null {
  try {
    return kind === 'session' ? window.sessionStorage : window.localStorage;
  } catch {
    return null;
  }
}

export function readStored(kind: 'session' | 'local', key: string): string | null {
  try {
    return storage(kind)?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeStored(kind: 'session' | 'local', key: string, value: string | null): void {
  try {
    const target = storage(kind);
    if (!target) return;
    if (value === null) target.removeItem(key);
    else target.setItem(key, value);
  } catch {
    // Storage is a convenience only.
  }
}

export const STORAGE_KEYS = {
  explicitHoliday: 'hailiday.explicitHoliday',
  attested: 'hailiday.attested',
  lastProject: 'hailiday.lastProject',
  downloadNoteShown: 'hailiday.downloadNoteShown',
  /** Followed by `:<projectId>`: the project's evening looks that could not be made. */
  failedEvenings: 'hailiday.failedEvenings',
  /** Followed by `:<projectId>`: the person canceled the project's first look. */
  canceledFirstLook: 'hailiday.canceledFirstLook',
  /** Followed by `:<projectId>`: the job of the page's own second pass at the project's look. */
  secondPassJob: 'hailiday.secondPassJob',
} as const;
