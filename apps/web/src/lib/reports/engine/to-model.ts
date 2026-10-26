/**
 * ReportResult → the shared export StatementModel (lib/reports/export), so the engine's
 * PDF / XLSX / CSV reuse the existing renderers. Money columns carry FULL cents (exports
 * are never rounded); percent columns carry display strings.
 */
import type { StatementModel, StmtRow } from '@/lib/reports/export/statement-model';
import { formatCell, isNonMoneyRow, isPercentColumn } from './format';
import type { ReportResult } from './types';

const WATERMARK_TEXT: Record<string, string> = { preview: 'PREVIEW — NOT RELEASED', preliminary: 'PRELIMINARY' };

/** The governance marks an export must keep (watermark / banner / footnote). */
export function governanceMarks(r: ReportResult): { watermark: string | null; banner: string | null; footnote: string | null } {
  const g = r.governance ?? null;
  const wm = typeof g?.watermark === 'string' ? WATERMARK_TEXT[g.watermark] ?? g.watermark.toUpperCase() : null;
  const banner = g && typeof g.banner === 'object' && g.banner && typeof (g.banner as { text?: unknown }).text === 'string' ? (g.banner as { text: string }).text : null;
  const withheld = Array.isArray(g?.withheldColumnIds) ? (g?.withheldColumnIds as unknown[]).length : 0;
  const foot = [typeof g?.footnote === 'string' ? g.footnote : null, withheld ? `${withheld} column(s) are not released for your audience and are left blank.` : null]
    .filter((x): x is string => !!x)
    .join(' ');
  return { watermark: wm ? wm.slice(0, 60) : null, banner: banner ? banner.slice(0, 400) : null, footnote: foot ? foot.slice(0, 1200) : null };
}

export function toStatementModel(r: ReportResult, opts: { collapsed?: ReadonlySet<string>; hideZero?: boolean } = {}): StatementModel {
  const columns = r.columns.map((c) => ({
    key: c.id,
    label: [c.label, c.sublabel].filter(Boolean).join(' · ').slice(0, 120),
    money: !isPercentColumn(c),
  }));
  const hidden = new Set<string>();
  for (const row of r.rows) if (row.parentId && (opts.collapsed?.has(row.parentId) || hidden.has(row.parentId))) hidden.add(row.id);
  const rows: StmtRow[] = [];
  for (const row of r.rows) {
    if (hidden.has(row.id)) continue;
    if (row.kind === 'spacer') {
      rows.push({ kind: 'spacer', label: '', values: [] });
      continue;
    }
    if (row.kind === 'header') {
      rows.push({ kind: 'section', label: row.label, values: [] });
      continue;
    }
    const kind = row.kind === 'total' ? 'total' : row.kind === 'subtotal' || row.kind === 'group' ? 'subtotal' : row.kind === 'check' ? 'note' : 'account';
    const code = row.accountNumber ?? undefined;
    rows.push({
      kind,
      label: code && row.label.startsWith(`${code} · `) ? row.label.slice(code.length + 3) : row.label,
      code,
      indent: Math.min(row.depth, 5),
      values: r.columns.map((c, i) => {
        const v = row.values[i];
        if (v == null) return null;
        if (isPercentColumn(c) || isNonMoneyRow(row)) return formatCell(row, c, v, r.rounding);
        return v;
      }),
    });
  }
  return {
    title: r.title,
    entityLabel: r.companies.length === 1 ? r.companies[0].name : `${r.companies.length} companies`,
    periodLabel: r.subtitle.split(' · ').slice(1, 2).join('') || r.subtitle,
    basisLabel: r.basisLabel,
    generatedAt: r.generatedAt,
    accent: '#2563EB',
    columns,
    rows,
    ...governanceMarks(r),
  };
}
