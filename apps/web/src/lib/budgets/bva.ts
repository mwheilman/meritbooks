/**
 * Department budget vs actual vs prior year (Wave 4B, AC-B16) — pure composition over cents maps
 * the service loads from the GL and the current budget version. 3B's variance helpers decide
 * favourable / unfavourable and materiality so this agrees with every other BvA in the product.
 */
import { addMonths, isMaterial, natureOfAccountType, varianceVerdict, type MonthKey } from '@/lib/analytics';
import type { AccountLite, BvaLine, BvaSection, BvaWindow, VarianceNote } from './types';

export function monthKey(year: number, month: number): MonthKey {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Calendar months of a window ending at (fiscalYear, month). Period n = calendar month n (the budgets convention). */
export function windowMonths(fiscalYear: number, month: number, window: BvaWindow): MonthKey[] {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('month must be 1–12');
  const end = monthKey(fiscalYear, month);
  let count: number;
  switch (window) {
    case 'MONTH': count = 1; break;
    case 'QTD': count = ((month - 1) % 3) + 1; break;
    case 'YTD': count = month; break;
    case 'TTM': count = 12; break;
  }
  const out: MonthKey[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addMonths(end, -i));
  return out;
}

export function priorYearMonths(months: readonly MonthKey[]): MonthKey[] {
  return months.map((m) => addMonths(m, -12));
}

export function windowLabel(fiscalYear: number, month: number, window: BvaWindow): string {
  const mon = new Date(Date.UTC(fiscalYear, month - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  switch (window) {
    case 'MONTH': return `${mon} ${fiscalYear}`;
    case 'QTD': return `Q${Math.ceil(month / 3)} ${fiscalYear} to date (through ${mon})`;
    case 'YTD': return `Year to date through ${mon} ${fiscalYear}`;
    case 'TTM': return `Twelve months to ${mon} ${fiscalYear}`;
  }
}

/** Cents keyed by `${accountId}|${YYYY-MM}`, natural sign. */
export type CentsByAccountMonth = ReadonlyMap<string, number>;

export function cellKey(accountId: string, month: MonthKey): string {
  return `${accountId}|${month}`;
}

function sumOver(map: CentsByAccountMonth, accountId: string, months: readonly MonthKey[]): number {
  let t = 0;
  for (const m of months) t += map.get(cellKey(accountId, m)) ?? 0;
  return t;
}

export interface BvaInput {
  accounts: ReadonlyMap<string, AccountLite>;
  actual: CentsByAccountMonth;
  budget: CentsByAccountMonth;
  months: readonly MonthKey[];
  pyMonths: readonly MonthKey[];
  materialityCents: number;
  materialityBps: number;
  explanations?: ReadonlyMap<string, VarianceNote>;
}

export interface BvaOutput {
  lines: BvaLine[];
  sections: BvaSection[];
  totals: { actualCents: number; budgetCents: number; pyCents: number; measure: 'contribution' | 'spend' };
  materialCount: number;
}

const SECTION_OF: Record<string, BvaSection['key']> = { REVENUE: 'revenue', COGS: 'cogs', OPEX: 'opex', OTHER: 'other' };
const SECTION_LABEL: Record<BvaSection['key'], string> = {
  revenue: 'Revenue',
  cogs: 'Cost of revenue',
  opex: 'Operating expenses',
  other: 'Other income & expense',
};

/** Signed contribution of a natural amount: income +, expense −. */
export function contributionOf(nature: 'income' | 'expense', naturalCents: number): number {
  return nature === 'income' ? naturalCents : -naturalCents;
}

export function departmentBva(i: BvaInput): BvaOutput {
  const ids = new Set<string>();
  for (const k of [...i.actual.keys(), ...i.budget.keys()]) ids.add(k.slice(0, k.indexOf('|')));
  const rule = { amountCents: i.materialityCents, pct: i.materialityBps > 0 ? i.materialityBps / 10000 : undefined, mode: 'or' as const };
  const lines: BvaLine[] = [];
  for (const id of ids) {
    const a = i.accounts.get(id);
    if (!a) continue;
    const nature = natureOfAccountType(a.type, a.subType);
    if (!nature) continue; // balance-sheet accounts are not part of a department P&L
    const actualCents = sumOver(i.actual, id, i.months);
    const budgetCents = sumOver(i.budget, id, i.months);
    const pyCents = sumOver(i.actual, id, i.pyMonths);
    if (actualCents === 0 && budgetCents === 0 && pyCents === 0) continue;
    const varianceCents = actualCents - budgetCents;
    const pyChangeCents = actualCents - pyCents;
    lines.push({
      accountId: id,
      accountNumber: a.number,
      accountName: a.name,
      accountType: a.type,
      groupName: a.groupName,
      nature,
      actualCents,
      budgetCents,
      pyCents,
      varianceCents,
      variancePct: budgetCents === 0 ? null : varianceCents / Math.abs(budgetCents),
      pyChangeCents,
      pyChangePct: pyCents === 0 ? null : pyChangeCents / Math.abs(pyCents),
      verdict: varianceVerdict(nature, varianceCents),
      material: isMaterial(varianceCents, budgetCents, rule),
      explanation: i.explanations?.get(id) ?? null,
    });
  }
  lines.sort((x, y) => x.accountNumber.localeCompare(y.accountNumber, undefined, { numeric: true }));

  const sections: BvaSection[] = [];
  for (const key of ['revenue', 'cogs', 'opex', 'other'] as const) {
    const ls = lines.filter((l) => SECTION_OF[l.accountType] === key);
    if (ls.length === 0) continue;
    // "Other" mixes income and expense: present it as a net expense (income negative).
    const v = (f: (l: BvaLine) => number) => ls.reduce((t, l) => t + (key === 'other' && l.nature === 'income' ? -f(l) : f(l)), 0);
    sections.push({ key, label: SECTION_LABEL[key], actualCents: v((l) => l.actualCents), budgetCents: v((l) => l.budgetCents), pyCents: v((l) => l.pyCents) });
  }

  const measure: 'contribution' | 'spend' = lines.some((l) => l.nature === 'income') ? 'contribution' : 'spend';
  const total = (f: (l: BvaLine) => number) =>
    lines.reduce((t, l) => t + (measure === 'contribution' ? contributionOf(l.nature, f(l)) : l.nature === 'expense' ? f(l) : -f(l)), 0);
  return {
    lines,
    sections,
    totals: { actualCents: total((l) => l.actualCents), budgetCents: total((l) => l.budgetCents), pyCents: total((l) => l.pyCents), measure },
    materialCount: lines.filter((l) => l.material).length,
  };
}
