import type { StatementModel, StmtRow } from './statement-model';

/**
 * Client-side transformers: the exact JSON the report API returns (the SAME
 * payload the on-screen table renders) → a normalized StatementModel. No new
 * queries, no re-computation — the export is a re-projection of what the user is
 * already looking at, so the numbers tie out (FPB AC7.1). react-pdf is NOT
 * imported here, so this module stays out of the client bundle's heavy path.
 */

export interface ExportMeta {
  reportLabel: string;
  entityLabel: string;
  periodLabel: string;
  basisLabel?: string;
  accent: string;
}

/** Where each report's data lives + how to shape it. */
export interface ExportSpec {
  url: string;
  query: Record<string, string>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: (data: any, meta: ExportMeta) => StatementModel;
}

const now = () => new Date().toISOString();

function base(meta: ExportMeta, title: string, columns: StatementModel['columns'], rows: StmtRow[], periodOverride?: string): StatementModel {
  return {
    title,
    entityLabel: meta.entityLabel,
    periodLabel: periodOverride ?? meta.periodLabel,
    basisLabel: meta.basisLabel,
    generatedAt: now(),
    accent: meta.accent,
    columns,
    rows,
  };
}

// ─── Income Statement (P&L) ──────────────────────────────────────────────────
interface ISAcct { accountNumber: string; accountName: string; amountCents: number }
interface ISGroup { name: string; accounts: ISAcct[]; totalCents: number }
interface ISSection { type: string; label: string; groups: ISGroup[]; totalCents: number }
interface ISData {
  sections: ISSection[];
  summary: { revenueCents: number; cogsCents: number; grossProfitCents: number; opexCents: number; ebitdaCents: number; otherCents: number; netIncomeCents: number };
  filters?: { startDate?: string; endDate?: string; basis?: string };
}

export function buildIncomeStatement(data: ISData, meta: ExportMeta): StatementModel {
  const rows: StmtRow[] = [];
  const sectionByType = (t: string) => data.sections.find((s) => s.type === t);
  const emitSection = (sec?: ISSection) => {
    if (!sec) return;
    rows.push({ kind: 'section', label: sec.label, values: [sec.totalCents], indent: 0 });
    for (const g of sec.groups) {
      for (const a of g.accounts) {
        rows.push({ kind: 'account', code: a.accountNumber, label: a.accountName, values: [a.amountCents], indent: 1 });
      }
    }
  };

  emitSection(sectionByType('REVENUE'));
  emitSection(sectionByType('COGS'));
  rows.push({ kind: 'subtotal', label: 'Gross Profit', values: [data.summary.grossProfitCents] });
  rows.push({ kind: 'spacer', values: [null] });
  emitSection(sectionByType('OPEX'));
  rows.push({ kind: 'subtotal', label: 'Operating Income', values: [data.summary.ebitdaCents] });
  const other = sectionByType('OTHER');
  if (other && other.groups.some((g) => g.accounts.length)) {
    rows.push({ kind: 'spacer', values: [null] });
    emitSection(other);
  }
  rows.push({ kind: 'total', label: 'Net Income', values: [data.summary.netIncomeCents] });

  const period = data.filters?.startDate && data.filters?.endDate
    ? `${data.filters.startDate} to ${data.filters.endDate}`
    : undefined;
  return base(meta, 'Profit & Loss', [{ key: 'amount', label: 'Amount', money: true }], rows, period);
}

// ─── Balance Sheet ───────────────────────────────────────────────────────────
interface BSAcct { accountNumber: string; accountName: string; balanceCents: number }
interface BSGroup { name: string; accounts: BSAcct[]; totalCents: number }
interface BSSubType { name: string; groups: BSGroup[]; totalCents: number }
interface BSSection { type: string; label: string; subTypes: BSSubType[]; totalCents: number }
interface BSData {
  sections: BSSection[];
  summary: { totalAssetsCents: number; totalLiabilitiesCents: number; totalEquityCents: number; liabilitiesPlusEquityCents: number; isBalanced: boolean; varianceCents: number };
  filters?: { asOfDate?: string };
}

export function buildBalanceSheet(data: BSData, meta: ExportMeta): StatementModel {
  const rows: StmtRow[] = [];
  const sec = (t: string) => data.sections.find((s) => s.type === t);
  const emit = (s?: BSSection) => {
    if (!s) return;
    rows.push({ kind: 'section', label: s.label, values: [s.totalCents], indent: 0 });
    for (const st of s.subTypes) {
      for (const g of st.groups) {
        for (const a of g.accounts) {
          rows.push({ kind: 'account', code: a.accountNumber, label: a.accountName, values: [a.balanceCents], indent: 1 });
        }
      }
      if (s.subTypes.length > 1) rows.push({ kind: 'subtotal', label: `Total ${st.name}`, values: [st.totalCents], indent: 1 });
    }
  };

  emit(sec('ASSET'));
  rows.push({ kind: 'total', label: 'Total Assets', values: [data.summary.totalAssetsCents] });
  rows.push({ kind: 'spacer', values: [null] });
  emit(sec('LIABILITY'));
  emit(sec('EQUITY'));
  rows.push({ kind: 'total', label: 'Total Liabilities & Equity', values: [data.summary.liabilitiesPlusEquityCents] });
  rows.push({
    kind: 'note',
    label: data.summary.isBalanced ? 'Balanced' : `Out of balance by ${Math.abs(data.summary.varianceCents / 100).toFixed(2)}`,
    values: [null],
  });

  const period = data.filters?.asOfDate ? `As of ${data.filters.asOfDate}` : undefined;
  return base(meta, 'Balance Sheet', [{ key: 'balance', label: 'Balance', money: true }], rows, period);
}

// ─── Cash Flow (indirect) ────────────────────────────────────────────────────
interface CFItem { label: string; amountCents: number }
interface CFData {
  period?: { startDate: string; endDate: string };
  operating: { netIncome: number; adjustments: CFItem[]; changesInWorkingCapital: CFItem[]; totalCents: number };
  investing: { items: CFItem[]; totalCents: number };
  financing: { items: CFItem[]; totalCents: number };
  netChangeCents: number;
  beginningCashCents: number;
  endingCashCents: number;
}

export function buildCashFlow(data: CFData, meta: ExportMeta): StatementModel {
  const rows: StmtRow[] = [];
  rows.push({ kind: 'section', label: 'Operating Activities', values: [null] });
  rows.push({ kind: 'account', label: 'Net Income', values: [data.operating.netIncome], indent: 1 });
  for (const a of data.operating.adjustments) rows.push({ kind: 'account', label: a.label, values: [a.amountCents], indent: 1 });
  for (const a of data.operating.changesInWorkingCapital) rows.push({ kind: 'account', label: a.label, values: [a.amountCents], indent: 1 });
  rows.push({ kind: 'subtotal', label: 'Net Cash from Operating Activities', values: [data.operating.totalCents] });
  rows.push({ kind: 'spacer', values: [null] });

  rows.push({ kind: 'section', label: 'Investing Activities', values: [null] });
  for (const a of data.investing.items) rows.push({ kind: 'account', label: a.label, values: [a.amountCents], indent: 1 });
  rows.push({ kind: 'subtotal', label: 'Net Cash from Investing Activities', values: [data.investing.totalCents] });
  rows.push({ kind: 'spacer', values: [null] });

  rows.push({ kind: 'section', label: 'Financing Activities', values: [null] });
  for (const a of data.financing.items) rows.push({ kind: 'account', label: a.label, values: [a.amountCents], indent: 1 });
  rows.push({ kind: 'subtotal', label: 'Net Cash from Financing Activities', values: [data.financing.totalCents] });
  rows.push({ kind: 'spacer', values: [null] });

  rows.push({ kind: 'total', label: 'Net Change in Cash', values: [data.netChangeCents] });
  rows.push({ kind: 'account', label: 'Beginning Cash', values: [data.beginningCashCents] });
  rows.push({ kind: 'total', label: 'Ending Cash', values: [data.endingCashCents] });

  const period = data.period ? `${data.period.startDate} to ${data.period.endDate}` : undefined;
  return base(meta, 'Cash Flow Statement', [{ key: 'amount', label: 'Amount', money: true }], rows, period);
}

// ─── Cash Flow (direct) ──────────────────────────────────────────────────────
interface CFDirectLine { key: string; label: string; section: string; amountCents: number }
interface CFDirectSection { lines: CFDirectLine[]; totalCents: number }
interface CFDirectData {
  period?: { startDate: string; endDate: string };
  operating: CFDirectSection;
  investing: CFDirectSection;
  financing: CFDirectSection;
  netChangeCents: number;
  beginningCashCents: number;
  endingCashCents: number;
}

export function buildCashFlowDirect(data: CFDirectData, meta: ExportMeta): StatementModel {
  const rows: StmtRow[] = [];
  const section = (label: string, s: CFDirectSection, totalLabel: string) => {
    rows.push({ kind: 'section', label, values: [null] });
    for (const l of s.lines) rows.push({ kind: 'account', label: l.label, values: [l.amountCents], indent: 1 });
    rows.push({ kind: 'subtotal', label: totalLabel, values: [s.totalCents] });
    rows.push({ kind: 'spacer', values: [null] });
  };
  section('Operating Activities', data.operating, 'Net Cash from Operating Activities');
  section('Investing Activities', data.investing, 'Net Cash from Investing Activities');
  section('Financing Activities', data.financing, 'Net Cash from Financing Activities');

  rows.push({ kind: 'total', label: 'Net Change in Cash', values: [data.netChangeCents] });
  rows.push({ kind: 'account', label: 'Beginning Cash', values: [data.beginningCashCents] });
  rows.push({ kind: 'total', label: 'Ending Cash', values: [data.endingCashCents] });

  const period = data.period ? `${data.period.startDate} to ${data.period.endDate}` : undefined;
  return base(meta, 'Cash Flow Statement (Direct Method)', [{ key: 'amount', label: 'Amount', money: true }], rows, period);
}

// ─── Trial Balance ───────────────────────────────────────────────────────────
interface TBRow { account_number: string; account_name: string; account_type?: string; total_debits: number | string; total_credits: number | string; net_balance: number | string }

export function buildTrialBalance(data: { data?: TBRow[] }, meta: ExportMeta): StatementModel {
  const src = data.data ?? [];
  const rows: StmtRow[] = [];
  let td = 0, tc = 0;
  for (const r of src) {
    const debit = Number(r.total_debits ?? 0);
    const credit = Number(r.total_credits ?? 0);
    const net = Number(r.net_balance ?? 0);
    td += debit; tc += credit;
    rows.push({ kind: 'account', code: r.account_number, label: r.account_name, values: [debit || null, credit || null, net] });
  }
  rows.push({ kind: 'total', label: 'Totals', values: [td, tc, td - tc] });
  return base(meta, 'Trial Balance', [
    { key: 'debit', label: 'Debit', money: true },
    { key: 'credit', label: 'Credit', money: true },
    { key: 'net', label: 'Net', money: true },
  ], rows);
}

// ─── Generic tabular fallback (every other report) ───────────────────────────
// Mirrors the on-screen GenericReport projection so any report can at least
// export a faithful CSV/PDF rather than a dead button.
export function buildGenericTable(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  meta: ExportMeta,
): StatementModel {
  const src: Record<string, unknown>[] = data?.data ?? data?.accounts ?? data?.reconciliations ?? (Array.isArray(data) ? data : []);
  if (!Array.isArray(src) || src.length === 0) {
    return base(meta, meta.reportLabel, [{ key: 'v', label: 'Value' }], [{ kind: 'note', label: 'No data for the selected filters.', values: [null] }]);
  }
  const keys = Object.keys(src[0]).filter((k) =>
    !k.toLowerCase().includes('id') &&
    !['transactions', 'invoices', 'details', 'aging', 'accounts', 'byAccount', 'byLocation'].includes(k));
  const labelKey = keys[0] ?? 'label';
  const valueKeys = keys.slice(1);
  const isMoney = (k: string) => k.endsWith('Cents') || k.toLowerCase().includes('cents');
  const pretty = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/Cents$/i, '').trim().replace(/^./, (c) => c.toUpperCase());

  const columns = valueKeys.map((k) => ({ key: k, label: pretty(k), money: isMoney(k) }));
  const rows: StmtRow[] = src.slice(0, 5000).map((r) => ({
    kind: 'account' as const,
    label: String(r[labelKey] ?? '—'),
    values: valueKeys.map((k) => {
      const v = r[k];
      if (isMoney(k)) return Number(v ?? 0);
      if (v === null || v === undefined) return '';
      return typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    }),
  }));
  return base(meta, meta.reportLabel, columns.length ? columns : [{ key: labelKey, label: pretty(labelKey) }], rows);
}

// ─── Resolver: reportKey → endpoint + builder ────────────────────────────────
export interface ResolveCtx { sd: string; ed: string; locIds: string; basis: string }

/** Reports that get a bespoke, statement-grade builder. */
const STATEMENT_BUILDERS: Record<string, { url: string; build: ExportSpec['build']; query: (c: ResolveCtx) => Record<string, string> }> = {
  pnl:      { url: '/api/reports/income-statement', build: buildIncomeStatement, query: periodQuery },
  pnl_dept: { url: '/api/reports/income-statement', build: buildIncomeStatement, query: periodQuery },
  pnl_class:{ url: '/api/reports/income-statement', build: buildIncomeStatement, query: periodQuery },
  bs:       { url: '/api/reports/balance-sheet',    build: buildBalanceSheet,    query: (c) => clean({ as_of_date: c.ed, location_ids: c.locIds }) },
  cf:       { url: '/api/reports/cash-flow',        build: buildCashFlow,        query: (c) => clean({ start_date: c.sd, end_date: c.ed, location_ids: c.locIds }) },
  cf_direct:{ url: '/api/reports/cash-flow-direct', build: buildCashFlowDirect,  query: (c) => clean({ start_date: c.sd, end_date: c.ed, location_ids: c.locIds }) },
  tb:       { url: '/api/gl/trial-balance',         build: buildTrialBalance,    query: (c) => clean({ location_ids: c.locIds }) },
};

/** Every other report → its endpoint (mirrors report-viewer's urlMap) + generic builder. */
const GENERIC_URLS: Record<string, string> = {
  debt: '/api/reports/debt-schedule',
  equity_table: '/api/reports/equity-table',
  equity_changes: '/api/reports/equity-changes',
  ap_aging: '/api/reports/ap-aging',
  ar_aging: '/api/reports/ar-aging',
  job_prof: '/api/reports/job-profitability',
  exp_vend: '/api/reports/expense-by-vendor',
  gl: '/api/reports/gl-detail',
  consol: '/api/reports/consolidated',
  inc_cust: '/api/reports/income-by-customer',
  sales_cust: '/api/reports/sales-by-customer',
  vend_bal: '/api/reports/vendor-balances',
  cust_bal: '/api/reports/customer-balances',
  open: '/api/reports/open-items',
  open_ar: '/api/reports/open-items',
  open_ap: '/api/reports/open-items',
  txn_list: '/api/reports/transaction-list',
  wip: '/api/reports/wip',
  job_cost: '/api/reports/job-cost',
  pnl_month: '/api/reports/pnl-by-month',
};

function clean(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v));
}
function periodQuery(c: ResolveCtx): Record<string, string> {
  return clean({ start_date: c.sd, end_date: c.ed, location_ids: c.locIds, basis: c.basis !== 'accrual' ? c.basis : '' });
}

export function resolveExportSpec(reportKey: string, c: ResolveCtx): ExportSpec | null {
  const s = STATEMENT_BUILDERS[reportKey];
  if (s) return { url: s.url, query: s.query(c), build: s.build };
  const url = GENERIC_URLS[reportKey];
  if (!url) return null;
  const query = clean({ start_date: c.sd, end_date: c.ed, location_ids: c.locIds, basis: c.basis !== 'accrual' ? c.basis : '', mode: 'summary' });
  if (reportKey === 'pnl_month') { delete query.start_date; delete query.end_date; if (c.sd) query.year = c.sd.slice(0, 4); }
  if (reportKey === 'open_ar') query.type = 'ar';
  if (reportKey === 'open_ap') query.type = 'ap';
  return { url, query, build: buildGenericTable };
}
