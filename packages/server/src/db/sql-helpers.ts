import { sql } from 'kysely';
import type { Kysely } from 'kysely';

/** A SQL string literal. Used only with trusted constants (core enum arrays), never user input. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `'a', 'b', 'c'` for an IN list. */
export function inList(values: readonly string[]): string {
  if (values.length === 0) throw new RangeError('An IN list needs at least one value');
  return values.map(literal).join(', ');
}

/** `CHECK (column IN (...))`; null passes, so add NOT NULL separately where required. */
export function checkIn(column: string, values: readonly string[]): string {
  return `CHECK (${column} IN (${inList(values)}))`;
}

/** `CHECK (column <@ ARRAY[...])` for a text[] column that holds a subset of an enum. */
export function checkSubset(column: string, values: readonly string[]): string {
  return `CHECK (${column} <@ ARRAY[${inList(values)}]::text[])`;
}

/** Columns every table carries. */
export const ID_AND_CREATED = `id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()`;

export const ID_CREATED_UPDATED = `${ID_AND_CREATED},
  updated_at timestamptz NOT NULL DEFAULT now()`;

/** Installs the trigger that maintains `updated_at` on a table. */
export function updatedAtTrigger(table: string): string {
  return `CREATE TRIGGER ${table}_set_updated_at BEFORE UPDATE ON ${table}
  FOR EACH ROW EXECUTE FUNCTION set_updated_at()`;
}

/** Runs DDL statements in order inside the migration's transaction. */
export async function runStatements(db: Kysely<unknown>, statements: readonly string[]) {
  for (const statement of statements) {
    await sql.raw(statement).execute(db);
  }
}
