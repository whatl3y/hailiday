import { t, type CopyKey } from '../copy';
import { DISPLAY_VALUES } from '../config/values';
import { useAppStore } from '../state/appStore';
import { type ApiError, isApiError } from './errors';

export interface InlineError {
  key: CopyKey;
  message: string;
  error: ApiError | null;
}

/** Formats seconds as a short human duration for `{retryAfter}`. */
export function formatWait(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Formats an ISO instant as a local time of day for `{resetsAt}`. */
export function formatResetTime(iso: string | null): string {
  if (!iso) return 'tomorrow';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'tomorrow';
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/** The inline message for an error, with every placeholder filled. */
export function inlineMessage(error: unknown): InlineError {
  const apiError = isApiError(error) ? error : null;
  const key: CopyKey = apiError ? apiError.copyKey : 'error.unknown';
  const message = t(key, {
    retryAfter: formatWait(apiError?.retryAfterSeconds ?? 60),
    formats: DISPLAY_VALUES.formats,
    maxFileSize: '25 MB',
  });
  return { key, message, error: apiError };
}

/**
 * Presents an error on its owning surface: the allowance and capacity sheets and the budget
 * banner are global; everything else is returned for the caller to show inline next to the
 * control that failed. Returns null when the error was presented globally.
 */
export function presentError(error: unknown, retry?: () => void): InlineError | null {
  const store = useAppStore.getState();
  if (isApiError(error)) {
    switch (error.surface) {
      case 'allowance_sheet': {
        const details = error.typedDetails('ALLOWANCE_EXHAUSTED');
        store.openSheet({
          kind: 'allowance',
          scope: details?.scope ?? 'variants',
          resetsAt: details?.resetsAt ?? null,
        });
        return null;
      }
      case 'capacity_sheet': {
        const details = error.typedDetails('AT_CAPACITY');
        store.openSheet({
          kind: 'capacity',
          retryAfterSeconds: error.retryAfterSeconds ?? details?.retryAfterSeconds ?? 30,
          onRetry: retry ?? null,
        });
        return null;
      }
      case 'budget_banner':
        store.setBudgetPaused(true);
        return inlineMessage(error);
      default:
        return inlineMessage(error);
    }
  }
  return inlineMessage(error);
}
