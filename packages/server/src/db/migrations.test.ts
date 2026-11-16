import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { sql, type Kysely } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RENDER_JOB_STATES } from '@hailiday/core';
import { createDb } from './client.js';
import { factories } from './factories.js';
import type { Db } from './client.js';
import { appliedMigrations, migrateToLatest } from './migrator.js';
import { MIGRATIONS } from './migrations/index.js';
import * as attemptRepairFlag from './migrations/0011_attempt_repair_flag.js';
import * as projectLookDefaults from './migrations/0012_project_look_defaults.js';
import * as brightLighting from './migrations/0013_bright_lighting.js';
import * as threeAttemptRelights from './migrations/0014_three_attempt_relights.js';
import * as keepEveryRendering from './migrations/0015_keep_every_rendering.js';
import * as streetViewEnhancement from './migrations/0018_street_view_enhancement.js';
import * as framingSubStage from './migrations/0019_framing_sub_stage.js';
import { testDatabaseUrl } from './testing.js';

/** A scratch database named after this run's test database, so parallel runs never share it. */
const scratchName = `${new URL(testDatabaseUrl()).pathname.replace(/^\//, '')}_migrations`;

function urlFor(database: string): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: urlFor('postgres') });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

describe('migrations', () => {
  let db: Db;

  beforeAll(async () => {
    await admin(async (client) => {
      await client.query(`drop database if exists ${scratchName} with (force)`);
      await client.query(`create database ${scratchName}`);
    });
    db = createDb({ connectionString: urlFor(scratchName), max: 4 });
  });

  afterAll(async () => {
    await db?.destroy();
    await admin((client) => client.query(`drop database if exists ${scratchName} with (force)`));
  });

  it('migrates up from an empty database, once, even when runs race', async () => {
    const [first, second] = await Promise.all([migrateToLatest(db), migrateToLatest(db)]);
    const applied = [...first.applied, ...second.applied].sort();
    expect(applied).toEqual(Object.keys(MIGRATIONS).sort());
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
    expect((await migrateToLatest(db)).applied).toEqual([]);
  });

  it('creates every entity table from the data model', async () => {
    const rows = await sql<{ tableName: string }>`
      select table_name from information_schema.tables where table_schema = 'public'
    `.execute(db);
    const tables = new Set(rows.rows.map((row) => row.tableName));
    for (const table of [
      'owners',
      'anonymous_sessions',
      'users',
      'auth_tokens',
      'country_capabilities',
      'runtime_settings',
      'properties',
      'projects',
      'source_discoveries',
      'source_assets',
      'asset_policies',
      'permission_evaluations',
      'holiday_pack_versions',
      'holiday_occurrences',
      'hero_assets',
      'example_assets',
      'style_kits',
      'kit_items',
      'render_jobs',
      'source_enhancements',
      'render_attempts',
      'scene_analyses',
      'decoration_plans',
      'judge_results',
      'render_assets',
      'reviews',
      'usage_ledger',
      'merchant_programs',
      'products',
      'offers',
      'render_product_links',
      'affiliate_clicks',
      'affiliate_conversions',
      'share_grants',
      'feedback',
      'reports',
      'blocked_addresses',
      'preservation_holds',
      'deletion_requests',
      'tombstones',
      'allowance_residue',
      'analytics_events',
      'audit_log',
      'fixture_emails',
    ]) {
      expect(tables.has(table), table).toBe(true);
    }
  });

  it('generates CHECK constraints from the core enum arrays', async () => {
    const rows = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid = 'render_jobs'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%state = ANY%'
    `.execute(db);
    const definition = rows.rows.map((row) => row.definition).join(' ');
    for (const state of RENDER_JOB_STATES) expect(definition).toContain(`'${state}'`);
  });

  it('lets only the second attempt be a repair, without making every second attempt one', async () => {
    const repairRule = async () =>
      (
        await sql<{ definition: string }>`
          select pg_get_constraintdef(oid) as definition from pg_constraint
          where conrelid = 'render_attempts'::regclass and conname = 'render_attempts_repair_rule'
        `.execute(db)
      ).rows.map((row) => row.definition);
    // The rule of 0011 as it stood before third attempts (0014) widened it.
    await threeAttemptRelights.down(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK (((NOT is_repair) OR (attempt_no = 2)))']);
    await attemptRepairFlag.down(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK ((is_repair = (attempt_no = 2)))']);
    await attemptRepairFlag.up(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK (((NOT is_repair) OR (attempt_no = 2)))']);
    await threeAttemptRelights.up(db.withoutPlugins() as Kysely<unknown>);
    expect(await repairRule()).toEqual(['CHECK (((NOT is_repair) OR (attempt_no > 1)))']);
  });

  it('allows a third attempt only as a relight and one repair per job, and reverts', async () => {
    const checks = async () =>
      Object.fromEntries(
        (
          await sql<{ name: string; definition: string; validated: boolean }>`
            select conname as name, pg_get_constraintdef(oid) as definition,
              convalidated as validated
            from pg_constraint
            where contype = 'c' and conname in (
              'decoration_plans_attempt_no_check', 'render_attempts_attempt_no_check',
              'render_jobs_attempt_count_check', 'render_attempts_repair_rule',
              'render_attempts_third_is_relight')
          `.execute(db)
        ).rows.map((row) => [row.name, { definition: row.definition, validated: row.validated }]),
      );
    const repairIndex = async () =>
      (
        await sql<{ definition: string }>`
          select indexdef as definition from pg_indexes
          where tablename = 'render_attempts' and indexname = 'render_attempts_one_repair_per_job_idx'
        `.execute(db)
      ).rows.map((row) => row.definition);
    const up = {
      decoration_plans_attempt_no_check: {
        definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2, 3])))',
        validated: true,
      },
      render_attempts_attempt_no_check: {
        definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2, 3])))',
        validated: true,
      },
      render_jobs_attempt_count_check: {
        definition: 'CHECK (((attempt_count >= 0) AND (attempt_count <= 3)))',
        validated: true,
      },
      render_attempts_repair_rule: {
        definition: 'CHECK (((NOT is_repair) OR (attempt_no > 1)))',
        validated: true,
      },
      render_attempts_third_is_relight: {
        definition: "CHECK (((attempt_no < 3) OR (fidelity_mode = 'global_relight'::text)))",
        validated: true,
      },
    };
    expect(await checks()).toEqual(up);
    expect(await repairIndex()).toEqual([
      expect.stringMatching(/UNIQUE INDEX .* \(job_id\) WHERE is_repair$/),
    ]);
    // No stored job made a third attempt, so every check returns to its two-attempt form.
    await threeAttemptRelights.down(db.withoutPlugins() as Kysely<unknown>);
    expect(await checks()).toEqual({
      decoration_plans_attempt_no_check: {
        definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2])))',
        validated: true,
      },
      render_attempts_attempt_no_check: {
        definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2])))',
        validated: true,
      },
      render_jobs_attempt_count_check: {
        definition: 'CHECK (((attempt_count >= 0) AND (attempt_count <= 2)))',
        validated: true,
      },
      render_attempts_repair_rule: {
        definition: 'CHECK (((NOT is_repair) OR (attempt_no = 2)))',
        validated: true,
      },
    });
    expect(await repairIndex()).toEqual([]);
    await threeAttemptRelights.up(db.withoutPlugins() as Kysely<unknown>);
    expect(await checks()).toEqual(up);
    expect(await repairIndex()).toHaveLength(1);
  });

  it('starts a project in the abundant style and as-photographed lighting', async () => {
    const defaults = async () =>
      Object.fromEntries(
        (
          await sql<{ column: string; value: string }>`
            select column_name as column, column_default as value from information_schema.columns
            where table_name = 'projects' and column_name in ('style', 'lighting_mode')
          `.execute(db)
        ).rows.map((row) => [row.column, row.value]),
      );
    expect(await defaults()).toEqual({
      style: "'abundant'::text",
      lighting_mode: "'source'::text",
    });
    await projectLookDefaults.down(db.withoutPlugins() as Kysely<unknown>);
    expect((await defaults()).style).toBe("'classic'::text");
    await projectLookDefaults.up(db.withoutPlugins() as Kysely<unknown>);
    expect((await defaults()).style).toBe("'abundant'::text");
  });

  it('accepts the bright lighting mode everywhere a lighting mode is stored, and reverts', async () => {
    const definitions = async () =>
      Object.fromEntries(
        (
          await sql<{ table: string; definition: string; validated: boolean }>`
            select conrelid::regclass::text as table, pg_get_constraintdef(oid) as definition,
              convalidated as validated
            from pg_constraint
            where contype = 'c' and conname like '%_lighting_mode_check'
          `.execute(db)
        ).rows.map((row) => [
          row.table,
          { bright: row.definition.includes("'bright'"), validated: row.validated },
        ]),
      );
    const galleryIndex = async () =>
      (
        await sql<{ definition: string }>`
          select indexdef as definition from pg_indexes
          where tablename = 'render_assets' and indexname = 'render_assets_owner_created_idx'
        `.execute(db)
      ).rows.map((row) => row.definition);
    const tables = ['example_assets', 'projects', 'render_assets', 'render_jobs'];
    const all = (value: { bright: boolean; validated: boolean }) =>
      Object.fromEntries(tables.map((table) => [table, value]));
    expect(await definitions()).toEqual(all({ bright: true, validated: true }));
    expect(await galleryIndex()).toEqual([expect.stringContaining('(owner_id, created_at, id)')]);
    // Nothing stored uses `bright`, so every check refuses it again.
    await brightLighting.down(db.withoutPlugins() as Kysely<unknown>);
    expect(await definitions()).toEqual(all({ bright: false, validated: true }));
    expect(await galleryIndex()).toEqual([]);
    await brightLighting.up(db.withoutPlugins() as Kysely<unknown>);
    expect(await definitions()).toEqual(all({ bright: true, validated: true }));
    expect(await galleryIndex()).toHaveLength(1);
  });

  /** Definition and validation state of the named check constraints. */
  const checksNamed = async (names: readonly string[]) =>
    Object.fromEntries(
      (
        await sql<{ name: string; table: string; definition: string; validated: boolean }>`
          select conname as name, conrelid::regclass::text as table,
            pg_get_constraintdef(oid) as definition, convalidated as validated
          from pg_constraint
          where contype = 'c' and conname in (${sql.join([...names])})
        `.execute(db)
      ).rows.map((row) => [row.name, { definition: row.definition, validated: row.validated }]),
    );

  /** Index definitions of a table, by name. */
  const indexesOf = async (table: string) =>
    Object.fromEntries(
      (
        await sql<{ name: string; definition: string }>`
          select indexname as name, indexdef as definition from pg_indexes
          where tablename = ${table}
        `.execute(db)
      ).rows.map((row) => [row.name, row.definition]),
    );

  /** A rendering of a job, with the smallest valid row. */
  const insertRenderAsset = async (jobId: string) =>
    (
      await sql<{ id: string }>`
        insert into render_assets (id, owner_id, project_id, job_id, source_asset_id, variant_key,
          holiday_id, style, lighting_mode, holiday_pack_version, compiler_version, object_key,
          width, height, content_type, byte_length, native_width, native_height, fidelity_mode,
          provenance, distributable, downloadable)
        select gen_random_uuid(), owner_id, project_id, id, source_asset_id, variant_key,
          holiday_id, style, lighting_mode, holiday_pack_version, compiler_version,
          'test/' || id::text, 10, 10, 'image/jpeg', 1, 10, 10,
          case when lighting_mode = 'source' then 'composite_additive' else 'global_relight' end,
          '{}'::jsonb, false, false
        from render_jobs where id = ${jobId}
        returning id
      `.execute(db)
    ).rows[0]?.id as string;

  /**
   * A bright job that used three attempts (the base, its relight, and the relight's repair on
   * attempt 3) and was delivered, as only the widened checks allow.
   */
  const seedThreeAttemptBrightJob = async () => {
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const job = await factories.renderJob(db, {
      ownerId: owner.id,
      projectId: project.id,
      sourceAssetId: source.id,
      lightingMode: 'bright',
      state: 'succeeded',
    });
    await sql`update render_jobs set attempt_count = 3, repair_used = true where id = ${job.id}`.execute(
      db,
    );
    const analysisId = randomUUID();
    await sql`
      insert into scene_analyses (id, source_asset_id, analysis_model, analysis_prompt_version,
        schema_version, working_width, working_height, working_checksum_sha256, document)
      values (${analysisId}, ${source.id}, 'fixture', 'test-1', 'test-1', 10, 10, 'checksum', '{}')
    `.execute(db);
    const kitId = randomUUID();
    await sql`
      insert into style_kits (id, kit_key, holiday_id, scene_type, version, status)
      values (${kitId}, 'christmas.interior', 'christmas', 'interior', '1.0.0', 'draft')
    `.execute(db);
    for (const [attemptNo, isRepair, fidelityMode] of [
      [1, false, 'composite_additive'],
      [2, false, 'global_relight'],
      [3, true, 'global_relight'],
    ] as const) {
      const planId = randomUUID();
      await sql`
        insert into decoration_plans (id, job_id, attempt_no, scene_analysis_id, pack_version,
          style_kit_id, compiler_version, document, validator_result)
        values (${planId}, ${job.id}, ${attemptNo}, ${analysisId}, '2.0.0', ${kitId}, 'test-1',
          '{}', '{}')
      `.execute(db);
      await sql`
        insert into render_attempts (id, job_id, attempt_no, is_repair, decoration_plan_id,
          scene_analysis_id, permission_evaluation_id, provider, model_snapshot, prompt_version,
          compiler_version, settings_hash, provider_mode, source_checksum_sha256,
          working_checksum_sha256, fidelity_mode, outcome)
        values (${randomUUID()}, ${job.id}, ${attemptNo}, ${isRepair}, ${planId}, ${analysisId},
          ${job.permissionEvaluationId}, 'fixture', 'fixture', 'test-1', 'test-1', 'hash',
          'fixture', 'checksum', 'checksum', ${fidelityMode},
          ${attemptNo === 2 ? 'qa_rejected' : 'succeeded'})
      `.execute(db);
    }
    const renderAssetId = await insertRenderAsset(job.id);
    return { ownerId: owner.id, jobId: job.id, renderAssetId };
  };

  /** The updates sweeps and reconciliation make to a stored job, its attempts and rendering. */
  const touchStoredRows = async (stored: { jobId: string; renderAssetId: string }) => {
    await sql`update render_jobs set updated_at = now() where id = ${stored.jobId}`.execute(db);
    await sql`
      update render_attempts set transport_retries = transport_retries + 1
      where job_id = ${stored.jobId}
    `.execute(db);
    await sql`
      update decoration_plans set compiled_instruction = 'x' where job_id = ${stored.jobId}
    `.execute(db);
    await sql`
      update render_assets set pinned_until = now() where id = ${stored.renderAssetId}
    `.execute(db);
  };

  it('keeps the wider checks on the way down while stored rows need them, and the rows stay updatable', async () => {
    const raw = db.withoutPlugins() as Kysely<unknown>;
    const stored = await seedThreeAttemptBrightJob();
    try {
      await threeAttemptRelights.down(raw);
      expect(
        await checksNamed([
          'decoration_plans_attempt_no_check',
          'render_attempts_attempt_no_check',
          'render_jobs_attempt_count_check',
          'render_attempts_repair_rule',
          'render_attempts_third_is_relight',
        ]),
      ).toEqual({
        decoration_plans_attempt_no_check: {
          definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2, 3])))',
          validated: true,
        },
        render_attempts_attempt_no_check: {
          definition: 'CHECK ((attempt_no = ANY (ARRAY[1, 2, 3])))',
          validated: true,
        },
        render_jobs_attempt_count_check: {
          definition: 'CHECK (((attempt_count >= 0) AND (attempt_count <= 3)))',
          validated: true,
        },
        render_attempts_repair_rule: {
          definition: 'CHECK (((NOT is_repair) OR (attempt_no > 1)))',
          validated: true,
        },
      });
      expect(Object.keys(await indexesOf('render_attempts'))).not.toContain(
        'render_attempts_one_repair_per_job_idx',
      );
      await touchStoredRows(stored);

      await brightLighting.down(raw);
      const lighting = await checksNamed([
        'projects_lighting_mode_check',
        'render_jobs_lighting_mode_check',
        'render_assets_lighting_mode_check',
        'example_assets_lighting_mode_check',
      ]);
      expect(
        Object.fromEntries(
          Object.entries(lighting).map(([name, check]) => [
            name,
            { bright: check.definition.includes("'bright'"), validated: check.validated },
          ]),
        ),
      ).toEqual({
        projects_lighting_mode_check: { bright: false, validated: true },
        render_jobs_lighting_mode_check: { bright: true, validated: true },
        render_assets_lighting_mode_check: { bright: true, validated: true },
        example_assets_lighting_mode_check: { bright: false, validated: true },
      });
      await touchStoredRows(stored);

      // The repair flag's own way down rewrites every attempt, the third included.
      await attemptRepairFlag.down(raw);
      await touchStoredRows(stored);
    } finally {
      await attemptRepairFlag.up(raw);
      await brightLighting.up(raw);
      await threeAttemptRelights.up(raw);
      await sql`delete from owners where id = ${stored.ownerId}`.execute(db);
    }
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
  });

  it('keeps several live renderings of one key, and restores uniqueness on the way down only when none share one', async () => {
    const raw = db.withoutPlugins() as Kysely<unknown>;
    const unique = 'render_assets_owner_variant_key_idx';
    const plain = 'render_assets_owner_variant_key_created_idx';
    const indexes = await indexesOf('render_assets');
    expect(indexes[unique]).toBeUndefined();
    expect(indexes[plain]).toMatch(
      /^CREATE INDEX .* \(owner_id, variant_key, created_at DESC, id DESC\) WHERE \(deleted_at IS NULL\)$/,
    );

    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const jobs = [];
    for (let index = 0; index < 2; index += 1) {
      jobs.push(
        await factories.renderJob(db, {
          ownerId: owner.id,
          projectId: project.id,
          sourceAssetId: source.id,
          state: 'succeeded',
        }),
      );
    }
    expect(jobs[0]?.variantKey).toBe(jobs[1]?.variantKey);
    const [older, newer] = [
      await insertRenderAsset(jobs[0]?.id as string),
      await insertRenderAsset(jobs[1]?.id as string),
    ];
    const live = async () =>
      (
        await sql<{ id: string }>`
          select id from render_assets where owner_id = ${owner.id} and deleted_at is null
          order by created_at, id
        `.execute(db)
      ).rows.map((row) => row.id);
    expect((await live()).sort()).toEqual([older, newer].sort());

    try {
      // Two live renderings share a key: the way down keeps them and the plain index.
      await keepEveryRendering.down(raw);
      const kept = await indexesOf('render_assets');
      expect(kept[unique]).toBeUndefined();
      expect(kept[plain]).toBeDefined();
      expect((await live()).sort()).toEqual([older, newer].sort());

      // With one of them deleted, the way down restores the unique index.
      await sql`update render_assets set deleted_at = now() where id = ${older}`.execute(db);
      await keepEveryRendering.down(raw);
      const restored = await indexesOf('render_assets');
      expect(restored[unique]).toMatch(/^CREATE UNIQUE INDEX .* \(owner_id, variant_key\) WHERE/);
      expect(restored[plain]).toBeUndefined();
    } finally {
      await keepEveryRendering.up(raw);
      await sql`delete from owners where id = ${owner.id}`.execute(db);
    }
    const again = await indexesOf('render_assets');
    expect(again[unique]).toBeUndefined();
    expect(again[plain]).toBeDefined();
  });
  it('records one enhancement per source, frame and release, adds the job sub-stage, and reverts', async () => {
    const raw = db.withoutPlugins() as Kysely<unknown>;
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const job = await factories.renderJob(db, {
      ownerId: owner.id,
      projectId: project.id,
      sourceAssetId: source.id,
    });
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      sourceAssetId: source.id,
      frameChecksumSha256: 'a'.repeat(64),
      compilerVersion: '2026.11.7-fixture',
      workingWidth: 1024,
      workingHeight: 1024,
      status: 'pending' as const,
      ...overrides,
    });
    const insert = (overrides: Record<string, unknown> = {}) =>
      db
        .insertInto('sourceEnhancements')
        .values(row(overrides) as never)
        .returningAll()
        .executeTakeFirstOrThrow();
    try {
      const first = await insert({ jobId: job.id });
      expect(first).toMatchObject({
        status: 'pending',
        retryable: false,
        editCount: 0,
        failureCodes: [],
        objectKey: null,
      });
      // One row per (source, frame checksum, compiler version).
      await expect(insert()).rejects.toThrow(/duplicate key/);
      await insert({ compilerVersion: '2026.11.8-fixture' });
      await insert({ frameChecksumSha256: 'b'.repeat(64) });
      // Accepted only with its stored picture and that picture's checksum.
      await expect(insert({ status: 'accepted', compilerVersion: 'v-a' })).rejects.toThrow(
        /source_enhancements_accepted_rule/,
      );
      await expect(
        insert({ status: 'accepted', compilerVersion: 'v-b', objectKey: 'enhanced/x.png' }),
      ).rejects.toThrow(/source_enhancements_accepted_rule/);
      await insert({
        status: 'accepted',
        compilerVersion: 'v-c',
        objectKey: 'enhanced/x.png',
        enhancedChecksumSha256: 'c'.repeat(64),
      });
      await expect(insert({ status: 'done', compilerVersion: 'v-d' })).rejects.toThrow(/check/);
      await expect(insert({ editCount: 3, compilerVersion: 'v-e' })).rejects.toThrow(/check/);
      await expect(
        insert({ failureCodes: ['made_up_code'], compilerVersion: 'v-f' }),
      ).rejects.toThrow(/check/);
      await insert({
        status: 'rejected',
        compilerVersion: 'v-g',
        failureCodes: ['structure_changed', 'text_added'],
      });

      // The job's sub-stage takes the sub-stage values only; the enhancement record is JSON.
      await db
        .updateTable('renderJobs')
        .set({ subStage: 'enhancing' })
        .where('id', '=', job.id)
        .execute();
      await expect(
        db
          .updateTable('renderJobs')
          .set({ subStage: 'sharpening' as never })
          .where('id', '=', job.id)
          .execute(),
      ).rejects.toThrow(/check/);
      const record = { outcome: 'made', enhancementId: first.id, reason: null };
      const updated = await db
        .updateTable('renderJobs')
        .set({ subStage: 'relight', enhancement: JSON.stringify(record) })
        .where('id', '=', job.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      expect(updated.subStage).toBe('relight');
      expect(updated.enhancement).toEqual(record);

      // Deleting a source deletes its enhancement rows.
      const other = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
      await db
        .insertInto('sourceEnhancements')
        .values({ ...row(), sourceAssetId: other.id })
        .execute();
      await sql`delete from source_assets where id = ${other.id}`.execute(db);
      const left = await sql<{ count: string }>`
        select count(*) from source_enhancements where source_asset_id = ${other.id}
      `.execute(db);
      expect(Number(left.rows[0]?.count)).toBe(0);

      await streetViewEnhancement.down(raw);
      const tables = await sql<{ tableName: string }>`
        select table_name from information_schema.tables
        where table_schema = 'public' and table_name = 'source_enhancements'
      `.execute(db);
      expect(tables.rows).toEqual([]);
      const columns = await sql<{ columnName: string }>`
        select column_name from information_schema.columns
        where table_name = 'render_jobs' and column_name in ('sub_stage', 'enhancement')
      `.execute(db);
      expect(columns.rows).toEqual([]);
    } finally {
      await streetViewEnhancement.up(raw).catch(() => undefined);
      await sql`delete from owners where id = ${owner.id}`.execute(db);
    }
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
    const restored = await sql<{ columnName: string }>`
      select column_name from information_schema.columns
      where table_name = 'render_jobs' and column_name in ('sub_stage', 'enhancement')
      order by column_name
    `.execute(db);
    expect(restored.rows.map((r) => r.columnName)).toEqual(['enhancement', 'sub_stage']);
  });

  it('accepts the framing sub-stage, and reverts by clearing it', async () => {
    const raw = db.withoutPlugins() as Kysely<unknown>;
    const owner = await factories.owner(db);
    const project = await factories.project(db, { ownerId: owner.id });
    const source = await factories.sourceAsset(db, { ownerId: owner.id, projectId: project.id });
    const job = await factories.renderJob(db, {
      ownerId: owner.id,
      projectId: project.id,
      sourceAssetId: source.id,
    });
    const setSubStage = (subStage: string) =>
      db
        .updateTable('renderJobs')
        .set({ subStage: subStage as never })
        .where('id', '=', job.id)
        .returning('subStage')
        .executeTakeFirstOrThrow();
    try {
      expect((await setSubStage('framing')).subStage).toBe('framing');
      await framingSubStage.down(raw);
      const cleared = await db
        .selectFrom('renderJobs')
        .select('subStage')
        .where('id', '=', job.id)
        .executeTakeFirstOrThrow();
      expect(cleared.subStage).toBeNull();
      await expect(setSubStage('framing')).rejects.toThrow(/check/);
      expect((await setSubStage('enhancing')).subStage).toBe('enhancing');
      await framingSubStage.up(raw);
      expect((await setSubStage('framing')).subStage).toBe('framing');
      await expect(setSubStage('zooming')).rejects.toThrow(/check/);
    } finally {
      await framingSubStage.up(raw).catch(() => undefined);
      await sql`delete from owners where id = ${owner.id}`.execute(db);
    }
    expect(await appliedMigrations(db)).toEqual(Object.keys(MIGRATIONS));
  });
});
