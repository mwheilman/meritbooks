/**
 * DealerReport → StatementModel (the reports system's one export interchange), and
 * small builder helpers shared by R1–R8. Pure and client-safe.
 *
 * Lossless: every row and every cell carries over. Money stays integer cents;
 * percent (basis points) and dates become display strings because StatementModel
 * cells are number | string | null; notes and KPIs become trailing note rows.
 */

import type { StatementModel, StmtRow } from '@/lib/reports/export/statement-model';
import type { DealerCell, DealerReport, DealerReportColumn, DealerReportRow, DealerRowKind } from './catalog';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isoLabel(iso: string | null | undefined): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1] ?? ym} ${y}`;
}

export function pctLabel(bps: number, digits = 1): string {
  return `${(bps / 100).toFixed(digits)}%`;
}

/** Ratio in basis points (rounded half away from zero); null when the base is 0. */
export function ratioBps(num: number, den: number): number | null {
  if (!den) return null;
  const v = (num * 10_000) / den;
  return v >= 0 ? Math.round(v) : -Math.round(-v);
}

export function periodLabelFor(window: { start?: string; end?: string; asOf?: string }): string {
  if (window.asOf) return `As of ${isoLabel(window.asOf)}`;
  if (window.start && window.end) return `${isoLabel(window.start)} to ${isoLabel(window.end)}`;
  return '';
}

/** Build a row with exactly `cols.length` values (missing → null). */
export function row(
  kind: DealerRowKind,
  label: string,
  cols: DealerReportColumn[],
  values: Partial<Record<string, DealerCell>>,
  extra: Omit<DealerReportRow, 'kind' | 'label' | 'values'> = {},
): DealerReportRow {
  return { kind, label, values: cols.map((c) => values[c.key] ?? null), ...extra };
}

export function spacer(cols: DealerReportColumn[]): DealerReportRow {
  return { kind: 'spacer', label: '', values: cols.map(() => null) };
}

export function cellToModel(col: DealerReportColumn, v: DealerCell): number | string | null {
  if (v === null || v === undefined) return null;
  switch (col.kind) {
    case 'money':
    case 'count':
    case 'days':
      return v;
    case 'percent':
      return typeof v === 'number' ? pctLabel(v) : v;
    case 'date':
      return typeof v === 'string' ? isoLabel(v) : v;
    default:
      return typeof v === 'number' ? String(v) : v;
  }
}

export function toStatementModel(report: DealerReport, overrides: { title?: string; entityLabel?: string; periodLabel?: string; basisLabel?: string; accent?: string } = {}): StatementModel {
  const columns = report.columns.map((c) => ({ key: c.key, label: c.label, ...(c.kind === 'money' ? { money: true } : {}) }));
  const blank = () => report.columns.map(() => null);
  const rows: StmtRow[] = report.rows.map((r) => ({
    kind: r.kind,
    label: r.label,
    ...(r.code ? { code: r.code } : {}),
    ...(r.indent ? { indent: Math.min(5, Math.max(0, r.indent)) } : {}),
    values: report.columns.map((c, i) => cellToModel(c, r.values[i] ?? null)),
  }));
  if (report.kpis.length || report.notes.length) rows.push({ kind: 'spacer', label: '', values: blank() });
  for (const k of report.kpis) rows.push({ kind: 'note', label: `${k.label}: ${k.value}${k.hint ? ` — ${k.hint}` : ''}`, values: blank() });
  for (const n of report.notes) rows.push({ kind: 'note', label: n, values: blank() });
  return {
    title: overrides.title || report.title,
    entityLabel: overrides.entityLabel || report.entityLabel,
    periodLabel: overrides.periodLabel || report.periodLabel,
    ...(overrides.basisLabel ? { basisLabel: overrides.basisLabel } : {}),
    generatedAt: report.generatedAt,
    accent: overrides.accent ?? '#10b981',
    columns,
    rows,
  };
}

/** Sum a money/count column over rows of one kind (test + builder helper). */
export function sumColumn(rows: DealerReportRow[], cols: DealerReportColumn[], key: string, kinds: DealerRowKind[] = ['account']): number {
  const i = cols.findIndex((c) => c.key === key);
  if (i < 0) return 0;
  return rows.filter((r) => kinds.includes(r.kind)).reduce((s, r) => s + (typeof r.values[i] === 'number' ? (r.values[i] as number) : 0), 0);
}

/** A report with only an empty-state note. */
export function hasData(report: DealerReport): boolean {
  return report.rows.some((r) => r.kind === 'account' || r.kind === 'total' || r.kind === 'subtotal');
}
