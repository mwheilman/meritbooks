/**
 * The Projects app's real pm reads, replayed as members (PM, Labor, Supervisor, Dispatcher) against
 * the full migration chain. Every `.from('<pm relation>')…select(<cols>)` in apps/projects/src —
 * including insert/update `.select()` returns, embedded selects and the ops/dealer `own()` /
 * `downs()` row loaders — is turned into the SQL PostgREST would run (same relation, same columns)
 * and must not fail. This is what catches a select of a member-revoked money column (1110 masks)
 * or of a column that does not exist.
 *
 * Covers, among others: jobs list (v_project_list), job page (v_job_overview, v_job_financials,
 * budgets, v_tasks_masked / v_wbs_nodes_masked milestones, v_estimates_masked, v_estimate_lines_masked,
 * billing_requests, commitments), time page (v_time_entries_masked), production board
 * (work_orders, wo_operations, v_work_centers_masked), units (v_units_masked), work-order and
 * dealer RO lines (v_work_order_lines_masked).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFixture, as, errorOf, q, type Fixture, type Persona } from './fixture';

const APP_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/projects/src');

interface AppRead {
  file: string;   // relative to apps/projects/src
  line: number;
  relation: string;
  columns: string; // PostgREST select string
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** `const NAME = 'a' + 'b'` / template literals without interpolation, per file. */
function fileConstants(file: string): Map<string, string> {
  const consts = new Map<string, string>();
  const re = /(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*((?:\s*(?:'[^'\n]*'|`[^`$]*`)\s*\+?)+)\s*;/g;
  for (const m of fs.readFileSync(file, 'utf8').matchAll(re)) {
    const parts = [...m[2].matchAll(/'([^'\n]*)'|`([^`$]*)`/g)].map((x) => x[1] ?? x[2] ?? '');
    consts.set(m[1], parts.join(''));
  }
  return consts;
}

function resolveModule(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? path.join(APP_SRC, spec.slice(2)) : spec.startsWith('.') ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/** The constants visible in a file: its own, then the ones it imports by name, then unique globals. */
function constantsFor(file: string, all: Map<string, Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  const globalCount = new Map<string, { n: number; v: string }>();
  for (const m of all.values()) for (const [k, v] of m) globalCount.set(k, { n: (globalCount.get(k)?.n ?? 0) + 1, v });
  for (const [k, g] of globalCount) if (g.n === 1) out.set(k, g.v);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const target = resolveModule(file, m[2]);
    const tc = target ? all.get(target) : undefined;
    if (!tc) continue;
    for (const item of m[1].split(',')) {
      const [orig, alias] = item.replace(/\btype\b/, '').trim().split(/\s+as\s+/);
      if (orig && tc.has(orig)) out.set((alias ?? orig).trim(), tc.get(orig) ?? '');
    }
  }
  for (const [k, v] of all.get(file) ?? new Map<string, string>()) out.set(k, v);
  return out;
}

/** Resolve a select(...) argument: literal, IDENT, IDENT + '…', or `${IDENT}, …`. Null when dynamic. */
function resolveArg(arg: string, consts: Map<string, string>): string | null {
  const a = arg.trim();
  if (/^'[^']*'$/.test(a)) return a.slice(1, -1);
  if (/^`[^`]*`$/.test(a)) {
    let unresolved = false;
    const v = a.slice(1, -1).replace(/\$\{\s*([A-Z][A-Z0-9_]*)\s*\}/g, (_, n: string) => {
      const c = consts.get(n);
      if (c === undefined) unresolved = true;
      return c ?? '';
    });
    return unresolved || v.includes('${') ? null : v;
  }
  const parts = a.split('+').map((s) => s.trim());
  const vals: string[] = [];
  for (const p of parts) {
    if (/^'[^']*'$/.test(p)) vals.push(p.slice(1, -1));
    else if (/^[A-Z][A-Z0-9_]*$/.test(p) && consts.has(p)) vals.push(consts.get(p) ?? '');
    else return null;
  }
  return vals.join('');
}

/** Text up to the next top-level ',' or ')' starting at `from` (an argument), respecting strings / nesting. */
function argAt(src: string, from: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') { if (depth === 0) return src.slice(from, i); depth--; }
    else if (ch === ',' && depth === 0) return src.slice(from, i);
  }
  return src.slice(from);
}

/** The first argument of a call starting at `open` (index of '('), respecting nesting and strings. */
function firstArg(src: string, open: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    } else if (ch === ',' && depth === 1) return src.slice(open + 1, i);
  }
  return '';
}

function extractReads(): { reads: AppRead[]; unresolved: string[] } {
  const files = walk(APP_SRC);
  const all = new Map(files.map((f) => [f, fileConstants(f)] as const));
  const reads: AppRead[] = [];
  const unresolved: string[] = [];
  const lineOf = (src: string, idx: number): number => src.slice(0, idx).split('\n').length;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APP_SRC, f);
    const consts = constantsFor(f, all);
    // .from('x') … .select(arg) within the same statement
    for (const m of src.matchAll(/\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)/g)) {
      const start = (m.index ?? 0) + m[0].length;
      const tail = src.slice(start);
      const stop = tail.search(/;|\.from\(/);
      const stmt = stop < 0 ? tail : tail.slice(0, stop);
      const s = stmt.search(/\.select\(/);
      if (s < 0) continue;
      const open = start + s + '.select'.length;
      const arg = firstArg(src, open);
      const line = lineOf(src, open);
      if (arg.trim() === '') { reads.push({ file: rel, line, relation: m[1], columns: '*' }); continue; }
      const cols = resolveArg(arg, consts);
      if (cols === null) unresolved.push(`${rel}:${line} ${m[1]} select(${arg.trim().slice(0, 60)})`);
      else reads.push({ file: rel, line, relation: m[1], columns: cols });
    }
    // ops own(db, 'table', cols, …) / dealer downs(db, 'table', cols, …)
    for (const m of src.matchAll(/\b(?:own|downs)(?:<[^>]*>)?\(\s*db\s*,\s*'([a-z_][a-z0-9_]*)'\s*,\s*/g)) {
      const idx = (m.index ?? 0) + m[0].length;
      const arg = argAt(src, idx);
      const cols = resolveArg(arg, consts);
      const line = lineOf(src, idx);
      if (cols === null) unresolved.push(`${rel}:${line} ${m[1]} own/downs(${arg.trim().slice(0, 60)})`);
      else reads.push({ file: rel, line, relation: m[1], columns: cols });
    }
  }
  return { reads, unresolved };
}

interface SqlRead { relation: string; sql: string }

/** PostgREST select string → the SQL reads it performs (top level + one per embedded resource). */
function toSql(relation: string, columns: string): SqlRead[] {
  const items: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of columns) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { items.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) items.push(cur.trim());
  const plain: string[] = [];
  const out: SqlRead[] = [];
  for (const raw of items) {
    const emb = raw.match(/^(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)(?:![a-z_0-9]+)*\((.*)\)$/s);
    if (emb) { out.push(...toSql(emb[1], emb[2])); continue; }
    if (raw === '*') { plain.push('*'); continue; }
    const col = raw.replace(/^[a-z_][a-z0-9_]*:/, '').replace(/::.*$/, '').replace(/->.*$/, '').trim();
    if (/^[a-z_][a-z0-9_]*$/.test(col)) plain.push(`"${col}"`);
  }
  out.unshift({ relation, sql: `select ${plain.length ? plain.join(', ') : '1'} from pm."${relation}" limit 50` });
  return out;
}

let f: Fixture;
let pmRelations: Set<string>;
const { reads, unresolved } = extractReads();

beforeAll(async () => {
  f = await buildFixture();
  pmRelations = new Set((await q<{ relname: string }>(f.db,
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pm' and c.relkind in ('r', 'p', 'v')`)).map((r) => r.relname));
}, 600_000);

afterAll(async () => {
  await f?.db.close();
});

describe('app pm reads run for members', () => {
  it('the extractor finds the reads behind the pages that show money', () => {
    const rels = new Set(reads.map((r) => r.relation));
    for (const r of ['v_project_list', 'v_job_overview', 'v_job_financials', 'v_estimates_masked', 'v_estimate_lines_masked', 'v_tasks_masked',
      'v_wbs_nodes_masked', 'v_time_entries_masked', 'v_units_masked', 'v_work_centers_masked', 'v_work_order_lines_masked',
      'billing_requests', 'commitments', 'budgets', 'work_orders', 'wo_operations']) {
      expect(rels.has(r), r).toBe(true);
    }
    expect(reads.length).toBeGreaterThan(150);
  });

  for (const persona of ['owner', 'gm', 'pm', 'supervisor', 'labor', 'dispatcher', 'accountant', 'legacyStaff', 'bOwner'] as const satisfies readonly Persona[]) {
    it(`every pm read succeeds as ${persona}`, async () => {
      const failures: string[] = [];
      for (const r of reads) {
        for (const s of toSql(r.relation, r.columns)) {
          if (!pmRelations.has(s.relation)) continue; // core / public tables are outside pm
          const err = await as(f, persona, async () => errorOf(f.db, s.sql));
          if (err) failures.push(`${r.file}:${r.line} ${s.relation}: ${err}`);
        }
      }
      expect([...new Set(failures)]).toEqual([]);
    });
  }

  it('reports reads whose select list is built dynamically (not checked)', () => {
    // Informational: dynamic column lists cannot be resolved statically.
    expect(Array.isArray(unresolved)).toBe(true);
    if (unresolved.length) console.log(`[app-queries] dynamic select lists (unchecked):\n  ${unresolved.join('\n  ')}`);
  });
});
