/**
 * Ephemeral Postgres for integration tests.
 *
 * Spins up a real Postgres (PGlite — Postgres compiled to WASM, in-process) and
 * replays every migration in packages/supabase/migrations in order. No Docker,
 * no network, no Supabase branch, no cost, and — critically — no possibility of
 * a test touching the production books.
 *
 * Everything hosted Supabase provides that PGlite does not is stubbed below.
 * The stubs are deliberately minimal: they exist so the migrations can run, not
 * to emulate Supabase. Anything a test genuinely depends on should be asserted
 * explicitly rather than assumed from a stub.
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/supabase/migrations',
);

/** Hosted-Supabase surface PGlite doesn't ship. Minimal by design. */
const SUPABASE_STUBS = `
  create extension if not exists pg_trgm;
  create extension if not exists pgcrypto;
  create extension if not exists "uuid-ossp";

  create schema if not exists auth;
  create schema if not exists vault;
  create schema if not exists extensions;
  create schema if not exists storage;

  create or replace function storage.foldername(name text) returns text[] language sql immutable as $sf$
    select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
  $sf$;

  create or replace function auth.jwt()  returns jsonb language sql stable as $$ select '{}'::jsonb $$;
  create or replace function auth.uid()  returns uuid  language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text  language sql stable as $$ select 'service_role'::text $$;

  do $$ begin create role service_role;  exception when duplicate_object then null; end $$;
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
  do $$ begin create role anon;          exception when duplicate_object then null; end $$;

  create table if not exists storage.buckets (
    id text primary key, name text, public boolean default false
  );
  create table if not exists storage.objects (
    id uuid default gen_random_uuid() primary key,
    bucket_id text, name text, owner text, metadata jsonb
  );
`;

/**
 * Hosted Supabase grants anon / authenticated / service_role full table privileges
 * by default (RLS is what then narrows them). PGlite has no such defaults, so a
 * privilege test against the bare replay would pass vacuously. Tests that assert
 * on GRANTs (e.g. identity-write-lock.test.ts) opt in to these to reproduce the
 * real attack surface. Applied BEFORE the migrations so every table created by a
 * migration inherits them, exactly like production.
 */
export const SUPABASE_DEFAULT_GRANTS = `
  alter default privileges grant all on tables    to anon, authenticated, service_role;
  alter default privileges grant all on sequences to anon, authenticated, service_role;
  alter default privileges grant execute on functions to anon, authenticated, service_role;
  alter default privileges grant usage on schemas to anon, authenticated, service_role;
  grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
`;

/** supabase_vault is proprietary to hosted Supabase and has no local equivalent. */
const stripVaultExtension = (sql: string) =>
  sql.replace(/create\s+extension[^;]*supabase_vault[^;]*;/gi, '');

/** Ordered migration filenames (NNN_name.sql). */
export function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
}

/** Apply one migration file; throws with the filename on failure. */
export async function applyMigrationFile(db: PGlite, file: string): Promise<void> {
  const sql = stripVaultExtension(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  try {
    await db.exec(sql);
  } catch (e) {
    throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface MigratedDb {
  db: PGlite;
  applied: number;
  total: number;
}

export interface CreateTestDbOptions {
  /** Reproduce hosted Supabase's default role grants (see SUPABASE_DEFAULT_GRANTS). */
  supabaseDefaultGrants?: boolean;
  /**
   * Stop after the migration whose filename starts with this prefix (e.g. '153'),
   * so a test can assert the state before a migration and then apply the rest.
   */
  through?: string;
}

/**
 * Fresh database with the full schema applied. Throws on the first migration
 * that fails — a broken migration must fail the test run loudly, not silently
 * leave the schema half-built.
 */
export async function createTestDb(opts: CreateTestDbOptions = {}): Promise<MigratedDb> {
  const files = listMigrationFiles();

  const db = new PGlite({ extensions: { pg_trgm, pgcrypto, uuid_ossp } });
  await db.exec(SUPABASE_STUBS);
  if (opts.supabaseDefaultGrants) await db.exec(SUPABASE_DEFAULT_GRANTS);

  let applied = 0;
  for (const f of files) {
    await applyMigrationFile(db, f);
    applied++;
    if (opts.through && f.startsWith(`${opts.through}_`)) break;
  }

  return { db, applied, total: files.length };
}
