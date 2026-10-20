/**
 * Dealer Pack reports (FPB-dealer-pack §7, R1–R8) — the catalog and the shared
 * report shape. Pure and client-safe (no I/O).
 *
 * `DealerReport` is what the screen renders (it carries per-row drill links);
 * `toStatementModel` (./model.ts) converts it losslessly to the reports system's
 * single export interchange (StatementModel → PDF / CSV / XLSX).
 */

export const DEALER_REPORT_KEYS = [
  'dealer_fp_position',
  'dealer_fp_interest',
  'dealer_unit_aging',
  'dealer_unit_gross',
  'dealer_warranty_aging',
  'dealer_incentive_aging',
  'dealer_dept_pnl',
  'dealer_lender_rec',
] as const;
export type DealerReportKey = (typeof DEALER_REPORT_KEYS)[number];

/** `period` reports take start/end; `asOf` reports take one date. */
export type DealerReportMode = 'period' | 'asOf';

export interface DealerReportDef {
  key: DealerReportKey;
  label: string;
  desc: string;
  mode: DealerReportMode;
}

export const DEALER_REPORTS: readonly DealerReportDef[] = [
  { key: 'dealer_fp_position', label: 'Floor-plan position', desc: 'By lender, line and program: balance, accrued interest, curtailments due, sold-not-paid, utilization, maturity', mode: 'asOf' },
  { key: 'dealer_fp_interest', label: 'Floor-plan interest', desc: 'Carrying cost by month, department, manufacturer and unit; interest per unit sold', mode: 'period' },
  { key: 'dealer_unit_aging', label: 'Unit aging', desc: 'Units in stock by condition, make and model with days-in-stock buckets, floored vs owned', mode: 'asOf' },
  { key: 'dealer_unit_gross', label: 'Unit gross', desc: 'Deal profitability: price less unit cost and over-allowance plus cost-reduction incentives', mode: 'period' },
  { key: 'dealer_warranty_aging', label: 'Warranty receivable aging', desc: 'Open warranty claims by manufacturer and status, recovery and rejection rates', mode: 'asOf' },
  { key: 'dealer_incentive_aging', label: 'Incentive receivable aging', desc: 'Open manufacturer incentives by manufacturer and program: accrued, claimed, settled, deadlines', mode: 'asOf' },
  { key: 'dealer_dept_pnl', label: 'Departmental P&L', desc: 'Profit and loss by dealership department, with service absorption', mode: 'period' },
  { key: 'dealer_lender_rec', label: 'Lender reconciliation', desc: 'Lender statements and floor checks vs Books: who prepared and approved, open items, audit findings', mode: 'period' },
];

export function isDealerReportKey(k: string | null | undefined): k is DealerReportKey {
  return !!k && (DEALER_REPORT_KEYS as readonly string[]).includes(k);
}

export function dealerReportDef(k: DealerReportKey): DealerReportDef {
  return DEALER_REPORTS.find((r) => r.key === k) ?? DEALER_REPORTS[0];
}

/** How a column's cells are typed (money = integer cents; percent = basis points). */
export type DealerCellKind = 'money' | 'count' | 'days' | 'percent' | 'text' | 'date';

export interface DealerReportColumn {
  key: string;
  label: string;
  kind: DealerCellKind;
}

export type DealerCell = number | string | null;

export type DealerRowKind = 'section' | 'account' | 'subtotal' | 'total' | 'spacer' | 'note';

export interface DealerReportRow {
  kind: DealerRowKind;
  label: string;
  code?: string;
  indent?: number;
  /** One entry per column. */
  values: DealerCell[];
  /** Drill target for the row (unit / note / claim / statement / deal). */
  href?: string;
  /** Journal entry behind the row, when there is exactly one. */
  jeHref?: string;
  /** Highlight (e.g. a cost that wasn't recorded). */
  tone?: 'warning' | 'danger';
}

export interface DealerReportKpi {
  label: string;
  value: string;
  hint?: string;
}

export interface DealerReport {
  key: DealerReportKey;
  title: string;
  entityLabel: string;
  periodLabel: string;
  window: { start?: string; end?: string; asOf?: string };
  columns: DealerReportColumn[];
  rows: DealerReportRow[];
  /** Definitions and caveats, shown under the table and exported as note rows. */
  notes: string[];
  kpis: DealerReportKpi[];
  generatedAt: string;
}

export interface ReportMeta {
  entityLabel: string;
  generatedAt?: string;
}
