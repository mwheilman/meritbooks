/**
 * Resolve a budget template against a tenant's chart of accounts and draft the months (Wave 4B,
 * AC-B14). Pure. Accounts are matched by type / sub-type / group / name (safe `|` / `*` patterns,
 * ./pattern.ts — never a RegExp) — never by number; a line
 * that matches nothing is returned in `missing`, never invented.
 *
 *   - Growth lines (PY_GROWTH / PRIOR_BUDGET_GROWTH) expand to every matching account that had
 *     prior-year activity in the department (else the best match), so "Revenue +6%" covers every
 *     revenue account the department actually used.
 *   - Every other method lands on the single best match (name match beats group match; then the
 *     lowest account number).
 *   - An account claimed by an earlier line is not reused.
 *   - A driver whose inputs are blank (a rate of 0, no units) falls back to last year + the line's
 *     growth, and says so.
 */
import { sum } from '@/lib/analytics';
import { generate, specFrom, type Generated } from '../generators';
import type { AccountLite, BudgetTemplate, DriverSpec, TemplateLine, TemplatePreviewLine } from '../types';
import { compilePattern, type Matcher } from './pattern';

/** undefined = no pattern; null = a pattern that isn't allowed (the line then matches nothing). */
function pat(src: string | undefined): Matcher | null | undefined {
  if (!src) return undefined;
  return compilePattern(src);
}

/** 2 = name match, 1 = group match, 0.5 = type-only line, 0 = no match. Safe patterns only (./pattern). */
export function matchScore(line: TemplateLine, a: AccountLite): number {
  const sel = line.selector;
  if (!sel.types.includes(a.type as TemplateLine['selector']['types'][number])) return 0;
  if (sel.subTypes && sel.subTypes.length > 0 && !sel.subTypes.includes(a.subType)) return 0;
  const not = pat(sel.notName);
  const name = pat(sel.name);
  const group = pat(sel.group);
  if (not === null || name === null || group === null) return 0;
  if (not && not(a.name)) return 0;
  if (!name && !group) return 0.5;
  if (name && name(a.name)) return 2;
  if (group && a.groupName && group(a.groupName)) return 1;
  return 0;
}

export interface ResolvedLine {
  line: TemplateLine;
  accounts: AccountLite[];
}

export interface Resolution {
  resolved: ResolvedLine[];
  missing: TemplateLine[];
}

const GROWTH_METHODS = new Set(['PY_GROWTH', 'PRIOR_BUDGET_GROWTH']);

export function resolveTemplate(
  t: Pick<BudgetTemplate, 'lines'>,
  accounts: readonly AccountLite[],
  pyTotals: ReadonlyMap<string, number> = new Map(),
): Resolution {
  const claimed = new Set<string>();
  const resolved: ResolvedLine[] = [];
  const missing: TemplateLine[] = [];
  for (const line of t.lines) {
    const scored = accounts
      .filter((a) => !claimed.has(a.id))
      .map((a) => ({ a, s: matchScore(line, a) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || x.a.number.localeCompare(y.a.number, undefined, { numeric: true }));
    if (scored.length === 0) {
      missing.push(line);
      continue;
    }
    let picked: AccountLite[];
    if (GROWTH_METHODS.has(line.method)) {
      const withPy = scored.filter((x) => (pyTotals.get(x.a.id) ?? 0) !== 0).map((x) => x.a);
      picked = withPy.length > 0 ? withPy : [scored[0].a];
    } else {
      picked = [scored[0].a];
    }
    for (const a of picked) claimed.add(a.id);
    resolved.push({ line, accounts: picked });
  }
  return { resolved, missing };
}

export interface PlanContext {
  /** Prior-year actuals per account, periods 1..12 (natural sign). */
  pyMonthsByAccount: ReadonlyMap<string, readonly number[]>;
  /** Prior-year budget per account, periods 1..12. */
  priorBudgetByAccount?: ReadonlyMap<string, readonly number[]>;
  /** Revenue already budgeted for the department outside this template (periods 1..12). */
  existingRevenueMonths?: readonly number[];
  /** Override every growth line's % (the "start from last year +x%" knob). */
  growthOverrideBps?: number | null;
}

function needsFallback(spec: DriverSpec): boolean {
  switch (spec.method) {
    case 'HEADCOUNT_RATE': return spec.monthlyRateCents === 0 || spec.headcount === 0;
    case 'UNITS_RATE': return spec.unitsPerMonth === 0 || spec.rateCents === 0;
    case 'FIXED_MONTHLY': return spec.monthlyCents === 0;
    case 'ANNUAL_EVEN':
    case 'ANNUAL_SEASONAL': return spec.annualCents === 0;
    default: return false;
  }
}

/** Draft months for every resolved account. Income lines first, so % of revenue sees them. */
export function planTemplate(
  t: Pick<BudgetTemplate, 'lines'>,
  accounts: readonly AccountLite[],
  ctx: PlanContext,
): { lines: TemplatePreviewLine[]; missing: TemplateLine[] } {
  const pyTotals = new Map<string, number>();
  for (const [id, ms] of ctx.pyMonthsByAccount) pyTotals.set(id, sum([...ms]));
  const { resolved, missing } = resolveTemplate(t, accounts, pyTotals);
  const isIncome = (a: AccountLite) => a.type === 'REVENUE' || (a.type === 'OTHER' && a.subType === 'OTHER_INCOME');
  const revenue = Array.from({ length: 12 }, (_, i) => ctx.existingRevenueMonths?.[i] ?? 0);
  const out: TemplatePreviewLine[] = [];
  const order = [...resolved].sort((x, y) => Number(!isIncome(x.accounts[0])) - Number(!isIncome(y.accounts[0])));
  for (const r of order) {
    for (const a of r.accounts) {
      let spec = specFrom(r.line.method, r.line.params);
      if ((spec.method === 'PY_GROWTH' || spec.method === 'PRIOR_BUDGET_GROWTH') && ctx.growthOverrideBps != null) {
        spec = { ...spec, growthBps: ctx.growthOverrideBps };
      }
      const py = ctx.pyMonthsByAccount.get(a.id);
      let g: Generated;
      if (needsFallback(spec)) {
        const growthBps = ctx.growthOverrideBps ?? r.line.params.growthBps ?? 0;
        g = generate({ method: 'PY_GROWTH', growthBps }, { pyMonths: py });
        g = { ...g, explain: `${g.explain} (the template’s driver needs inputs — set them in the driver panel)` };
      } else {
        g = generate(spec, { pyMonths: py, priorBudgetMonths: ctx.priorBudgetByAccount?.get(a.id), revenueMonths: revenue });
      }
      if (isIncome(a)) for (let i = 0; i < 12; i++) revenue[i] += g.months[i];
      out.push({ line: r.line, account: a, months: g.months, annualCents: g.annualCents, explain: g.explain });
    }
  }
  return { lines: out, missing };
}
