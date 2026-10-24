/**
 * Report-engine test fixture (Wave 3A). Seeds a tenant with a small but complete chart of
 * accounts (every account type, the intercompany roles, an eliminating interdept pair, a
 * depreciation pair), N companies, fiscal periods, departments / classes, and posts
 * balanced entries the way the app does (header POSTED, then ALL lines in one statement).
 *
 * Used by period-balances.test.ts (the 185 store), report-engine-db.test.ts (adapter +
 * statements end-to-end) and report-engine-perf.test.ts.
 */
import type { PGlite } from '@electric-sql/pglite';

export type AcctKey =
  | 'cash' | 'ar' | 'icAr' | 'fixed' | 'accDep'
  | 'ap' | 'icAp' | 'loan'
  | 'capital' | 're' | 'draw'
  | 'revenue' | 'interdeptRev'
  | 'cogs' | 'interdeptCost'
  | 'rent' | 'wages' | 'depExp' | 'interest'
  | 'otherInc';

interface AcctDef {
  key: AcctKey; num: string; name: string; type: string; sub: string; group: string;
  bank?: boolean; elim?: boolean; role?: string;
}

export const ACCOUNTS: readonly AcctDef[] = [
  { key: 'cash', num: '1000', name: 'Operating Bank', type: 'ASSET', sub: 'CURRENT_ASSET', group: 'Cash', bank: true, role: 'OPERATING_BANK' },
  { key: 'ar', num: '1100', name: 'Accounts Receivable', type: 'ASSET', sub: 'CURRENT_ASSET', group: 'Receivables', role: 'AR_CONTROL' },
  { key: 'icAr', num: '1160', name: 'Intercompany Receivable', type: 'ASSET', sub: 'CURRENT_ASSET', group: 'Receivables', role: 'INTERCOMPANY_AR' },
  { key: 'fixed', num: '1500', name: 'Equipment', type: 'ASSET', sub: 'FIXED_ASSET', group: 'Fixed Assets' },
  { key: 'accDep', num: '1510', name: 'Accumulated Depreciation', type: 'ASSET', sub: 'FIXED_ASSET', group: 'Fixed Assets' },
  { key: 'ap', num: '2000', name: 'Accounts Payable', type: 'LIABILITY', sub: 'CURRENT_LIABILITY', group: 'Payables', role: 'AP_CONTROL' },
  { key: 'icAp', num: '2020', name: 'Intercompany Payable', type: 'LIABILITY', sub: 'CURRENT_LIABILITY', group: 'Payables', role: 'INTERCOMPANY_AP' },
  { key: 'loan', num: '2700', name: 'Term Loan', type: 'LIABILITY', sub: 'LONG_TERM_LIABILITY', group: 'Long-term Debt', role: 'NOTES_PAYABLE' },
  { key: 'capital', num: '3000', name: "Owner's Capital", type: 'EQUITY', sub: 'EQUITY', group: 'Equity', role: 'OWNERS_CAPITAL' },
  { key: 're', num: '3020', name: 'Retained Earnings', type: 'EQUITY', sub: 'EQUITY', group: 'Equity', role: 'RETAINED_EARNINGS' },
  { key: 'draw', num: '3010', name: "Owner's Draw", type: 'EQUITY', sub: 'EQUITY', group: 'Equity', role: 'OWNERS_DRAW' },
  { key: 'revenue', num: '4000', name: 'Service Revenue', type: 'REVENUE', sub: 'REVENUE', group: 'Revenue' },
  { key: 'interdeptRev', num: '4900', name: 'Interdepartment Services Revenue', type: 'REVENUE', sub: 'REVENUE', group: 'Revenue', elim: true },
  { key: 'cogs', num: '5000', name: 'Materials', type: 'COGS', sub: 'COST_OF_GOODS_SOLD', group: 'Cost of Sales' },
  { key: 'interdeptCost', num: '5900', name: 'Interdepartment Services Cost', type: 'COGS', sub: 'COST_OF_GOODS_SOLD', group: 'Cost of Sales', elim: true },
  { key: 'rent', num: '6100', name: 'Rent', type: 'OPEX', sub: 'OPERATING_EXPENSE', group: 'Occupancy' },
  { key: 'wages', num: '6200', name: 'Wages', type: 'OPEX', sub: 'OPERATING_EXPENSE', group: 'Payroll', role: 'WAGES_EXPENSE' },
  { key: 'depExp', num: '6800', name: 'Depreciation Expense', type: 'OPEX', sub: 'OPERATING_EXPENSE', group: 'Depreciation' },
  { key: 'interest', num: '7100', name: 'Interest Expense', type: 'OTHER', sub: 'OTHER_EXPENSE', group: 'Other Expense', role: 'INTEREST_EXPENSE' },
  { key: 'otherInc', num: '7000', name: 'Interest Income', type: 'OTHER', sub: 'OTHER_INCOME', group: 'Other Income' },
];

const TYPE_DEFS: ReadonlyArray<[string, string, number, 'DEBIT' | 'CREDIT']> = [
  ['ASSET', 'Asset', 1, 'DEBIT'],
  ['LIABILITY', 'Liability', 2, 'CREDIT'],
  ['EQUITY', 'Equity', 3, 'CREDIT'],
  ['REVENUE', 'Revenue', 4, 'CREDIT'],
  ['COGS', 'Cost of Goods Sold', 5, 'DEBIT'],
  ['OPEX', 'Operating Expense', 6, 'DEBIT'],
  ['OTHER', 'Other', 7, 'DEBIT'],
];
const SUB_DEFS: ReadonlyArray<[string, string, string, number]> = [
  ['CURRENT_ASSET', 'ASSET', 'Current Assets', 1],
  ['FIXED_ASSET', 'ASSET', 'Fixed Assets', 2],
  ['CURRENT_LIABILITY', 'LIABILITY', 'Current Liabilities', 3],
  ['LONG_TERM_LIABILITY', 'LIABILITY', 'Long-term Liabilities', 4],
  ['EQUITY', 'EQUITY', 'Equity', 5],
  ['REVENUE', 'REVENUE', 'Revenue', 6],
  ['COST_OF_GOODS_SOLD', 'COGS', 'Cost of Goods Sold', 7],
  ['OPERATING_EXPENSE', 'OPEX', 'Operating Expenses', 8],
  ['OTHER_INCOME', 'OTHER', 'Other Income', 9],
  ['OTHER_EXPENSE', 'OTHER', 'Other Expense', 10],
];

export interface ReportTenant {
  org: string;
  companies: string[];
  acct: Record<AcctKey, string>;
  depts: string[];
  classes: string[];
}

let entrySeq = 0;

function uuidFrom(seed: string): string {
  // deterministic-enough unique uuid per seed for readable fixtures
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hex = (h.toString(16) + '00000000').slice(0, 8);
  return `${hex}-${crypto.randomUUID().slice(9)}`;
}

/** Seed one tenant. `months` = ISO 'YYYY-MM' list to create fiscal periods for, per company. */
export async function seedReportTenant(
  db: PGlite,
  opts: { slug: string; companies: number; months: string[]; fyStartMonth?: number; hardClose?: string[] },
): Promise<ReportTenant> {
  const org = uuidFrom(`org-${opts.slug}`);
  await db.query(
    `insert into core.organizations (id, name, slug, fiscal_year_start_month) values ($1, $2, $3, $4)`,
    [org, `Org ${opts.slug}`, opts.slug, opts.fyStartMonth ?? 1],
  );
  const companies: string[] = [];
  for (let i = 0; i < opts.companies; i++) {
    const id = crypto.randomUUID();
    await db.query(
      `insert into core.locations (id, org_id, name, short_code, fiscal_year_start_month) values ($1, $2, $3, $4, $5)`,
      [id, org, `Company ${String.fromCharCode(65 + i)}`, `C${i}`, opts.fyStartMonth ?? 1],
    );
    companies.push(id);
  }
  const typeIds = new Map<string, string>();
  for (const [code, name, order, nb] of TYPE_DEFS) {
    const r = await db.query<{ id: string }>(
      `insert into public.account_types (org_id, name, code, display_order, normal_balance) values ($1, $2, $3::account_type_enum, $4, $5) returning id`,
      [org, name, code, order, nb],
    );
    typeIds.set(code, r.rows[0].id);
  }
  const subIds = new Map<string, string>();
  for (const [code, type, name, order] of SUB_DEFS) {
    const r = await db.query<{ id: string }>(
      `insert into public.account_sub_types (org_id, account_type_id, name, code, display_order) values ($1, $2, $3, $4::account_sub_type_enum, $5) returning id`,
      [org, typeIds.get(type), name, code, order],
    );
    subIds.set(code, r.rows[0].id);
  }
  const groupIds = new Map<string, string>();
  let gOrder = 0;
  for (const a of ACCOUNTS) {
    if (groupIds.has(a.group)) continue;
    const r = await db.query<{ id: string }>(
      `insert into public.account_groups (org_id, account_sub_type_id, name, display_order) values ($1, $2, $3, $4) returning id`,
      [org, subIds.get(a.sub), a.group, ++gOrder],
    );
    groupIds.set(a.group, r.rows[0].id);
  }
  const acct = {} as Record<AcctKey, string>;
  let aOrder = 0;
  for (const a of ACCOUNTS) {
    const r = await db.query<{ id: string }>(
      `insert into public.accounts (org_id, account_group_id, account_number, name, account_type, account_sub_type,
                                    approval_status, is_bank_account, is_eliminating, display_order, require_location)
       values ($1, $2, $3, $4, $5::account_type_enum, $6::account_sub_type_enum, 'APPROVED', $7, $8, $9, false) returning id`,
      [org, groupIds.get(a.group), a.num, a.name, a.type, a.sub, !!a.bank, !!a.elim, ++aOrder],
    );
    acct[a.key] = r.rows[0].id;
    if (a.role) {
      await db.query(
        `insert into public.account_roles (org_id, role_key, account_id, location_id) values ($1, $2, $3, null)
         on conflict do nothing`,
        [org, a.role, r.rows[0].id],
      );
    }
  }
  const depts: string[] = [];
  for (const [code, name] of [['OPS', 'Operations'], ['SALES', 'Sales']]) {
    const r = await db.query<{ id: string }>(
      `insert into core.departments (org_id, name, code) values ($1, $2, $3) returning id`, [org, name, code]);
    depts.push(r.rows[0].id);
  }
  const classes: string[] = [];
  for (const [code, name] of [['RES', 'Residential'], ['COM', 'Commercial']]) {
    const r = await db.query<{ id: string }>(
      `insert into public.classes (org_id, name, code) values ($1, $2, $3) returning id`, [org, name, code]);
    classes.push(r.rows[0].id);
  }
  const hard = new Set(opts.hardClose ?? []);
  for (const loc of companies) {
    for (const ym of opts.months) {
      const [y, m] = ym.split('-').map(Number);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      await db.query(
        `insert into public.fiscal_periods (org_id, location_id, period_year, period_month, start_date, end_date, status)
         values ($1, $2, $3, $4, $5, $6, $7::period_status_enum)`,
        [org, loc, y, m, `${ym}-01`, end, hard.has(ym) ? 'HARD_CLOSE' : 'OPEN'],
      );
    }
  }
  return { org, companies, acct, depts, classes };
}

export interface FixtureLine {
  account: string;
  debit?: number;
  credit?: number;
  /** Line company (defaults to the entry's company). */
  location?: string;
  department?: string | null;
  classId?: string | null;
  counterparty?: string | null;
}

/** Post a balanced entry the way the app does. Returns the entry id. */
export async function postEntry(
  db: PGlite,
  t: ReportTenant,
  e: { location: string; date: string; lines: FixtureLine[]; entryType?: string; status?: string; memo?: string },
): Promise<string> {
  entrySeq++;
  const ym = e.date.slice(0, 7);
  const fp = await db.query<{ id: string }>(
    `select id from public.fiscal_periods where org_id = $1 and location_id = $2 and start_date = $3`,
    [t.org, e.location, `${ym}-01`],
  );
  if (!fp.rows[0]) throw new Error(`no fiscal period ${ym} for ${e.location}`);
  const h = await db.query<{ id: string }>(
    `insert into public.gl_entries (org_id, location_id, entry_number, entry_date, entry_type, fiscal_period_id,
                                    source_module, status, posted_at, memo)
     values ($1, $2, $3, $4, $5::entry_type_enum, $6, 'MANUAL', $7::transaction_status_enum, now(), $8) returning id`,
    [t.org, e.location, `JE-${entrySeq}-${crypto.randomUUID().slice(0, 6)}`, e.date, e.entryType ?? 'STANDARD',
     fp.rows[0].id, e.status ?? 'POSTED', e.memo ?? null],
  );
  const id = h.rows[0].id;
  const vals: string[] = [];
  const params: unknown[] = [];
  e.lines.forEach((l, i) => {
    const b = params.length;
    params.push(t.org, id, i + 1, l.account, l.debit ?? 0, l.credit ?? 0, l.location ?? e.location,
      l.department ?? null, l.classId ?? null, l.counterparty ?? null);
    vals.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`);
  });
  await db.query(
    `insert into public.gl_entry_lines (org_id, gl_entry_id, line_number, account_id, debit_cents, credit_cents,
                                        location_id, department_id, class_id, counterparty_location_id)
     values ${vals.join(', ')}`,
    params,
  );
  return id;
}

/** Run as a PostgREST member of `org` (SET ROLE authenticated + JWT claims). */
export async function asMember<T>(db: PGlite, org: string, sub: string, fn: () => Promise<T>): Promise<T> {
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub, org_id: org, role: 'authenticated' })]);
  await db.exec('set role authenticated');
  try {
    return await fn();
  } finally {
    await db.exec('reset role');
    await db.query(`select set_config('request.jwt.claims', '{}', false)`);
  }
}

/** Months 'YYYY-MM' from start (inclusive) for n months. */
export function monthRange(startYm: string, n: number): string[] {
  const [y, m] = startYm.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

/**
 * A SERVICE-ROLE client for the engine's governed RPCs (report_balances / report_drill_lines /
 * period_balances_tieout — EXECUTE is revoked from `authenticated`, mig 185/186). Each call
 * runs in its own transaction as `service_role` (BYPASSRLS, like hosted Supabase) with
 * service-role JWT claims, then the session returns to whatever role it was in (e.g. the
 * member `asMember` set) — so RLS reads of the same request still run as the member.
 * Only `.rpc` is supported: the engine must never read tables through the service role.
 */
export function serviceClient(db: PGlite): import('@supabase/supabase-js').SupabaseClient {
  const call = async (schema: string, fn: string, args: Record<string, unknown> = {}) =>
    db.transaction(async (tx) => {
      await tx.exec('set local role postgres');
      await tx.exec('alter role service_role bypassrls');
      await tx.exec('set local role service_role');
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })]);
      const { pgSupabase } = await import('./pg-supabase');
      return (pgSupabase(tx as unknown as PGlite).schema(schema) as unknown as {
        rpc: (f: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;
      }).rpc(fn, args);
    });
  const refuse = () => {
    throw new Error('serviceClient: only .rpc is allowed on the engine service client');
  };
  const scoped = (schema: string) => ({
    schema: (s: string) => scoped(s),
    from: refuse,
    rpc: (fn: string, args?: Record<string, unknown>) => call(schema, fn, args),
  });
  return scoped('public') as unknown as import('@supabase/supabase-js').SupabaseClient;
}
