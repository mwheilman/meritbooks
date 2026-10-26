/**
 * RECEIVABLES & PAYABLES — the one definition every summary figure uses (board package KPIs,
 * the Home "Money" widget, the balance sheet).
 *
 *   Accounts receivable = posted GL balance (debit − credit) of the AR control account(s)
 *                         (role AR_CONTROL), as of the date, for the companies in scope.
 *   Accounts payable    = posted GL balance (credit − debit) of the AP control account(s)
 *                         (role AP_CONTROL).
 *
 * Identified BY ROLE (public.account_roles; the role's standard COA number only when the role
 * is not mapped at all — the posting resolver's fallback), never by a number range. These are
 * TRADE balances: intercompany receivables / payables (INTERCOMPANY_AR / INTERCOMPANY_AP) are
 * not trade AR / AP — they eliminate on consolidation and are shown on their own balance-sheet
 * lines (lib/reports/engine/presentation.ts).
 *
 * The subledger (open invoices / open bills) is the DETAIL behind the control accounts and
 * drives aging. When the two differ, something reached the control account outside an
 * invoice / bill (or the reverse); surfaces show the GL figure and name the difference rather
 * than silently picking one.
 *
 * Money is integer cents.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ROLE_DEFAULT_NUMBER } from '@/lib/posting/account-roles';
import { loadCashLines, sumCashAsOf } from '@/lib/cash/book-cash';
import { fetchAll } from '@/lib/supabase/fetch-all';

export const TRADE_AR_ROLES = ['AR_CONTROL'] as const;
export const TRADE_AP_ROLES = ['AP_CONTROL'] as const;

export const AR_AP_DEFINITION =
  'Receivables and payables are the posted GL balances of the AR and AP control accounts as of the date — the figures on the balance sheet. Intercompany balances are excluded. Open invoices and bills are the detail behind them.';

export interface RoleAccount {
  id: string;
  account_number: string;
}
export interface RoleMapping {
  role_key: string;
  account_id: string;
}

/** Account ids carrying any of `roles` — mapped accounts, else the role's standard number. */
export function roleAccountIds(
  accounts: readonly RoleAccount[],
  mappings: readonly RoleMapping[],
  roles: readonly string[],
  defaults: Record<string, string> = ROLE_DEFAULT_NUMBER,
): Set<string> {
  const known = new Set(accounts.map((a) => a.id));
  const out = new Set<string>();
  for (const role of roles) {
    const mapped = mappings.filter((m) => m.role_key === role && known.has(m.account_id));
    if (mapped.length) {
      for (const m of mapped) out.add(m.account_id);
      continue;
    }
    const num = defaults[role];
    for (const a of accounts) if (num && a.account_number === num) out.add(a.id);
  }
  return out;
}

export interface ControlBalances {
  asOfDate: string;
  /** AR control, debit-normal (positive = customers owe us). */
  arCents: number;
  /** AP control, credit-normal (positive = we owe vendors). */
  apCents: number;
  byLocation: Record<string, { arCents: number; apCents: number }>;
  /** False when no AR / AP control account could be identified. */
  arMapped: boolean;
  apMapped: boolean;
}

/** Pure: fold GL lines into AR / AP control balances. */
export function foldControlBalances(
  lines: Parameters<typeof sumCashAsOf>[0],
  arIds: ReadonlySet<string>,
  apIds: ReadonlySet<string>,
  asOf: string,
  locationIds?: readonly string[] | null,
): ControlBalances {
  const ar = sumCashAsOf(lines, arIds, asOf, locationIds);
  const ap = sumCashAsOf(lines, apIds, asOf, locationIds);
  const byLocation: ControlBalances['byLocation'] = {};
  for (const [loc, v] of Object.entries(ar.byLocation)) byLocation[loc] = { arCents: v, apCents: 0 };
  for (const [loc, v] of Object.entries(ap.byLocation)) byLocation[loc] = { arCents: byLocation[loc]?.arCents ?? 0, apCents: v === 0 ? 0 : -v };
  return {
    asOfDate: asOf,
    arCents: ar.totalCents,
    apCents: ap.totalCents === 0 ? 0 : -ap.totalCents,
    byLocation,
    arMapped: arIds.size > 0,
    apMapped: apIds.size > 0,
  };
}

/** "Open invoices total $150,000.00 — $100.00 more than the GL." (null when they agree). */
export function subledgerDifferenceText(kind: 'receivables' | 'payables', glCents: number, subledgerCents: number, fmt: (cents: number) => string): string | null {
  const d = subledgerCents - glCents;
  if (d === 0) return null;
  const docs = kind === 'receivables' ? 'Open invoices' : 'Open bills';
  return `${docs} total ${fmt(subledgerCents)} — ${fmt(Math.abs(d))} ${d > 0 ? 'more' : 'less'} than the GL control account.`;
}

/** Read AR / AP control balances (RLS-scoped — pass the user's client). */
export async function fetchControlBalances(
  supabase: SupabaseClient,
  orgId: string | null | undefined,
  opts: { asOfDate: string; locationIds?: readonly string[] | null },
): Promise<ControlBalances> {
  const [accts, maps] = await Promise.all([
    fetchAll(
      () => {
        let q = supabase.from('accounts').select('id, account_number').in('account_type', ['ASSET', 'LIABILITY']);
        if (orgId) q = q.eq('org_id', orgId);
        return q;
      },
      { label: 'control-balances accounts' },
    ),
    (() => {
      let q = supabase.from('account_roles').select('role_key, account_id').in('role_key', [...TRADE_AR_ROLES, ...TRADE_AP_ROLES]);
      if (orgId) q = q.eq('org_id', orgId);
      return q;
    })(),
  ]);
  if (accts.error) throw new Error(accts.error.message);
  const accounts = (accts.data ?? []) as unknown as RoleAccount[];
  const mappings = ((maps.data ?? []) as unknown as RoleMapping[]) ?? [];
  const arIds = roleAccountIds(accounts, mappings, TRADE_AR_ROLES);
  const apIds = roleAccountIds(accounts, mappings, TRADE_AP_ROLES);
  const lines = await loadCashLines(supabase, new Set([...arIds, ...apIds]), { maxAsOf: opts.asOfDate, locationIds: opts.locationIds });
  return foldControlBalances(lines, arIds, apIds, opts.asOfDate, opts.locationIds);
}
