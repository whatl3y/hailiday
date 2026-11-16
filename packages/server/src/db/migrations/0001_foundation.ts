import type { Kysely } from 'kysely';
import {
  ACTIVATION_STATES,
  AUDIT_ACTOR_KINDS,
  AUTH_TOKEN_PURPOSES,
  BASE_CAPABILITY_KEYS,
  OWNER_KINDS,
  PRESERVATION_HOLD_REASONS,
  PRESERVATION_HOLD_TARGET_KINDS,
  USER_ROLES,
} from '@hailiday/core';
import {
  ID_AND_CREATED,
  ID_CREATED_UPDATED,
  checkIn,
  checkSubset,
  inList,
  runStatements,
  updatedAtTrigger,
} from '../sql-helpers.js';

/** Owners, sessions, accounts, capabilities, runtime settings, preservation holds and audit. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await runStatements(db, [
    `CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,

    `CREATE TABLE owners (
      ${ID_CREATED_UPDATED},
      kind text NOT NULL ${checkIn('kind', OWNER_KINDS)},
      deleted_at timestamptz
    )`,
    updatedAtTrigger('owners'),

    `CREATE TABLE users (
      ${ID_CREATED_UPDATED},
      owner_id uuid NOT NULL UNIQUE REFERENCES owners(id) ON DELETE CASCADE,
      email_normalized text NOT NULL UNIQUE,
      email_verified_at timestamptz,
      roles text[] NOT NULL DEFAULT '{user}' ${checkSubset('roles', USER_ROLES)},
      tos_version text,
      last_login_at timestamptz,
      deleted_at timestamptz
    )`,
    updatedAtTrigger('users'),

    `CREATE TABLE anonymous_sessions (
      ${ID_CREATED_UPDATED},
      owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
      token_hash text NOT NULL UNIQUE,
      turnstile_verified_at timestamptz,
      device_hash text,
      ip_hash text,
      timezone text,
      country_code char(2) NOT NULL DEFAULT 'US',
      last_seen_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL
    )`,
    updatedAtTrigger('anonymous_sessions'),
    `CREATE INDEX anonymous_sessions_owner_id_idx ON anonymous_sessions (owner_id)`,
    `CREATE INDEX anonymous_sessions_device_hash_idx ON anonymous_sessions (device_hash)`,
    `CREATE INDEX anonymous_sessions_ip_hash_idx ON anonymous_sessions (ip_hash)`,
    `CREATE INDEX anonymous_sessions_last_seen_at_idx ON anonymous_sessions (last_seen_at)`,
    `CREATE INDEX anonymous_sessions_expires_at_idx ON anonymous_sessions (expires_at)`,

    `CREATE TABLE auth_tokens (
      ${ID_CREATED_UPDATED},
      token_hash text NOT NULL UNIQUE,
      email_normalized text NOT NULL,
      purpose text NOT NULL ${checkIn('purpose', AUTH_TOKEN_PURPOSES)},
      requested_from_session_id uuid REFERENCES anonymous_sessions(id) ON DELETE SET NULL,
      return_to text CHECK (return_to IS NULL OR return_to ~ '^/[^/\\\\]'  OR return_to = '/'),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      ip_hash text
    )`,
    updatedAtTrigger('auth_tokens'),
    `CREATE INDEX auth_tokens_email_normalized_idx ON auth_tokens (email_normalized)`,
    `CREATE INDEX auth_tokens_expires_at_idx ON auth_tokens (expires_at)`,

    `CREATE TABLE country_capabilities (
      ${ID_CREATED_UPDATED},
      country_code char(2) NOT NULL,
      capability text NOT NULL CHECK (
        capability IN (${inList(BASE_CAPABILITY_KEYS)})
        OR capability ~ '^commerce:[a-z0-9][a-z0-9_-]{0,63}$'
      ),
      state text NOT NULL ${checkIn('state', ACTIVATION_STATES)},
      evidence_ref text NOT NULL,
      reviewed_at timestamptz NOT NULL,
      reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      version integer NOT NULL DEFAULT 0,
      UNIQUE (country_code, capability)
    )`,
    updatedAtTrigger('country_capabilities'),

    `CREATE TABLE runtime_settings (
      key text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      value jsonb NOT NULL,
      version integer NOT NULL DEFAULT 0,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL
    )`,
    updatedAtTrigger('runtime_settings'),

    `CREATE TABLE preservation_holds (
      ${ID_CREATED_UPDATED},
      target_kind text NOT NULL ${checkIn('target_kind', PRESERVATION_HOLD_TARGET_KINDS)},
      target_id uuid NOT NULL,
      reason text NOT NULL ${checkIn('reason', PRESERVATION_HOLD_REASONS)},
      authority_ref text NOT NULL,
      release_condition text NOT NULL,
      placed_by uuid NOT NULL REFERENCES users(id),
      released_by uuid REFERENCES users(id),
      released_at timestamptz,
      release_reason text
    )`,
    updatedAtTrigger('preservation_holds'),
    `CREATE INDEX preservation_holds_target_idx ON preservation_holds (target_kind, target_id)`,

    `CREATE TABLE audit_log (
      ${ID_AND_CREATED},
      actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_kind text NOT NULL ${checkIn('actor_kind', AUDIT_ACTOR_KINDS)},
      action text NOT NULL CHECK (action ~ '^[a-z_]+(\\.[a-z_]+)+$'),
      target_kind text NOT NULL,
      target_id text NOT NULL,
      before jsonb,
      after jsonb,
      request_id text NOT NULL,
      ip_hash text
    )`,
    `CREATE INDEX audit_log_action_created_at_idx ON audit_log (action, created_at)`,
  ]);
}
