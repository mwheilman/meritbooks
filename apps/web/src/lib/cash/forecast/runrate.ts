/**
 * Budgeted opex run-rate with the no-double-counting rule (AC-CF3) — pure.
 *
 * The run-rate covers spend no other source sees (utilities, supplies, fuel, repairs …). For each
 * company × month in the horizon:
 *   run-rate(account) = monthly basis(account)            (published budget, or trailing-3M actual)
 *                       − Σ open-bill lines and manual OUT items coded to the account that month
 *   floored at 0, and accounts whose FAMILY another source already carries contribute nothing:
 *     PAYROLL     when the company has an active pay schedule (payroll source)
 *     RENT_LEASE  when the company has an active lease
 *     INTEREST    when the company has scheduled debt service
 *     NON_CASH    always (depreciation, amortization, bad debt, impairment)
 *     INCOME_TAX  always (estimated tax is its own setting)
 * The remaining month amount is prorated to the days of the month inside the horizon and spread
 * evenly per day (largest remainder, so the cents tie), then grouped into one item per week.
 */

import { allocateCents } from '@/lib/analytics/numbers';
import { addDays, daysInMonth, maxIso, minIso, mondayOf, parseIso } from './dates';
import type { ForecastItem } from './types';

export type AccountFamily = 'PAYROLL' | 'RENT_LEASE' | 'INTEREST' | 'NON_CASH' | 'INCOME_TAX' | 'OTHER';

const ROLE_FAMILY: Readonly<Record<string, AccountFamily>> = {
  WAGES_EXPENSE: 'PAYROLL',
  PAYROLL_TAX_EXPENSE: 'PAYROLL',
  HEALTH_INSURANCE_EXPENSE: 'PAYROLL',
  RETIREMENT_MATCH_EXPENSE: 'PAYROLL',
  WORKERS_COMP_EXPENSE: 'PAYROLL',
  INTEREST_EXPENSE: 'INTEREST',
  INCOME_TAX_EXPENSE: 'INCOME_TAX',
  BAD_DEBT_EXPENSE: 'NON_CASH',
};

/** Classify an expense account by role first, then by name / group wording (never by number). */
export function classifyFamily(a: { name: string; groupName?: string | null; roleKeys?: readonly string[] }): AccountFamily {
  for (const r of a.roleKeys ?? []) {
    const f = ROLE_FAMILY[r];
    if (f) return f;
  }
  const text = `${a.name} ${a.groupName ?? ''}`.toLowerCase();
  if (/depreciation|amortization|amortisation|bad debt|impairment|unrealized/.test(text)) return 'NON_CASH';
  if (/income tax/.test(text)) return 'INCOME_TAX';
  if (/interest/.test(text)) return 'INTEREST';
  if (/wage|salar|payroll|bonus|commission|401\s?k|benefit|health ins|workers.?comp|labor|labour|fica|futa|suta/.test(text)) return 'PAYROLL';
  if (/\brent\b|lease/.test(text)) return 'RENT_LEASE';
  return 'OTHER';
}

export interface MonthlyBasisRow {
  companyId: string;
  accountId: string;
  /** 'YYYY-MM' */
  month: string;
  cents: number;
}

export interface CountedRow {
  companyId: string;
  accountId: string;
  month: string;
  cents: number;
}

export interface RunRateInput {
  basis: readonly MonthlyBasisRow[];
  counted: readonly CountedRow[];
  families: ReadonlyMap<string, AccountFamily>;
  accountNames?: ReadonlyMap<string, string>;
  /** Families carried by another source, per company. */
  coveredFamilies: (companyId: string) => ReadonlySet<AccountFamily>;
  today: string;
  horizonEnd: string;
  basisLabel: string;
}

export interface RunRateMonth {
  companyId: string;
  month: string;
  basisCents: number;
  excludedCents: number;
  countedCents: number;
  /** For the whole month (before proration). */
  runRateCents: number;
  /** Prorated to the days inside the horizon. */
  inHorizonCents: number;
}

export const ALWAYS_EXCLUDED: ReadonlySet<AccountFamily> = new Set<AccountFamily>(['NON_CASH', 'INCOME_TAX']);

export function computeRunRate(input: RunRateInput): { items: ForecastItem[]; months: RunRateMonth[] } {
  const counted = new Map<string, number>();
  for (const c of input.counted) {
    const k = `${c.companyId}|${c.accountId}|${c.month}`;
    counted.set(k, (counted.get(k) ?? 0) + Math.max(0, Math.round(c.cents)));
  }
  // company|month → { basis, excluded, counted, run, perAccount }
  const agg = new Map<string, { basis: number; excluded: number; counted: number; run: number; perAccount: Map<string, number> }>();
  for (const b of input.basis) {
    const cents = Math.round(b.cents);
    if (!(cents > 0)) continue;
    const key = `${b.companyId}|${b.month}`;
    const a = agg.get(key) ?? { basis: 0, excluded: 0, counted: 0, run: 0, perAccount: new Map<string, number>() };
    a.basis += cents;
    const fam = input.families.get(b.accountId) ?? 'OTHER';
    if (ALWAYS_EXCLUDED.has(fam) || input.coveredFamilies(b.companyId).has(fam)) {
      a.excluded += cents;
    } else {
      const already = Math.min(cents, counted.get(`${b.companyId}|${b.accountId}|${b.month}`) ?? 0);
      a.counted += already;
      const left = cents - already;
      a.run += left;
      if (left > 0) a.perAccount.set(b.accountId, (a.perAccount.get(b.accountId) ?? 0) + left);
    }
    agg.set(key, a);
  }

  const items: ForecastItem[] = [];
  const months: RunRateMonth[] = [];
  // company → weekStart → { cents, breakdown }
  const weekly = new Map<string, Map<string, { cents: number; parts: Map<string, number> }>>();

  for (const [key, a] of agg) {
    const [companyId, month] = key.split('|');
    const [y, m] = month.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const first = `${month}-01`;
    const last = `${month}-${String(dim).padStart(2, '0')}`;
    const from = maxIso(first, input.today);
    const to = minIso(last, input.horizonEnd);
    const days = from <= to ? Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / 86_400_000) + 1 : 0;
    const inHorizon = days > 0 ? Math.round((a.run * days) / dim) : 0;
    months.push({ companyId, month, basisCents: a.basis, excludedCents: a.excluded, countedCents: a.counted, runRateCents: a.run, inHorizonCents: inHorizon });
    if (inHorizon <= 0) continue;
    const perDay = allocateCents(inHorizon, Array.from({ length: days }, () => 1));
    const byWeek = weekly.get(companyId) ?? new Map<string, { cents: number; parts: Map<string, number> }>();
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const wk = mondayOf(d);
      const slot = byWeek.get(wk) ?? { cents: 0, parts: new Map<string, number>() };
      slot.cents += perDay[i];
      byWeek.set(wk, slot);
    }
    // Account breakdown, prorated the same way (for the drill — display only).
    for (const [acct, c] of a.perAccount) {
      const share = Math.round((c * days) / dim);
      const wks = Array.from(new Set(Array.from({ length: days }, (_, i) => mondayOf(addDays(from, i)))));
      for (const wk of wks) {
        const slot = byWeek.get(wk);
        if (slot) slot.parts.set(acct, (slot.parts.get(acct) ?? 0) + Math.round(share / wks.length));
      }
    }
    weekly.set(companyId, byWeek);
  }

  for (const [companyId, byWeek] of weekly) {
    for (const [wk, slot] of Array.from(byWeek.entries()).sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      if (slot.cents <= 0) continue;
      const date = maxIso(wk, input.today);
      items.push({
        key: `runrate:${companyId}:${wk}`,
        companyId,
        direction: 'OUT',
        category: 'OPEX_RUNRATE',
        date,
        amountCents: slot.cents,
        grossCents: slot.cents,
        probability: 1,
        certainty: 'ESTIMATED',
        label: `Budgeted opex not otherwise counted (week of ${wk})`,
        party: null,
        partyId: null,
        source: { kind: 'BUDGET', id: null },
        note: `${input.basisLabel}, less bills and items already in the forecast; payroll, rent, interest and non-cash accounts excluded.`,
        breakdown: Array.from(slot.parts.entries())
          .sort((x, y) => y[1] - x[1])
          .slice(0, 8)
          .map(([acct, c]) => ({ label: input.accountNames?.get(acct) ?? acct, cents: c })),
      });
    }
  }
  return { items, months };
}

/** Month keys ('YYYY-MM') touched by [today, horizonEnd]. */
export function horizonMonths(today: string, horizonEnd: string): string[] {
  const out: string[] = [];
  let k = today.slice(0, 7);
  const end = horizonEnd.slice(0, 7);
  let guard = 0;
  while (k <= end && guard++ < 24) {
    out.push(k);
    const [y, m] = k.split('-').map(Number);
    k = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}

/** Items already in the forecast that code to an account, by company × account × month (dedupe input). */
export function countedFromItems(items: readonly ForecastItem[]): CountedRow[] {
  const out: CountedRow[] = [];
  for (const it of items) {
    if (it.direction !== 'OUT' || !it.companyId) continue;
    const month = it.date.slice(0, 7);
    if (it.accountSplit && it.accountSplit.length > 0) {
      for (const a of it.accountSplit) out.push({ companyId: it.companyId, accountId: a.accountId, month, cents: a.cents });
    } else if (it.accountId) {
      out.push({ companyId: it.companyId, accountId: it.accountId, month, cents: it.amountCents });
    }
  }
  return out;
}
