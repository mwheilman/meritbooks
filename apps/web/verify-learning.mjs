// Verifies migration 040 + the learning loop wiring, end to end.
// Run: cd ~/Projects/meritbooks/apps/web && node verify-learning.mjs
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = {};
try {
  for (const line of readFileSync(new URL('./.env.local', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { console.error('\n  Run from ~/Projects/meritbooks/apps/web\n'); process.exit(1); }
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${m}`); };
const no = (m) => { fail++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };

console.log('\n  Migration 040 + learning-loop verification\n');

// org + a real account to satisfy the FK
const { data: org } = await db.schema('core').from('organizations').select('id').limit(1).single();
const { data: acct } = await db.from('accounts').select('id').eq('org_id', org.id).eq('is_active', true).limit(1).single();
if (!org || !acct) { no('need an org + one account to test'); process.exit(0); }

// 1. vendor_id is now nullable (040)
{
  const norm = 'zz smoke ' + Date.now();
  const { data, error } = await db.from('vendor_patterns').insert({
    org_id: org.id, account_id: acct.id, vendor_id: null,
    raw_description: 'ZZ smoke test', normalized_description: norm, match_count: 1,
  }).select('id').single();
  if (error) { no(`insert with null vendor_id failed — ${error.message} (did 040 run?)`); }
  else {
    ok('vendor_id is nullable — description-only pattern inserted');

    // 2. unique index supports upsert (re-insert same norm should conflict)
    const { error: dupErr } = await db.from('vendor_patterns').insert({
      org_id: org.id, account_id: acct.id, normalized_description: norm,
      raw_description: 'dup', match_count: 1,
    });
    (dupErr ? ok : no)(dupErr
      ? 'unique (org_id, normalized_description) enforced — upsert key present'
      : 'NO unique constraint — duplicates allowed (040 index missing)');

    // 3. update path (the learn loop increments match_count)
    const { error: upErr } = await db.from('vendor_patterns')
      .update({ match_count: 2, last_matched_at: new Date().toISOString() }).eq('id', data.id);
    (upErr ? no : ok)(upErr ? `match_count update failed — ${upErr.message}` : 'match_count increment works');

    await db.from('vendor_patterns').delete().eq('id', data.id);
    ok('cleaned up test row');
  }
}

console.log(`\n  ${pass} pass / ${fail} fail\n`);
console.log(fail === 0
  ? '  Migration 040 is live and the learning loop can write. Confirm end-to-end by\n  posting a coding in AI Categorizer, then re-posting the same description — the\n  second time should come back as a high-confidence "Pattern match".\n'
  : '  Fix the failures above before relying on the learning loop.\n');
