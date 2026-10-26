/**
 * Shared PGlite fixture for the Projects ⇄ Books seam tests (migration 173): the full
 * Books replay PLUS the Projects `pm` emitter chain (1100–1103 — the billing/deposit
 * emitters and pm.v_seam_health; the 3-digit harness does not replay 4-digit files),
 * a service-role-like supabase client over it (./pg-supabase.ts), and a tenant seeder
 * (company, customer, job, the role accounts, 2025–2027 fiscal periods).
 */
import crypto from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { applyMigrationFile, createTestDb } from './pg';
import { pgSupabase } from './pg-supabase';

export const PM_CHAIN = ['1100_pm_foundation.sql', '1101_pm_onboarding_followups.sql', '1102_pm_commitments_billing.sql', '1103_pm_cost_drain.sql'];

export interface SeamDb {
  db: PGlite;
  sb: SupabaseClient;
}

export async function seamDb(): Promise<SeamDb> {
  const { db } = await createTestDb();
  for (const f of PM_CHAIN) await applyMigrationFile(db, f);
  return { db, sb: pgSupabase(db) };
}

export interface Tenant {
  org: string;
  loc: string;
  cust: string;
  job: string;
  acct: Record<'AR' | 'RET' | 'DEF' | 'DEP' | 'REV' | 'REV2' | 'TAX' | 'BANK', string>;
}

export interface TenantOptions {
  projects: boolean;
  shortCode: string;
  revRec?: string;
  jobOverride?: string | null;
  contractCents?: number;
  termsDays?: number;
  taxRatePct?: number;
}

async function one<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T> {
  return (await db.query<T>(sql, params)).rows[0];
}

async function group(db: PGlite, org: string, type: string, subType: string): Promise<string> {
  const t = await one<{ id: string }>(db,
    `insert into public.account_types (org_id, name, code, display_order, normal_balance)
     values ($1, $2::text, ($2::text)::account_type_enum, 1, $3)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, type, ['ASSET', 'COGS', 'OPEX', 'OTHER'].includes(type) ? 'DEBIT' : 'CREDIT']);
  const st = await one<{ id: string }>(db,
    `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order)
     values ($1, $2, $3::text, ($3::text)::account_sub_type_enum, 1)
     on conflict (org_id, code) do update set name = excluded.name returning id`,
    [org, t.id, subType]);
  const g = await one<{ id: string }>(db,
    `insert into public.account_groups (org_id, account_sub_type_id, name, display_order)
     values ($1, $2, $3, 1) on conflict (org_id, name) do update set display_order = 1 returning id`,
    [org, st.id, `G ${subType}`]);
  return g.id;
}

/** Add one approved account to a tenant (seam part 2 tests need COGS / OPEX / accrual accounts too). */
export async function addAccount(db: PGlite, org: string, number: string, name: string, type: string, subType: string): Promise<string> {
  return account(db, org, number, name, type, subType);
}

async function account(db: PGlite, org: string, number: string, name: string, type: string, subType: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `insert into public.accounts (id, org_id, account_group_id, account_number, name, account_type, account_sub_type, is_active, approval_status)
     values ($1, $2, $3, $4, $5, $6::account_type_enum, $7::account_sub_type_enum, true, 'APPROVED')`,
    [id, org, await group(db, org, type, subType), number, name, type, subType]);
  return id;
}

export async function seedTenant(db: PGlite, o: TenantOptions): Promise<Tenant> {
  const org = crypto.randomUUID();
  const loc = crypto.randomUUID();
  const cust = crypto.randomUUID();
  const job = crypto.randomUUID();
  const ent: Record<string, unknown> = { books: true };
  if (o.projects) ent.projects = true;
  await db.query(`insert into core.organizations (id, name, slug, entitlements) values ($1, $2, $3, $4::jsonb)`,
    [org, `Tenant ${o.shortCode}`, `t-${o.shortCode.toLowerCase()}-${org.slice(0, 6)}`, JSON.stringify(ent)]);
  await db.query(`insert into core.locations (id, org_id, name, short_code, rev_rec_method) values ($1, $2, $3, $4, $5::rev_rec_method_enum)`,
    [loc, org, `Co ${o.shortCode}`, o.shortCode, o.revRec ?? 'AS_BILLED']);
  await db.query(`insert into core.customers (id, org_id, name, payment_terms_days, state) values ($1, $2, 'Owner LLC', $3, 'IA')`,
    [cust, org, o.termsDays ?? 45]);
  const acct = {
    AR: await account(db, org, '1100', 'Accounts Receivable', 'ASSET', 'CURRENT_ASSET'),
    RET: await account(db, org, '1110', 'Retainage Receivable', 'ASSET', 'CURRENT_ASSET'),
    BANK: await account(db, org, '1000', 'Operating Bank', 'ASSET', 'CURRENT_ASSET'),
    DEF: await account(db, org, '2410', 'Deferred Revenue', 'LIABILITY', 'CURRENT_LIABILITY'),
    DEP: await account(db, org, '2420', 'Customer Deposits', 'LIABILITY', 'CURRENT_LIABILITY'),
    TAX: await account(db, org, '2300', 'Sales Tax Payable', 'LIABILITY', 'CURRENT_LIABILITY'),
    REV: await account(db, org, '4000', 'Contract Revenue', 'REVENUE', 'REVENUE'),
    REV2: await account(db, org, '4100', 'Change Order Revenue', 'REVENUE', 'REVENUE'),
  };
  await db.query(
    `insert into core.jobs (id, org_id, location_id, customer_id, job_number, name, contract_amount_cents, rev_rec_method_override)
     values ($1, $2, $3, $4, $5, 'Main St build', $6, $7::rev_rec_method_enum)`,
    [job, org, loc, cust, `J-${o.shortCode}`, o.contractCents ?? 0, o.jobOverride ?? null]);
  for (const y of [2025, 2026, 2027]) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, '0')}-01`;
      await db.query(
        `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
         values ($1, $2, $3, $4, $5::date, ($5::date + interval '1 month' - interval '1 day')::date, 'OPEN')`,
        [org, loc, y, m, start]);
    }
  }
  if (o.taxRatePct) {
    await db.query(
      `insert into public.sales_tax_rates (org_id, state, jurisdiction_label, combined_rate_pct, effective_date, is_active)
       values ($1, 'IA', 'Iowa', $2, '2020-01-01', true)`, [org, o.taxRatePct]);
  }
  return { org, loc, cust, job, acct };
}

/** Insert a pending Projects event; returns the core.events row id. */
export async function enqueue(db: PGlite, org: string, eventType: string, payload: Record<string, unknown>, occurredOn = '2026-06-15'): Promise<string> {
  const eventId = (payload.event_id as string | undefined) ?? crypto.randomUUID();
  const r = await one<{ id: string }>(db,
    `insert into core.events (org_id, event_id, event_type, source_module, payload, occurred_on, status)
     values ($1, $2, $3, 'PROJECTS', $4::jsonb, $5, 'pending') returning id`,
    [org, eventId, eventType, JSON.stringify({ ...payload, event_id: eventId }), occurredOn]);
  return r.id;
}

export interface EventRow {
  id: string; status: string; invoice_id: string | null; invoice_number: string | null; gl_entry_id: string | null;
  error: string | null; error_code: string | null; ack_meta: Record<string, unknown> | null; processed_at: string | null;
}

export async function eventRow(db: PGlite, id: string): Promise<EventRow> {
  return one<EventRow>(db, `select id, status, invoice_id, invoice_number, gl_entry_id, error, error_code, ack_meta, processed_at from core.events where id = $1`, [id]);
}

/** Net GL balance (debits − credits, POSTED) of one account. */
export async function balance(db: PGlite, accountId: string): Promise<number> {
  const r = await one<{ n: string | null }>(db,
    `select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint as n
       from public.gl_entry_lines l join public.gl_entries e on e.id = l.gl_entry_id
      where l.account_id = $1 and e.status = 'POSTED'`, [accountId]);
  return Number(r.n ?? 0);
}

export async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  return Number((await one<{ n: string }>(db, sql, params)).n);
}

/** Run as a signed-in Projects user (pm.current_user_id / get_org_id read the claims). */
export async function asUser<T>(db: PGlite, org: string, sub: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, org_id: org })]);
  try {
    return await fn();
  } finally {
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}
