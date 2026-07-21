/**
 * Schema contract — every constrained string the code writes must be a value the
 * database will actually accept.
 *
 * WHY THIS EXISTS
 *
 * Two defects found in production on 2026-07-20 had identical shape:
 *
 *   1. gl_entries.entry_type is entry_type_enum. GATE 12 posted 'AR_COLLECTION',
 *      'PLATFORM_FEE', 'PAYROLL_RUN' and six more. None existed in the enum, so
 *      the ENTIRE money-movement posting layer had never written a journal entry
 *      since Session 23 - roughly fifteen sessions of silent failure.
 *
 *   2. invoice_events.event_type is a CHECK-constrained vocabulary. The webhook
 *      needed 'PAY_PROCESSING'; the constraint rejected it.
 *
 * Both survived unit tests because the pure functions producing those values are
 * correct in isolation. The mismatch only exists at the boundary, and only a real
 * database can see it. That boundary is now covered.
 *
 * HOW IT WORKS
 *
 * Reads every enum type and every `col = ANY (ARRAY[...])` CHECK constraint out
 * of a freshly migrated database, then scans the source for `column_name: 'VALUE'`
 * literals and asserts the database would accept each one.
 *
 * DELIBERATELY CONSERVATIVE: column names repeat across tables (`status` appears
 * in a dozen), so allowed values are unioned across every table using that column
 * name. A literal passes if ANY table would accept it. That yields zero false
 * positives while still catching the real failure mode - a value no table accepts
 * anywhere, which is precisely what 'AR_COLLECTION' was.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb } from './pg';

let db: PGlite;
let allowedByColumn: Map<string, Set<string>>;
/**
 * Column names that are constrained in one table and free text in another —
 * e.g. invoice_events.event_type is a CHECK vocabulary while core.events.event_type
 * is unconstrained ('JOB_COST', 'DEPT_INVOICE_ISSUE'). A bare literal can't be
 * attributed to a table, so these are skipped rather than reported as false
 * positives. They're covered by the explicit regression tests below instead.
 */
let ambiguousColumns: Set<string>;

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

beforeAll(async () => {
  ({ db } = await createTestDb());
  allowedByColumn = await buildAllowedMap();
  ambiguousColumns = await findAmbiguousColumns(allowedByColumn);
}, 120_000);

/** Column names that also exist somewhere as an unconstrained text column. */
async function findAmbiguousColumns(allowed: Map<string, Set<string>>): Promise<Set<string>> {
  const constrained = [...allowed.keys()];
  if (constrained.length === 0) return new Set();
  const r = await db.query<{ column_name: string }>(`
    select distinct c.column_name
    from information_schema.columns c
    where c.table_schema in ('public','core')
      and lower(c.column_name) = any($1)
      and c.data_type in ('text','character varying')
      and not exists (
        select 1 from pg_constraint k
        where k.conrelid = (quote_ident(c.table_schema)||'.'||quote_ident(c.table_name))::regclass
          and k.contype = 'c'
          and pg_get_constraintdef(k.oid) ilike '%'||c.column_name||'%'
      )
  `, [constrained]);
  return new Set(r.rows.map((x) => x.column_name.toLowerCase()));
}

afterAll(async () => {
  await db?.close();
});

/** column name -> every literal any table will accept for it. */
async function buildAllowedMap(): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const add = (col: string, val: string) => {
    const key = col.toLowerCase();
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(val);
  };

  // Enum-typed columns.
  const enumCols = await db.query<{ column_name: string; enumlabel: string }>(`
    select c.column_name, e.enumlabel
    from information_schema.columns c
    join pg_type t on t.typname = c.udt_name
    join pg_enum e on e.enumtypid = t.oid
    where c.table_schema in ('public','core')
  `);
  for (const r of enumCols.rows) add(r.column_name, r.enumlabel);

  // CHECK constraints of the form: col = ANY (ARRAY['A'::text, 'B'::text, ...])
  const checks = await db.query<{ def: string }>(`
    select pg_get_constraintdef(oid) as def
    from pg_constraint
    where contype = 'c' and pg_get_constraintdef(oid) ilike '%= ANY (ARRAY%'
  `);
  for (const { def } of checks.rows) {
    // e.g. CHECK (((status)::text = ANY ((ARRAY['DRAFT'::character varying, ...])::text[])))
    const colMatch = def.match(/\(\(?([a-z_]+)\)?::/i) ?? def.match(/\(\s*([a-z_]+)\s*=/i);
    if (!colMatch) continue;
    const col = colMatch[1];
    for (const m of def.matchAll(/'([^']+)'::/g)) add(col, m[1]);
  }

  return map;
}

interface Literal { file: string; column: string; value: string; }

/** Scan the app source for `column_name: 'VALUE'` object-literal assignments. */
function collectLiterals(dir: string, out: Literal[] = []): Literal[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'test') continue;
      collectLiterals(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    const src = fs.readFileSync(full, 'utf8');
    // snake_case key followed by an ALL-CAPS string literal — the shape of a
    // constrained-vocabulary column being written.
    for (const m of src.matchAll(/\b([a-z][a-z0-9_]*_?(?:type|status|method|kind|scope|action|phase|mode|frequency)|entry_type|event_type)\s*:\s*'([A-Z][A-Z0-9_]{2,})'/g)) {
      out.push({ file: path.relative(SRC_ROOT, full), column: m[1], value: m[2] });
    }
  }
  return out;
}

describe('schema contract: constrained columns', () => {
  it('discovers constrained columns from the live schema', () => {
    expect(allowedByColumn.size).toBeGreaterThan(10);
  });

  it('finds constrained-looking literals in the source', () => {
    expect(collectLiterals(SRC_ROOT).length).toBeGreaterThan(10);
  });

  it('every literal the code writes is accepted by the database', () => {
    const violations = collectLiterals(SRC_ROOT)
      .filter((l) => allowedByColumn.has(l.column.toLowerCase()))
      .filter((l) => !ambiguousColumns.has(l.column.toLowerCase()))
      .filter((l) => !allowedByColumn.get(l.column.toLowerCase())!.has(l.value))
      .map((l) => `${l.file}: ${l.column} = '${l.value}' is not accepted by any table`);

    // Deduplicate — the same literal often appears in several files.
    expect([...new Set(violations)]).toEqual([]);
  });
});

describe('schema contract: the two known regressions', () => {
  it('entry_type accepts every money-movement value (GATE 12)', () => {
    const allowed = allowedByColumn.get('entry_type');
    expect(allowed).toBeDefined();
    for (const v of [
      'AR_COLLECTION', 'AR_PAYOUT', 'AR_REFUND', 'PLATFORM_FEE', 'PAYROLL_RUN',
      'AP_DISBURSEMENT_RELEASE', 'AP_DISBURSEMENT_SETTLE',
      'AP_DISBURSEMENT_RETURN', 'AP_DISBURSEMENT_VOID',
    ]) {
      expect(allowed!.has(v)).toBe(true);
    }
  });

  it('event_type accepts the full invoice lifecycle vocabulary', () => {
    const allowed = allowedByColumn.get('event_type');
    expect(allowed).toBeDefined();
    for (const v of ['PAY_INITIATED', 'PAY_PROCESSING', 'PAY_SUCCEEDED', 'PAY_FAILED', 'MARKED_PAID']) {
      expect(allowed!.has(v)).toBe(true);
    }
  });
});
