import pg from 'pg';
import { CamelCasePlugin, Kysely, PostgresDialect } from 'kysely';
import type { Transaction } from 'kysely';
import type { Logger } from '../logger/index.js';
import type { Database } from './schema.js';

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
/** Either the root database handle or an open transaction. */
export type DbOrTx = Kysely<Database>;

const INT8_OID = 20;
const NUMERIC_OID = 1700;
const DATE_OID = 1082;

/**
 * Per-pool type parsers: `bigint` and `numeric` become numbers (ledger micros and counts stay
 * within the safe integer range), and `date` stays a `YYYY-MM-DD` string so no timezone shift
 * happens. Scoped to our pools so other `pg` users (pg-boss) keep the driver defaults.
 */
const typeParsers = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (oid === INT8_OID || oid === NUMERIC_OID) {
      return (value: string) => (value === null ? null : Number(value));
    }
    if (oid === DATE_OID) return (value: string) => value;
    return pg.types.getTypeParser(oid, format);
  },
};

export interface CreateDbOptions {
  connectionString: string;
  max?: number;
  applicationName?: string;
  logger?: Logger;
  /** Log every query at debug level. */
  logQueries?: boolean;
}

/** Creates a pg pool with the project's type parsers. */
export function createPool(options: CreateDbOptions): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'holiday',
    types: typeParsers as pg.CustomTypesConfig,
  });
  pool.on('error', (error) => {
    options.logger?.error({ err: error }, 'postgres pool error');
  });
  return pool;
}

/**
 * Creates the Kysely instance: snake_case columns map to camelCase properties through the
 * CamelCasePlugin; keys inside `jsonb` values are left untouched.
 */
export function createDb(options: CreateDbOptions): Db {
  const pool = createPool(options);
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin({ maintainNestedObjectKeys: true })],
    log: options.logQueries
      ? (event) => {
          if (event.level === 'error') {
            options.logger?.error(
              { err: event.error, durationMs: event.queryDurationMillis },
              'query failed',
            );
          } else {
            options.logger?.debug({ durationMs: event.queryDurationMillis }, 'query');
          }
        }
      : undefined,
  });
}

/** Serializes a value for a `jsonb` column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

/** Like `toJson`, passing null and undefined through as null. */
export function toJsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Runs `fn` in a transaction (reusing the caller's when `db` is already one). */
export async function withTransaction<T>(db: DbOrTx, fn: (trx: Tx) => Promise<T>): Promise<T> {
  if (db.isTransaction) return fn(db as Tx);
  return db.transaction().execute(fn);
}

/** Postgres error code for a unique violation. */
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

/** The Postgres SQLSTATE of a driver error, if any. */
export function pgErrorCode(error: unknown): string | null {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/** The violated constraint name of a driver error, if any. */
export function pgConstraint(error: unknown): string | null {
  if (error && typeof error === 'object' && 'constraint' in error) {
    const constraint = (error as { constraint: unknown }).constraint;
    return typeof constraint === 'string' ? constraint : null;
  }
  return null;
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  return (
    pgErrorCode(error) === UNIQUE_VIOLATION &&
    (constraint === undefined || pgConstraint(error) === constraint)
  );
}
