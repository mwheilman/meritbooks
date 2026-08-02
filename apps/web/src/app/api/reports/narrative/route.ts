export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runAiGateway } from '@meritbooks/core-ai';
import { formatMoney } from '@meritbooks/shared';
import { apiHandler, type ApiContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import {
  computeVariances,
  type VarianceLine,
  type VarianceDriver,
  type VarianceResult,
} from '@/lib/reports/variance';
import {
  computeCashFlowSnapshot,
  computeCashFlowVariance,
  computeBudgetVariance,
  type CashFlowAcctMeta,
  type CashFlowInputLine,
  type CashFlowRoleSets,
  type BudgetInputRow,
} from '@/lib/reports/variance-cash';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';

/**
 * POST /api/reports/narrative — AI flux / variance auto-narrative (M7).
 *
 * The "why did this move" layer for financial reports. Read-only. The pipeline:
 *   1. DETERMINISTICALLY aggregate each period's report line items from the GL
 *      (RLS-scoped, org-isolated) and compute the ranked variances IN CODE
 *      (lib/reports/variance.ts) — the model never sees the ledger.
 *   2. Hand ONLY those computed driver facts to the Core AI gateway, which is
 *      told, in the strongest terms, to phrase (not recompute) them.
 *   3. Return { narrative, drivers, citations } — where `drivers` and every
 *      figure come from OUR computation; the model authors only the prose.
 *
 * If the gateway is unavailable or budget-blocked, a deterministic template
 * narrative is returned so the panel always renders something truthful.
 */

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const periodSchema = z.object({
  start_date: DATE.optional(),
  end_date: DATE.optional(),
  as_of_date: DATE.optional(),
  label: z.string().max(120).optional(),
});

const schema = z.object({
  report: z.enum(['pnl', 'balance_sheet', 'cash_flow', 'budget_vs_actual']),
  periodA: periodSchema, // current period
  periodB: periodSchema, // comparison period (prior period / prior year / budget window)
  // Budget-vs-actual scope (only used when report === 'budget_vs_actual').
  fiscal_year: z.number().int().min(2000).max(2100).optional(),
  period_number: z.number().int().min(0).max(12).optional(),
  dimensions: z
    .object({
      location_ids: z.string().max(2000).optional(),
      department_id: z.string().uuid().optional(),
      class_id: z.string().uuid().optional(),
      basis: z.enum(['accrual', 'cash']).optional(),
    })
    .optional(),
});

type Body = z.infer<typeof schema>;
type Dimensions = NonNullable<Body['dimensions']>;

export const NARRATIVE_MODEL = 'claude-sonnet-4-20250514';
export const NARRATIVE_FEATURE = 'FLUX_NARRATIVE';

// ── Nested join shape (mirrors income-statement / balance-sheet routes) ──────
interface JoinedLine {
  account_id: string;
  debit_cents: number | null;
  credit_cents: number | null;
  accounts: {
    account_number: string;
    name: string;
    account_type: string;
    account_groups: {
      account_sub_types: {
        account_types: { normal_balance: string };
      };
    };
  };
}

function resolveLocationIds(dims?: Dimensions): string[] {
  if (!dims?.location_ids) return [];
  return dims.location_ids.split(',').map((s) => s.trim()).filter(Boolean);
}

const SELECT = `
  account_id,
  debit_cents,
  credit_cents,
  accounts!inner(
    account_number,
    name,
    account_type,
    account_groups!inner(
      account_sub_types!inner(
        account_types!inner(
          normal_balance
        )
      )
    )
  ),
  gl_entries!inner(
    entry_date,
    status
  )
`;

/** Aggregate signed per-account amounts into VarianceLine[], the same way the
 *  on-screen statement does (amount derived from the account's normal balance). */
function aggregate(rows: JoinedLine[]): VarianceLine[] {
  const map = new Map<string, { label: string; section: string; normal: string; debits: number; credits: number }>();
  for (const line of rows) {
    const acct = line.accounts;
    const normal = acct.account_groups.account_sub_types.account_types.normal_balance;
    const key = acct.account_number;
    const existing = map.get(key);
    if (existing) {
      existing.debits += Number(line.debit_cents ?? 0);
      existing.credits += Number(line.credit_cents ?? 0);
    } else {
      map.set(key, {
        label: acct.name,
        section: acct.account_type,
        normal,
        debits: Number(line.debit_cents ?? 0),
        credits: Number(line.credit_cents ?? 0),
      });
    }
  }
  const lines: VarianceLine[] = [];
  for (const [key, v] of map) {
    const amountCents = v.normal === 'CREDIT' ? v.credits - v.debits : v.debits - v.credits;
    lines.push({ key, label: v.label, section: v.section, amountCents });
  }
  return lines;
}

/** P&L line items for a date range (REVENUE/COGS/OPEX/OTHER). */
async function fetchPnlLines(
  supabase: SupabaseClient,
  startDate: string,
  endDate: string,
  dims?: Dimensions,
): Promise<VarianceLine[]> {
  const locationIds = resolveLocationIds(dims);
  let query = supabase
    .from('gl_entry_lines')
    .select(SELECT)
    .eq('gl_entries.status', 'POSTED')
    .gte('gl_entries.entry_date', startDate)
    .lte('gl_entries.entry_date', endDate)
    .in('accounts.account_type', ['REVENUE', 'COGS', 'OPEX', 'OTHER']);

  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);
  if (dims?.department_id) query = query.eq('department_id', dims.department_id);
  if (dims?.class_id) query = query.eq('class_id', dims.class_id);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return aggregate((data ?? []) as unknown as JoinedLine[]);
}

/** Balance-sheet line items as of a date (ASSET/LIABILITY/EQUITY). */
async function fetchBsLines(
  supabase: SupabaseClient,
  asOfDate: string,
  dims?: Dimensions,
): Promise<VarianceLine[]> {
  const locationIds = resolveLocationIds(dims);
  let query = supabase
    .from('gl_entry_lines')
    .select(SELECT)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', asOfDate)
    .in('accounts.account_type', ['ASSET', 'LIABILITY', 'EQUITY']);

  if (locationIds.length === 1) query = query.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) query = query.in('location_id', locationIds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return aggregate((data ?? []) as unknown as JoinedLine[]);
}

// ── Cash-flow snapshot fetch (raw GL → deterministic classifier) ─────────────

/** Resolve a set of role keys to their account ids (RLS-scoped), tolerating
 *  unseeded roles. Mirrors the cash-flow report route — families are identified
 *  BY ROLE, never by a hard-coded account-number range. */
async function resolveRoleIds(
  supabase: SupabaseClient,
  orgId: string,
  keys: AccountRoleKey[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const role of keys) {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      ids.add(ref.id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }
  return ids;
}

/** Build the indirect-method cash-flow snapshot for a period (RLS-scoped). */
async function fetchCashFlowSnapshot(
  supabase: SupabaseClient,
  orgId: string,
  startDate: string,
  endDate: string,
  dims?: Dimensions,
) {
  const locationIds = resolveLocationIds(dims);
  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', startDate)
    .lte('entry_date', endDate);
  if (locationIds.length === 1) entriesQ = entriesQ.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) entriesQ = entriesQ.in('location_id', locationIds);

  const { data: entryRows, error: entriesErr } = await entriesQ;
  if (entriesErr) throw new Error(entriesErr.message);
  const entryIds = (entryRows ?? []).map((e: { id: string }) => e.id);

  // Account metadata: classify BY TYPE / SUB-TYPE / ROLE, not by number.
  const { data: accts, error: acctErr } = await supabase
    .from('accounts')
    .select('id, account_type, account_sub_type, is_bank_account, name');
  if (acctErr) throw new Error(acctErr.message);
  const acctMeta = new Map<string, CashFlowAcctMeta>();
  for (const a of accts ?? []) {
    acctMeta.set(a.id as string, {
      type: (a.account_type as string) ?? '',
      subType: (a.account_sub_type as string) ?? '',
      isBank: Boolean(a.is_bank_account),
      name: (a.name as string) ?? '',
    });
  }

  const cashIds = new Set<string>();
  for (const [id, m] of acctMeta) if (m.isBank) cashIds.add(id);
  for (const id of await resolveRoleIds(supabase, orgId, ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'])) {
    cashIds.add(id);
  }
  const arIds = await resolveRoleIds(supabase, orgId, ['AR_CONTROL', 'UNBILLED_RECEIVABLE', 'RETAINAGE_RECEIVABLE', 'ALLOWANCE_DOUBTFUL']);
  const apIds = await resolveRoleIds(supabase, orgId, ['AP_CONTROL', 'RETAINAGE_PAYABLE', 'ACCRUED_EXPENSES']);
  const roles: CashFlowRoleSets = { cashIds, arIds, apIds };

  let lines: CashFlowInputLine[] = [];
  if (entryIds.length > 0) {
    let linesQ = supabase
      .from('gl_entry_lines')
      .select('account_id, debit_cents, credit_cents')
      .in('gl_entry_id', entryIds);
    if (dims?.department_id) linesQ = linesQ.eq('department_id', dims.department_id);
    if (dims?.class_id) linesQ = linesQ.eq('class_id', dims.class_id);
    const { data: lineRows, error: linesErr } = await linesQ;
    if (linesErr) throw new Error(linesErr.message);
    lines = (lineRows ?? []).map((l) => ({
      account_id: l.account_id as string,
      debit_cents: Number(l.debit_cents ?? 0),
      credit_cents: Number(l.credit_cents ?? 0),
    }));
  }

  return computeCashFlowSnapshot(lines, acctMeta, roles);
}

// ── Budget-vs-actual rows fetch (mirrors /api/budgets/vs-actual conventions) ──

async function fetchBudgetRows(
  supabase: SupabaseClient,
  fiscalYear: number,
  periodNumber: number,
  dims?: Dimensions,
): Promise<BudgetInputRow[]> {
  const locationIds = resolveLocationIds(dims);

  let budgetQ = supabase
    .from('budgets')
    .select('account_id, amount_cents, period_number, account:accounts!budgets_account_id_fkey(account_number, name, account_type)')
    .eq('fiscal_year', fiscalYear);
  if (locationIds.length === 1) budgetQ = budgetQ.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) budgetQ = budgetQ.in('location_id', locationIds);
  if (dims?.department_id) budgetQ = budgetQ.eq('department_id', dims.department_id);
  if (periodNumber > 0) budgetQ = budgetQ.eq('period_number', periodNumber);

  const { data: budgetData, error: budgetErr } = await budgetQ;
  if (budgetErr) throw new Error(budgetErr.message);

  interface BudgetAcct { account_number: string; name: string; account_type: string }
  const budgetMap = new Map<string, { accountNumber: string; accountName: string; accountType: string; budgetCents: number }>();
  for (const b of budgetData ?? []) {
    const raw = (b as { account: BudgetAcct | BudgetAcct[] | null }).account;
    const acct = Array.isArray(raw) ? raw[0] : raw;
    if (!acct) continue;
    const accountId = b.account_id as string;
    const existing = budgetMap.get(accountId);
    if (existing) existing.budgetCents += Number(b.amount_cents);
    else budgetMap.set(accountId, { accountNumber: acct.account_number, accountName: acct.name, accountType: acct.account_type, budgetCents: Number(b.amount_cents) });
  }

  // Actuals for the same window (derive month range when a period is selected).
  const pad = (n: number) => String(n).padStart(2, '0');
  let actualStart = `${fiscalYear}-01-01`;
  let actualEnd = `${fiscalYear}-12-31`;
  if (periodNumber >= 1 && periodNumber <= 12) {
    const lastDay = new Date(fiscalYear, periodNumber, 0).getDate();
    actualStart = `${fiscalYear}-${pad(periodNumber)}-01`;
    actualEnd = `${fiscalYear}-${pad(periodNumber)}-${pad(lastDay)}`;
  }

  let entriesQ = supabase
    .from('gl_entries')
    .select('id')
    .eq('status', 'POSTED')
    .gte('entry_date', actualStart)
    .lte('entry_date', actualEnd);
  if (locationIds.length === 1) entriesQ = entriesQ.eq('location_id', locationIds[0]);
  else if (locationIds.length > 1) entriesQ = entriesQ.in('location_id', locationIds);
  const { data: entries, error: entriesErr } = await entriesQ;
  if (entriesErr) throw new Error(entriesErr.message);
  const entryIds = (entries ?? []).map((e: { id: string }) => e.id);

  const actualMap = new Map<string, number>();
  if (entryIds.length > 0) {
    let linesQ = supabase.from('gl_entry_lines').select('account_id, debit_cents, credit_cents').in('gl_entry_id', entryIds);
    if (dims?.department_id) linesQ = linesQ.eq('department_id', dims.department_id);
    if (dims?.class_id) linesQ = linesQ.eq('class_id', dims.class_id);
    const { data: lineRows, error: linesErr } = await linesQ;
    if (linesErr) throw new Error(linesErr.message);
    for (const line of lineRows ?? []) {
      const id = line.account_id as string;
      actualMap.set(id, (actualMap.get(id) ?? 0) + Number(line.debit_cents ?? 0) - Number(line.credit_cents ?? 0));
    }
  }

  // Merge → sign-normalized P&L rows (revenue flipped positive), P&L only.
  const rows: BudgetInputRow[] = [];
  const allIds = new Set<string>([...budgetMap.keys(), ...actualMap.keys()]);
  for (const accountId of allIds) {
    const budget = budgetMap.get(accountId);
    let accountNumber = budget?.accountNumber ?? '';
    let accountName = budget?.accountName ?? '';
    let accountType = budget?.accountType ?? '';
    if (!budget) {
      const { data: acct } = await supabase.from('accounts').select('account_number, name, account_type').eq('id', accountId).single();
      if (acct) { accountNumber = acct.account_number as string; accountName = acct.name as string; accountType = acct.account_type as string; }
    }
    if (!['REVENUE', 'COGS', 'OPEX', 'OTHER'].includes(accountType)) continue;
    const actualNet = actualMap.get(accountId) ?? 0;
    const actualCents = accountType === 'REVENUE' ? -actualNet : actualNet;
    rows.push({ key: accountNumber || accountId, label: accountName, section: accountType, budgetCents: budget?.budgetCents ?? 0, actualCents });
  }
  return rows;
}

// ── Prompt + parsing ─────────────────────────────────────────────────────────

function money(cents: number): string {
  return formatMoney(cents);
}

function driverFactLine(d: VarianceDriver, i: number): string {
  const pct = d.pct == null ? 'new vs prior' : `${d.pct > 0 ? '+' : ''}${d.pct}%`;
  const fav = d.favorable == null ? '' : d.favorable ? ' [favorable]' : ' [unfavorable]';
  const arrow = d.direction === 'up' ? 'up' : d.direction === 'down' ? 'down' : 'flat';
  return `${i + 1}. ${d.section} · ${d.line}: ${money(d.priorCents)} -> ${money(d.currentCents)} (${arrow} ${d.deltaCents > 0 ? '+' : ''}${money(d.deltaCents)}, ${pct})${fav}`;
}

function buildFacts(
  reportLabel: string,
  labelA: string,
  labelB: string,
  v: VarianceResult,
): string {
  const netLine =
    v.netCurrentCents != null && v.netPriorCents != null
      ? `Net income: prior ${money(v.netPriorCents)} -> current ${money(v.netCurrentCents)} (change ${v.netDeltaCents! > 0 ? '+' : ''}${money(v.netDeltaCents!)}).`
      : '';
  const driverLines = v.drivers.map((d, i) => driverFactLine(d, i)).join('\n');
  return [
    `Report: ${reportLabel}`,
    `Current period (A): ${labelA}`,
    `Prior/comparison period (B): ${labelB}`,
    netLine,
    '',
    'Largest computed line-item variances (already calculated — use these figures verbatim, do not alter or add any number):',
    driverLines || '(no material variances)',
  ]
    .filter(Boolean)
    .join('\n');
}

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

/** Deterministic, no-speculation fallback narrative (used if AI is unavailable). */
function deterministicNarrative(v: VarianceResult): string {
  if (v.drivers.length === 0) return 'No material line-item variances between the two periods.';
  const parts: string[] = [];
  if (v.netCurrentCents != null && v.netDeltaCents != null && v.netDeltaCents !== 0) {
    parts.push(
      `Net income moved ${v.netDeltaCents > 0 ? 'up' : 'down'} ${money(Math.abs(v.netDeltaCents))} to ${money(v.netCurrentCents)}.`,
    );
  }
  const top = v.drivers.slice(0, 3).map((d) => {
    const pct = d.pct == null ? '' : ` (${d.pct > 0 ? '+' : ''}${d.pct}%)`;
    return `${d.line} ${d.direction === 'up' ? 'rose' : 'fell'} ${money(Math.abs(d.deltaCents))}${pct}`;
  });
  parts.push(`Largest movers: ${top.join('; ')}. The ledger does not explain the underlying cause of each move; drill into the accounts for detail.`);
  return parts.join(' ');
}

// ── Citations (deterministic drill anchors) ──────────────────────────────────

function buildCitations(body: Body, v: VarianceResult): { label: string; href: string }[] {
  const reportKey = body.report === 'pnl' ? 'pnl' : 'bs';
  const citations: { label: string; href: string }[] = [
    { label: `${body.report === 'pnl' ? 'Profit & Loss' : 'Balance Sheet'} — source statement`, href: `/reports?report=${reportKey}` },
  ];
  for (const d of v.drivers.slice(0, 3)) {
    citations.push({ label: `GL detail · ${d.line} (${d.key})`, href: `/reports?report=gl&account=${encodeURIComponent(d.key)}` });
  }
  return citations;
}

function periodLabel(report: Body['report'], p: Body['periodA']): string {
  if (p.label) return p.label;
  if (report === 'balance_sheet') return p.as_of_date ? `as of ${p.as_of_date}` : 'as of date';
  return p.start_date && p.end_date ? `${p.start_date} to ${p.end_date}` : 'selected period';
}

// ── Cash-flow facts / fallback / citations ────────────────────────────────────

function buildCashFacts(labelA: string, labelB: string, v: VarianceResult): string {
  const netLine =
    v.netCurrentCents != null && v.netPriorCents != null
      ? `Net change in cash: prior ${money(v.netPriorCents)} -> current ${money(v.netCurrentCents)} (change ${v.netDeltaCents! > 0 ? '+' : ''}${money(v.netDeltaCents!)}).`
      : '';
  const sectionLines = v.sectionTotals
    .map((s) => `${s.section}: prior ${money(s.priorCents)} -> current ${money(s.currentCents)} (${s.deltaCents > 0 ? '+' : ''}${money(s.deltaCents)})`)
    .join('\n');
  const driverLines = v.drivers.map((d, i) => driverFactLine(d, i)).join('\n');
  return [
    'Report: Statement of Cash Flows (indirect method) — sources/uses of cash vs prior',
    `Current period (A): ${labelA}`,
    `Prior/comparison period (B): ${labelB}`,
    netLine,
    '',
    'Section subtotals:',
    sectionLines,
    '',
    'Largest computed cash-flow line movements (already calculated — use these figures verbatim; [favorable] = contributed more cash this period):',
    driverLines || '(no material cash movements)',
  ]
    .filter(Boolean)
    .join('\n');
}

function deterministicCashNarrative(v: VarianceResult): string {
  if (v.drivers.length === 0) return 'No material change in cash flows between the two periods.';
  const parts: string[] = [];
  if (v.netCurrentCents != null && v.netDeltaCents != null) {
    parts.push(
      `Net change in cash was ${money(v.netCurrentCents)}, ${v.netDeltaCents === 0 ? 'flat vs' : v.netDeltaCents > 0 ? `up ${money(Math.abs(v.netDeltaCents))} from` : `down ${money(Math.abs(v.netDeltaCents))} from`} the prior period.`,
    );
  }
  const top = v.drivers.slice(0, 3).map((d) => {
    const dir = d.deltaCents > 0 ? 'contributed more cash' : 'contributed less cash';
    return `${d.line} ${dir} (${d.deltaCents > 0 ? '+' : ''}${money(d.deltaCents)})`;
  });
  parts.push(`Largest swings: ${top.join('; ')}. The ledger does not explain the underlying business cause; drill into the statement for detail.`);
  return parts.join(' ');
}

function buildCashCitations(): { label: string; href: string }[] {
  return [
    { label: 'Statement of Cash Flows — source statement', href: '/reports?report=cf' },
    { label: 'Profit & Loss — operating drivers', href: '/reports?report=pnl' },
  ];
}

// ── Budget-vs-actual facts / fallback / citations ─────────────────────────────

function budgetDriverFactLine(d: VarianceDriver, i: number): string {
  const pct = d.pct == null ? 'no budget' : `${d.pct > 0 ? '+' : ''}${d.pct}% vs budget`;
  const fav = d.favorable == null ? '' : d.favorable ? ' [favorable]' : ' [unfavorable]';
  const overUnder = d.deltaCents > 0 ? 'over' : 'under';
  return `${i + 1}. ${d.section} · ${d.line}: budget ${money(d.priorCents)} vs actual ${money(d.currentCents)} (${money(Math.abs(d.deltaCents))} ${overUnder} budget, ${pct})${fav}`;
}

function buildBudgetFacts(scopeLabel: string, v: VarianceResult): string {
  const netLine =
    v.netCurrentCents != null && v.netPriorCents != null
      ? `Net income: budget ${money(v.netPriorCents)} vs actual ${money(v.netCurrentCents)} (${v.netDeltaCents! >= 0 ? '+' : ''}${money(v.netDeltaCents!)} vs budget).`
      : '';
  const driverLines = v.drivers.map((d, i) => budgetDriverFactLine(d, i)).join('\n');
  return [
    'Report: Budget vs Actual (P&L) — largest variances vs budget',
    `Scope: ${scopeLabel}`,
    netLine,
    '',
    'Largest computed budget variances (already calculated — use these figures verbatim, do not alter or add any number):',
    driverLines || '(no material variances vs budget)',
  ]
    .filter(Boolean)
    .join('\n');
}

function deterministicBudgetNarrative(v: VarianceResult): string {
  if (v.drivers.length === 0) return 'Actuals match budget with no material variances for this scope.';
  const parts: string[] = [];
  if (v.netCurrentCents != null && v.netPriorCents != null && v.netDeltaCents != null) {
    const fav = v.netDeltaCents >= 0 ? 'ahead of' : 'behind';
    parts.push(`Net income of ${money(v.netCurrentCents)} is ${money(Math.abs(v.netDeltaCents))} ${fav} the budgeted ${money(v.netPriorCents)}.`);
  }
  const top = v.drivers.slice(0, 3).map((d) => {
    const overUnder = d.deltaCents > 0 ? 'over' : 'under';
    const tag = d.favorable ? 'favorable' : 'unfavorable';
    return `${d.line} is ${money(Math.abs(d.deltaCents))} ${overUnder} budget (${tag})`;
  });
  parts.push(`Largest variances: ${top.join('; ')}. Drill into each account for the drivers behind the variance.`);
  return parts.join(' ');
}

function buildBudgetCitations(v: VarianceResult): { label: string; href: string }[] {
  const citations: { label: string; href: string }[] = [
    { label: 'Budget vs Actual — source report', href: '/budgets' },
  ];
  for (const d of v.drivers.slice(0, 3)) {
    citations.push({ label: `GL detail · ${d.line} (${d.key})`, href: `/reports?report=gl&account=${encodeURIComponent(d.key)}` });
  }
  return citations;
}

// ── System prompts (one per report family) ────────────────────────────────────

const SYSTEM_FLUX =
  'You are a controller writing the flux/variance section of a board financial package. ' +
  'You are given variances that have ALREADY been computed from the general ledger. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures and percentages provided — never invent, recompute, round differently, or introduce any number that is not in the facts. ' +
  '(2) Do not speculate about business causes the data does not contain; if a driver has no explanation in the facts, describe the movement and note the cause is not determinable from the ledger. ' +
  '(3) Write 3-6 tight sentences, board-ready prose, leading with net income (if given) then the largest drivers. No markdown, no headings, no bullet list — just the paragraph.';

const SYSTEM_CASH =
  'You are a controller writing the cash-flow commentary of a board financial package. ' +
  'You are given cash-flow movements that have ALREADY been computed from the general ledger (indirect method). ' +
  'STRICT RULES: (1) Use ONLY the dollar figures provided — never invent, recompute, or introduce any number not in the facts. ' +
  '(2) Explain the biggest sources and uses of cash and how they shifted vs the prior period; a positive movement means the line contributed more cash. ' +
  '(3) Do not speculate about business causes the data does not contain. ' +
  '(4) Write 3-6 tight sentences, board-ready prose, leading with the net change in cash then the largest swings. No markdown, no headings, no bullets — just the paragraph.';

const SYSTEM_BUDGET =
  'You are a controller writing the budget-vs-actual commentary of a board financial package. ' +
  'You are given actual-vs-budget variances that have ALREADY been computed. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures and percentages provided — never invent, recompute, or introduce any number not in the facts. ' +
  '(2) Explain where the business is over/under budget, respecting favorability (revenue over budget and expense under budget are favorable). ' +
  '(3) Do not speculate about causes the data does not contain. ' +
  '(4) Write 3-6 tight sentences, board-ready prose, leading with net income vs budget then the largest variances. No markdown, no headings, no bullets — just the paragraph.';

// ── Handler ──────────────────────────────────────────────────────────────────

export const POST = apiHandler(schema, async (body: Body, ctx: ApiContext) => {
  // 1. Deterministically fetch + compute variances (RLS-scoped, org-isolated).
  //    Every figure below is computed IN CODE; the model only phrases them.
  let variance: VarianceResult;
  let reportLabel: string;
  let labelA: string;
  let labelB: string;
  let citations: { label: string; href: string }[];
  let facts: string;
  let system: string;
  let noMovementMessage: string;
  let fallbackNarrative: () => string;

  try {
    if (body.report === 'pnl') {
      if (!body.periodA.start_date || !body.periodA.end_date || !body.periodB.start_date || !body.periodB.end_date) {
        return NextResponse.json({ error: 'P&L narrative requires start_date and end_date for both periods.', code: 'MISSING_DATES' }, { status: 422 });
      }
      const currentLines = await fetchPnlLines(ctx.supabase, body.periodA.start_date, body.periodA.end_date, body.dimensions);
      const priorLines = await fetchPnlLines(ctx.supabase, body.periodB.start_date, body.periodB.end_date, body.dimensions);
      variance = computeVariances(currentLines, priorLines, { mode: 'pnl' });
      reportLabel = 'Profit & Loss (flux vs prior)';
      labelA = periodLabel(body.report, body.periodA);
      labelB = periodLabel(body.report, body.periodB);
      citations = buildCitations(body, variance);
      facts = buildFacts(reportLabel, labelA, labelB, variance);
      system = SYSTEM_FLUX;
      noMovementMessage = 'No material line-item variances between the two periods.';
      fallbackNarrative = () => deterministicNarrative(variance);
    } else if (body.report === 'balance_sheet') {
      if (!body.periodA.as_of_date || !body.periodB.as_of_date) {
        return NextResponse.json({ error: 'Balance-sheet narrative requires as_of_date for both periods.', code: 'MISSING_DATES' }, { status: 422 });
      }
      const currentLines = await fetchBsLines(ctx.supabase, body.periodA.as_of_date, body.dimensions);
      const priorLines = await fetchBsLines(ctx.supabase, body.periodB.as_of_date, body.dimensions);
      variance = computeVariances(currentLines, priorLines, { mode: 'neutral' });
      reportLabel = 'Balance Sheet (movement vs prior)';
      labelA = periodLabel(body.report, body.periodA);
      labelB = periodLabel(body.report, body.periodB);
      citations = buildCitations(body, variance);
      facts = buildFacts(reportLabel, labelA, labelB, variance);
      system = SYSTEM_FLUX;
      noMovementMessage = 'No material line-item variances between the two periods.';
      fallbackNarrative = () => deterministicNarrative(variance);
    } else if (body.report === 'cash_flow') {
      if (!body.periodA.start_date || !body.periodA.end_date || !body.periodB.start_date || !body.periodB.end_date) {
        return NextResponse.json({ error: 'Cash-flow narrative requires start_date and end_date for both periods.', code: 'MISSING_DATES' }, { status: 422 });
      }
      const orgId = ctx.orgId ?? '';
      const current = await fetchCashFlowSnapshot(ctx.supabase, orgId, body.periodA.start_date, body.periodA.end_date, body.dimensions);
      const prior = await fetchCashFlowSnapshot(ctx.supabase, orgId, body.periodB.start_date, body.periodB.end_date, body.dimensions);
      variance = computeCashFlowVariance(current, prior);
      reportLabel = 'Statement of Cash Flows (sources/uses vs prior)';
      labelA = periodLabel(body.report, body.periodA);
      labelB = periodLabel(body.report, body.periodB);
      citations = buildCashCitations();
      facts = buildCashFacts(labelA, labelB, variance);
      system = SYSTEM_CASH;
      noMovementMessage = 'No material change in cash flows between the two periods.';
      fallbackNarrative = () => deterministicCashNarrative(variance);
    } else {
      // budget_vs_actual
      const fiscalYear =
        body.fiscal_year ??
        (body.periodA.start_date ? Number(body.periodA.start_date.slice(0, 4)) : new Date().getUTCFullYear());
      const periodNumber = body.period_number ?? 0;
      const rows = await fetchBudgetRows(ctx.supabase, fiscalYear, periodNumber, body.dimensions);
      variance = computeBudgetVariance(rows);
      const scopeLabel = periodNumber >= 1 && periodNumber <= 12 ? `FY ${fiscalYear}, period ${periodNumber}` : `FY ${fiscalYear} (full year)`;
      reportLabel = 'Budget vs Actual (P&L)';
      labelA = scopeLabel;
      labelB = 'budget';
      citations = buildBudgetCitations(variance);
      facts = buildBudgetFacts(scopeLabel, variance);
      system = SYSTEM_BUDGET;
      noMovementMessage = 'Actuals match budget with no material variances for this scope.';
      fallbackNarrative = () => deterministicBudgetNarrative(variance);
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to load report data', code: 'REPORT_QUERY_ERROR' }, { status: 500 });
  }

  // The response `drivers` ALWAYS come from our computation, never the model.
  const responseDrivers = variance.drivers.map((d) => ({
    line: d.line,
    key: d.key,
    section: d.section,
    currentCents: d.currentCents,
    priorCents: d.priorCents,
    deltaCents: d.deltaCents,
    pct: d.pct,
    direction: d.direction,
    favorable: d.favorable,
  }));

  // No movement → truthful, no model call.
  if (variance.drivers.length === 0) {
    return NextResponse.json({
      narrative: noMovementMessage,
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under' },
    });
  }

  // 2. Ask the gateway to PHRASE the computed facts. Fall back deterministically.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({
      narrative: fallbackNarrative(),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: 'AI provider key not configured' },
    });
  }

  const prompt = `FACTS (already computed — phrase these, do not alter):\n\n${facts}\n\nWrite the narrative now.`;

  const admin = createAdminSupabase();
  let gw;
  try {
    gw = await runAiGateway(
      { supabase: admin, anthropicApiKey: apiKey },
      {
        tenant_id: ctx.orgId ?? '',
        user_id: ctx.userId,
        module: 'BOOKS',
        feature: NARRATIVE_FEATURE,
        model: NARRATIVE_MODEL,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        max_tokens: 500,
      },
    );
  } catch (e) {
    return NextResponse.json({
      narrative: fallbackNarrative(),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: null, decisionId: null, budgetState: 'under', message: e instanceof Error ? e.message : 'Gateway error' },
    });
  }

  if (gw.status === 'blocked' || gw.result == null) {
    return NextResponse.json({
      narrative: fallbackNarrative(),
      drivers: responseDrivers,
      citations,
      meta: { report: body.report, source: 'deterministic', model: gw.model_used, decisionId: null, budgetState: gw.budget.state, message: gw.message ?? 'AI request blocked' },
    });
  }

  const text = extractText(gw.result);
  const narrative = (text ?? '').trim() || fallbackNarrative();

  // 3. Audit the AI proposal to the existing decision-log rail (org-scoped, RLS).
  let decisionId: string | null = null;
  try {
    const { data } = await ctx.supabase
      .from('ai_decisions')
      .insert({
        org_id: ctx.orgId,
        feature: NARRATIVE_FEATURE,
        model_requested: NARRATIVE_MODEL,
        model_used: gw.model_used,
        correlation_id: gw.correlation_id,
        input_summary: `Flux narrative — ${reportLabel}: ${labelA} vs ${labelB}`.slice(0, 2000),
        proposed_output: { narrative, drivers: responseDrivers, citations },
        reasoning: 'AI phrasing of deterministically-computed variances; figures authored in code, not by the model.',
        status: 'PROPOSED',
        tokens_input: gw.tokens.input,
        tokens_output: gw.tokens.output,
        cost_cents: gw.cost_cents,
        created_by_user: ctx.userId,
      })
      .select('id')
      .single();
    decisionId = (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[reports-narrative] decision log failed (non-fatal):', e);
  }

  return NextResponse.json({
    narrative,
    drivers: responseDrivers,
    citations,
    meta: {
      report: body.report,
      source: 'ai',
      model: gw.model_used,
      decisionId,
      budgetState: gw.budget.state,
      costCents: gw.cost_cents,
      message: gw.message,
    },
  });
});
