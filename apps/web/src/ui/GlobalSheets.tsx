import { useEffect, useState } from 'react';
import { t } from '../copy';
import { formatResetTime, formatWait } from '../api/present';
import { currentHolidayId, useAppStore } from '../state/appStore';
import { useProjectStore } from '../state/projectStore';
import { ExampleGallery } from './Examples';
import { Sheet } from './Sheet';

function AllowanceSheet({
  scope,
  resetsAt,
}: {
  scope: 'variants' | 'addresses';
  resetsAt: string | null;
}) {
  const close = useAppStore((state) => state.closeSheet);
  // Over a project with no preview yet, the body speaks of its photo instead of previews.
  const noPreview = useProjectStore((state) => state.project !== null && state.variant === null);
  const time = formatResetTime(resetsAt);
  const isAddresses = scope === 'addresses';
  return (
    <Sheet
      title={t(isAddresses ? 'allowance.addressHeading' : 'allowance.heading')}
      onClose={close}
    >
      <p className="lede">
        {t(
          isAddresses
            ? 'allowance.addressBody'
            : noPreview
              ? 'allowance.bodyNoPreview'
              : 'allowance.body',
          { resetsAt: time },
        )}
      </p>
      <button type="button" className="button button--primary button--block" onClick={close}>
        {t('common.gotIt')}
      </button>
    </Sheet>
  );
}

function CapacitySheet({
  retryAfterSeconds,
  onRetry,
}: {
  retryAfterSeconds: number;
  onRetry: (() => void) | null;
}) {
  const close = useAppStore((state) => state.closeSheet);
  const [remaining, setRemaining] = useState(retryAfterSeconds);

  useEffect(() => {
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining]);

  const ready = remaining <= 0;
  return (
    <Sheet
      title={t('error.AT_CAPACITY', { retryAfter: formatWait(retryAfterSeconds) })}
      hideTitle
      onClose={close}
    >
      {/* The countdown is visual; the dialog's label carries the wait, and readiness is announced. */}
      <p className="lede">
        {t('error.AT_CAPACITY', { retryAfter: formatWait(Math.max(remaining, 1)) })}
      </p>
      <p className="sr-only" role="status">
        {ready ? t('capacity.ready') : ''}
      </p>
      <button
        type="button"
        className="button button--primary button--block"
        aria-disabled={!ready}
        onClick={() => {
          if (!ready) return;
          close();
          onRetry?.();
        }}
      >
        {t('common.tryAgain')}
      </button>
    </Sheet>
  );
}

function ExamplesSheet() {
  const close = useAppStore((state) => state.closeSheet);
  const holidayId = useAppStore(currentHolidayId);
  return (
    <Sheet title={t('landing.examplesHeading')} onClose={close} wide>
      <ExampleGallery holidayId={holidayId} />
    </Sheet>
  );
}

/** Sheets opened from anywhere in the app: allowance, capacity and examples. */
export function GlobalSheets() {
  const sheet = useAppStore((state) => state.sheet);
  if (!sheet) return null;
  switch (sheet.kind) {
    case 'allowance':
      return <AllowanceSheet scope={sheet.scope} resetsAt={sheet.resetsAt} />;
    case 'capacity':
      return <CapacitySheet retryAfterSeconds={sheet.retryAfterSeconds} onRetry={sheet.onRetry} />;
    case 'examples':
      return <ExamplesSheet />;
  }
}
