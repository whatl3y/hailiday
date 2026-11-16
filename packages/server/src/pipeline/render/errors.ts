import type { FailureDetail, FailureKind } from '@hailiday/core';
import type { EditOutcome } from '../../providers/types.js';

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

/** The editor answered with a reply that carries no image (nothing billed for an image). */
export const NO_IMAGE = 'no_image';

/**
 * Whether a failed edit carries the vendor's answer (an HTTP status, or a reply without an
 * image). A failure without one (connection loss, unreadable body, client timeout, a status
 * query a provider cannot answer) may have been billed.
 */
export function vendorAnswered(outcome: Extract<EditOutcome, { status: 'failed' }>): boolean {
  return outcome.httpStatus !== undefined || outcome.providerCode === NO_IMAGE;
}

/**
 * A 200 response whose body could not be read: the vendor most likely rendered and billed the
 * image, so the outcome is unknown rather than an unbilled provider error.
 */
export function unreadableAnswer(outcome: Extract<EditOutcome, { status: 'failed' }>): boolean {
  return outcome.httpStatus === 200 && outcome.providerCode === 'invalid_json';
}
