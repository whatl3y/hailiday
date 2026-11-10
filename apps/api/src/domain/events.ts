import { createHash } from 'node:crypto';
import { parseAnalyticsProperties, type AnalyticsEventName } from '@holiday/core';
import type { AuditActorKind } from '@holiday/core';
import { toJson, toJsonOrNull, type DbOrTx } from '@holiday/server/db';
import { formatUuidV7, newId } from '@holiday/server/ids';
import type { ApiDeps } from '../deps.js';
import { sessionHashOf } from '../auth/session.js';

export interface ServerEvent {
  name: AnalyticsEventName;
  properties: Record<string, unknown>;
  /** The owner whose daily-salted hash identifies the session; or an explicit hash. */
  ownerId?: string | null;
  sessionHash?: string;
  holidayId?: string | null;
  sceneType?: string | null;
  sourceKind?: string | null;
  fixture?: boolean;
  /**
   * A fixed event ID (see `onceEventId`): an event whose ID is already recorded is not recorded
   * again, so callers that may race to report one occurrence record it once.
   */
  id?: string;
}

/**
 * A deterministic UUIDv7 for the one event that reports an occurrence identified by `key` (for
 * example a deletion request): the timestamp is `at` and the random bits come from a hash of the
 * event name and key, so every caller derives the same ID.
 */
export function onceEventId(name: AnalyticsEventName, key: string, at: Date): string {
  const digest = createHash('sha256').update(`${name}:${key}`).digest();
  return formatUuidV7(at.getTime(), digest.readUInt16BE(0) & 0xfff, digest.subarray(2, 10));
}

/** Whether events describe fixture activity (excluded from live metrics). */
export function isFixtureEnvironment(deps: Pick<ApiDeps, 'config'>): boolean {
  return deps.config.providers.imageEditor === 'fixture' || deps.config.isLocal;
}

/**
 * Records one server-emitted analytics event. Properties are validated by the core per-event
 * schema; an invalid event is logged and dropped (analytics never fails a request).
 */
export async function emitEvent(
  deps: Pick<ApiDeps, 'config' | 'clock' | 'logger'>,
  db: DbOrTx,
  event: ServerEvent,
): Promise<void> {
  const now = deps.clock.now();
  try {
    const properties = parseAnalyticsProperties(event.name, event.properties) as Record<
      string,
      unknown
    >;
    const fixture = event.fixture ?? isFixtureEnvironment(deps);
    const insert = db.insertInto('analyticsEvents').values({
      id: event.id ?? newId(),
      eventName: event.name,
      occurredAt: now,
      receivedAt: now,
      sessionHash:
        event.sessionHash ??
        (event.ownerId ? sessionHashOf(deps, event.ownerId) : sessionHashOf(deps, 'anonymous')),
      emitter: 'server',
      properties: toJson({ ...properties, ...(fixture ? { fixture: true } : {}) }),
      holidayId: event.holidayId ?? null,
      sceneType: event.sceneType ?? null,
      sourceKind: event.sourceKind ?? null,
      countryCode: 'US',
      appVersion: deps.config.appVersion,
    });
    await (event.id ? insert.onConflict((oc) => oc.column('id').doNothing()) : insert).execute();
  } catch (error) {
    deps.logger.warn({ err: error, event: event.name }, 'analytics event dropped');
  }
}

export interface AuditEntry {
  actorUserId: string | null;
  actorKind: AuditActorKind;
  action: string;
  targetKind: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  requestId: string;
  ipHash?: string | null;
}

/** Appends one `audit_log` row (never image bytes or addresses). */
export async function writeAudit(db: DbOrTx, entry: AuditEntry): Promise<void> {
  await db
    .insertInto('auditLog')
    .values({
      id: newId(),
      actorUserId: entry.actorUserId,
      actorKind: entry.actorKind,
      action: entry.action,
      targetKind: entry.targetKind,
      targetId: entry.targetId,
      before: toJsonOrNull(entry.before ?? null),
      after: toJsonOrNull(entry.after ?? null),
      requestId: entry.requestId,
      ipHash: entry.ipHash ?? null,
    })
    .execute();
}
