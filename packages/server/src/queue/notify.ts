import pg from 'pg';
import { sql } from 'kysely';
import { z } from 'zod';
import type { DbOrTx } from '../db/client.js';
import type { Logger } from '../logger/index.js';

/** Channel that carries render job state changes to the API's SSE fan-out. */
export const RENDER_JOB_CHANNEL = 'render_job_changed';

/** Postgres rejects NOTIFY payloads of 8,000 bytes or more; we stay well below. */
const MAX_PAYLOAD_BYTES = 7_900;

export const RenderJobChangedSchema = z.strictObject({
  jobId: z.uuid(),
  seq: z.int().nonnegative(),
});
export type RenderJobChanged = z.infer<typeof RenderJobChangedSchema>;

/**
 * Issues `NOTIFY` on a channel. Inside a transaction Postgres delivers it only after commit, so
 * listeners never see a change that rolled back.
 */
export async function notify(db: DbOrTx, channel: string, payload: unknown): Promise<void> {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`NOTIFY payload too large for ${channel}`);
  }
  await sql`select pg_notify(${channel}, ${text})`.execute(db);
}

/** Publishes an IDs-only render job change; call in the transaction that writes the state. */
export async function notifyRenderJobChanged(db: DbOrTx, change: RenderJobChanged): Promise<void> {
  await notify(db, RENDER_JOB_CHANNEL, RenderJobChangedSchema.parse(change));
}

export function parseRenderJobChanged(payload: string | undefined): RenderJobChanged | null {
  if (!payload) return null;
  try {
    const parsed = RenderJobChangedSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface NotificationListener {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly connected: boolean;
}

/**
 * Holds one dedicated `LISTEN` connection and reconnects with backoff when it drops. After every
 * (re)connect `onReconnect` runs so callers can re-read state they may have missed.
 */
export function createNotificationListener(options: {
  connectionString: string;
  channels: readonly string[];
  onNotification: (channel: string, payload: string | undefined) => void;
  onReconnect?: () => void;
  logger?: Logger;
  maxBackoffMs?: number;
}): NotificationListener {
  let client: pg.Client | null = null;
  let stopped = true;
  let connected = false;
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;

  const schedule = () => {
    if (stopped) return;
    const delay = Math.min(options.maxBackoffMs ?? 15_000, 250 * 2 ** attempt);
    attempt += 1;
    timer = setTimeout(() => void connect(), delay);
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const next = new pg.Client({
      connectionString: options.connectionString,
      application_name: 'holiday-listener',
      keepAlive: true,
    });
    next.on('notification', (message) => options.onNotification(message.channel, message.payload));
    next.on('error', (error) => {
      options.logger?.warn({ err: error }, 'listener connection error');
    });
    next.on('end', () => {
      connected = false;
      if (client === next) client = null;
      schedule();
    });
    try {
      await next.connect();
      for (const channel of options.channels) {
        await next.query(`LISTEN ${pg.escapeIdentifier(channel)}`);
      }
      client = next;
      connected = true;
      attempt = 0;
      options.onReconnect?.();
    } catch (error) {
      options.logger?.warn({ err: error }, 'listener connect failed');
      next.removeAllListeners('end');
      await next.end().catch(() => undefined);
      schedule();
    }
  };

  return {
    get connected() {
      return connected;
    },
    async start() {
      if (!stopped) return;
      stopped = false;
      await connect();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const current = client;
      client = null;
      connected = false;
      if (current) {
        current.removeAllListeners('end');
        await current.end().catch(() => undefined);
      }
    },
  };
}
