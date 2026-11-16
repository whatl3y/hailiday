import { systemClock, type Clock } from './clock/index.js';
import { loadConfig, type AppConfig } from './config/index.js';
import { createDb, type Db } from './db/client.js';
import { createLogger } from './logger/index.js';
import { replayTombstoneMirror } from './pipeline/jobs/tombstones.js';
import { createStorage, type Storage } from './storage/client.js';

export const TOMBSTONES_REPLAY_USAGE = [
  'Usage: pnpm tombstones:replay',
  '',
  'Replays the tombstone mirror (tombstones/ in the private bucket) into the database after a',
  'restore, before traffic resumes: missing tombstones are re-inserted, tombstoned projects,',
  'source assets and variants are marked deleted again, tombstoned share links are revoked and',
  'tombstoned owners lose their account email. Idempotent. Prints counts only.',
].join('\n');

export type TombstonesReplayArgs =
  { kind: 'run' } | { kind: 'help' } | { kind: 'invalid'; argument: string };

/** The command takes no options besides help; a `--` separator forwarded by pnpm is ignored. */
export function parseTombstonesReplayArgs(argv: readonly string[]): TombstonesReplayArgs {
  const args = argv.filter((arg) => arg !== '--');
  const unknown = args.find((arg) => arg !== '--help' && arg !== '-h');
  if (unknown !== undefined) return { kind: 'invalid', argument: unknown };
  return args.length > 0 ? { kind: 'help' } : { kind: 'run' };
}

export interface TombstonesReplayOptions {
  config?: AppConfig;
  db?: Db;
  storage?: Storage;
  clock?: Clock;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

/**
 * `pnpm tombstones:replay`: builds the database and storage clients from the configuration (the
 * package script loads `.env` through the same preload as the other server scripts), replays the
 * tombstone mirror and prints the replay counts as one JSON line. Returns the exit code: 0 on
 * success or help, 2 for an unknown argument.
 */
export async function runTombstonesReplay(
  argv: readonly string[],
  options: TombstonesReplayOptions = {},
): Promise<number> {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const writeError = options.writeError ?? ((line: string) => process.stderr.write(`${line}\n`));
  const args = parseTombstonesReplayArgs(argv);
  if (args.kind === 'help') {
    write(TOMBSTONES_REPLAY_USAGE);
    return 0;
  }
  if (args.kind === 'invalid') {
    writeError(`tombstones:replay: unknown argument ${JSON.stringify(args.argument)}`);
    writeError(TOMBSTONES_REPLAY_USAGE);
    return 2;
  }

  const config = options.config ?? loadConfig();
  const logger = createLogger({
    level: config.logLevel,
    name: 'tombstones-replay',
    secrets: config.secrets,
  });
  const db =
    options.db ??
    createDb({
      connectionString: config.database.url,
      max: 2,
      applicationName: 'hailiday-tombstones-replay',
      logger,
    });
  const storage = options.storage ?? createStorage(config, { logger });
  try {
    const result = await replayTombstoneMirror({
      db,
      storage,
      clock: options.clock ?? systemClock,
      logger,
    });
    write(JSON.stringify({ tombstonesReplay: result }));
    return 0;
  } finally {
    if (!options.storage) storage.destroy();
    if (!options.db) await db.destroy();
  }
}

if (process.argv[1] && /tombstones-replay\.(js|ts)$/.test(process.argv[1])) {
  runTombstonesReplay(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error('tombstones:replay failed:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) console.error(error.stack);
      process.exit(1);
    });
}
