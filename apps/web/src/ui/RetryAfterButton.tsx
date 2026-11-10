import { useEffect, useState } from 'react';
import { t } from '../copy';

/** The wait used when a rate-limited response carries no `Retry-After`. */
export const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * "Try again" for a rate-limited action: disabled (and saying so) until the server's wait has
 * passed, then it repeats the action.
 */
export function RetryAfterButton({
  retryAfterSeconds,
  onRetry,
  className = 'button button--small',
}: {
  retryAfterSeconds: number | null;
  onRetry: () => void;
  className?: string;
}) {
  const [remaining, setRemaining] = useState(
    Math.max(0, Math.ceil(retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)),
  );

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const waiting = remaining > 0;
  return (
    <button
      type="button"
      className={className}
      aria-disabled={waiting || undefined}
      onClick={() => {
        if (!waiting) onRetry();
      }}
    >
      {t('common.tryAgain')}
    </button>
  );
}
