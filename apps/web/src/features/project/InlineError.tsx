import { useProjectStore } from '../../state/projectStore';
import { RetryAfterButton } from '../../ui/RetryAfterButton';

/**
 * The current phase's inline error, next to its primary action. A rate-limited action also
 * gets "Try again", enabled once the server's wait has passed.
 */
export function ProjectInlineError() {
  const inlineError = useProjectStore((state) => state.inlineError);
  const inlineRetry = useProjectStore((state) => state.inlineRetry);
  if (!inlineError) return null;
  const message = (
    <p className="message message--error" role="alert">
      {inlineError}
    </p>
  );
  if (!inlineRetry) return message;
  return (
    <div className="retry-after">
      {message}
      <RetryAfterButton
        key={inlineRetry.id}
        retryAfterSeconds={inlineRetry.retryAfterSeconds}
        onRetry={inlineRetry.retry}
      />
    </div>
  );
}
