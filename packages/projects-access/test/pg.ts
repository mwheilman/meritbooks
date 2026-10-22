/**
 * PGlite replay of EVERY migration in packages/supabase/migrations, in the repo's real
 * (numeric) order: 001…174 (Books), 1001…1007 (legacy proj), 1100…1110 (pm). Same Supabase
 * stubs as apps/web/src/test/pg.ts, plus btree_gist (1104's no-overlap dispatch constraint)
 * and hosted Supabase's default role grants (so privilege assertions are real).
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../supabase/migrations',
);

const SUPABASE_STUBS = `
  create extension if not exists pg_trgm;
  create extension if not exists pgcrypto;
  create extension if not exists "uuid-ossp";
  create extension if not exists btree_gist;

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

  create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
  create table if not exists storage.objects (
    id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner text, metadata jsonb
  );
`;

const SUPABASE_DEFAULT_GRANTS = `
  alter default privileges grant all on tables    to anon, authenticated, service_role;
  alter default privileges grant all on sequences to anon, authenticated, service_role;
  alter default privileges grant execute on functions to anon, authenticated, service_role;
  alter default privileges grant usage on schemas to anon, authenticated, service_role;
  grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
`;

const stripVault = (sql: string): string => sql.replace(/create\s+extension[^;]*supabase_vault[^;]*;/gi, '');

/** NNN_name.sql / NNNN_name.sql, numeric order (the order the repo applies them in). */
export function listMigrationFiles(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10) || a.localeCompare(b));
}

export async function applyMigration(db: PGlite, file: string): Promise<void> {
  const sql = stripVault(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  try {
    await db.exec(sql);
  } catch (e) {
    throw new Error(`migration ${file} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface ReplayOptions {
  /** Stop BEFORE the first migration whose number is ≥ this (e.g. 1110 → state before 1110). */
  before?: number;
}

export async function createReplayDb(opts: ReplayOptions = {}): Promise<{ db: PGlite; applied: string[] }> {
  const db = new PGlite({ extensions: { pg_trgm, pgcrypto, uuid_ossp, btree_gist } });
  await db.exec(SUPABASE_STUBS);
  await db.exec(SUPABASE_DEFAULT_GRANTS);
  const applied: string[] = [];
  for (const f of listMigrationFiles()) {
    if (opts.before !== undefined && parseInt(f, 10) >= opts.before) break;
    await applyMigration(db, f);
    applied.push(f);
  }
  return { db, applied };
}
