/**
 * ChartTable — the ONE data model behind a chart's "View as table", its CSV,
 * its XLSX and its printed table. The chart and the table are built from the
 * same input by the same builder, so they cannot disagree (D-PARTNER-PORTAL
 * §1: "the same TableData the chart drew").
 */
import { computeBridge, shares, type BridgeStep } from './series';
import { formatValue } from './format';
import { longLabel, periodStatus, type Category, type CategorySeries, type ChartUnit, type PeriodStatus, type TimeSeriesData, type Value } from './types';

export interface ChartTableColumn {
  key: string;
  label: string;
  /** Unit of the numeric cells in this column; absent = text column. */
  unit?: ChartUnit;
}

export type ChartTableCell = Value | string;

export interface ChartTableRow {
  key: string;
  cells: ChartTableCell[];
  /** Period status, printed as a marker ("P" preliminary, "F" forecast). */
  status?: PeriodStatus;
  /** Total / anchor rows render bold with a rule. */
  emphasis?: 'total' | 'subtotal';
}

export interface ChartTable {
  caption: string;
  columns: ChartTableColumn[];
  rows: ChartTableRow[];
  /** Printed under the table and in the export banner. */
  notes?: string[];
}

/** A display string for one cell (em dash for gaps — never "0"). */
export function cellText(cell: ChartTableCell, col: ChartTableColumn): string {
  if (typeof cell === 'string') return cell;
  if (!col.unit) return cell === null ? '—' : String(cell);
  return formatValue(cell, col.unit);
}

// ─────────────────────────────────────────────────────────── builders

export interface TimeSeriesTableOptions {
  caption: string;
  unit: ChartUnit;
  actualLabel?: string;
}

/** Period · Actual · Prior year · Budget · TTM · Low · High · Status (only the columns that exist). */
export function timeSeriesTable(data: TimeSeriesData, opts: TimeSeriesTableOptions): ChartTable {
  const cols: ChartTableColumn[] = [{ key: 'period', label: 'Period' }, { key: 'actual', label: opts.actualLabel ?? 'Actual', unit: opts.unit }];
  const series: Array<Value[] | undefined> = [data.actual];
  if (data.priorYear) {
    cols.push({ key: 'priorYear', label: 'Prior year', unit: opts.unit });
    series.push(data.priorYear);
  }
  if (data.budget) {
    cols.push({ key: 'budget', label: 'Budget', unit: opts.unit });
    series.push(data.budget);
  }
  if (data.ttm) {
    cols.push({ key: 'ttm', label: 'TTM', unit: opts.unit });
    series.push(data.ttm);
  }
  if (data.band) {
    cols.push({ key: 'lo', label: 'Low', unit: opts.unit }, { key: 'hi', label: 'High', unit: opts.unit });
    series.push(data.band.lo, data.band.hi);
  }
  cols.push({ key: 'status', label: 'Status' });
  const rows: ChartTableRow[] = data.periods.map((p, i) => {
    const st = periodStatus(p);
    return {
      key: p.key,
      status: st,
      cells: [longLabel(p), ...series.map((s) => (s ? (s[i] ?? null) : null)), st === 'closed' ? 'Closed' : st === 'preliminary' ? 'Preliminary' : 'Forecast'],
    };
  });
  return { caption: opts.caption, columns: cols, rows };
}

/** Category rows × series columns (bars, aging, combo). Optional total column. */
export function categoryTable(
  categories: ReadonlyArray<Category>,
  series: ReadonlyArray<CategorySeries>,
  opts: { caption: string; unit: ChartUnit; categoryLabel?: string; total?: boolean; units?: ReadonlyArray<ChartUnit> },
): ChartTable {
  const cols: ChartTableColumn[] = [
    { key: 'category', label: opts.categoryLabel ?? 'Category' },
    ...series.map((s, j) => ({ key: s.key, label: s.label, unit: opts.units?.[j] ?? opts.unit })),
  ];
  if (opts.total) cols.push({ key: 'total', label: 'Total', unit: opts.unit });
  const rows: ChartTableRow[] = categories.map((c, i) => {
    const vals = series.map((s) => s.values[i] ?? null);
    const cells: ChartTableCell[] = [c.label, ...vals];
    if (opts.total) {
      const present = vals.filter((v): v is number => v !== null);
      cells.push(present.length ? present.reduce((a, b) => a + b, 0) : null);
    }
    return { key: c.key, cells };
  });
  return { caption: opts.caption, columns: cols, rows };
}

/** Step · Movement · Running total (bridge / waterfall). */
export function bridgeTable(steps: ReadonlyArray<BridgeStep>, opts: { caption: string; unit: ChartUnit }): ChartTable {
  const b = computeBridge(steps);
  const notes = b.ties ? undefined : [`Does not tie: the end figure differs from the steps by ${formatValue(b.difference, opts.unit)}.`];
  return {
    caption: opts.caption,
    columns: [
      { key: 'step', label: 'Step' },
      { key: 'movement', label: 'Movement', unit: opts.unit },
      { key: 'running', label: 'Running total', unit: opts.unit },
    ],
    rows: b.bars.map((bar) => ({
      key: bar.key,
      emphasis: bar.kind === 'delta' ? undefined : bar.kind === 'subtotal' ? 'subtotal' : 'total',
      cells: [bar.label, bar.kind === 'delta' ? bar.value : null, bar.running],
    })),
    notes,
  };
}

/** Item · Value · Share (concentration). Losses listed with no share. */
export function shareTable(
  items: ReadonlyArray<{ key: string; label: string; value: Value }>,
  opts: { caption: string; unit: ChartUnit; itemLabel?: string; topN?: number },
): ChartTable {
  const s = shares(items, opts.topN ?? 8);
  return {
    caption: opts.caption,
    columns: [
      { key: 'item', label: opts.itemLabel ?? 'Item' },
      { key: 'value', label: 'Value', unit: opts.unit },
      { key: 'share', label: 'Share', unit: 'percent' },
    ],
    rows: [
      ...s.items.map((i) => ({ key: i.key, cells: [i.loss ? `${i.label} (loss)` : i.label, i.value, i.loss ? null : i.share] as ChartTableCell[] })),
      { key: '__total', emphasis: 'total' as const, cells: ['Total (positive contributors)', s.total, s.total > 0 ? 1 : null] },
    ],
  };
}

/** Generic two-axis rows (scatter): Label · X · Y [· Size]. */
export function pointTable(
  points: ReadonlyArray<{ key: string; label: string; x: Value; y: Value; size?: Value }>,
  opts: { caption: string; xLabel: string; yLabel: string; xUnit: ChartUnit; yUnit: ChartUnit; sizeLabel?: string; sizeUnit?: ChartUnit; itemLabel?: string },
): ChartTable {
  const cols: ChartTableColumn[] = [
    { key: 'item', label: opts.itemLabel ?? 'Company' },
    { key: 'x', label: opts.xLabel, unit: opts.xUnit },
    { key: 'y', label: opts.yLabel, unit: opts.yUnit },
  ];
  if (opts.sizeLabel) cols.push({ key: 'size', label: opts.sizeLabel, unit: opts.sizeUnit ?? 'money' });
  return {
    caption: opts.caption,
    columns: cols,
    rows: points.map((p) => ({ key: p.key, cells: opts.sizeLabel ? [p.label, p.x, p.y, p.size ?? null] : [p.label, p.x, p.y] })),
  };
}

// ─────────────────────────────────────────────────────────── CSV

/**
 * CSV / formula injection (CWE-1236): a TEXT cell starting with = + - @ (or TAB / CR, or
 * the full-width ＝ ＋ － ＠) is executed by Excel / Sheets as a formula. Such a cell gets a
 * leading single quote so it is shown as text. Numeric cells are emitted from numbers (never
 * through here) and a plain signed number / percent string ("-12.5%", "+3", "-1,500.25")
 * can't be a formula, so both stay numeric. Same rule as lib/reports/export/csv.ts.
 */
const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
const PLAIN_NUMBER = /^[+-]?\d[\d,]*(\.\d+)?%?$/;

export function neutralizeCsvFormula(v: string): string {
  if (!FORMULA_START.test(v) || PLAIN_NUMBER.test(v)) return v;
  return `'${v}`;
}

function esc(raw: string): string {
  const v = neutralizeCsvFormula(raw);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * CSV a controller can pivot: money as plain decimal dollars (1234.56, from
 * integer cents at the edge), percent as "13.1%" (Excel reads it as 0.131),
 * gaps as EMPTY cells (never 0). Same convention as lib/reports/export/csv.ts.
 */
export function chartTableToCsv(t: ChartTable, meta: string[] = []): string {
  const out: string[] = [];
  out.push(esc(t.caption));
  for (const m of meta) out.push(esc(m));
  out.push('');
  out.push(t.columns.map((c) => esc(c.unit === 'money' ? `${c.label} ($)` : c.label)).join(','));
  for (const r of t.rows) {
    out.push(
      r.cells
        .map((cell, j) => {
          const col = t.columns[j];
          if (cell === null || cell === undefined) return '';
          if (typeof cell === 'string') return esc(cell);
          if (!Number.isFinite(cell)) return '';
          switch (col?.unit) {
            case 'money':
              return centsToDecimal(cell);
            case 'percent':
              return `${trimNum(cell * 100, 4)}%`;
            default:
              return trimNum(cell, 6);
          }
        })
        .join(','),
    );
  }
  for (const n of t.notes ?? []) out.push(esc(n));
  return out.join('\r\n');
}

/** Integer cents → "1234.56" with integer arithmetic (no float money). */
export function centsToDecimal(cents: number): string {
  const c = Math.round(cents);
  const neg = c < 0;
  const abs = Math.abs(c);
  const rem = abs % 100;
  const whole = (abs - rem) / 100;
  return `${neg ? '-' : ''}${whole}.${rem < 10 ? `0${rem}` : rem}`;
}

function trimNum(n: number, decimals: number): string {
  return String(Number(n.toFixed(decimals)));
}
