/**
 * Business-table PostgREST write lock (migration 171, wave 2H).
 *
 * PostgREST exposes public / core and accepts a member's Clerk token (role=authenticated,
 * org_id=<tenant>). A table with a permissive member write policy + INSERT/UPDATE/DELETE
 * granted to `authenticated` can be written directly over /rest/v1, bypassing every route
 * check and the capability model. Migration 171 locks the money / ledger / control tables
 * to SELECT-only for members; the app writes them through the service role
 * (lib/db/scoped-writer.ts) after its permission check, org pinned, client scope asserted.
 *
 * This suite (PGlite, WITH hosted Supabase's default grants so the surface is real):
 *   (a) negative control at the migration before 171: a member CAN reopen a hard-closed
 *       period and mint a vendor portal link; after 171 authenticated + anon cannot
 *       INSERT / UPDATE / DELETE / TRUNCATE any locked table, members still read their own
 *       tenant only, the service role still writes, and the ledger triggers (period lock)
 *       still fire for service-role writes;
 *   (b) RATCHET: every public / core table still member-writable must be listed below
 *       with a reason — a NEW member-writable table fails the build (new tables default to
 *       locked), and a listed table that is no longer member-writable must be removed;
 *   (c) static scan: no write to a locked table in apps/web/src (or apps/projects/src)
 *       goes through anything but a provable service-role client.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';

const LOCK_MIGRATION = '171';
/** The migration right before 171 (whatever its number) — the negative-control state. */
const PRE_LOCK = listMigrationFiles().filter((f) => f.slice(0, 3) < LOCK_MIGRATION).pop()!.slice(0, 3);

/** Tables 171 makes SELECT-only for members. Keep in sync with 171 §1. */
const BUSINESS_LOCKED_TABLES: ReadonlyArray<readonly [schema: 'public' | 'core', table: string]> = [
  ['public', 'gl_entries'],
  ['public', 'gl_entry_lines'],
  ['public', 'fiscal_periods'],
  ['public', 'accounts'],
  ['public', 'bills'],
  ['public', 'bill_lines'],
  ['public', 'bill_payments'],
  ['public', 'bank_accounts'],
  ['public', 'plaid_items'],
  ['public', 'plaid_pending_accounts'],
  ['public', 'payment_origination_batches'],
  ['public', 'payment_origination_items'],
  ['public', 'disbursement_batches'],
  ['public', 'disbursement_batch_items'],
  ['public', 'disbursement_check_numbers'],
  ['public', 'vendor_payment_profiles'],
  ['public', 'ach_authorizations'],
  ['public', 'vendor_payment_holds'],
  ['public', 'customer_payments'],
  ['public', 'payment_applications'],
  ['public', 'vendor_portal_tokens'],
  ['public', 'customer_portal_tokens'],
  ['core', 'items'],
  ['core', 'provider_connections'],
];

/** 171 §2: member policies were already read-only / service-only; write GRANTs revoked. */
const GRANT_HARDENED_TABLES: ReadonlyArray<readonly [string, string]> = [
  ['core', 'account_role_keys'],
  ['core', 'ai_feature_caps'],
  ['core', 'ai_model_prices'],
  ['core', 'ai_tier_config'],
  ['core', 'transaction_types'],
  ['core', 'erp_connections'],
  ['core', 'merchant_fee_schedules'],
  ['public', 'app_error_log'],
  ['public', 'stripe_events'],
];

// ── (b) the ratchet ─────────────────────────────────────────────────────────
// Every public/core base table a member can still write over PostgREST, with WHY.
//   A — money / ledger / control: SHOULD be locked; its app write sites have not been
//       moved to the service role yet (follow-up sweep). Do not add new tables here.
//   B — user workspace, planning, AI working state, or append-only logs: intentionally
//       member-writable.
//   C — ownership / sensitivity unclear (shared with Projects, config, evidence) — needs
//       an owner decision before it is locked or accepted.
const A = 'A: money/ledger/control — write sites not yet moved to the service role (follow-up)';
const B = 'B: user workspace / planning / AI working state / append-only — intentionally member-writable';
const C = 'C: ownership or sensitivity unclear — needs an owner decision';

const MEMBER_WRITABLE: Readonly<Record<string, string>> = {
  // A — receivables
  'public.invoices': A,
  'public.invoice_lines': A,
  'public.invoice_events': A,
  'public.credit_memos': A,
  'public.credit_memo_lines': A,
  'public.customer_deposits': A,
  'public.customer_deposit_applications': A,
  'public.recurring_invoice_templates': A,
  // A — internal / intercompany
  'public.internal_invoices': A,
  'public.internal_invoice_lines': A,
  'public.intercompany_balances': A,
  'public.intercompany_loans': A,
  'public.intercompany_transactions': A,
  'public.entity_ownership': A,
  'public.equity_holders': A,
  'core.equity_holders': A,
  // A — banking
  'public.bank_transactions': A,
  'public.bank_reconciliations': A,
  'public.vendor_patterns': A, // drives auto-categorization / auto-approve
  // A — debt / leases / assets / schedules
  'public.debt_instruments': A,
  'public.debt_schedule_lines': A,
  'public.loan_covenants': A,
  'public.covenant_measurements': A,
  'public.leases': A,
  'public.lease_schedule_lines': A,
  'public.fixed_assets': A,
  'public.depreciation_runs': A,
  'public.tax_depreciation_runs': A,
  'public.insurance_amortization_schedules': A,
  'public.insurance_amortization_runs': A,
  'public.posting_schedules': A,
  'public.posting_schedule_runs': A,
  'public.recurring_je_templates': A,
  'public.recurring_je_runs': A,
  'public.recurring_templates': A,
  'public.year_end_closes': A,
  // A — revenue recognition
  'public.revenue_recognition_runs': A,
  'public.rev_rec_method_map': A,
  'public.revenue_type_methods': A,
  // A — job cost / procurement / expenses
  'public.job_cost_entries': A,
  'public.job_cost_attributions': A,
  'public.retainage_releases': A,
  'public.inventory_items': A,
  'public.inventory_movements': A,
  'public.purchase_orders': A,
  'public.purchase_order_lines': A,
  'public.goods_receipts': A,
  'public.goods_receipt_lines': A,
  'public.bill_po_links': A,
  'public.expense_reports': A,
  'public.expense_report_lines': A,
  'public.receipts': A,
  // A — tax / basis / FX
  'public.sales_tax_filings': A,
  'public.sales_tax_rates': A,
  'public.tax_provision': A,
  'public.deferred_tax_items': A,
  'public.tax_year_params': A,
  'public.book_tax_account_tags': A,
  'public.book_tax_line_overrides': A,
  'public.book_tax_m_lines': A,
  'public.reporting_basis_adjustments': A,
  'public.fx_rates': A,
  // A — chart of accounts structure + dimensions + posting-role map
  'public.account_types': A,
  'public.account_sub_types': A,
  'public.account_groups': A,
  'public.account_roles': A,
  'public.classes': A,
  'core.departments': A,
  'public.location_classes': A,
  'public.location_departments': A,
  'public.location_items': A,
  // A — payroll config (payroll_runs / _employees are 2G / migration 170)
  'public.pay_schedules': A,
  'public.payroll_register_mappings': A,
  // A — audit trails / control evidence (a member can rewrite or delete history)
  'public.audit_log': A,
  'public.ai_audit_log': A,
  'public.ai_decisions': A,
  'public.close_checklists': A,
  'public.compliance_filings': A,
  'public.compliance_obligations': A,
  'public.vendor_compliance_docs': A,
  'public.vendor_compliance_events': A,
  'public.company_policies': A,
  'public.expense_policies': A,
  // B
  'public.report_views': B,
  'public.report_packs': B,
  'public.budgets': B,
  'public.budget_versions': B,
  'public.learned_preferences': B,
  'public.agent_runs': B,
  'public.agent_run_steps': B,
  'public.invoice_templates': B,
  'public.invoice_text_overrides': B,
  'public.pbc_requests': B,
  'public.subscriptions': B,
  'core.action_log': B, // INSERT-only (own org): append-only action log
  'core.ai_usage_log': B, // INSERT-only (167): append-only AI usage log
  // C
  'core.jobs': C, // Projects seam (jobs are owned by the suite job contract)
  'core.job_phases': C,
  'core.change_orders': C,
  'public.job_cost_codes': C,
  'public.estimates': C,
  'public.estimate_lines': C,
  'core.company_legal_records': C,
  'public.insurance_policies': C,
  'public.performance_config': C,
  'public.working_papers': C,
  'public.documents': C,
};

const ORG_A = 'aaaaaaaa-0000-0000-0000-000000000171';
const ORG_B = 'bbbbbbbb-0000-0000-0000-000000000171';
const LOC_A = 'aaaaaaaa-1710-0000-0000-000000000001';
const LOC_B = 'bbbbbbbb-1710-0000-0000-000000000001';
const VENDOR_A = 'aaaaaaaa-1710-0000-0000-0000000000f1';
const P_HARD = 'aaaaaaaa-1710-0000-0000-0000000000a1';
const P_OPEN = 'aaaaaaaa-1710-0000-0000-0000000000a2';
const P_B = 'bbbbbbbb-1710-0000-0000-0000000000a1';
const MEMBER = 'user_member_171';

let db: PGlite;

async function asRole<T>(
  role: 'authenticated' | 'anon' | 'service_role',
  fn: () => Promise<T>,
  claims: Record<string, string> = { sub: MEMBER, org_id: ORG_A, role: 'authenticated' },
): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [
    role === 'anon' ? '{}' : JSON.stringify(role === 'service_role' ? { role: 'service_role' } : claims),
  ]);
  await db.exec(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

async function errorOf(sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const q = (s: string, t: string) => `${s}.${t}`;

beforeAll(async () => {
  ({ db } = await createTestDb({ supabaseDefaultGrants: true, through: PRE_LOCK }));
  // Seed as the migration runner: two tenants, a client each, periods, a vendor.
  await db.exec(`
    insert into core.organizations (id, name, slug) values
      ('${ORG_A}', 'Tenant A 171', 'tenant-a-171'),
      ('${ORG_B}', 'Tenant B 171', 'tenant-b-171');
    insert into core.locations (id, org_id, name, short_code) values
      ('${LOC_A}', '${ORG_A}', 'A HQ', 'AHQ'),
      ('${LOC_B}', '${ORG_B}', 'B HQ', 'BHQ');
    insert into public.fiscal_periods (id, org_id, location_id, period_year, period_month, start_date, end_date, status) values
      ('${P_HARD}', '${ORG_A}', '${LOC_A}', 2025, 1, '2025-01-01', '2025-01-31', 'HARD_CLOSE'),
      ('${P_OPEN}', '${ORG_A}', '${LOC_A}', 2025, 3, '2025-03-01', '2025-03-31', 'OPEN'),
      ('${P_B}',    '${ORG_B}', '${LOC_B}', 2025, 1, '2025-01-01', '2025-01-31', 'OPEN');
    insert into core.vendors (id, org_id, name) values ('${VENDOR_A}', '${ORG_A}', 'Vendor A');
  `);
}, 300_000);

afterAll(async () => {
  await db?.close();
});

describe('migration 171 — before (negative control: the hole is real)', () => {
  it('the replay stopped right before 171', () => {
    const next = listMigrationFiles().find((f) => f.slice(0, 3) > PRE_LOCK);
    expect(next?.startsWith(`${LOCK_MIGRATION}_`)).toBe(true);
  });

  it('before 171 a member CAN reopen a hard-closed period over PostgREST', async () => {
    const res = await asRole('authenticated', () =>
      db.query(`update public.fiscal_periods set status = 'OPEN' where id = $1 returning id`, [P_HARD]),
    );
    expect(res.rows).toHaveLength(1);
    await db.query(`update public.fiscal_periods set status = 'HARD_CLOSE' where id = $1`, [P_HARD]);
  });

  it('before 171 a member CAN mint a vendor portal bearer link directly', async () => {
    const res = await asRole('authenticated', () =>
      db.query(
        `insert into public.vendor_portal_tokens (org_id, vendor_id, token, status) values ($1, $2, $3, 'ACTIVE') returning id`,
        [ORG_A, VENDOR_A, 'f'.repeat(64)],
      ),
    );
    expect(res.rows).toHaveLength(1);
    await db.query(`delete from public.vendor_portal_tokens where org_id = $1`, [ORG_A]);
  });
});

describe('migration 171 — after (members are SELECT-only on business tables)', () => {
  beforeAll(async () => {
    for (const f of listMigrationFiles().filter((x) => x.slice(0, 3) > PRE_LOCK)) await applyMigrationFile(db, f);
  }, 120_000);

  for (const [s, t] of BUSINESS_LOCKED_TABLES) {
    it(`authenticated + anon cannot INSERT / UPDATE / DELETE / TRUNCATE ${s}.${t}`, async () => {
      for (const role of ['authenticated', 'anon'] as const) {
        const errs = await asRole(role, async () => [
          await errorOf(`insert into ${q(s, t)} default values`),
          await errorOf(`update ${q(s, t)} set org_id = org_id`),
          await errorOf(`delete from ${q(s, t)}`),
          await errorOf(`truncate ${q(s, t)}`),
        ]);
        for (const e of errs) expect(e, `${role} on ${s}.${t}`).toMatch(/permission denied/);
      }
    });
  }

  it('catalog: RLS on, no member-facing write policy, no member write GRANT, service_all present', async () => {
    for (const [s, t] of BUSINESS_LOCKED_TABLES) {
      const r = await db.query<{ rls: boolean; ins: boolean; upd: boolean; del: boolean; trunc: boolean; anon_ins: boolean }>(
        `select c.relrowsecurity rls,
                has_table_privilege('authenticated', c.oid, 'INSERT') ins,
                has_table_privilege('authenticated', c.oid, 'UPDATE') upd,
                has_table_privilege('authenticated', c.oid, 'DELETE') del,
                has_table_privilege('authenticated', c.oid, 'TRUNCATE') trunc,
                has_table_privilege('anon', c.oid, 'INSERT') anon_ins
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = $2`,
        [s, t],
      );
      expect(r.rows[0], `${s}.${t}`).toEqual({ rls: true, ins: false, upd: false, del: false, trunc: false, anon_ins: false });
      const writePolicies = await db.query<{ policyname: string }>(
        `select policyname from pg_policies
          where schemaname = $1 and tablename = $2 and permissive = 'PERMISSIVE'
            and cmd <> 'SELECT' and roles::text <> '{service_role}'`,
        [s, t],
      );
      expect(writePolicies.rows, `${s}.${t}`).toEqual([]);
      const svc = await db.query(`select 1 from pg_policies where schemaname = $1 and tablename = $2 and policyname = 'service_all'`, [s, t]);
      expect(svc.rows.length, `${s}.${t} service_all`).toBe(1);
    }
  });

  it('163 client-scope RESTRICTIVE policies survive on the locked tables that carry them', async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and permissive = 'RESTRICTIVE'
         and tablename in ('gl_entries', 'gl_entry_lines', 'fiscal_periods', 'bills', 'bank_accounts', 'payment_origination_batches')`,
    );
    expect(r.rows.map((x) => x.tablename).sort()).toEqual(
      ['bank_accounts', 'bills', 'fiscal_periods', 'gl_entries', 'gl_entry_lines', 'payment_origination_batches'],
    );
  });

  it('grant-only hardened tables carry no member write GRANT', async () => {
    for (const [s, t] of GRANT_HARDENED_TABLES) {
      const r = await db.query<{ ok: boolean }>(
        `select not (has_table_privilege('authenticated', c.oid, 'INSERT') or has_table_privilege('authenticated', c.oid, 'UPDATE')
                  or has_table_privilege('authenticated', c.oid, 'DELETE') or has_table_privilege('anon', c.oid, 'INSERT')) ok
           from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2`,
        [s, t],
      );
      if (r.rows.length === 0) continue; // table absent in this schema
      expect(r.rows[0].ok, `${s}.${t}`).toBe(true);
    }
  });

  it('the hole is closed: a member can no longer reopen a hard-closed period', async () => {
    const e = await asRole('authenticated', () =>
      errorOf(`update public.fiscal_periods set status = 'OPEN' where id = $1`, [P_HARD]),
    );
    expect(e).toMatch(/permission denied/);
  });

  it('members still read their own tenant (and only it)', async () => {
    const rows = await asRole('authenticated', () =>
      db.query<{ id: string }>(`select id from public.fiscal_periods where id in ($1, $2, $3) order by id`, [P_HARD, P_OPEN, P_B]),
    );
    expect(rows.rows.map((r) => r.id).sort()).toEqual([P_HARD, P_OPEN].sort());
  });

  it('the service role still writes (the app write path)', async () => {
    const res = await asRole('service_role', () =>
      db.query(
        `insert into public.vendor_portal_tokens (org_id, vendor_id, token, status) values ($1, $2, $3, 'ACTIVE') returning id`,
        [ORG_A, VENDOR_A, 'e'.repeat(64)],
      ),
    );
    expect(res.rows).toHaveLength(1);
    const upd = await asRole('service_role', () =>
      db.query(`update public.fiscal_periods set status = 'SOFT_CLOSE' where id = $1 returning id`, [P_OPEN]),
    );
    expect(upd.rows).toHaveLength(1);
    await db.query(`update public.fiscal_periods set status = 'OPEN' where id = $1`, [P_OPEN]);
  });

  it('the period lock (152/153) still fires for a SERVICE-ROLE GL write', async () => {
    const e = await asRole('service_role', () =>
      errorOf(
        `insert into public.gl_entries (org_id, location_id, entry_number, entry_date, entry_type, fiscal_period_id, source_module, status, posted_at)
         values ($1, $2, 'T-171', '2025-01-15', 'STANDARD', $3, 'GL_HISTORY', 'POSTED', now())`,
        [ORG_A, LOC_A, P_HARD],
      ),
    );
    expect(e).toMatch(/hard-closed period/);
  });

  it('is idempotent: re-running 171 changes nothing', async () => {
    const snap = () => db.query(`select schemaname, tablename, policyname, cmd, permissive, roles::text r, qual
                                   from pg_policies where schemaname in ('public', 'core') order by 1, 2, 3`);
    const before = (await snap()).rows;
    const file = listMigrationFiles().find((f) => f.startsWith(`${LOCK_MIGRATION}_`))!;
    await applyMigrationFile(db, file);
    expect((await snap()).rows).toEqual(before);
  });

  // ── (b) ratchet ──────────────────────────────────────────────────────────
  it('RATCHET: every member-writable public/core table is listed with a reason (new tables default to locked)', async () => {
    const r = await db.query<{ t: string }>(`
      select n.nspname || '.' || c.relname as t
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'core') and c.relkind in ('r', 'p')
         and (has_table_privilege('authenticated', c.oid, 'INSERT')
           or has_table_privilege('authenticated', c.oid, 'UPDATE')
           or has_table_privilege('authenticated', c.oid, 'DELETE'))
         and (not c.relrowsecurity or exists (
               select 1 from pg_policies p
                where p.schemaname = n.nspname and p.tablename = c.relname
                  and p.permissive = 'PERMISSIVE' and p.cmd <> 'SELECT'
                  and p.roles && array['public', 'authenticated']::name[]))
       order by 1`);
    const writable = r.rows.map((x) => x.t);
    const unlisted = writable.filter((t) => !(t in MEMBER_WRITABLE));
    expect(unlisted, 'member-writable but not in MEMBER_WRITABLE — lock it (171 pattern) or record why').toEqual([]);
    const stale = Object.keys(MEMBER_WRITABLE).filter((t) => !writable.includes(t));
    expect(stale, 'listed in MEMBER_WRITABLE but no longer member-writable — remove the entry').toEqual([]);
  });

  it('RATCHET: no locked table is in the member-writable list', () => {
    for (const [s, t] of BUSINESS_LOCKED_TABLES) expect(MEMBER_WRITABLE[q(s, t)], q(s, t)).toBeUndefined();
  });
});

// ── (c) static scan ─────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(HERE, '..');
const PROJECTS_SRC = path.resolve(HERE, '../../../projects/src');
const MIGRATIONS_DIR = path.resolve(HERE, '../../../../packages/supabase/migrations');

/**
 * Write sites whose receiver is a function PARAMETER that is service-role by contract
 * (every caller hands in the service role). Keyed `file::receiver` so a NEW member-client
 * write in the same file still fails. Each entry names the callers that guarantee it.
 */
const SERVICE_ROLE_PARAMS: Readonly<Record<string, string>> = {
  'lib/money/plaid-feed.ts::adminDb':
    'every export takes adminDb; callers (integrations/plaid/exchange|map|sync, bank-accounts/[id]) pass createAdminSupabase() after requirePermission',
  'lib/money/connections.ts::adminDb':
    'connectProvider/disconnectProvider callers (integrations/connections, payments/connect, plaid-feed) pass the service role after settings_system:edit',
  'lib/money/apply-invoice-payment.ts::db':
    'called only by the Stripe webhook with createAdminSupabase(); org pinned from the verified PaymentIntent metadata',
  'lib/portal/customer/tokens.ts::admin': 'public customer-portal token resolution; caller passes the service role',
  'lib/portal/vendor/tokens.ts::admin': 'public vendor-portal token usage stamp; caller passes the service role',
  'lib/companies/create-company.ts::db':
    "ensureFiscalPeriods' db IS the write client: callers pass serviceWriter() (onboarding/portfolio/periods) or createCompany's service-role writer (settings/entities, import, onboarding/portfolio/companies)",
  'lib/services/sandbox.ts::db': 'sandbox seed/reset: only app/api/sandbox (createAdminSupabase, sandbox guard)',
  'lib/services/posting-verify.ts::db': 'GATE-2 verification harness: only app/api/sandbox (createAdminSupabase, sandbox guard)',
};

/** Receiver expressions that ARE the service role. */
//   serviceWriter / createAdminSupabase / eventsWriter — always the service role;
//   writerFor / scopedWriter — the service role for a KNOWN member client (after the org /
//   client-scope checks), else the caller itself (service role, or fails closed at RLS).
const SERVICE_EXPR = /\b(serviceWriter|createAdminSupabase|eventsWriter|writerFor|scopedWriter)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Walk back from `end` over `.schema('x')` calls and one receiver expression. */
function receiverBefore(src: string, end: number): string {
  let i = end;
  const skipWs = () => { while (i > 0 && /\s/.test(src[i - 1])) i--; };
  skipWs();
  // optional .schema('...') hop(s)
  for (;;) {
    const m = /\.schema\(\s*['"][a-z_]+['"]\s*\)$/.exec(src.slice(Math.max(0, i - 40), i));
    if (!m) break;
    i -= m[0].length;
    skipWs();
  }
  const stop = i;
  // receiver: identifiers, dots, and balanced (...) groups (calls / parenthesized exprs)
  for (;;) {
    if (i > 0 && src[i - 1] === ')') {
      let depth = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (src[j] === ')') depth++;
        else if (src[j] === '(') { depth--; if (depth === 0) break; }
      }
      i = j;
      continue;
    }
    if (i > 0 && /[A-Za-z0-9_$.]/.test(src[i - 1])) { i--; continue; }
    break;
  }
  return src.slice(i, stop).replace(/\s+/g, ' ').trim();
}

/** Is this receiver provably the service role in this file (before `pos`)? */
function isServiceReceiver(src: string, pos: number, recv: string, relFile: string): boolean {
  if (SERVICE_EXPR.test(recv)) return true;
  const name = recv.replace(/^\(+|\)+$/g, '').trim();
  if (!/^[A-Za-z_$][\w$.]*$/.test(name)) return false;
  if (SERVICE_ROLE_PARAMS[`${relFile}::${name}`]) return true;
  // nearest preceding `const|let NAME = <rhs>` or plain `NAME = <rhs>` before the site
  const esc = name.replace(/[.$]/g, '\\$&');
  const re = new RegExp(`(?:(?:const|let|var)\\s+${esc}\\b[^=;]*|(?:^|[^.\\w$])${esc}\\s*)=(?![=>])\\s*([^;]+);`, 'gm');
  let last: string | null = null;
  for (const m of src.slice(0, pos).matchAll(re)) last = m[1];
  // A ternary (`x ? admin : member`) is not provable; `??` / `?.` are fine.
  return last !== null && SERVICE_EXPR.test(last) && !/(^|[^?])\?(?![?.])/.test(last);
}

interface Site { file: string; line: number; table: string; recv: string }

function scanWrites(root: string, locked: ReadonlySet<string>): Site[] {
  const sites: Site[] = [];
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file).split(path.sep).join('/');
    sites.push(...scanSource(src, rel, locked));
  }
  return sites;
}

function scanSource(src: string, rel: string, locked: ReadonlySet<string>): Site[] {
  const sites: Site[] = [];
  {
    const fromRe = /\.from\(([^()]*)\)/g;
    for (const m of src.matchAll(fromRe)) {
      const literals = [...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1]);
      const hit = literals.find((t) => locked.has(t));
      if (!hit) continue;
      let seg = src.slice(m.index! + m[0].length, m.index! + m[0].length + 1500);
      const semi = seg.indexOf(';');
      if (semi >= 0) seg = seg.slice(0, semi);
      const nextFrom = seg.search(/\.from\(/);
      if (nextFrom >= 0) seg = seg.slice(0, nextFrom);
      if (!/\.(insert|update|upsert|delete)\(/.test(seg)) continue;
      const recv = receiverBefore(src, m.index!);
      if (isServiceReceiver(src, m.index!, recv, rel)) continue;
      sites.push({ file: rel, line: src.slice(0, m.index!).split('\n').length, table: hit, recv });
    }
  }
  return sites;
}

describe('static: no member-client write to a locked table (171 + earlier locks)', () => {
  const lockedNames = new Set(BUSINESS_LOCKED_TABLES.map(([, t]) => t));

  it('the scanner itself flags member-client writes and passes service-role ones (self-test)', () => {
    const src = [
      `const { supabase } = ctx;`,
      `await supabase.from('bills').update({ status: 'APPROVED' }).eq('id', id);`,
      `await ctx.supabase\n  .from('gl_entries')\n  .insert(row);`,
      `const pick = isAr ? supabase : createAdminSupabase();`,
      `await pick.from('bills').insert(rows);`,
      `await db.schema('core').from('items').delete().eq('id', x);`,
      `await supabase.from(isAr ? 'invoices' : 'bills').insert(rows);`,
      `const writer = serviceWriter(opts.writer);`,
      `await writer.from('bills').update({ a: 1 }).eq('org_id', o);`,
      `await serviceWriter().from('fiscal_periods').insert(rows);`,
      `await createAdminSupabase().schema('core').from('items').insert(rows);`,
      `const { data } = await supabase.from('bills').select('id').eq('id', id);`,
      `let w2: SupabaseClient;`,
      `w2 = await scopedWriter(db, orgId, [loc]);`,
      `await w2.from('bills').insert(rows);`,
      `await writerFor(db).from('bill_payments').insert(rows);`,
    ].join('\n');
    const flagged = scanSource(src, 'x.ts', lockedNames).map((s) => `${s.line}:${s.table}`);
    expect(flagged).toEqual(['2:bills', '4:gl_entries', '7:bills', '8:items', '9:bills']);
  });

  it('apps/web/src writes locked tables only through the service role', () => {
    const bad = scanWrites(WEB_SRC, lockedNames).map((s) => `${s.file}:${s.line} ${s.table} via ${s.recv || '?'}`);
    expect(bad, 'route the write through serviceWriter() after the permission check (lib/db/scoped-writer.ts)').toEqual([]);
  });

  it('apps/projects/src never writes a Books locked table', () => {
    const bad = scanWrites(PROJECTS_SRC, lockedNames).map((s) => `${s.file}:${s.line} ${s.table}`);
    expect(bad).toEqual([]);
  });

  it('every SERVICE_ROLE_PARAMS entry still matches a real write site (no stale exemptions)', () => {
    for (const key of Object.keys(SERVICE_ROLE_PARAMS)) {
      const [file, recv] = key.split('::');
      const src = fs.readFileSync(path.join(WEB_SRC, file), 'utf8');
      expect(new RegExp(`\\b${recv}\\b[\\s\\S]{0,80}\\.from\\(`).test(src), key).toBe(true);
    }
  });

  it('no migration after 171 re-grants member writes or adds a member write policy on a locked table', () => {
    const later = listMigrationFiles().filter((f) => f.slice(0, 3) > LOCK_MIGRATION && /^\d{3}_/.test(f));
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').toLowerCase();
      for (const [s, t] of BUSINESS_LOCKED_TABLES) {
        const tbl = `${s}.${t}`;
        const grant = new RegExp(`grant[^;]*(insert|update|delete|all)[^;]*on\\s+(table\\s+)?${tbl.replace('.', '\\.')}\\b[^;]*to[^;]*(authenticated|anon|public)`);
        expect(grant.test(sql), `${f} re-grants writes on ${tbl}`).toBe(false);
        const pol = new RegExp(`create\\s+policy[^;]*on\\s+${tbl.replace('.', '\\.')}\\b[^;]*for\\s+(all|insert|update|delete)\\b(?![^;]*to\\s+service_role)`);
        expect(pol.test(sql), `${f} adds a member write policy on ${tbl}`).toBe(false);
      }
    }
  });
});
