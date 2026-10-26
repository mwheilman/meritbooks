/**
 * Business-table PostgREST write lock (migration 171, wave 2H; part 2 = migration 172).
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
 * Part 2 (172): negative control at 171 (a member CAN delete audit history and rewrite an
 * AI decision's evidence), the 172 locks, append-only evidence (audit_log / ai_audit_log /
 * invoice_events / vendor_compliance_events immutable for EVERY role except FK cascades and
 * the retention GUC), and the ai_decisions partial lock (Projects' propose / approve path
 * still works; nothing else does).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrationFile, createTestDb, listMigrationFiles } from './pg';

const LOCK_MIGRATION = '171';
const LOCK_MIGRATION_2 = '172';
const LOCK_MIGRATION_3 = '176';
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

/** Tables 172 §1 makes SELECT-only for members. Keep in sync with 172 §1. */
const BUSINESS_LOCKED_TABLES_172: ReadonlyArray<readonly [schema: 'public' | 'core', table: string]> = [
  // audit evidence
  ['public', 'audit_log'],
  ['public', 'ai_audit_log'],
  ['public', 'invoice_events'],
  ['public', 'vendor_compliance_events'],
  // receivables (seam-owned invoice / deposit tables stay — see MEMBER_WRITABLE)
  ['public', 'credit_memos'],
  ['public', 'credit_memo_lines'],
  ['public', 'recurring_invoice_templates'],
  // intercompany / ownership
  ['public', 'intercompany_balances'],
  ['public', 'intercompany_loans'],
  ['public', 'intercompany_transactions'],
  ['public', 'entity_ownership'],
  ['public', 'equity_holders'],
  ['core', 'equity_holders'],
  // banking
  ['public', 'bank_transactions'],
  ['public', 'bank_reconciliations'],
  ['public', 'vendor_patterns'],
  // debt / leases / assets / schedules
  ['public', 'debt_instruments'],
  ['public', 'debt_schedule_lines'],
  ['public', 'loan_covenants'],
  ['public', 'covenant_measurements'],
  ['public', 'leases'],
  ['public', 'lease_schedule_lines'],
  ['public', 'fixed_assets'],
  ['public', 'depreciation_runs'],
  ['public', 'tax_depreciation_runs'],
  ['public', 'insurance_amortization_schedules'],
  ['public', 'insurance_amortization_runs'],
  ['public', 'posting_schedules'],
  ['public', 'posting_schedule_runs'],
  ['public', 'recurring_je_templates'],
  ['public', 'recurring_je_runs'],
  ['public', 'recurring_templates'],
  ['public', 'year_end_closes'],
  // revenue recognition
  ['public', 'revenue_recognition_runs'],
  ['public', 'rev_rec_method_map'],
  ['public', 'revenue_type_methods'],
  // job cost / procurement / expenses
  ['public', 'job_cost_entries'],
  ['public', 'job_cost_attributions'],
  ['public', 'retainage_releases'],
  ['public', 'inventory_items'],
  ['public', 'inventory_movements'],
  ['public', 'purchase_orders'],
  ['public', 'purchase_order_lines'],
  ['public', 'goods_receipts'],
  ['public', 'goods_receipt_lines'],
  ['public', 'bill_po_links'],
  ['public', 'expense_reports'],
  ['public', 'expense_report_lines'],
  ['public', 'receipts'],
  // tax / basis / FX
  ['public', 'sales_tax_filings'],
  ['public', 'sales_tax_rates'],
  ['public', 'tax_provision'],
  ['public', 'deferred_tax_items'],
  ['public', 'tax_year_params'],
  ['public', 'book_tax_account_tags'],
  ['public', 'book_tax_line_overrides'],
  ['public', 'book_tax_m_lines'],
  ['public', 'reporting_basis_adjustments'],
  ['public', 'fx_rates'],
  // chart-of-accounts structure + dimensions + posting-role map
  ['public', 'account_types'],
  ['public', 'account_sub_types'],
  ['public', 'account_groups'],
  ['public', 'account_roles'],
  ['public', 'classes'],
  ['core', 'departments'],
  ['public', 'location_classes'],
  ['public', 'location_departments'],
  ['public', 'location_items'],
  // payroll config
  ['public', 'pay_schedules'],
  ['public', 'payroll_register_mappings'],
  // close / compliance / policy control evidence
  ['public', 'close_checklists'],
  ['public', 'compliance_filings'],
  ['public', 'compliance_obligations'],
  ['public', 'vendor_compliance_docs'],
  ['public', 'company_policies'],
  ['public', 'expense_policies'],
];

/**
 * Tables 176 §4 makes SELECT-only for members (HIGH-2: the AR / internal-billing / deposit
 * tables the Projects seam used to block, plus the invoice design templates and the
 * per-customer template / CC settings). Keep in sync with 176 §4.
 */
const BUSINESS_LOCKED_TABLES_176: ReadonlyArray<readonly [schema: 'public' | 'core', table: string]> = [
  ['public', 'invoices'],
  ['public', 'invoice_lines'],
  ['public', 'internal_invoices'],
  ['public', 'internal_invoice_lines'],
  ['public', 'customer_deposits'],
  ['public', 'customer_deposit_applications'],
  ['public', 'invoice_templates'],
  ['public', 'customer_invoice_settings'],
  // 177: bank-feed split lines + remembered split rules (service writes only)
  ['public', 'bank_transaction_splits'],
  ['public', 'split_rules'],
  // 190: tenant / company brand profiles (service writes after settings_system:edit)
  ['public', 'brand_profiles'],
];

/** 172 §2: append-only evidence — no UPDATE / DELETE / TRUNCATE for ANY role. */
const APPEND_ONLY_EVIDENCE = ['audit_log', 'ai_audit_log', 'invoice_events', 'vendor_compliance_events'] as const;

/** Every member-locked table (171 + 172 + 176). */
/** 191 §2b (security review H3): scheduled + emailed report packs. */
const BUSINESS_LOCKED_TABLES_191: ReadonlyArray<readonly [schema: 'public' | 'core', table: string]> = [
  ['public', 'report_packs'],
];

const ALL_LOCKED_TABLES = [...BUSINESS_LOCKED_TABLES, ...BUSINESS_LOCKED_TABLES_172, ...BUSINESS_LOCKED_TABLES_176, ...BUSINESS_LOCKED_TABLES_191];

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
//   A — money / ledger / control: SHOULD be locked; blocked on another owner's code (the
//       Projects seam, Merit Projects). Do not add new tables here.
//   B — user workspace, planning, AI working state, or append-only logs: intentionally
//       member-writable.
//   C — ownership / sensitivity unclear (shared with Projects, config, evidence) — needs
//       an owner decision before it is locked or accepted.
const A_PROJECTS =
  'A (partial, 172 §3): Merit Projects still proposes / approves through the member client (apps/projects/src/lib/ai/decisions.ts). ' +
  'Members may only INSERT a PROPOSED row and move a PROPOSED row to a disposition (evidence immutable, no DELETE); ' +
  'lock fully once Projects writes through a definer RPC / service path';
const B = 'B: user workspace / planning / AI working state / append-only — intentionally member-writable';
const C = 'C: ownership or sensitivity unclear — needs an owner decision';

const MEMBER_WRITABLE: Readonly<Record<string, string>> = {
  // A — AI decision log: partial lock (Projects writes it)
  'public.ai_decisions': A_PROJECTS,
  // B
  'public.report_views': B,
  // public.report_packs: locked by 191 §2b (security review H3 — scheduled + emailed; writes are
  // the service role after reports:export + the pack's client-scope check)
  // public.budgets: locked by 189 (the published budget of record; written by the version triggers)
  'public.budget_versions': B,
  'public.learned_preferences': B,
  'public.agent_runs': B,
  'public.agent_run_steps': B,
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
const AUDIT_A = 'aaaaaaaa-1720-0000-0000-0000000000a1';
const AUDIT_B = 'bbbbbbbb-1720-0000-0000-0000000000a1';
const AI_AUDIT_A = 'aaaaaaaa-1720-0000-0000-0000000000b1';
const DEC_APPROVED = 'aaaaaaaa-1720-0000-0000-0000000000c1';
const DEC_PROPOSED = 'aaaaaaaa-1720-0000-0000-0000000000c2';
const VCE_A = 'aaaaaaaa-1720-0000-0000-0000000000d1';

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

describe('migration 172 — before (at 171, negative control: audit history is rewritable)', () => {
  beforeAll(async () => {
    const f171 = listMigrationFiles().find((f) => f.startsWith(`${LOCK_MIGRATION}_`))!;
    await applyMigrationFile(db, f171);
    // Seed the evidence as the migration runner.
    await db.query(
      `insert into public.audit_log (id, org_id, table_name, record_id, action, field_name, old_value, new_value, user_id) values
         ($1, $3, 'bills', gen_random_uuid(), 'UPDATE', 'status', 'PENDING', 'APPROVED', 'user_x'),
         ($2, $4, 'bills', gen_random_uuid(), 'UPDATE', 'status', 'PENDING', 'APPROVED', 'user_y')`,
      [AUDIT_A, AUDIT_B, ORG_A, ORG_B],
    );
    await db.query(
      `insert into public.ai_audit_log (id, org_id, feature, model_version, input_summary, output_summary)
       values ($1, $2, 'OCR', 'm-1', 'in', 'out')`,
      [AI_AUDIT_A, ORG_A],
    );
    await db.query(
      `insert into public.ai_decisions (id, org_id, location_id, feature, input_summary, proposed_output, status, disposition_by_user, disposition_at) values
         ($1, $3, $4, 'JE_COMPOSER', 'post rent', '{"memo":"rent","amount_cents":100}'::jsonb, 'APPROVED', 'user_x', now()),
         ($2, $3, $4, 'CATEGORIZATION', 'categorize', '{"dedup_key":"k1","account":"6100"}'::jsonb, 'PROPOSED', null, null)`,
      [DEC_APPROVED, DEC_PROPOSED, ORG_A, LOC_A],
    );
    await db.query(
      `insert into public.vendor_compliance_events (id, org_id, vendor_id, event_type, detail) values ($1, $2, $3, 'DOC_EXPIRED', 'W-9 expired')`,
      [VCE_A, ORG_A, VENDOR_A],
    );
  }, 120_000);

  it('at 171 a member CAN rewrite and delete audit history over PostgREST', async () => {
    const upd = await asRole('authenticated', () =>
      db.query(`update public.audit_log set new_value = 'PENDING' where id = $1 returning id`, [AUDIT_A]),
    );
    expect(upd.rows).toHaveLength(1);
    const del = await asRole('authenticated', () => db.query(`delete from public.audit_log where id = $1 returning id`, [AUDIT_A]));
    expect(del.rows).toHaveLength(1);
    await db.query(
      `insert into public.audit_log (id, org_id, table_name, record_id, action, field_name, old_value, new_value, user_id)
       values ($1, $2, 'bills', gen_random_uuid(), 'UPDATE', 'status', 'PENDING', 'APPROVED', 'user_x')`,
      [AUDIT_A, ORG_A],
    );
  });

  it("at 171 a member CAN rewrite an APPROVED AI decision's evidence and delete it", async () => {
    const upd = await asRole('authenticated', () =>
      db.query(`update public.ai_decisions set proposed_output = '{"memo":"forged"}'::jsonb where id = $1 returning id`, [DEC_APPROVED]),
    );
    expect(upd.rows).toHaveLength(1);
    await db.query(`update public.ai_decisions set proposed_output = '{"memo":"rent","amount_cents":100}'::jsonb where id = $1`, [DEC_APPROVED]);
  });
});

describe('migration 171 — after (members are SELECT-only on business tables)', () => {
  beforeAll(async () => {
    for (const f of listMigrationFiles().filter((x) => x.slice(0, 3) > LOCK_MIGRATION)) await applyMigrationFile(db, f);
  }, 120_000);

  for (const [s, t] of ALL_LOCKED_TABLES) {
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
    for (const [s, t] of ALL_LOCKED_TABLES) {
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

  it('is idempotent: re-running 172 changes nothing (policies, grants, triggers)', async () => {
    const snap = async () => ({
      pol: (await db.query(`select schemaname, tablename, policyname, cmd, permissive, roles::text r, qual, with_check
                              from pg_policies where schemaname in ('public', 'core') order by 1, 2, 3`)).rows,
      trg: (await db.query(`select tgrelid::regclass::text t, tgname from pg_trigger
                             where tgname in ('trg_append_only_evidence', 'trg_append_only_evidence_truncate', 'trg_ai_decisions_member_update')
                             order by 1, 2`)).rows,
      grants: (await db.query(`select table_schema, table_name, grantee, privilege_type from information_schema.role_table_grants
                                where table_schema in ('public', 'core') and grantee in ('anon', 'authenticated') order by 1, 2, 3, 4`)).rows,
    });
    const before = await snap();
    const file = listMigrationFiles().find((f) => f.startsWith(`${LOCK_MIGRATION_2}_`))!;
    await applyMigrationFile(db, file);
    expect(await snap()).toEqual(before);
    expect(before.trg).toHaveLength(9); // 4 evidence tables × 2 + ai_decisions
  });

  it('163 client-scope RESTRICTIVE policies survive on the 172 tables that carry them', async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and permissive = 'RESTRICTIVE'
         and tablename in ('bank_transactions', 'ai_decisions', 'fixed_assets', 'leases', 'debt_instruments', 'purchase_orders', 'expense_reports')`,
    );
    expect(r.rows.map((x) => x.tablename).sort()).toEqual(
      ['ai_decisions', 'bank_transactions', 'debt_instruments', 'expense_reports', 'fixed_assets', 'leases', 'purchase_orders'],
    );
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
    for (const [s, t] of ALL_LOCKED_TABLES) expect(MEMBER_WRITABLE[q(s, t)], q(s, t)).toBeUndefined();
  });

  it('RATCHET: no class-A table is left without a named blocker (172 + 176 cleared the follow-up list)', () => {
    const a = Object.entries(MEMBER_WRITABLE).filter(([, why]) => why.startsWith('A')).map(([t]) => t).sort();
    // 176 locked the seam-blocked receivables tables (HIGH-2); only the Projects-written
    // AI decision log remains class A.
    expect(a).toEqual(['public.ai_decisions']);
  });

  // ── 176 (HIGH-2): the AR tables ───────────────────────────────────────────
  it('176: a member can no longer issue, rewrite or delete an invoice; the service role still can', async () => {
    const CUST = 'aaaaaaaa-1760-0000-0000-0000000000c1';
    await db.query(`insert into core.customers (id, org_id, name) values ($1, $2, 'Customer 176') on conflict (id) do nothing`, [CUST, ORG_A]);
    const insertInvoice = (num: string) =>
      db.query<{ id: string }>(
        `insert into public.invoices (org_id, location_id, customer_id, invoice_number, invoice_date, due_date, total_cents)
         values ($1, $2, $3, $4, '2025-03-10', '2025-04-09', 12500) returning id`,
        [ORG_A, LOC_A, CUST, num],
      );
    const memberErr = await asRole('authenticated', async () => {
      try { await insertInvoice('INV-176-M'); return null; } catch (e) { return e instanceof Error ? e.message : String(e); }
    });
    expect(memberErr).toMatch(/permission denied/);

    const svc = await asRole('service_role', () => insertInvoice('INV-176-S'));
    expect(svc.rows).toHaveLength(1);
    const id = svc.rows[0].id;

    const errs = await asRole('authenticated', async () => [
      await errorOf(`update public.invoices set status = 'PAID', amount_paid_cents = total_cents where id = $1`, [id]),
      await errorOf(`delete from public.invoices where id = $1`, [id]),
      await errorOf(`insert into public.invoice_templates (org_id, location_id, name) values ($1, $2, 'Forged')`, [ORG_A, LOC_A]),
    ]);
    for (const e of errs) expect(e).toMatch(/permission denied/);

    // Members still read their own tenant's invoice (and not another tenant's).
    const seen = await asRole('authenticated', () => db.query(`select id from public.invoices where id = $1`, [id]));
    expect(seen.rows).toHaveLength(1);
    const other = await asRole(
      'authenticated',
      () => db.query(`select id from public.invoices where id = $1`, [id]),
      { sub: MEMBER, org_id: ORG_B, role: 'authenticated' },
    );
    expect(other.rows).toHaveLength(0);
    await db.query(`delete from public.invoices where id = $1`, [id]);
  });

  it('176: the 163 client-scope RESTRICTIVE policy survives on the AR tables', async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_policies where schemaname = 'public' and policyname = 'client_scope_rls' and permissive = 'RESTRICTIVE'
         and tablename in ('invoices', 'invoice_lines', 'customer_deposits', 'internal_invoices')`,
    );
    expect(r.rows.map((x) => x.tablename).sort()).toEqual(['customer_deposits', 'internal_invoices', 'invoice_lines', 'invoices']);
  });

  it('is idempotent: re-running 176 changes nothing (policies, grants)', async () => {
    const snap = async () => ({
      pol: (await db.query(`select schemaname, tablename, policyname, cmd, permissive, roles::text r, qual, with_check
                              from pg_policies where schemaname in ('public', 'core') order by 1, 2, 3`)).rows,
      grants: (await db.query(`select table_schema, table_name, grantee, privilege_type from information_schema.role_table_grants
                                where table_schema in ('public', 'core') and grantee in ('anon', 'authenticated') order by 1, 2, 3, 4`)).rows,
    });
    const before = await snap();
    const file = listMigrationFiles().find((f) => f.startsWith(`${LOCK_MIGRATION_3}_`))!;
    await applyMigrationFile(db, file);
    expect(await snap()).toEqual(before);
  });
});

// ── 172 §2: append-only evidence ────────────────────────────────────────────
describe('migration 172 — audit evidence is append-only for every role', () => {
  it('the audit hole is closed for members: no UPDATE / DELETE on audit_log (permission denied)', async () => {
    const errs = await asRole('authenticated', async () => [
      await errorOf(`update public.audit_log set new_value = 'PENDING' where id = $1`, [AUDIT_A]),
      await errorOf(`delete from public.audit_log where id = $1`, [AUDIT_A]),
      await errorOf(`insert into public.audit_log (org_id, table_name, record_id, action) values ($1, 'bills', gen_random_uuid(), 'INSERT')`, [ORG_A]),
    ]);
    for (const e of errs) expect(e).toMatch(/permission denied/);
  });

  it('members still read their own tenant audit history (and only it)', async () => {
    const r = await asRole('authenticated', () =>
      db.query<{ id: string }>(`select id from public.audit_log where id in ($1, $2)`, [AUDIT_A, AUDIT_B]),
    );
    expect(r.rows.map((x) => x.id)).toEqual([AUDIT_A]);
  });

  it('the service role (the app write path) can INSERT audit rows', async () => {
    const r = await asRole('service_role', () =>
      db.query(
        `insert into public.audit_log (org_id, table_name, record_id, action, user_id) values ($1, 'bills', gen_random_uuid(), 'INSERT', 'svc') returning id`,
        [ORG_A],
      ),
    );
    expect(r.rows).toHaveLength(1);
  });

  for (const t of APPEND_ONLY_EVIDENCE) {
    it(`even the service role cannot UPDATE / DELETE / TRUNCATE public.${t}`, async () => {
      const errs = await asRole('service_role', async () => [
        await errorOf(`update public.${t} set org_id = org_id`),
        await errorOf(`delete from public.${t}`),
        await errorOf(`truncate public.${t}`),
      ]);
      const [upd, del, trunc] = errs;
      // UPDATE / DELETE only fire the guard when a row exists; seeded tables must refuse.
      const n = (await db.query<{ n: number }>(`select count(*)::int n from public.${t}`)).rows[0].n;
      if (n > 0) {
        expect(upd, `${t} update`).toMatch(/append-only audit evidence/);
        expect(del, `${t} delete`).toMatch(/append-only audit evidence/);
      }
      expect(trunc, `${t} truncate`).toMatch(/append-only audit evidence/);
    });
  }

  it('the superuser / migration runner is refused too (the trigger is role-independent)', async () => {
    expect(await errorOf(`delete from public.audit_log where id = $1`, [AUDIT_A])).toMatch(/append-only audit evidence/);
    expect(await errorOf(`update public.audit_log set user_id = 'someone_else' where id = $1`, [AUDIT_A])).toMatch(/append-only/);
  });

  it('a documented retention / reset job can purge inside its own transaction (meritbooks.allow_audit_purge)', async () => {
    await db.exec('begin');
    try {
      await db.exec(`set local meritbooks.allow_audit_purge = 'on'`);
      const r = await db.query(`delete from public.audit_log where id = $1 returning id`, [AUDIT_B]);
      expect(r.rows).toHaveLength(1);
    } finally {
      await db.exec('rollback');
    }
    // the GUC was transaction-local: the row is back and the guard is armed again
    expect((await db.query(`select 1 from public.audit_log where id = $1`, [AUDIT_B])).rows).toHaveLength(1);
    expect(await errorOf(`delete from public.audit_log where id = $1`, [AUDIT_B])).toMatch(/append-only/);
  });

  it('an FK cascade still removes evidence (pg_trigger_depth() > 1): deleting a tenant org', async () => {
    const ORG_C = 'cccccccc-0000-0000-0000-000000000172';
    await db.query(`insert into core.organizations (id, name, slug) values ($1, 'Tenant C 172', 'tenant-c-172')`, [ORG_C]);
    await db.query(
      `insert into public.audit_log (org_id, table_name, record_id, action) values ($1, 'bills', gen_random_uuid(), 'INSERT')`,
      [ORG_C],
    );
    const e = await errorOf(`delete from core.organizations where id = $1`, [ORG_C]);
    if (e === null) {
      expect((await db.query(`select 1 from public.audit_log where org_id = $1`, [ORG_C])).rows).toHaveLength(0);
    } else {
      // An org-lifecycle guard elsewhere may refuse hard deletes; it must not be OUR guard.
      expect(e).not.toMatch(/append-only audit evidence/);
    }
  });

  it('ai_audit_log: the human response is stamped ONCE; nothing else may change', async () => {
    const ok = await asRole('service_role', () =>
      db.query(
        `update public.ai_audit_log set human_response = 'APPROVED', human_response_at = now() where id = $1 returning id`,
        [AI_AUDIT_A],
      ),
    );
    expect(ok.rows).toHaveLength(1);
    const again = await asRole('service_role', () =>
      errorOf(`update public.ai_audit_log set human_response = 'REJECTED' where id = $1`, [AI_AUDIT_A]),
    );
    expect(again).toMatch(/append-only/);
    const other = await asRole('service_role', () =>
      errorOf(`update public.ai_audit_log set output_summary = 'rewritten' where id = $1`, [AI_AUDIT_A]),
    );
    expect(other).toMatch(/append-only/);
  });
});

// ── 172 §3: ai_decisions partial lock ───────────────────────────────────────
describe('migration 172 — ai_decisions: members propose / dispose only (Projects path), evidence immutable', () => {
  it('a member can no longer DELETE or TRUNCATE a decision', async () => {
    const errs = await asRole('authenticated', async () => [
      await errorOf(`delete from public.ai_decisions where id = $1`, [DEC_APPROVED]),
      await errorOf(`truncate public.ai_decisions`),
    ]);
    for (const e of errs) expect(e).toMatch(/permission denied/);
    const anon = await asRole('anon', async () => [
      await errorOf(`insert into public.ai_decisions (org_id, feature, input_summary, proposed_output) values ($1, 'X', 'x', '{}'::jsonb)`, [ORG_A]),
      await errorOf(`update public.ai_decisions set status = 'APPROVED'`),
    ]);
    for (const e of anon) expect(e).toMatch(/permission denied/);
  });

  it("a member can no longer rewrite an APPROVED decision's evidence (the 171 hole is closed)", async () => {
    // RLS USING (status = 'PROPOSED') hides the final row from the member's UPDATE.
    const r = await asRole('authenticated', () =>
      db.query(`update public.ai_decisions set proposed_output = '{"memo":"forged"}'::jsonb where id = $1 returning id`, [DEC_APPROVED]),
    );
    expect(r.rows).toHaveLength(0);
    const row = await db.query<{ p: { memo: string } }>(`select proposed_output p from public.ai_decisions where id = $1`, [DEC_APPROVED]);
    expect(row.rows[0].p.memo).toBe('rent');
  });

  it('a member cannot forge an APPROVED / posted decision on INSERT, nor one for another tenant', async () => {
    const errs = await asRole('authenticated', async () => [
      await errorOf(
        `insert into public.ai_decisions (org_id, feature, input_summary, proposed_output, status) values ($1, 'X', 'x', '{}'::jsonb, 'APPROVED')`,
        [ORG_A],
      ),
      await errorOf(
        `insert into public.ai_decisions (org_id, feature, input_summary, proposed_output, disposition_by_user) values ($1, 'X', 'x', '{}'::jsonb, 'me')`,
        [ORG_A],
      ),
      await errorOf(`insert into public.ai_decisions (org_id, feature, input_summary, proposed_output) values ($1, 'X', 'x', '{}'::jsonb)`, [ORG_B]),
    ]);
    for (const e of errs) expect(e).toMatch(/row-level security/i);
  });

  it("a member cannot dispose (approve/reject/expire) a Books-owned decision — only Projects' (security review H-1)", async () => {
    const r = await asRole('authenticated', () =>
      db.query(
        `update public.ai_decisions set status = 'REJECTED', disposition_at = now()
          where org_id = $1 and feature = 'CATEGORIZATION' and status = 'PROPOSED' returning id`,
        [ORG_A],
      ),
    );
    expect(r.rows).toHaveLength(0);
    const ins = await asRole('authenticated', () =>
      errorOf(`insert into public.ai_decisions (org_id, feature, input_summary, proposed_output) values ($1, 'DUPLICATE_PAYMENT', 'x', '{}'::jsonb)`, [ORG_A]),
    );
    expect(ins).toMatch(/row-level security/i);
  });

  it("Projects' propose path still works: expire the open row by dedup_key, insert a new PROPOSED row", async () => {
    await db.query(
      `insert into public.ai_decisions (org_id, location_id, feature, input_summary, proposed_output, status)
       values ($1, $2, 'PROJECTS_PACK_CONFIGURE', 'configure', '{"dedup_key":"pk1"}'::jsonb, 'PROPOSED')`,
      [ORG_A, LOC_A],
    );
    const res = await asRole('authenticated', async () => {
      const exp = await db.query(
        `update public.ai_decisions set status = 'EXPIRED', disposition_at = now(), disposition_note = 'Replaced by a newer proposal'
          where org_id = $1 and feature = 'PROJECTS_PACK_CONFIGURE' and status = 'PROPOSED' and proposed_output->>'dedup_key' = 'pk1' returning id`,
        [ORG_A],
      );
      const ins = await db.query<{ id: string }>(
        `insert into public.ai_decisions (org_id, location_id, feature, input_summary, proposed_output, status, created_by_user)
         values ($1, $2, 'PROJECTS_PACK_CONFIGURE', 'configure', '{"dedup_key":"pk1","pack":"equipment_dealer"}'::jsonb, 'PROPOSED', $3) returning id`,
        [ORG_A, LOC_A, MEMBER],
      );
      return { expired: exp.rows.length, id: ins.rows[0].id };
    });
    expect(res.expired).toBe(1);
    // approve path: the SAME row moves PROPOSED → APPROVED with the disposition fields
    const appr = await asRole('authenticated', () =>
      db.query(
        `update public.ai_decisions set status = 'APPROVED', disposition_by_user = $3, disposition_at = now(), disposition_note = 'ok'
          where id = $1 and org_id = $2 and status = 'PROPOSED' returning id`,
        [res.id, ORG_A, MEMBER],
      ),
    );
    expect(appr.rows).toHaveLength(1);
  });

  it("a member cannot change a PROPOSED decision's evidence (only status + disposition)", async () => {
    const id = (await db.query<{ id: string }>(
      `insert into public.ai_decisions (org_id, feature, input_summary, proposed_output) values ($1, 'PROJECTS_IMPORT_MAP', 'x', '{"v":1}'::jsonb) returning id`,
      [ORG_A],
    )).rows[0].id;
    const errs = await asRole('authenticated', async () => [
      await errorOf(`update public.ai_decisions set proposed_output = '{"v":2}'::jsonb where id = $1`, [id]),
      await errorOf(`update public.ai_decisions set confidence = 0.99 where id = $1`, [id]),
      await errorOf(`update public.ai_decisions set posted_gl_entry_id = gen_random_uuid() where id = $1`, [id]),
      await errorOf(`update public.ai_decisions set org_id = $2, status = 'REJECTED' where id = $1`, [id, ORG_B]),
    ]);
    for (const e of errs.slice(0, 3)) expect(e).toMatch(/evidence is immutable|foreign key/);
    expect(errs[0]).toMatch(/evidence is immutable/);
    expect(errs[3]).toMatch(/row-level security|evidence is immutable/i);
  });

  it('the service role (every Books write) may refresh evidence and delete (detector refresh, nl/saved)', async () => {
    const id = (await db.query<{ id: string }>(
      `insert into public.ai_decisions (org_id, feature, input_summary, proposed_output) values ($1, 'X', 'x', '{"v":1}'::jsonb) returning id`,
      [ORG_A],
    )).rows[0].id;
    const upd = await asRole('service_role', () =>
      db.query(`update public.ai_decisions set proposed_output = '{"v":2}'::jsonb, confidence = 0.5 where id = $1 returning id`, [id]),
    );
    expect(upd.rows).toHaveLength(1);
    const del = await asRole('service_role', () => db.query(`delete from public.ai_decisions where id = $1 returning id`, [id]));
    expect(del.rows).toHaveLength(1);
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
  'lib/reports/compiler/scheduled-delivery.tsx::admin':
    'deliverDuePacks(admin): callers are the scheduler job (ctx.admin, the service role) and the secret-gated run-scheduled route (createAdminSupabase); only next_run_date / last_run_* are written',
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
    // same-file string constants naming a table (`const TEMPLATES = 'recurring_je_templates'`)
    const consts = new Map(
      [...src.matchAll(/\bconst\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*string\s*)?=\s*['"]([a-z_]+)['"]/g)].map((x) => [x[1], x[2]] as const),
    );
    for (const m of src.matchAll(fromRe)) {
      const literals = [
        ...[...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1]),
        ...[...m[1].matchAll(/\b([A-Z_][A-Z0-9_]*)\b/g)].map((x) => consts.get(x[1])).filter((x): x is string => !!x),
      ];
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

describe('static: no member-client write to a locked table (171 + 172 + 176)', () => {
  const lockedNames = new Set(ALL_LOCKED_TABLES.map(([, t]) => t));
  // Books writes ai_decisions only through the service role too (172 §3: Projects is the
  // one remaining member writer, so it is scanned in apps/web only).
  const webScanned = new Set([...lockedNames, 'ai_decisions']);

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
      `const RUNS = 'recurring_je_runs';`,
      `await db.from(RUNS).update({ status: 'POSTED' }).eq('id', id);`,
      `await writerFor(db).from(RUNS).insert(rows);`,
    ].join('\n');
    const flagged = scanSource(src, 'x.ts', lockedNames).map((s) => `${s.line}:${s.table}`);
    expect(flagged).toEqual(['2:bills', '4:gl_entries', '7:bills', '8:items', '9:invoices', '20:recurring_je_runs']);
  });

  it('apps/web/src writes locked tables only through the service role', () => {
    const bad = scanWrites(WEB_SRC, webScanned).map((s) => `${s.file}:${s.line} ${s.table} via ${s.recv || '?'}`);
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

  it('no migration after 171 / 172 / 176 re-grants member writes or adds a member write policy on a locked table', () => {
    const later = listMigrationFiles().filter((f) => f.slice(0, 3) > LOCK_MIGRATION && /^\d{3}_/.test(f));
    for (const f of later) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8').toLowerCase();
      const tables = f.slice(0, 3) > LOCK_MIGRATION_3
        ? ALL_LOCKED_TABLES
        : f.slice(0, 3) > LOCK_MIGRATION_2
          ? [...BUSINESS_LOCKED_TABLES, ...BUSINESS_LOCKED_TABLES_172]
          : BUSINESS_LOCKED_TABLES;
      for (const [s, t] of tables) {
        const tbl = `${s}.${t}`;
        const grant = new RegExp(`grant[^;]*(insert|update|delete|all)[^;]*on\\s+(table\\s+)?${tbl.replace('.', '\\.')}\\b[^;]*to[^;]*(authenticated|anon|public)`);
        expect(grant.test(sql), `${f} re-grants writes on ${tbl}`).toBe(false);
        const pol = new RegExp(`create\\s+policy[^;]*on\\s+${tbl.replace('.', '\\.')}\\b[^;]*for\\s+(all|insert|update|delete)\\b(?![^;]*to\\s+service_role)`);
        expect(pol.test(sql), `${f} adds a member write policy on ${tbl}`).toBe(false);
      }
    }
  });
});
