import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from './config/index.js';
import { findWorkspaceRoot } from './config/dotenv.js';
import { sha256Hex } from './ids/index.js';
import type { PipelineDeps } from './pipeline/context.js';
import type { TombstoneMirrorLine } from './pipeline/jobs/tombstones.js';
import { createPipelineTestDeps, createStreetViewSource } from './pipeline/testing.js';
import type { GetResult, Storage } from './storage/client.js';
import {
  TOMBSTONES_REPLAY_USAGE,
  parseTombstonesReplayArgs,
  runTombstonesReplay,
} from './tombstones-replay.js';

let deps: PipelineDeps & { close(): Promise<void> };

beforeAll(async () => {
  deps = await createPipelineTestDeps();
});

afterAll(async () => {
  await deps.close();
});

/** A storage stand-in holding only the given mirror objects (list and get are all replay uses). */
function mirrorStorage(objects: Record<string, string>): Storage {
  return {
    async list(_bucket: string, prefix: string) {
      return Object.keys(objects).filter((key) => key.startsWith(prefix));
    },
    async get(_bucket: string, key: string): Promise<GetResult | null> {
      const body = objects[key];
      return body === undefined ? null : ({ body: Buffer.from(body) } as GetResult);
    },
    destroy() {
      throw new Error('an injected storage is never destroyed by the command');
    },
  } as unknown as Storage;
}

describe('tombstones:replay arguments', () => {
  it('runs with no arguments, prints help, and refuses anything else', () => {
    expect(parseTombstonesReplayArgs([])).toEqual({ kind: 'run' });
    expect(parseTombstonesReplayArgs(['--'])).toEqual({ kind: 'run' });
    expect(parseTombstonesReplayArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseTombstonesReplayArgs(['--', '-h'])).toEqual({ kind: 'help' });
    expect(parseTombstonesReplayArgs(['--dry-run'])).toEqual({
      kind: 'invalid',
      argument: '--dry-run',
    });
    expect(parseTombstonesReplayArgs(['--help', 'extra'])).toEqual({
      kind: 'invalid',
      argument: 'extra',
    });
  });

  it('answers help and unknown arguments without loading configuration or touching storage', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const storage = mirrorStorage({});
    expect(
      await runTombstonesReplay(['--help'], {
        storage,
        write: (line) => out.push(line),
        writeError: (line) => err.push(line),
      }),
    ).toBe(0);
    expect(out).toEqual([TOMBSTONES_REPLAY_USAGE]);
    expect(
      await runTombstonesReplay(['--force'], {
        storage,
        write: (line) => out.push(line),
        writeError: (line) => err.push(line),
      }),
    ).toBe(2);
    expect(err[0]).toContain('--force');
    expect(err[1]).toBe(TOMBSTONES_REPLAY_USAGE);
  });
});

describe('tombstones:replay against the database', () => {
  it('replays the mirror into the configured database and prints counts only', async () => {
    const { projectId } = await createStreetViewSource(deps, {
      placeId: 'ChIJfxLanternHillColonial01',
    });
    const hash = sha256Hex(projectId);
    const deletedAt = new Date('2026-01-02T03:04:05Z');
    const line: TombstoneMirrorLine = {
      kind: 'project',
      hashSha256: hash,
      deletionRequestId: null,
      deletedAt: deletedAt.toISOString(),
      retainUntil: new Date('2099-01-01T00:00:00Z').toISOString(),
      attestationVersion: null,
      attestedAt: null,
    };
    const out: string[] = [];
    const code = await runTombstonesReplay([], {
      config: testConfig(),
      storage: mirrorStorage({
        'tombstones/2026-01-02/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b.jsonl': `${JSON.stringify(line)}\n`,
      }),
      write: (text) => out.push(text),
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    const printed = JSON.parse(out[0] ?? '{}') as {
      tombstonesReplay: Record<string, number>;
    };
    expect(printed.tombstonesReplay).toMatchObject({
      batches: 1,
      lines: 1,
      projectsRedeleted: 1,
    });
    for (const value of Object.values(printed.tombstonesReplay)) {
      expect(typeof value).toBe('number');
    }
    expect(out[0]).not.toContain(projectId);
    expect(out[0]).not.toContain(hash);

    const project = await deps.db
      .selectFrom('projects')
      .select('deletedAt')
      .where('id', '=', projectId)
      .executeTakeFirst();
    // Another test file's deletion resume may already have removed the re-deleted row.
    if (project) expect(project.deletedAt?.toISOString()).toBe(deletedAt.toISOString());
    // The re-deleted project gets a request the deletion resume completes.
    const request = await deps.db
      .selectFrom('deletionRequests')
      .select(['scope', 'requestedBy'])
      .where('targetId', '=', projectId)
      .executeTakeFirstOrThrow();
    expect(request).toEqual({ scope: 'project', requestedBy: 'system' });
    const tombstone = await deps.db
      .selectFrom('tombstones')
      .select('kind')
      .where('hashSha256', '=', hash)
      .executeTakeFirstOrThrow();
    expect(tombstone.kind).toBe('project');
  });
});

describe('tombstones:replay scripts', () => {
  it('runs the built entry through the .env preload, with a root alias', () => {
    const root = findWorkspaceRoot(path.dirname(fileURLToPath(import.meta.url)));
    if (!root) throw new Error('workspace root not found');
    const scriptsOf = (file: string) =>
      (
        JSON.parse(readFileSync(path.join(root, file), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
    expect(scriptsOf('packages/server/package.json')['tombstones:replay']).toBe(
      'node --import ./dist/config/load-env/index.js dist/tombstones-replay.js',
    );
    expect(scriptsOf('package.json')['tombstones:replay']).toBe(
      'pnpm --filter @hailiday/server tombstones:replay',
    );
  });
});
