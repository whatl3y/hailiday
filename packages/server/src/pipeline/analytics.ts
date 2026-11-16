import { parseAnalyticsProperties, type AnalyticsEventName } from '@hailiday/core';
import type { Clock } from '../clock/index.js';
import type { AppConfig } from '../config/index.js';
import { toJson, type DbOrTx } from '../db/client.js';
import { dailySaltedHash, newId } from '../ids/index.js';
import type { Logger } from '../logger/index.js';

/**
 * Records one server-emitted analytics event. Properties are validated against the event's core
 * schema; an invalid event is logged and dropped, never thrown, because analytics must not fail
 * a pipeline step. The session hash is derived from the owner ID with the daily rotating salt.
 */
export async function emitServerEvent<N extends AnalyticsEventName>(
  db: DbOrTx,
  deps: { config: AppConfig; clock: Clock; logger: Logger },
  event: {
    name: N;
    ownerId: string;
    properties: Record<string, unknown>;
    holidayId?: string | null;
    sceneType?: string | null;
    sourceKind?: string | null;
    fixture: boolean;
  },
): Promise<void> {
  const now = deps.clock.now();
  try {
    const properties = parseAnalyticsProperties(event.name, event.properties) as Record<
      string,
      unknown
    >;
    await db
      .insertInto('analyticsEvents')
      .values({
        id: newId(),
        eventName: event.name,
        occurredAt: now,
        receivedAt: now,
        sessionHash: dailySaltedHash(deps.config.sessionSecret, `owner:${event.ownerId}`, now),
        emitter: 'server',
        properties: toJson({ ...properties, ...(event.fixture ? { fixture: true } : {}) }),
        holidayId: event.holidayId ?? null,
        sceneType: event.sceneType ?? null,
        sourceKind: event.sourceKind ?? null,
        countryCode: 'US',
        appVersion: deps.config.appVersion,
      })
      .execute();
  } catch (error) {
    deps.logger.warn({ err: error, event: event.name }, 'analytics event dropped');
  }
}
