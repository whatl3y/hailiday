import type { AppConfig } from '@holiday/server/config';
import { atCapacity } from '@holiday/server/errors';
import type { Logger } from '@holiday/server/logger';
import {
  RENDER_JOB_CHANNEL,
  createNotificationListener,
  parseRenderJobChanged,
  type NotificationListener,
} from '@holiday/server/queue';

type Listener = (seq: number | null) => void;

/** Bounds on open render event streams in one API process. */
export interface StreamLimits {
  /** Streams one owner may hold on one job (two tabs); a further stream replaces the oldest. */
  perOwnerJob: number;
  /** Streams one owner may hold in total; a further stream replaces the owner's oldest. */
  perOwner: number;
  /** Streams the process holds in total; a further stream is refused with `AT_CAPACITY`. */
  total: number;
}

export const DEFAULT_STREAM_LIMITS: StreamLimits = { perOwnerJob: 2, perOwner: 6, total: 2000 };

/** `Retry-After` of a stream refused because the process is full or shutting down. */
const STREAM_RETRY_AFTER_S = 5;

interface OpenStream {
  ownerId: string;
  jobId: string;
  close: () => void;
}

/**
 * One `LISTEN render_job_changed` connection per API process, fanned out to the SSE streams
 * subscribed to each job. Notifications carry IDs only; subscribers re-read the job row. After a
 * reconnect every subscriber is poked (seq null) so a missed notification is recovered.
 */
export class RenderEventHub {
  private readonly subscribers = new Map<string, Set<Listener>>();
  /** Open streams in the order they opened (oldest first). */
  private readonly streams = new Set<OpenStream>();
  private readonly limits: StreamLimits;
  private listener: NotificationListener | null = null;
  private closing = false;

  constructor(
    private readonly options: {
      config: AppConfig;
      logger: Logger;
      enabled: boolean;
      limits?: Partial<StreamLimits>;
    },
  ) {
    this.limits = { ...DEFAULT_STREAM_LIMITS, ...(options.limits ?? {}) };
  }

  async start(): Promise<void> {
    if (!this.options.enabled || this.listener) return;
    this.listener = createNotificationListener({
      connectionString: this.options.config.database.url,
      channels: [RENDER_JOB_CHANNEL],
      logger: this.options.logger,
      onNotification: (_channel, payload) => {
        const change = parseRenderJobChanged(payload);
        if (change) this.publish(change.jobId, change.seq);
      },
      onReconnect: () => {
        for (const jobId of this.subscribers.keys()) this.publish(jobId, null);
      },
    });
    await this.listener.start();
  }

  /**
   * Admits a new stream for an owner's job, replacing the oldest stream of the same owner and job
   * (or of the owner) beyond their bounds. Refuses with `AT_CAPACITY` when the process holds its
   * maximum or is shutting down. `close` must end the response; it is called when the stream is
   * replaced or at shutdown. Returns the release function the stream calls when it ends.
   */
  openStream(stream: OpenStream): () => void {
    if (this.closing) throw atCapacity(STREAM_RETRY_AFTER_S, null);
    const ofOwner = [...this.streams].filter((open) => open.ownerId === stream.ownerId);
    const ofJob = ofOwner.filter((open) => open.jobId === stream.jobId);
    const replaced = new Set<OpenStream>();
    for (const open of ofJob.slice(0, Math.max(0, ofJob.length - this.limits.perOwnerJob + 1))) {
      replaced.add(open);
    }
    const remaining = ofOwner.filter((open) => !replaced.has(open));
    for (const open of remaining.slice(
      0,
      Math.max(0, remaining.length - this.limits.perOwner + 1),
    )) {
      replaced.add(open);
    }
    for (const open of replaced) this.end(open);
    if (this.streams.size >= this.limits.total) throw atCapacity(STREAM_RETRY_AFTER_S, null);
    this.streams.add(stream);
    return () => {
      this.streams.delete(stream);
    };
  }

  /** Ends every open stream and refuses new ones (graceful shutdown, before the server closes). */
  closeAll(): void {
    this.closing = true;
    for (const open of [...this.streams]) this.end(open);
  }

  private end(stream: OpenStream): void {
    this.streams.delete(stream);
    try {
      stream.close();
    } catch (error) {
      this.options.logger.warn({ err: error }, 'render event stream close failed');
    }
  }

  async stop(): Promise<void> {
    this.closeAll();
    const listener = this.listener;
    this.listener = null;
    await listener?.stop();
    this.subscribers.clear();
  }

  /** Open streams, of one owner when given. */
  streamCount(ownerId?: string): number {
    if (!ownerId) return this.streams.size;
    return [...this.streams].filter((open) => open.ownerId === ownerId).length;
  }

  get connected(): boolean {
    return this.listener?.connected ?? false;
  }

  /** Delivers a change to every stream of a job. */
  publish(jobId: string, seq: number | null): void {
    for (const listener of this.subscribers.get(jobId) ?? []) {
      try {
        listener(seq);
      } catch (error) {
        this.options.logger.warn({ err: error }, 'render event subscriber failed');
      }
    }
  }

  subscribe(jobId: string, listener: Listener): () => void {
    let set = this.subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this.subscribers.set(jobId, set);
    }
    set.add(listener);
    return () => {
      const current = this.subscribers.get(jobId);
      current?.delete(listener);
      if (current && current.size === 0) this.subscribers.delete(jobId);
    };
  }

  subscriberCount(jobId?: string): number {
    if (jobId) return this.subscribers.get(jobId)?.size ?? 0;
    let total = 0;
    for (const set of this.subscribers.values()) total += set.size;
    return total;
  }
}
