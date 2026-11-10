import type { FailureDetail, FailureKind } from '@holiday/core';

/** A stage ended the job `failed` (render spec, failure kinds). */
export class JobFailure extends Error {
  readonly kind: FailureKind;
  readonly detail: FailureDetail | null;
  constructor(kind: FailureKind, detail: FailureDetail | null = null, message?: string) {
    super(message ?? `Render job failed: ${kind}${detail ? `/${detail}` : ''}`);
    this.name = 'JobFailure';
    this.kind = kind;
    this.detail = detail;
  }
}

/** The job's abort signal fired (cancellation, supersede, expiry or the duration limit). */
export class JobAborted extends Error {
  readonly reason: 'signal' | 'deadline';
  constructor(reason: 'signal' | 'deadline') {
    super(`Render job aborted: ${reason}`);
    this.name = 'JobAborted';
    this.reason = reason;
  }
}

/** Waits `ms`, resolving early (false) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
