/**
 * P&L SPLIT BY A DIMENSION (department or class) — one column per dimension value,
 * an "Unassigned" column for lines with no tag, and a Total column that is exactly
 * the plain P&L for the same period/clients.
 *
 * PURE (no I/O): the route (app/api/reports/pnl-by-dimension) reads posted
 * gl_entry_lines with the same filters as the income statement and hands the flat
 * lines here. The section/sign/subtotal math mirrors app/api/reports/income-statement
 * exactly (normal-balance signed amounts; gross profit = revenue − COGS; EBITDA =
 * gross profit − opex; net income = EBITDA − other) so every column's net income sums
 * to the Total column, and the Total column equals the plain P&L. All bigint cents.
 */

export type PnlAccountType = 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';
export type PnlDimension = 'department' | 'class';

/** One posted GL line, flattened. */
export interface DimensionLine {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: PnlAccountType;
  groupName: string;
  groupOrder: number;
  normalBalance: 'DEBIT' | 'CREDIT';
  /** The line's department_id / class_id; null = untagged. */
  dimensionId: string | null;
  debitCents: number;
  creditCents: number;
}

export interface DimensionValue {
  id: string;
  name: string;
}

/** Column id for lines with no dimension tag. */
export const UNASSIGNED = 'unassigned';

export interface DimensionColumn {
  id: string;
  name: string;
}

/** A row of figures: one value per column id, plus the total. */
export interface SplitFigures {
  byColumn: Record<string, number>;
  totalCents: number;
}

export interface SplitAccount extends SplitFigures {
  accountId: string;
  accountNumber: string;
  accountName: string;
}

export interface SplitGroup extends SplitFigures {
  name: string;
  accounts: SplitAccount[];
}

export interface SplitSection extends SplitFigures {
  type: PnlAccountType;
  label: string;
  groups: SplitGroup[];
}

export interface PnlByDimension {
  dimension: PnlDimension;
  columns: DimensionColumn[];
  sections: SplitSection[];
  summary: {
    revenue: SplitFigures;
    cogs: SplitFigures;
    grossProfit: SplitFigures;
    opex: SplitFigures;
    ebitda: SplitFigures;
    other: SplitFigures;
    netIncome: SplitFigures;
  };
}

export const SECTION_CONFIG: ReadonlyArray<{ type: PnlAccountType; label: string }> = [
  { type: 'REVENUE', label: 'Revenue' },
  { type: 'COGS', label: 'Cost of Goods Sold' },
  { type: 'OPEX', label: 'Operating Expenses' },
  { type: 'OTHER', label: 'Other Income / Expense' },
];

/** Normal-balance signed amount for one line (same rule as the income statement). */
export function signedAmount(l: Pick<DimensionLine, 'normalBalance' | 'debitCents' | 'creditCents'>): number {
  const d = Number(l.debitCents) || 0;
  const c = Number(l.creditCents) || 0;
  return l.normalBalance === 'CREDIT' ? c - d : d - c;
}

function emptyFigures(cols: readonly DimensionColumn[]): SplitFigures {
  const byColumn: Record<string, number> = {};
  for (const c of cols) byColumn[c.id] = 0;
  return { byColumn, totalCents: 0 };
}

function addInto(target: SplitFigures, colId: string, cents: number): void {
  target.byColumn[colId] = (target.byColumn[colId] ?? 0) + cents;
  target.totalCents += cents;
}

function combine(cols: readonly DimensionColumn[], parts: ReadonlyArray<{ f: SplitFigures; sign: 1 | -1 }>): SplitFigures {
  const out = emptyFigures(cols);
  for (const c of cols) out.byColumn[c.id] = parts.reduce((n, p) => n + p.sign * (p.f.byColumn[c.id] ?? 0), 0);
  out.totalCents = parts.reduce((n, p) => n + p.sign * p.f.totalCents, 0);
  return out;
}

/**
 * Columns: every dimension value that has activity OR is in `values` (so an active
 * department with no activity still shows a zero column), sorted by name, then
 * "Unassigned" last when any line is untagged. Unknown ids (inactive/deleted values
 * still on lines) keep their own column labelled by id so nothing silently merges.
 */
export function dimensionColumns(lines: readonly DimensionLine[], values: readonly DimensionValue[]): DimensionColumn[] {
  const names = new Map(values.map((v) => [v.id, v.name]));
  const used = new Set<string>();
  let untagged = false;
  for (const l of lines) {
    if (l.dimensionId) used.add(l.dimensionId);
    else untagged = true;
  }
  const ids = new Set<string>([...values.map((v) => v.id), ...used]);
  const cols = Array.from(ids).map((id) => ({ id, name: names.get(id) ?? `Unknown (${id.slice(0, 8)})` }));
  cols.sort((a, b) => a.name.localeCompare(b.name));
  if (untagged) cols.push({ id: UNASSIGNED, name: 'Unassigned' });
  return cols;
}

export function buildPnlByDimension(
  dimension: PnlDimension,
  lines: readonly DimensionLine[],
  values: readonly DimensionValue[],
): PnlByDimension {
  const columns = dimensionColumns(lines, values);

  // account → figures (+ its metadata)
  const accounts = new Map<string, { meta: DimensionLine; f: SplitFigures }>();
  for (const l of lines) {
    const key = l.accountNumber;
    const entry = accounts.get(key) ?? { meta: l, f: emptyFigures(columns) };
    addInto(entry.f, l.dimensionId ?? UNASSIGNED, signedAmount(l));
    accounts.set(key, entry);
  }

  const sections: SplitSection[] = SECTION_CONFIG.map((cfg) => {
    const accts = Array.from(accounts.values())
      .filter((a) => a.meta.accountType === cfg.type)
      .sort((a, b) => a.meta.groupOrder - b.meta.groupOrder || a.meta.accountNumber.localeCompare(b.meta.accountNumber));
    const groupMap = new Map<string, SplitGroup>();
    for (const a of accts) {
      const g = groupMap.get(a.meta.groupName) ?? { name: a.meta.groupName, accounts: [], ...emptyFigures(columns) };
      g.accounts.push({
        accountId: a.meta.accountId,
        accountNumber: a.meta.accountNumber,
        accountName: a.meta.accountName,
        byColumn: a.f.byColumn,
        totalCents: a.f.totalCents,
      });
      for (const c of columns) addInto(g, c.id, a.f.byColumn[c.id] ?? 0);
      groupMap.set(a.meta.groupName, g);
    }
    const groups = Array.from(groupMap.values());
    const section: SplitSection = { type: cfg.type, label: cfg.label, groups, ...emptyFigures(columns) };
    for (const g of groups) for (const c of columns) addInto(section, c.id, g.byColumn[c.id] ?? 0);
    return section;
  });

  const of = (t: PnlAccountType): SplitFigures => sections.find((s) => s.type === t) ?? { ...emptyFigures(columns) };
  const revenue = of('REVENUE');
  const cogs = of('COGS');
  const opex = of('OPEX');
  const other = of('OTHER');
  const grossProfit = combine(columns, [
    { f: revenue, sign: 1 },
    { f: cogs, sign: -1 },
  ]);
  const ebitda = combine(columns, [
    { f: grossProfit, sign: 1 },
    { f: opex, sign: -1 },
  ]);
  const netIncome = combine(columns, [
    { f: ebitda, sign: 1 },
    { f: other, sign: -1 },
  ]);

  return {
    dimension,
    columns,
    sections,
    summary: {
      revenue: { byColumn: revenue.byColumn, totalCents: revenue.totalCents },
      cogs: { byColumn: cogs.byColumn, totalCents: cogs.totalCents },
      grossProfit,
      opex: { byColumn: opex.byColumn, totalCents: opex.totalCents },
      ebitda,
      other: { byColumn: other.byColumn, totalCents: other.totalCents },
      netIncome,
    },
  };
}

/** The plain (unsplit) P&L totals for the same lines — what the Total column must equal. */
export function plainPnlTotals(lines: readonly DimensionLine[]): {
  revenueCents: number;
  cogsCents: number;
  opexCents: number;
  otherCents: number;
  netIncomeCents: number;
} {
  const sum = (t: PnlAccountType) => lines.filter((l) => l.accountType === t).reduce((n, l) => n + signedAmount(l), 0);
  const revenueCents = sum('REVENUE');
  const cogsCents = sum('COGS');
  const opexCents = sum('OPEX');
  const otherCents = sum('OTHER');
  return { revenueCents, cogsCents, opexCents, otherCents, netIncomeCents: revenueCents - cogsCents - opexCents - otherCents };
}
