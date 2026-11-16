import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '@hailiday/core';
import { sql } from '@hailiday/server/db';
import { runRenderJob, type PipelineDeps } from '@hailiday/server/pipeline';
import { createHarness, json, type Harness, type TestClient } from './test/harness.js';
import { adoptStreetViewProject } from './test/projects.js';

/** A fixture place whose wide frame shows its home small enough to zoom in on. */
const FRAMED_PLACE = 'ChIJfxOldQuarryRoadColoni19';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness({
    overrides: {
      SESSION_SECRET: 'street-view-framing-locks-secret-0123456789abc',
      STREET_VIEW_FRAMING: 'on',
      RENDER_QUEUE_DEPTH_MAX: '100000',
      RENDER_MAX_WAIT_S: '1000000',
    },
  });
});

afterAll(async () => {
  await harness?.close();
});

type Method = (...args: unknown[]) => unknown;
const EXECUTE = new Set<PropertyKey>(['execute', 'executeTakeFirst', 'executeTakeFirstOrThrow']);

/**
 * A database handle whose transactions wait in `gate` once, before the first select of `table`
 * with the row lock `lock` runs. Everything else passes through.
 */
function gatedDb(
  db: PipelineDeps['db'],
  table: string,
  lock: 'forShare' | 'forUpdate',
  gate: () => Promise<void>,
): PipelineDeps['db'] {
  let used = false;
  const bound = (target: object, prop: PropertyKey): unknown => {
    const value: unknown = Reflect.get(target, prop, target);
    return typeof value === 'function' ? (value as Method).bind(target) : value;
  };
  const builder = (inner: object, locking: boolean): object =>
    new Proxy(inner, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        const method = value as Method;
        if (EXECUTE.has(prop)) {
          return async (...args: unknown[]) => {
            if (locking && !used) {
              used = true;
              await gate();
            }
            return method.apply(target, args);
          };
        }
        return (...args: unknown[]) => {
          const next = method.apply(target, args);
          const chained =
            typeof next === 'object' &&
            next !== null &&
            typeof (next as { executeTakeFirst?: unknown }).executeTakeFirst === 'function';
          return chained ? builder(next, locking || prop === lock) : next;
        };
      },
    });
  const transaction = (trx: object): object =>
    new Proxy(trx, {
      get(target, prop) {
        if (prop !== 'selectFrom') return bound(target, prop);
        const selectFrom = Reflect.get(target, prop, target) as Method;
        return (name: unknown) => {
          const query = selectFrom.call(target, name) as object;
          return name === table ? builder(query, false) : query;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'transaction') return bound(target, prop);
      return () => ({
        execute: (callback: (trx: object) => Promise<unknown>) =>
          target.transaction().execute((trx) => callback(transaction(trx))),
      });
    },
  });
}

/** The deadlocks Postgres detected in this database so far. */
async function deadlocks(): Promise<number> {
  const result = await sql<{ deadlocks: string | number }>`
    select deadlocks from pg_stat_database where datname = current_database()`.execute(
    harness.context.db,
  );
  return Number(result.rows[0]?.deadlocks ?? 0);
}

/** Waits until a backend of this database waits for a lock (at most `ms`). */
async function lockWaiter(ms = 8000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await sql<{ n: string | number }>`
      select count(*) as n from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(harness.context.db);
    if (Number(result.rows[0]?.n ?? 0) > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function requestLook(client: TestClient, projectId: string, holidayId: string) {
  const project = json<{ project: Project }>(await client.get(`/v1/projects/${projectId}`)).project;
  return client.post(
    '/v1/renders',
    {
      projectId,
      projectVersion: project.projectVersion,
      holidayId,
      style: 'classic',
      lightingMode: 'source',
    },
    { 'idempotency-key': randomUUID() },
  );
}

const cases: {
  mode: 'persist' | 'transient';
  table: string;
  lock: 'forShare' | 'forUpdate';
  remoteAddress: string;
}[] = [
  // Persist: the record holds the source row and stops before its share lock on the job row.
  { mode: 'persist', table: 'renderJobs', lock: 'forShare', remoteAddress: '10.66.0.1' },
  // Transient: the record holds the job row too and stops before it locks the property to
  // count the framed view's display load.
  { mode: 'transient', table: 'properties', lock: 'forUpdate', remoteAddress: '10.66.0.2' },
];

describe('recording a framing while another look of the project is requested', () => {
  for (const { mode, table, lock, remoteAddress } of cases) {
    it(`${mode}: the request waits for the record, then supersedes the job`, async () => {
      const client = harness.client({ remoteAddress });
      await client.createSession();
      const project = await adoptStreetViewProject(harness, client, FRAMED_PLACE, mode);
      if (mode === 'transient') {
        const { assetPolicyId } = await harness.context.db
          .selectFrom('sourceAssets')
          .select('assetPolicyId')
          .where('id', '=', project.sourceAssetId)
          .executeTakeFirstOrThrow();
        await harness.context.db
          .updateTable('assetPolicies')
          .set({ store: 'denied' })
          .where('id', '=', assetPolicyId!)
          .execute();
      }
      const first = await requestLook(client, project.projectId, 'christmas');
      expect(first.statusCode).toBe(202);
      const jobId = json<{ renderJobId: string }>(first).renderJobId;

      const before = await deadlocks();
      let second: ReturnType<typeof requestLook> | null = null;
      let requestWaited = false;
      const pipeline: PipelineDeps = {
        ...harness.pipeline,
        db: gatedDb(harness.pipeline.db, table, lock, async () => {
          // Another look of the place is requested while the first one records its framing.
          second = requestLook(client, project.projectId, 'halloween');
          requestWaited = await lockWaiter();
        }),
      };
      await runRenderJob(pipeline, { renderJobId: jobId }).catch(() => null);
      expect(second).not.toBeNull();
      const response = await second!;
      // The statistics collector reports the counter with a delay.
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(requestWaited).toBe(true);
      expect(response.statusCode).toBe(202);
      expect(await deadlocks()).toBe(before);
      const job = await harness.context.db
        .selectFrom('renderJobs')
        .select('state')
        .where('id', '=', jobId)
        .executeTakeFirstOrThrow();
      expect(job.state).toBe('superseded');
      // The framing was recorded before the request went on.
      const source = await harness.context.db
        .selectFrom('sourceAssets')
        .select('viewpoint')
        .where('id', '=', project.sourceAssetId)
        .executeTakeFirstOrThrow();
      expect(source.viewpoint?.framing?.status).toBe('framed');
    });
  }
});
