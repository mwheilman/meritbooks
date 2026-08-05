/**
 * NL Report Compiler — the DETERMINISTIC runner.
 *
 * Given a validated, already-expanded ResolvedPack (concrete dates chosen by
 * spec.ts, never by the model), this produces one rendered section per
 * (report × period) by calling the SAME RLS-scoped engines the on-screen reports
 * use, so every figure ties out to the app:
 *   - Income statement / balance sheet / cash flow → the board-package query
 *     helpers (which reproduce the report-route aggregations) + the shared
 *     StatementModel builders (build-model.ts).
 *   - Trial balance, sales-by-customer, A/R & A/P aging → deterministic helpers
 *     below, all RLS-scoped and read-only.
 *
 * Money is bigint cents throughout. No AI, no writes, no SQL from a model.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { fetchCoreMap } from '@/lib/stitch-core';
import {
  fetchIncomeStatement,
  fetchBalanceSheet,
  fetchCashFlow,
  fetchArAging,
  fetchApAging,
} from '@/app/api/reports/board-package/queries';
import {
  buildIncomeStatement,
  buildBalanceSheet,
  buildCashFlow,
  buildTrialBalance,
  type ExportMeta,
} from '@/lib/reports/export/build-model';
import type { StatementModel, StmtRow } from '@/lib/reports/export/statement-model';
import { REPORT_CATALOG, type ReportType, type ResolvedPack, type ResolvedPeriod, type ResolvedSpec } from './spec';

const ACCENT = '#10b981';

export interface CompiledSection {
  report: ReportType;
  reportTitle: string;
  basisLabel: string;
  periodLabel: string;
  /** Non-null when the requested cash basis was substituted with accrual. */
  warning: string | null;
  model: StatementModel;
}

export interface CompiledPack {
  meta: { entityLabel: string; generatedAt: string; sectionCount: number };
  cover: {
    title: string;
    entityLabel: string;
    generatedAt: string;
    contents: { report: string; basisLabel: string; periodLabel: string }[];
  };
  sections: CompiledSection[];
}

function basisLabelFor(report: ReportType, requested: 'ACCRUAL' | 'CASH', effectiveCash: boolean): string {
  const e = REPORT_CATALOG[report];
  if (!e.supportsBasis && e.cashBasis === 'NA') return ''; // basis not meaningful
  if (requested === 'CASH' && effectiveCash) return 'Cash basis';
  if (requested === 'CASH' && !effectiveCash) return 'Accrual basis (cash requested)';
  return 'Accrual basis';
}

function exportMeta(entityLabel: string, reportLabel: string, periodLabel: string, basisLabel: string): ExportMeta {
  return { reportLabel, entityLabel, periodLabel, basisLabel: basisLabel || undefined, accent: ACCENT };
}

/** Patch a built StatementModel with the pack's entity + our nicer period/basis labels. */
function finalize(model: StatementModel, entityLabel: string, periodLabel: string, basisLabel: string): StatementModel {
  model.entityLabel = entityLabel;
  model.periodLabel = periodLabel;
  model.basisLabel = basisLabel || undefined;
  model.accent = ACCENT;
  return model;
}

// ── Trial balance (as-of, cumulative through endDate) ─────────────────────────
interface TBRow { account_number: string; account_name: string; total_debits: number; total_credits: number; net_balance: number }

async function fetchTrialBalanceModel(
  supabase: SupabaseClient,
  scope: { asOfDate: string; locationIds: string[] },
): Promise<{ data: TBRow[] }> {
  let query = supabase
    .from('gl_entry_lines')
    .select(`
      debit_cents, credit_cents, location_id,
      accounts!inner( account_number, name, display_order ),
      gl_entries!inner( entry_date, status )
    `)
    .eq('gl_entries.status', 'POSTED')
    .lte('gl_entries.entry_date', scope.asOfDate);
  if (scope.locationIds.length === 1) query = query.eq('location_id', scope.locationIds[0]);
  else if (scope.locationIds.length > 1) query = query.in('location_id', scope.locationIds);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const map = new Map<string, { name: string; order: number; debits: number; credits: number }>();
  for (const raw of (data ?? []) as unknown as Record<string, unknown>[]) {
    const acct = raw.accounts as Record<string, unknown>;
    const num = String(acct.account_number ?? '');
    const existing = map.get(num);
    const debit = Number(raw.debit_cents ?? 0);
    const credit = Number(raw.credit_cents ?? 0);
    if (existing) {
      existing.debits += debit;
      existing.credits += credit;
    } else {
      map.set(num, { name: String(acct.name ?? ''), order: Number(acct.display_order ?? 0), debits: debit, credits: credit });
    }
  }
  const rows: TBRow[] = [...map.entries()]
    .map(([account_number, v]) => ({
      account_number,
      account_name: v.name,
      total_debits: v.debits,
      total_credits: v.credits,
      net_balance: v.debits - v.credits,
      _order: v.order,
    }))
    .sort((a, b) => a._order - b._order || a.account_number.localeCompare(b.account_number))
    .map(({ _order, ...r }) => { void _order; return r; });
  return { data: rows };
}

// ── Sales by customer (invoiced sales per customer for a window) ───────────────
async function fetchSalesByCustomerModel(
  supabase: SupabaseClient,
  scope: { startDate: string; endDate: string; locationIds: string[] },
  meta: ExportMeta,
): Promise<StatementModel> {
  let invQ = supabase
    .from('invoices')
    .select('id, customer_id, location_id, status, invoice_date')
    .gte('invoice_date', scope.startDate)
    .lte('invoice_date', scope.endDate)
    .not('status', 'in', '("VOIDED","DRAFT")');
  if (scope.locationIds.length === 1) invQ = invQ.eq('location_id', scope.locationIds[0]);
  else if (scope.locationIds.length > 1) invQ = invQ.in('location_id', scope.locationIds);

  const { data: invoicesRaw, error: invErr } = await invQ;
  if (invErr) throw new Error(invErr.message);
  const invoices = (invoicesRaw ?? []) as Array<Record<string, unknown>>;

  const rows: StmtRow[] = [];
  const columns: StatementModel['columns'] = [
    { key: 'invoices', label: 'Invoices' },
    { key: 'sales', label: 'Sales', money: true },
  ];

  if (invoices.length === 0) {
    rows.push({ kind: 'note', label: 'No invoiced sales in this period.', values: [null, null] });
    return { title: 'Sales by Customer', entityLabel: meta.entityLabel, periodLabel: meta.periodLabel, generatedAt: new Date().toISOString(), accent: ACCENT, columns, rows };
  }

  const custMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase, 'customers', 'id, name', invoices.map((i) => i.customer_id as string));

  const invIds = invoices.map((i) => i.id as string);
  const invToCust = new Map<string, string>();
  for (const i of invoices) {
    const c = i.customer_id ? custMap.get(i.customer_id as string) ?? null : null;
    invToCust.set(i.id as string, (c as { name?: string } | null)?.name ?? 'Unknown customer');
  }

  const { data: lines, error: lineErr } = await supabase
    .from('invoice_lines')
    .select('invoice_id, amount_cents')
    .in('invoice_id', invIds);
  if (lineErr) throw new Error(lineErr.message);

  const perCustomer = new Map<string, { salesCents: number; invoiceSet: Set<string> }>();
  for (const line of (lines ?? []) as Array<Record<string, unknown>>) {
    const custName = invToCust.get(line.invoice_id as string);
    if (!custName) continue;
    const amt = Number(line.amount_cents ?? 0);
    const e = perCustomer.get(custName) ?? { salesCents: 0, invoiceSet: new Set<string>() };
    e.salesCents += amt;
    e.invoiceSet.add(line.invoice_id as string);
    perCustomer.set(custName, e);
  }

  const ranked = [...perCustomer.entries()]
    .map(([name, v]) => ({ name, salesCents: v.salesCents, invoiceCount: v.invoiceSet.size }))
    .sort((a, b) => b.salesCents - a.salesCents);

  let total = 0;
  for (const r of ranked) {
    total += r.salesCents;
    rows.push({ kind: 'account', label: r.name, values: [String(r.invoiceCount), r.salesCents] });
  }
  rows.push({ kind: 'total', label: 'Total Sales', values: ['', total] });

  return { title: 'Sales by Customer', entityLabel: meta.entityLabel, periodLabel: meta.periodLabel, generatedAt: new Date().toISOString(), accent: ACCENT, columns, rows };
}

// ── A/R & A/P aging (current snapshot) ────────────────────────────────────────
function buildAgingModel(
  buckets: Record<string, { count: number; totalCents: number }>,
  totalOutstanding: number,
  title: string,
  meta: ExportMeta,
): StatementModel {
  const order = ['CURRENT', '1-30', '31-60', '61-90', '90+'];
  const rows: StmtRow[] = order.map((b) => ({
    kind: 'account' as const,
    label: b === 'CURRENT' ? 'Current' : `${b} days`,
    values: [String(buckets[b]?.count ?? 0), buckets[b]?.totalCents ?? 0],
  }));
  rows.push({ kind: 'total', label: 'Total Outstanding', values: ['', totalOutstanding] });
  return {
    title,
    entityLabel: meta.entityLabel,
    periodLabel: meta.periodLabel,
    generatedAt: new Date().toISOString(),
    accent: ACCENT,
    columns: [
      { key: 'items', label: 'Open Items' },
      { key: 'amount', label: 'Amount', money: true },
    ],
    rows,
  };
}

// ── Section builders per report type ──────────────────────────────────────────
async function buildSection(
  supabase: SupabaseClient,
  orgId: string,
  entityLabel: string,
  spec: ResolvedSpec,
  period: ResolvedPeriod,
  locationIds: string[],
): Promise<CompiledSection> {
  const entry = REPORT_CATALOG[spec.report];
  const wantCash = spec.basis === 'CASH' && entry.cashBasis === 'FULL';
  const basisLabel = basisLabelFor(spec.report, spec.basis, wantCash);
  const meta = exportMeta(entityLabel, entry.title, period.label, basisLabel);
  const warning = spec.cashWarning ?? null;

  let model: StatementModel;
  switch (spec.report) {
    case 'INCOME_STATEMENT': {
      const payload = await fetchIncomeStatement(supabase, {
        startDate: period.startDate,
        endDate: period.endDate,
        locationIds,
        basis: wantCash ? 'cash' : 'accrual',
      });
      model = finalize(buildIncomeStatement(payload, meta), entityLabel, period.label, basisLabel);
      break;
    }
    case 'BALANCE_SHEET': {
      const payload = await fetchBalanceSheet(supabase, { asOfDate: period.asOfDate, locationIds });
      model = finalize(buildBalanceSheet(payload, meta), entityLabel, period.label, basisLabel);
      break;
    }
    case 'CASH_FLOW': {
      const payload = await fetchCashFlow(supabase, orgId, {
        startDate: period.startDate,
        endDate: period.endDate,
        locationIds,
      });
      model = finalize(buildCashFlow(payload, meta), entityLabel, period.label, basisLabel);
      break;
    }
    case 'TRIAL_BALANCE': {
      const payload = await fetchTrialBalanceModel(supabase, { asOfDate: period.asOfDate, locationIds });
      model = finalize(buildTrialBalance(payload, meta), entityLabel, period.label, basisLabel);
      break;
    }
    case 'SALES_BY_CUSTOMER': {
      model = await fetchSalesByCustomerModel(supabase, { startDate: period.startDate, endDate: period.endDate, locationIds }, meta);
      break;
    }
    case 'AR_AGING': {
      const aging = await fetchArAging(supabase, locationIds);
      model = buildAgingModel(aging.buckets, aging.totalOutstanding, 'Accounts Receivable Aging', meta);
      break;
    }
    case 'AP_AGING': {
      const aging = await fetchApAging(supabase, locationIds);
      model = buildAgingModel(aging.buckets, aging.totalOutstanding, 'Accounts Payable Aging', meta);
      break;
    }
  }

  return { report: spec.report, reportTitle: entry.title, basisLabel, periodLabel: period.label, warning, model };
}

/** Run a whole resolved pack into rendered sections (cover + one section per report×period). */
export async function runPack(supabase: SupabaseClient, orgId: string, pack: ResolvedPack): Promise<CompiledPack> {
  const entityLabel = pack.entityLabel || 'All Companies (Consolidated)';
  const locationIds = pack.locationIds ?? [];
  const generatedAt = new Date().toISOString();

  const sections: CompiledSection[] = [];
  for (const spec of pack.specs) {
    for (const period of spec.periods) {
      // Sections are built sequentially — the sandbox is memory-limited and each
      // engine already fans out its own queries; serial keeps peak memory low.
      // eslint-disable-next-line no-await-in-loop
      sections.push(await buildSection(supabase, orgId, entityLabel, spec, period, locationIds));
    }
  }

  return {
    meta: { entityLabel, generatedAt, sectionCount: sections.length },
    cover: {
      title: 'Financial Report Pack',
      entityLabel,
      generatedAt,
      contents: sections.map((s) => ({ report: s.reportTitle, basisLabel: s.basisLabel, periodLabel: s.periodLabel })),
    },
    sections,
  };
}
