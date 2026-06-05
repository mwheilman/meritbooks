// MeritBooks smoke test — verifies the Session 22 features against the live DB.
// Run from the repo:   cd ~/Projects/meritbooks/apps/web && node smoke-test.mjs
// Uses the service-role key in apps/web/.env.local (bypasses RLS for inspection).
// Read-only except one self-cleaning insert+delete that proves the decision log works.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

// ── load env ────────────────────────────────────────────────────────────────
const env = {};
try {
  const raw = readFileSync(new URL('./.env.local', import.meta.url), 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  console.error('\n  Could not read apps/web/.env.local — run this from ~/Projects/meritbooks/apps/web\n');
  process.exit(1);
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) {
  console.error('\n  Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local\n');
  process.exit(1);
}
const db = createClient(URL_, KEY, { auth: { persistSession: false } });

// ── tiny reporter ─────────────────────────────────────────────────────────────
let pass = 0, fail = 0, warn = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const wn = (m) => { warn++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };
const head = (m) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function tableOk(name) {
  const { error } = await db.from(name).select('id, org_id').limit(1);
  if (error) { no(`table ${name} — ${error.message}`); return false; }
  ok(`table ${name} exists & readable`); return true;
}
async function count(schema, table, build) {
  let q = (schema ? db.schema(schema) : db).from(table).select('id', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count: c, error } = await q;
  return error ? null : (c ?? 0);
}

console.log('\n══════════════════════════════════════════════════════════');
console.log('  MeritBooks — Session 22 feature smoke test');
console.log('  ' + URL_);
console.log('══════════════════════════════════════════════════════════');

// ── 1. schema ─────────────────────────────────────────────────────────────────
head('1. Schema (migrations 035–039)');
await tableOk('intercompany_transactions');
await tableOk('retainage_releases');
await tableOk('vendor_compliance_events');
await tableOk('year_end_closes');
await tableOk('ai_decisions');

// ── 2. org + data inventory ─────────────────────────────────────────────────────
head('2. Data inventory');
const { data: orgs, error: orgErr } = await db.schema('core').from('organizations').select('id, name');
if (orgErr || !orgs?.length) {
  no(`no organizations found — ${orgErr?.message ?? 'empty'} (cannot test features without a tenant)`);
  summary(); process.exit(0);
}
const org = orgs[0];
ok(`organization: ${org.name} (${orgs.length} total)`);

const { data: locs } = await db.schema('core').from('locations').select('id, name, is_active').eq('org_id', org.id);
const activeLocs = (locs ?? []).filter((l) => l.is_active);
(activeLocs.length ? ok : wn)(`entities/companies: ${activeLocs.length} active (${(locs ?? []).length} total)`);

const coaCount = await count(null, 'accounts', (q) => q.eq('org_id', org.id).eq('is_active', true).eq('approval_status', 'APPROVED'));
(coaCount > 0 ? ok : wn)(`approved chart-of-accounts entries: ${coaCount ?? '?'}`);

const periodCount = await count(null, 'fiscal_periods', (q) => q.eq('org_id', org.id));
const openPeriods = await count(null, 'fiscal_periods', (q) => q.eq('org_id', org.id).eq('status', 'OPEN'));
(periodCount > 0 ? ok : wn)(`fiscal periods: ${periodCount ?? '?'} (${openPeriods ?? 0} open)`);

const postedCount = await count(null, 'gl_entries', (q) => q.eq('org_id', org.id).eq('status', 'POSTED'));
console.log(`    posted GL entries: ${postedCount ?? '?'}`);
const vendorCount = await count('core', 'vendors', (q) => q.eq('org_id', org.id));
console.log(`    vendors: ${vendorCount ?? '?'}`);

// account-role mappings the new features resolve at runtime
const { data: roleRows } = await db.from('account_roles').select('role_key').eq('org_id', org.id);
const roles = new Set((roleRows ?? []).map((r) => r.role_key));
const need = ['RETAINED_EARNINGS', 'INTERCOMPANY_AR', 'INTERCOMPANY_AP', 'RETAINAGE_PAYABLE'];
for (const k of need) (roles.has(k) ? ok : wn)(`account role mapped: ${k}${roles.has(k) ? '' : ' (missing — feature will error until set)'}`);

// ── 3. decision log is writable (self-cleaning) ─────────────────────────────────
head('3. AI decision log — write/read/delete');
let wrote = null;
{
  const { data, error } = await db.from('ai_decisions').insert({
    org_id: org.id, feature: 'SMOKE_TEST', input_summary: 'smoke test — safe to ignore',
    proposed_output: { test: true, lines: [] }, status: 'PROPOSED',
  }).select('id').single();
  if (error) no(`insert failed — ${error.message}`);
  else { wrote = data.id; ok(`inserted decision ${wrote.slice(0, 8)}…`); }
}
if (wrote) {
  const { data } = await db.from('ai_decisions').select('id, proposed_output').eq('id', wrote).single();
  (data?.proposed_output?.test === true ? ok : no)('read back jsonb proposed_output');
  const { error } = await db.from('ai_decisions').delete().eq('id', wrote);
  (error ? no : ok)(error ? `cleanup failed — ${error.message}` : 'deleted test row (clean)');
}

// ── 4. per-feature readiness ────────────────────────────────────────────────────
head('4. Feature readiness (against current data)');
const ready = (label, cond, reason) => cond ? ok(`${label}: READY`) : wn(`${label}: BLOCKED — ${reason}`);
ready('Year-End Close', roles.has('RETAINED_EARNINGS') && activeLocs.length > 0,
  !roles.has('RETAINED_EARNINGS') ? 'map RETAINED_EARNINGS role' : 'add at least one entity');
ready('Intercompany', roles.has('INTERCOMPANY_AR') && roles.has('INTERCOMPANY_AP') && activeLocs.length >= 2,
  (!roles.has('INTERCOMPANY_AR') || !roles.has('INTERCOMPANY_AP')) ? 'map INTERCOMPANY_AR/AP roles' : 'need ≥2 entities to pair');
ready('Retainage', roles.has('RETAINAGE_PAYABLE'), 'map RETAINAGE_PAYABLE role');
ready('Vendor Compliance', (vendorCount ?? 0) > 0, 'no vendors yet to enforce on');
ready('AI JE Composer', activeLocs.length > 0 && (coaCount ?? 0) > 0,
  activeLocs.length === 0 ? 'add an entity' : 'seed the chart of accounts');
console.log('    (AI Composer also needs ANTHROPIC_API_KEY set on Vercel — verify in Vercel env settings.)');

summary();

function summary() {
  console.log('\n══════════════════════════════════════════════════════════');
  console.log(`  RESULT:  \x1b[32m${pass} pass\x1b[0m   \x1b[33m${warn} warn\x1b[0m   \x1b[31m${fail} fail\x1b[0m`);
  console.log('══════════════════════════════════════════════════════════');
  if (fail > 0) console.log('  ✗ = a migration/table problem to fix before the feature works.');
  if (warn > 0) console.log('  ! = feature is built & deployed but needs setup data (entities, COA, roles) to exercise.');
  console.log('');
}
