/**
 * Flux line computer (FPB-financial-reports §5 A-3E.1/A-3E.2) — pure.
 *
 * Inputs are already-aggregated ledger cells (debit − credit per account × month, and
 * each account's ending balance at the closing month end); outputs are signed, ranked
 * flux lines with the threshold applied. The loader (`./load.ts`) produces the inputs
 * from the posted GL behind the `FluxBalanceSource` seam, so the 3A report engine's
 * period balances can replace the GL read without touching this file.
 *
 *   • P&L accounts compare period ACTIVITY; balance-sheet accounts compare ENDING balances.
 *   • Every figure is signed in the account's normal balance (`normalBalanceFor`).
 *   • Department / class splits apply to P&L accounts; balance-sheet lines stay per account.
 *   • BUDGET compares P&L lines to the month's budget; BS lines (and class splits, which
 *     budgets don't carry) fall back to PRIOR_MONTH and say so in `basisUsed`.
 */

import { normalBalanceFor } from '@/lib/posting/account-direction';
import { evaluateMateriality, pctChangeBps, resolveThreshold } from './materiality';
import type { ComparisonBasis, FluxAccount, FluxDimension, FluxLine, FluxPolicy, Statement } from './types';

// ── period keys ────────────────────────────────────────────────────────────────

export function periodKeyOf(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** Shift a 'YYYY-MM' key by n months (negative = earlier). */
export function shiftPeriod(key: string, n: number): string {
  const [y, m] = key.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return periodKeyOf(Math.floor(idx / 12), (idx % 12) + 1);
}

/** First and last calendar day of a 'YYYY-MM' key (ISO dates). */
export function monthBounds(key: string): { start: string; end: string } {
  const [y, m] = key.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${key}-01`, end: `${key}-${String(last).padStart(2, '0')}` };
}

export function periodLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** How many months back the comparison needs (activity must cover [M − n, M]). */
export function lookbackMonths(basis: ComparisonBasis): number {
  switch (basis) {
    case 'PRIOR_YEAR_MONTH': return 12;
    case 'TRAILING_3_AVG': return 3;
    default: return 1;
  }
}

/** Trailing series length (sparkline points, ending at the closing month). */
export const TRAILING_POINTS = 6;

// ── statement / line keys ──────────────────────────────────────────────────────

export function statementOf(type: FluxAccount['type']): Statement {
  return type === 'ASSET' || type === 'LIABILITY' || type === 'EQUITY' ? 'BS' : 'PNL';
}

export function lineKeyFor(accountId: string, statement: Statement, dimension: FluxDimension, departmentId: string | null, classId: string | null): string {
  if (statement === 'BS' || dimension === 'ACCOUNT') return accountId;
  if (dimension === 'ACCOUNT_DEPARTMENT') return `${accountId}|d:${departmentId ?? 'none'}`;
  return `${accountId}|c:${classId ?? 'none'}`;
}

export function parseLineKey(lineKey: string): { accountId: string; departmentId: string | null; classId: string | null; dim: 'd' | 'c' | null } {
  const [accountId, rest] = lineKey.split('|');
  if (!rest) return { accountId, departmentId: null, classId: null, dim: null };
  const [k, v] = rest.split(':');
  const id = v && v !== 'none' ? v : null;
  return k === 'd'
    ? { accountId, departmentId: id, classId: null, dim: 'd' }
    : { accountId, departmentId: null, classId: id, dim: 'c' };
}

/** Half-away-from-zero integer mean (cents stay integers). */
export function roundedMean(values: number[]): number {
  if (values.length === 0) return 0;
  const sum = values.reduce((a, b) => a + b, 0);
  const m = Math.round(Math.abs(sum) / values.length);
  return sum < 0 ? -m : m;
}

// ── inputs ─────────────────────────────────────────────────────────────────────

/** Σ(debit − credit) for one account (× dimension) in one month. */
export interface ActivityCell {
  accountId: string;
  departmentId: string | null;
  classId: string | null;
  periodKey: string;
  netDebitCents: number;
}

export interface ComputeFluxInput {
  periodKey: string;
  accounts: FluxAccount[];
  policy: FluxPolicy;
  activity: ActivityCell[];
  /** Ending debit − credit balance per account at the closing month end (BS accounts). */
  closingBalanceDebit: Map<string, number>;
  /** Normal-signed budget for the closing month, keyed by line key (BUDGET basis). */
  budget?: Map<string, number> | null;
  /** Optional dimension display names. */
  dimensionNames?: Map<string, string>;
}

export interface ComputeFluxResult {
  lines: FluxLine[];
  excludedCount: number;
}

/**
 * Build every in-scope flux line for the closing month. Lines whose current, comparison
 * and trailing values are all zero are omitted. Sorted: material first, then by |change|.
 */
export function computeFluxLines(input: ComputeFluxInput): ComputeFluxResult {
  const { periodKey, policy } = input;
  const acctById = new Map(input.accounts.map((a) => [a.id, a]));

  // activity[lineKey][periodKey] = Σ debit − credit
  const act = new Map<string, Map<string, number>>();
  // BS: activity per account (for back-solving earlier ending balances)
  const bsAct = new Map<string, Map<string, number>>();
  const lineMeta = new Map<string, { accountId: string; departmentId: string | null; classId: string | null }>();

  for (const c of input.activity) {
    const a = acctById.get(c.accountId);
    if (!a) continue;
    const st = statementOf(a.type);
    const key = lineKeyFor(a.id, st, policy.dimension, c.departmentId, c.classId);
    if (!lineMeta.has(key)) {
      lineMeta.set(key, {
        accountId: a.id,
        departmentId: st === 'PNL' && policy.dimension === 'ACCOUNT_DEPARTMENT' ? c.departmentId : null,
        classId: st === 'PNL' && policy.dimension === 'ACCOUNT_CLASS' ? c.classId : null,
      });
    }
    const target = st === 'BS' ? bsAct : act;
    const tkey = st === 'BS' ? a.id : key;
    const m = target.get(tkey) ?? new Map<string, number>();
    m.set(c.periodKey, (m.get(c.periodKey) ?? 0) + c.netDebitCents);
    target.set(tkey, m);
  }
  for (const accountId of input.closingBalanceDebit.keys()) {
    const a = acctById.get(accountId);
    if (a && statementOf(a.type) === 'BS' && !lineMeta.has(accountId)) {
      lineMeta.set(accountId, { accountId, departmentId: null, classId: null });
    }
  }
  if (input.budget) {
    for (const key of input.budget.keys()) {
      const { accountId, departmentId, classId } = parseLineKey(key);
      const a = acctById.get(accountId);
      if (a && statementOf(a.type) === 'PNL' && !lineMeta.has(key)) lineMeta.set(key, { accountId, departmentId, classId });
    }
  }

  const lines: FluxLine[] = [];
  let excludedCount = 0;

  for (const [key, meta] of lineMeta) {
    const a = acctById.get(meta.accountId);
    if (!a) continue;
    const st = statementOf(a.type);
    if (st === 'PNL' && !policy.includePnl) continue;
    if (st === 'BS' && !policy.includeBalanceSheet) continue;

    const sign = normalBalanceFor(a.type, a.subType) === 'DEBIT' ? 1 : -1;

    // `|| 0` folds −0 (sign × 0) into 0 so figures compare and serialize cleanly.
    const valueAt = (pk: string): number => {
      if (st === 'PNL') return sign * (act.get(key)?.get(pk) ?? 0) || 0;
      // BS ending balance at pk = closing − Σ activity in months (pk, M].
      const closing = input.closingBalanceDebit.get(a.id) ?? 0;
      const months = bsAct.get(a.id);
      let after = 0;
      if (months) for (const [mk, v] of months) if (mk > pk && mk <= periodKey) after += v;
      return sign * (closing - after) || 0;
    };

    let basisUsed: ComparisonBasis = policy.comparisonBasis;
    if (basisUsed === 'BUDGET' && (st === 'BS' || policy.dimension === 'ACCOUNT_CLASS' || !input.budget)) basisUsed = 'PRIOR_MONTH';

    const current = valueAt(periodKey);
    let comparison: number;
    switch (basisUsed) {
      case 'PRIOR_YEAR_MONTH':
        comparison = valueAt(shiftPeriod(periodKey, -12));
        break;
      case 'TRAILING_3_AVG':
        comparison = roundedMean([1, 2, 3].map((n) => valueAt(shiftPeriod(periodKey, -n))));
        break;
      case 'BUDGET':
        comparison = (input.budget?.get(key) ?? 0) || 0;
        break;
      default:
        comparison = valueAt(shiftPeriod(periodKey, -1));
    }
    const trailing = Array.from({ length: TRAILING_POINTS }, (_, i) => {
      const pk = shiftPeriod(periodKey, i - (TRAILING_POINTS - 1));
      return { periodKey: pk, cents: valueAt(pk) };
    });
    if (current === 0 && comparison === 0 && trailing.every((t) => t.cents === 0)) continue;

    const change = current - comparison;
    const pct = pctChangeBps(change, comparison);
    const threshold = resolveThreshold(policy, a);
    if (threshold.excluded) excludedCount += 1;
    const { material, breaches } = evaluateMateriality(change, pct, threshold);

    const dimId = meta.departmentId ?? meta.classId;
    const dimensionLabel = key.includes('|')
      ? dimId
        ? input.dimensionNames?.get(dimId) ?? (meta.departmentId ? 'Department' : 'Class')
        : key.includes('|d:') ? 'No department' : 'No class'
      : null;

    lines.push({
      lineKey: key,
      accountId: a.id,
      accountNumber: a.number,
      accountName: a.name,
      accountType: a.type,
      groupName: a.groupName,
      statement: st,
      departmentId: meta.departmentId,
      classId: meta.classId,
      dimensionLabel,
      currentCents: current,
      comparisonCents: comparison,
      changeCents: change,
      changePctBps: pct,
      basisUsed,
      threshold,
      material,
      breaches,
      trailing,
    });
  }

  lines.sort(
    (x, y) =>
      Number(y.material) - Number(x.material) ||
      Math.abs(y.changeCents) - Math.abs(x.changeCents) ||
      x.accountNumber.localeCompare(y.accountNumber) ||
      x.lineKey.localeCompare(y.lineKey),
  );
  return { lines, excludedCount };
}
