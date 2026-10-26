/**
 * CSV export of a forecast (pure). Money as decimal dollars with two places (from integer cents),
 * formula-looking cells neutralized (the chart kit's rule) so a spreadsheet never executes them.
 */

import { centsToDecimal, neutralizeCsvFormula } from '@/components/charts/core/table';
import { CATEGORY_LABEL, INFLOW_CATEGORIES, OUTFLOW_CATEGORIES, type Category } from './types';
import type { WorkspaceForecast } from './service';

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : neutralizeCsvFormula(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const money = (c: number | null | undefined) => (c === null || c === undefined ? '' : centsToDecimal(c));

export function forecastCsv(ws: WorkspaceForecast, view: 'weeks' | 'items', scopeName: string): string {
  const f = ws.forecast;
  const rows: string[][] = [];
  rows.push([`Cash forecast — ${scopeName}`]);
  rows.push([`Scenario: ${ws.scenario.name}`, `As of ${f.today}`, `Opening: ${f.combined.openingCents >= 0 ? '' : '-'}${money(Math.abs(f.combined.openingCents))}`]);
  rows.push([]);
  if (view === 'weeks') {
    const s = f.combined;
    const cats = [...INFLOW_CATEGORIES, ...OUTFLOW_CATEGORIES].filter((c) => s.weeks.some((w) => (w.byCategory[c as Category] ?? 0) !== 0)) as Category[];
    rows.push(['Week', 'Starts', 'Ends', 'Opening', ...cats.map((c) => `${(INFLOW_CATEGORIES as readonly string[]).includes(c) ? 'In' : 'Out'}: ${CATEGORY_LABEL[c]}`), 'Total in', 'Total out', 'Net', 'Closing', 'Low (80%)', 'High (80%)', 'Minimum', 'Below minimum']);
    for (const w of s.weeks) {
      rows.push([
        String(w.weekNumber),
        w.start,
        w.end,
        money(w.openingCents),
        ...cats.map((c) => money(w.byCategory[c] ?? 0)),
        money(w.inflowsCents),
        money(w.outflowsCents),
        money(w.netCents),
        money(w.closingCents),
        money(w.loCents),
        money(w.hiCents),
        money(s.minimumCents),
        w.belowMinimum ? 'yes' : 'no',
      ]);
    }
  } else {
    const names = new Map(ws.positions.map((p) => [p.id, p.name]));
    rows.push(['Date', 'Company', 'Direction', 'Category', 'Item', 'Counterparty', 'Expected', 'Document amount', 'Probability', 'Certainty', 'Due date', 'Flags', 'Source', 'Note']);
    for (const it of f.items) {
      rows.push([
        it.date,
        it.companyId ? (names.get(it.companyId) ?? it.companyId) : 'Organization',
        it.direction === 'IN' ? 'In' : 'Out',
        CATEGORY_LABEL[it.category],
        it.label,
        it.party ?? '',
        money(it.amountCents),
        money(it.grossCents),
        `${Math.round(it.probability * 100)}%`,
        it.certainty.toLowerCase(),
        it.dueDate ?? '',
        (it.flags ?? []).join(' '),
        it.source.kind.toLowerCase(),
        it.note ?? '',
      ]);
    }
  }
  return rows.map((r) => r.map((v) => cell(v)).join(',')).join('\r\n') + '\r\n';
}
