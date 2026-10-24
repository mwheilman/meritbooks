/**
 * The Projects app's real pm reads, replayed as members (PM, Labor, Supervisor, Dispatcher) against
 * the full migration chain. Every `.from('<pm relation>')…select(<cols>)` in apps/projects/src —
 * including insert/update `.select()` returns, embedded selects and the ops/dealer `own()` /
 * `downs()` row loaders — is turned into the SQL PostgREST would run (same relation, same columns)
 * and must not fail. This is what catches a select of a member-revoked money column (1110 masks)
 * or of a column that does not exist.
 *
 * Schemas: pm, crm, core and public reads, resolved from `.schema('x')`, the pm() / core() /
 * pmOf() helpers, a local `const x = db.schema('y')`, the 1111 contract map (`T.<key>` →
 * { schema, table } in lib/crm/contract.ts) used as `.schema(T.k.schema).from(T.k.table)` or
 * `from(db, T.k)`, and `db.from(...)` (public). A read whose schema cannot be resolved is
 * treated as pm (when pm has that relation). Runs on the full migration chain (1110 fixture +
 * every later migration) as every fixture persona.
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
import { buildFixture, applyAfter1110, as, errorOf, q, type Fixture, type Persona } from './fixture';

const APP_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../apps/projects/src');

interface AppRead {
  file: string;   // relative to apps/projects/src
  line: number;
  schema: string | null; // null = not resolvable statically (treated as pm)
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

/** `key: { schema: 's', table: 't' }` entries (the 1111 contract map T), across the app. */
function contractTables(files: string[]): Map<string, { schema: string; table: string }> {
  const out = new Map<string, { schema: string; table: string }>();
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{\s*schema\s*:\s*'([a-z_]+)'\s*,\s*table\s*:\s*'([a-z_][a-z0-9_]*)'\s*\}/g)) {
      out.set(m[1], { schema: m[2], table: m[3] });
    }
  }
  return out;
}

/** The schema of the client expression right before `.from(` (null when unknown). */
function schemaBefore(src: string, idx: number): string | null {
  const before = src.slice(Math.max(0, idx - 160), idx);
  let m = before.match(/\.schema\(\s*'([a-z_]+)'\s*\)\s*$/);
  if (m) return m[1];
  if (/\bpm(?:Of)?\(\s*[A-Za-z_.]*\s*\)\s*$/.test(before)) return 'pm';
  if (/\bcore\(\s*[A-Za-z_.]*\s*\)\s*$/.test(before)) return 'core';
  m = before.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  if (m) {
    const local = src.match(new RegExp(`\\b(?:const|let)\\s+${m[1]}\\s*=\\s*[A-Za-z_.()]*\\.schema\\(\\s*'([a-z_]+)'\\s*\\)`));
    if (local) return local[1];
    if (/^(db|supabase|client|admin)$/.test(m[1])) return 'public';
  }
  return null;
}

function extractReads(): { reads: AppRead[]; unresolved: string[] } {
  const files = walk(APP_SRC);
  const all = new Map(files.map((f) => [f, fileConstants(f)] as const));
  const tmap = contractTables(files);
  const reads: AppRead[] = [];
  const unresolved: string[] = [];
  const lineOf = (src: string, idx: number): number => src.slice(0, idx).split('\n').length;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(APP_SRC, f);
    const consts = constantsFor(f, all);
    // .from('x') / .from(T.k.table) / from(db, T.k) … .select(arg) within the same statement
    const sites: { idx: number; end: number; schema: string | null; relation: string }[] = [];
    for (const m of src.matchAll(/\.from\(\s*'([a-z_][a-z0-9_]*)'\s*\)/g)) {
      sites.push({ idx: m.index ?? 0, end: (m.index ?? 0) + m[0].length, schema: schemaBefore(src, m.index ?? 0), relation: m[1] });
    }
    for (const m of src.matchAll(/\.from\(\s*T\.([A-Za-z_][A-Za-z0-9_]*)\.table\s*\)/g)) {
      const t = tmap.get(m[1]);
      if (t) sites.push({ idx: m.index ?? 0, end: (m.index ?? 0) + m[0].length, schema: t.schema, relation: t.table });
    }
    for (const m of src.matchAll(/(?<![.\w])from\(\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*T\.([A-Za-z_][A-Za-z0-9_]*)\s*\)/g)) {
      const t = tmap.get(m[1]);
      if (t) sites.push({ idx: m.index ?? 0, end: (m.index ?? 0) + m[0].length, schema: t.schema, relation: t.table });
    }
    for (const site of sites) {
      const start = site.end;
      const tail = src.slice(start);
      const stop = tail.search(/;|\.from\(|(?<![.\w])from\(/);
      const stmt = stop < 0 ? tail : tail.slice(0, stop);
      const s = stmt.search(/\.select\(/);
      if (s < 0) continue;
      const open = start + s + '.select'.length;
      const arg = firstArg(src, open);
      const line = lineOf(src, open);
      if (arg.trim() === '') { reads.push({ file: rel, line, schema: site.schema, relation: site.relation, columns: '*' }); continue; }
      const cols = resolveArg(arg, consts);
      if (cols === null) unresolved.push(`${rel}:${line} ${site.schema ?? '?'}.${site.relation} select(${arg.trim().slice(0, 60)})`);
      else reads.push({ file: rel, line, schema: site.schema, relation: site.relation, columns: cols });
    }
    // ops own(db, 'table', cols, …) / dealer downs(db, 'table', cols, …)
    for (const m of src.matchAll(/\b(?:own|downs)(?:<[^>]*>)?\(\s*db\s*,\s*'([a-z_][a-z0-9_]*)'\s*,\s*/g)) {
      const idx = (m.index ?? 0) + m[0].length;
      const arg = argAt(src, idx);
      const cols = resolveArg(arg, consts);
      const line = lineOf(src, idx);
      if (cols === null) unresolved.push(`${rel}:${line} ${m[1]} own/downs(${arg.trim().slice(0, 60)})`);
      else reads.push({ file: rel, line, schema: 'pm', relation: m[1], columns: cols });
    }
  }
  return { reads, unresolved };
}

interface SqlRead { schema: string; relation: string; sql: string }

/** PostgREST select string → the SQL reads it performs (top level + one per embedded resource). */
function toSql(schema: string, relation: string, columns: string): SqlRead[] {
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
    if (emb) { out.push(...toSql(schema, emb[1], emb[2])); continue; }
    if (raw === '*') { plain.push('*'); continue; }
    const col = raw.replace(/^[a-z_][a-z0-9_]*:/, '').replace(/::.*$/, '').replace(/->.*$/, '').trim();
    if (/^[a-z_][a-z0-9_]*$/.test(col)) plain.push(`"${col}"`);
  }
  out.unshift({ schema, relation, sql: `select ${plain.length ? plain.join(', ') : '1'} from "${schema}"."${relation}" limit 50` });
  return out;
}

let f: Fixture;
let relations: Set<string>; // 'schema.relation'
const { reads, unresolved } = extractReads();
const PERSONAS_ALL = ['owner', 'gm', 'pm', 'supervisor', 'labor', 'dispatcher', 'accountant', 'legacyOwner', 'legacyStaff', 'legacyPm', 'bOwner'] as const satisfies readonly Persona[];

/** The schema a read runs in: its resolved schema, else pm (the pre-1111 default). Null = skip. */
const schemaOf = (r: { schema: string | null; relation: string }): string | null =>
  r.schema ?? (relations.has(`pm.${r.relation}`) ? 'pm' : null);

beforeAll(async () => {
  f = await buildFixture();
  await applyAfter1110(f.db);
  relations = new Set((await q<{ r: string }>(f.db,
    `select n.nspname || '.' || c.relname as r from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('pm', 'crm', 'core', 'public') and c.relkind in ('r', 'p', 'v')`)).map((x) => x.r));
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

  it('the extractor resolves the crm / shared-record reads and the field (phone) routes', () => {
    const keys = new Set(reads.map((r) => `${r.schema ?? '?'}.${r.relation}`));
    for (const k of ['crm.leads', 'crm.pipelines', 'crm.pipeline_stages', 'crm.activities', 'crm.followups', 'crm.lead_stage_events',
      'core.contacts', 'core.sites', 'core.duplicate_reviews', 'core.v_customer_relationship', 'pm.v_customer_360', 'pm.v_job_tieout']) {
      expect(keys.has(k), k).toBe(true);
    }
    const field = reads.filter((r) => r.file.startsWith(path.join('app', 'api', 'field')));
    for (const k of ['pm.field_logs', 'pm.punch_items', 'pm.v_time_entries_masked', 'core.employees', 'public.documents']) {
      expect(field.some((r) => `${r.schema}.${r.relation}` === k), `field route read ${k}`).toBe(true);
    }
    const by = (sc: string) => reads.filter((r) => r.schema === sc).length;
    console.log(`[app-queries] reads by schema: pm ${by('pm')} · crm ${by('crm')} · core ${by('core')} · public ${by('public')} · unresolved-schema ${reads.filter((r) => r.schema === null).length}`);
    expect(by('crm')).toBeGreaterThanOrEqual(8);
    expect(by('core')).toBeGreaterThanOrEqual(10);
    // every resolved read names a relation that exists in its schema
    const missing = reads.filter((r) => r.schema && !relations.has(`${r.schema}.${r.relation}`)).map((r) => `${r.file}:${r.line} ${r.schema}.${r.relation}`);
    expect(missing).toEqual([]);
  });

  for (const persona of PERSONAS_ALL) {
    it(`every pm / crm / core / public read succeeds as ${persona}`, async () => {
      const failures: string[] = [];
      for (const r of reads) {
        const schema = schemaOf(r);
        if (!schema) continue;
        for (const s of toSql(schema, r.relation, r.columns)) {
          if (!relations.has(`${s.schema}.${s.relation}`)) continue;
          const err = await as(f, persona, async () => errorOf(f.db, s.sql));
          if (err) failures.push(`${r.file}:${r.line} ${s.schema}.${s.relation}: ${err}`);
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
