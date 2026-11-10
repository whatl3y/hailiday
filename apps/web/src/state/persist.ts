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
  explicitHoliday: 'holiday.explicitHoliday',
  attested: 'holiday.attested',
  lastProject: 'holiday.lastProject',
  downloadNoteShown: 'holiday.downloadNoteShown',
} as const;
