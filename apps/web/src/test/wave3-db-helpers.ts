/**
 * Shared PGlite helpers for the Wave 3 security guard tests (migrations 185–190):
 * impersonate a signed-in member (JWT claims + `set role authenticated`) and seed a
 * core.employees seat with a legacy role (the source core.is_finance_member() reads).
 */
import type { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';

export interface Claims {
  sub?: string;
  org_id?: string;
  role?: string;
}

/** Run `fn` as `role` with the given JWT claims; always resets. */
export async function asClaims<T>(db: PGlite, role: 'authenticated' | 'anon' | 'service_role', claims: Claims, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ ...claims, role })]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

/** Error message of one statement, or null when it succeeds. */
export async function errorOf(db: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Insert an active core.employees seat (filling any other required enum / text column generically). */
export async function seedEmployee(db: PGlite, orgId: string, clerkUserId: string, role: string): Promise<string> {
  const id = crypto.randomUUID();
  const cols = await db.query<{ column_name: string; udt_name: string }>(
    `select column_name, udt_name from information_schema.columns
      where table_schema = 'core' and table_name = 'employees' and is_nullable = 'NO' and column_default is null`,
  );
  const values: Record<string, string> = { id, org_id: orgId, clerk_user_id: clerkUserId, role, first_name: 'T', last_name: 'User' };
  const names = Object.keys(values);
  const exprs = names.map((_, i) => `$${i + 1}`);
  const params: string[] = names.map((n) => values[n]);
  for (const c of cols.rows) {
    if (names.includes(c.column_name)) continue;
    const label = await db.query<{ enumlabel: string }>(
      `select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = $1 order by e.enumsortorder limit 1`,
      [c.udt_name],
    );
    names.push(c.column_name);
    params.push(label.rows[0]?.enumlabel ?? 'x');
    exprs.push(label.rows[0] ? `$${params.length}::${c.udt_name}` : `$${params.length}`);
  }
  await db.query(`insert into core.employees (${names.join(', ')}) values (${exprs.join(', ')})`, params);
  return id;
}
