import {
  validateClientAnalyticsEvent,
  type AnalyticsBatch,
  type AnalyticsEventProperties,
  type ClientAnalyticsEventInput,
  type ClientAnalyticsEventName,
  type HolidayId,
  type SceneType,
  type SourceKind,
} from '@hailiday/core';
import { CLIENT_DEFAULTS } from '../config/values';

export interface AnalyticsDimensions {
  holidayId?: HolidayId | null;
  sceneType?: SceneType | null;
  sourceKind?: SourceKind | null;
}

export interface AnalyticsQueueDeps {
  send: (batch: AnalyticsBatch, keepalive: boolean) => Promise<void>;
  /**
   * Whether the page has a session. `POST /v1/analytics` needs one, and analytics never starts
   * one, so events wait in memory until something else has started it.
   */
  hasSession?: () => boolean;
  /** Subscribes to the session starting; the waiting events are sent then. */
  onSessionReady?: (listener: () => void) => unknown;
  flushMs?: number;
  maxBatch?: number;
  /** The most events held while waiting for a session; the oldest are dropped beyond it. */
  maxHeld?: number;
  now?: () => Date;
}

/**
 * Batches client-emitted events for `POST /v1/analytics`. Events are validated against the
 * core per-event schemas before they are queued, so nothing outside the contract (and never
 * an address, URL or free text) leaves the browser. Until the page has a session the events
 * stay in memory (they are dropped if the page closes first): sending them must never start a
 * session, and with it the bot check, before the person has done anything that needs one.
 */
export function createAnalyticsQueue(deps: AnalyticsQueueDeps) {
  const flushMs = deps.flushMs ?? CLIENT_DEFAULTS.analyticsFlushMs;
  const maxBatch = deps.maxBatch ?? CLIENT_DEFAULTS.analyticsMaxBatch;
  const maxHeld = deps.maxHeld ?? maxBatch * 5;
  const hasSession = deps.hasSession ?? (() => true);
  const now = deps.now ?? (() => new Date());
  let queue: ClientAnalyticsEventInput[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(keepalive = false): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!hasSession()) return;
    while (queue.length > 0) {
      const events = queue.slice(0, maxBatch);
      queue = queue.slice(maxBatch);
      deps.send({ events }, keepalive).catch(() => {
        // Analytics never interrupts the person; a failed batch is dropped.
      });
    }
  }

  function track<N extends ClientAnalyticsEventName>(
    name: N,
    properties: AnalyticsEventProperties<N>,
    dimensions: AnalyticsDimensions = {},
  ): boolean {
    const event: ClientAnalyticsEventInput = {
      name,
      occurredAt: now().toISOString(),
      properties: properties as Record<string, unknown>,
      ...dimensions,
    };
    const validated = validateClientAnalyticsEvent(event);
    if (!validated) return false;
    queue.push({ ...event, properties: validated.properties });
    if (queue.length > maxHeld) queue = queue.slice(queue.length - maxHeld);
    if (queue.length >= maxBatch && hasSession()) flush();
    else timer ??= setTimeout(() => flush(), flushMs);
    return true;
  }

  deps.onSessionReady?.(() => flush());

  return { track, flush, size: () => queue.length };
}

export type AnalyticsQueue = ReturnType<typeof createAnalyticsQueue>;
