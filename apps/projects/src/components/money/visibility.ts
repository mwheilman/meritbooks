/**
 * Who sees which money (Wave 0a spec §2.3, §5). Pure and client-safe: server pages call
 * moneyVisFor(access, companyId); client components read the same answer from the shell
 * (useMoneyVis). RLS and maskMoney are the boundary — this decides what the screen draws, so a
 * masked figure never renders as a misleading $0.
 *
 *   cost      projects.financials:view      cost, budget, committed, actual, margin, WIP, job cost
 *   contract  projects.contract_value:view  contract / sell price, change-order and invoice amounts
 *   rates     projects.labor_rates:view     individual pay rates and burden
 *
 * Derived figures follow their inputs: margin needs cost AND contract; a budget-used bar shows
 * hours when the level is 2 or below.
 */
import type { Access, MoneyLevel } from '@/lib/access/types';

export interface MoneyVis {
  cost: boolean;
  contract: boolean;
  rates: boolean;
  level: MoneyLevel;
}

/** Fail closed: no money until the shell says otherwise. */
export const NO_MONEY: MoneyVis = { cost: false, contract: false, rates: false, level: 1 };

/** Everything (tests and screens that are already behind a money page guard). */
export const ALL_MONEY: MoneyVis = { cost: true, contract: true, rates: true, level: 4 };

type GrantSource = Pick<Access, 'grants' | 'byCompany' | 'moneyLevel'>;

function grantsOf(access: GrantSource, companyId?: string | null): ReadonlySet<string> {
  if (companyId) return access.byCompany[companyId] ?? new Set<string>();
  return access.grants;
}

/** Money visibility for one company (or the union when no company is named). */
export function moneyVisFor(access: GrantSource, companyId?: string | null): MoneyVis {
  return moneyVisFromGrants(grantsOf(access, companyId), access.moneyLevel);
}

export function moneyVisFromGrants(grants: Iterable<string>, accessLevel: MoneyLevel): MoneyVis {
  const set = grants instanceof Set ? (grants as ReadonlySet<string>) : new Set(grants);
  const cost = set.has('projects.financials:view');
  const contract = set.has('projects.contract_value:view');
  const rates = set.has('projects.labor_rates:view');
  const derived: MoneyLevel = cost && contract && rates ? 4 : cost || contract ? 3 : accessLevel >= 2 ? 2 : 1;
  return { cost, contract, rates, level: Math.min(derived, accessLevel) as MoneyLevel };
}

/** Margin, markup and anything else computed from both sides. */
export function seesMargin(m: MoneyVis): boolean {
  return m.cost && m.contract;
}

/** Keep an item only when its flag is on: `[...when(m.cost, col)]`. */
export function when<T>(on: boolean, ...xs: T[]): T[] {
  return on ? xs : [];
}
