/**
 * Role-based statement presentation (PURE) — makes the report engine's balance sheet, its cash
 * flow and the metric registry read the SAME cash, receivables and payables, whatever account
 * groups a tenant's chart happens to use.
 *
 * 1. EFFECTIVE ROLES. An account carries a role when public.account_roles maps it, or — when
 *    that role has no mapping anywhere in the org — when it is the role's standard COA number
 *    (lib/posting/account-roles.ts ROLE_DEFAULT_NUMBER). Exactly the posting resolver's and the
 *    metric classifier's fallback (lib/metrics/classes.ts `classifyAccounts`), so "the petty
 *    cash account" is the same account to the poster, the KPI and the statement.
 *
 * 2. CASH = the canonical book-cash definition (lib/cash/book-cash.ts): ASSET accounts that are
 *    bank-flagged or carry a cash role (operating bank, cash on hand, undeposited funds).
 *    Payment-processor settlement clearing and payments in transit are NOT cash: they are funds
 *    owed to us by a processor / not yet landed in a bank account (a receivable from the
 *    processor until payout — ASC 230 cash is cash on hand and demand deposits; amounts held by a
 *    third party pending settlement are not). On the balance sheet they are presented on their
 *    own line, "Funds in transit (processor clearing)", directly after cash; in the cash flow
 *    they are working capital. The cash-flow "Cash per balance sheet" check therefore compares
 *    the same accounts the balance sheet's cash line shows.
 *
 * 3. INTERCOMPANY balances (INTERCOMPANY_AR / INTERCOMPANY_AP roles) are presented on their own
 *    lines ("Due from related companies" / "Due to related companies"), never inside trade
 *    accounts receivable / payable (they eliminate on consolidation).
 */
import { ROLE_DEFAULT_NUMBER } from '@/lib/posting/account-roles';
import type { AccountMeta } from './types';

/** The canonical cash roles (same list as lib/cash/book-cash.ts CASH_ROLE_KEYS). */
export const CASH_ROLES: readonly string[] = ['OPERATING_BANK', 'CASH_ON_HAND', 'UNDEPOSITED_FUNDS'];
/** Cash in transit: presented next to cash, but not cash. */
export const IN_TRANSIT_ROLES: readonly string[] = ['SETTLEMENT_CLEARING', 'PAYMENTS_IN_TRANSIT'];
export const INTERCOMPANY_AR_ROLES: readonly string[] = ['INTERCOMPANY_AR'];
export const INTERCOMPANY_AP_ROLES: readonly string[] = ['INTERCOMPANY_AP'];

export const PRESENTATION_GROUPS = {
  cash: { id: '__pres_cash', name: 'Cash & cash equivalents' },
  inTransit: { id: '__pres_in_transit', name: 'Funds in transit (processor clearing)' },
  icAr: { id: '__pres_ic_ar', name: 'Due from related companies (intercompany)' },
  icAp: { id: '__pres_ic_ap', name: 'Due to related companies (intercompany)' },
} as const;

/** Add the standard-number fallback roles (only for roles no account is mapped to). */
export function withEffectiveRoles<A extends Pick<AccountMeta, 'number' | 'roles'>>(accounts: readonly A[], defaults: Record<string, string> = ROLE_DEFAULT_NUMBER): A[] {
  const mapped = new Set<string>();
  for (const a of accounts) for (const r of a.roles) mapped.add(r);
  const byNumber = new Map<string, string[]>();
  for (const [role, num] of Object.entries(defaults)) {
    if (mapped.has(role) || !num) continue;
    const list = byNumber.get(num) ?? [];
    list.push(role);
    byNumber.set(num, list);
  }
  if (byNumber.size === 0) return [...accounts];
  return accounts.map((a) => {
    const extra = byNumber.get(a.number);
    if (!extra) return a;
    const roles = [...a.roles];
    for (const r of extra) if (!roles.includes(r)) roles.push(r);
    return { ...a, roles };
  });
}

const hasRole = (a: Pick<AccountMeta, 'roles'>, roles: readonly string[]) => a.roles.some((r) => roles.includes(r));

/** Canonical cash (on effective roles). */
export function isCashAccount(a: Pick<AccountMeta, 'type' | 'isBank' | 'roles'>): boolean {
  return a.type === 'ASSET' && (a.isBank || hasRole(a, CASH_ROLES));
}

export type PresentationLine = 'cash' | 'inTransit' | 'icAr' | 'icAp' | null;

export function presentationLine(a: Pick<AccountMeta, 'type' | 'isBank' | 'roles'>): PresentationLine {
  if (isCashAccount(a)) return 'cash';
  if (a.type === 'ASSET' && hasRole(a, IN_TRANSIT_ROLES)) return 'inTransit';
  if (a.type === 'ASSET' && hasRole(a, INTERCOMPANY_AR_ROLES)) return 'icAr';
  if (a.type === 'LIABILITY' && hasRole(a, INTERCOMPANY_AP_ROLES)) return 'icAp';
  return null;
}

/**
 * Effective roles + presentation groups. Accounts on a role line move into that line's group
 * (named in plain English); the group sorts where the accounts' own groups sorted (cash first
 * among them; the in-transit / intercompany lines just after their source group). Everything
 * else is untouched.
 */
export function presentAccounts(accounts: readonly AccountMeta[]): AccountMeta[] {
  const eff = withEffectiveRoles(accounts);
  const line = new Map(eff.map((a) => [a.id, presentationLine(a)]));
  // A presentation group takes the earliest order among its members' original groups.
  const order = new Map<string, number>();
  for (const a of eff) {
    const l = line.get(a.id);
    if (!l) continue;
    const prev = order.get(l);
    if (prev === undefined || a.groupOrder < prev) order.set(l, a.groupOrder);
  }
  const bump: Record<Exclude<PresentationLine, null>, number> = { cash: 0, inTransit: 0.5, icAr: 0.5, icAp: 0.5 };
  return eff.map((a) => {
    const l = line.get(a.id);
    if (!l) return a;
    const g = PRESENTATION_GROUPS[l];
    return { ...a, sourceGroupId: a.sourceGroupId ?? a.groupId, groupId: g.id, groupName: g.name, groupOrder: (order.get(l) ?? a.groupOrder) + bump[l] };
  });
}

/**
 * In-place regroup for statement shapes outside the engine (the board package's balance sheet):
 * accounts on a presentation line take that line's group name and sort order.
 */
export function regroupForPresentation<A extends { groupName: string; groupOrder: number }>(
  accounts: A[],
  lineOf: (a: A) => PresentationLine,
): void {
  const lines = accounts.map((a) => lineOf(a));
  const order = new Map<string, number>();
  accounts.forEach((a, i) => {
    const l = lines[i];
    if (!l) return;
    const prev = order.get(l);
    if (prev === undefined || a.groupOrder < prev) order.set(l, a.groupOrder);
  });
  const bump: Record<Exclude<PresentationLine, null>, number> = { cash: 0, inTransit: 0.5, icAr: 0.5, icAp: 0.5 };
  accounts.forEach((a, i) => {
    const l = lines[i];
    if (!l) return;
    a.groupName = PRESENTATION_GROUPS[l].name;
    a.groupOrder = (order.get(l) ?? a.groupOrder) + bump[l];
  });
}
