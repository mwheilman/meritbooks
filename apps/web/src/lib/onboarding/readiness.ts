/**
 * Onboarding READINESS LEDGER — read-only aggregation of how populated a tenant's
 * book of record is. Powers the "Readiness Ledger" UI: a live checklist with counts
 * and a single "next best action".
 *
 * This module owns ONLY the pure aggregation. Given an RLS-scoped Supabase client and
 * the caller's org id, it returns a typed summary. It performs NO writes. Every query
 * is BOTH explicitly org-scoped (`.eq('org_id', orgId)`) AND running under RLS, so a
 * tenant can never read another tenant's setup progress even if RLS were misconfigured.
 *
 * DEGRADE-SAFE BY DESIGN. Each item is computed inside its own try/catch (via the count
 * helpers), so a table that does not yet exist in a given deployment (e.g. `prepaids`,
 * which has no standalone table today) simply causes that ONE item to be omitted from
 * the ledger — it never 500s the whole endpoint. `null` from a count helper means
 * "table/column unavailable → omit the item"; `0` means "table exists, nothing captured
 * yet → show the item as not-done".
 *
 * Schema ground truth (verified against packages/supabase/migrations):
 *   - core.locations     org_id, is_active            (the entities / companies)
 *   - public.accounts    org_id                        (chart of accounts)
 *   - core.customers     org_id
 *   - public.invoices    org_id, status                (open = SENT|PARTIALLY_PAID|OVERDUE)
 *   - core.vendors       org_id
 *   - public.bills       org_id, status                (open = PENDING|APPROVED|SCHEDULED|PARTIALLY_PAID|ON_HOLD)
 *   - public.debt_instruments  org_id, status ACTIVE
 *   - public.leases            org_id, status ACTIVE
 *   - public.fixed_assets      org_id, status ACTIVE
 *   - public.subscriptions     org_id                  (any captured subscription)
 *   - public.insurance_policies org_id, status ACTIVE
 *   - public.loan_covenants     org_id                 (any covenant)
 *   - core.employees     org_id                        (team)
 *   - core.equity_holders org_id                       (cap table)
 *   - public.gl_entries       org_id, source_module='OPENING_BALANCE'  (go-live signal)
 *   - public.gl_entry_lines   org_id, gl_entry_id, debit_cents, credit_cents (tie-out)
 *
 * Opening-balance detection mirrors the live convention used by the import/conversion
 * posters (api/import/route.ts, api/onboarding/conversion/[id]/post/route.ts) and
 * lib/onboarding/status.ts: an opening entry is a posted `gl_entries` row whose
 * `source_module = 'OPENING_BALANCE'`. (Note: 'OPENING_BALANCE' is a `source_module`
 * text value, NOT an `entry_type_enum` member — the enum only holds STANDARD/ADJUSTING/
 * CLOSING/REVERSING/RECURRING/SYSTEM plus money-movement additions.)
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** The visual grouping a readiness item belongs to. */
export type ReadinessGroup =
  | 'foundation'
  | 'receivables'
  | 'payables'
  | 'assets_liabilities'
  | 'governance';

/** One row in the Readiness Ledger. */
export interface ReadinessItem {
  /** Stable identifier the UI keys off. */
  key: string;
  /** Human label for the checklist row. */
  label: string;
  /** Which section of the ledger this belongs to. */
  group: ReadinessGroup;
  /** True once this domain is considered populated / set up. */
  done: boolean;
  /** Populated-record count, when the item is count-based. */
  count?: number;
  /**
   * Opening-balances only: whether the posted opening entries tie out (aggregate
   * debits === aggregate credits). `undefined` when there is no opening entry yet
   * (not applicable) or the lines could not be summed.
   */
  tiedOut?: boolean;
}

/** The full Readiness Ledger summary returned to the UI. */
export interface ReadinessSummary {
  items: ReadinessItem[];
  /** First not-done REQUIRED item (company → opening_balances → customers → vendors), else null. */
  nextAction: { key: string; label: string } | null;
  /** ISO timestamp the summary was computed (the ledger is live, never cached here). */
  generatedAt: string;
  /**
   * Keys of items intentionally omitted because their table/column was unavailable in
   * this deployment (surfaced so the UI/lead can see what degraded rather than guess).
   */
  omitted: string[];
}

/** A supabase head-count query shape. */
type CountQuery = PromiseLike<{ count: number | null; error: unknown }>;

/**
 * Best-effort head count. Returns the count (0 when empty), or `null` when the query
 * errored / the table is unavailable — the caller then OMITS that item rather than
 * showing a misleading zero or throwing. Never throws.
 */
async function tryCount(q: CountQuery): Promise<number | null> {
  try {
    const { count, error } = await q;
    if (error) return null;
    return count ?? 0;
  } catch {
    return null;
  }
}

/** REQUIRED items, in the order the "next best action" walks them. */
const REQUIRED_ORDER = ['company', 'opening_balances', 'customers', 'vendors'] as const;

interface OpeningDetection {
  done: boolean;
  tiedOut: boolean | undefined;
}

/**
 * Detect whether the org has posted its opening balances, and whether they tie out.
 *
 * `done`    → at least one `gl_entries` row with source_module='OPENING_BALANCE'.
 * `tiedOut` → aggregate debit_cents === aggregate credit_cents across those entries'
 *             lines. `undefined` when there is no opening entry (n/a) or the lines
 *             could not be read. (Per-entry balance is DB-enforced, so a tie-out here
 *             is the aggregate confirmation that the imported trial balance is whole.)
 *
 * Returns `null` only when the gl_entries probe itself failed (table unavailable) so the
 * caller can omit the item; otherwise a concrete detection.
 */
async function detectOpeningBalances(
  supabase: SupabaseClient,
  orgId: string,
): Promise<OpeningDetection | null> {
  try {
    const { data: entries, error } = await supabase
      .from('gl_entries')
      .select('id')
      .eq('org_id', orgId)
      .eq('source_module', 'OPENING_BALANCE');

    if (error) return null;
    const ids = (entries ?? []).map((e) => (e as { id: string }).id);
    if (ids.length === 0) return { done: false, tiedOut: undefined };

    // Sum the opening entries' lines to confirm the aggregate ties out.
    const { data: lines, error: linesError } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .eq('org_id', orgId)
      .in('gl_entry_id', ids);

    if (linesError || !lines) return { done: true, tiedOut: undefined };

    let debit = 0n;
    let credit = 0n;
    for (const line of lines as Array<{ debit_cents: number | string | null; credit_cents: number | string | null }>) {
      debit += BigInt(line.debit_cents ?? 0);
      credit += BigInt(line.credit_cents ?? 0);
    }
    return { done: true, tiedOut: debit === credit };
  } catch {
    return null;
  }
}

/**
 * Compute the full Readiness Ledger for one tenant.
 *
 * @param supabase RLS-scoped request client (from requireAuthedContext).
 * @param orgId    The caller's org UUID (from the Clerk token claim).
 */
export async function computeReadiness(
  supabase: SupabaseClient,
  orgId: string,
): Promise<ReadinessSummary> {
  // Head-count builders bound to this org. Each returns a head:true count query, which
  // `tryCount` resolves to a number (0 when empty) or null (table/column unavailable →
  // item omitted). Filters are applied inline so supabase-js keeps full type inference.
  const pub = (table: string) =>
    supabase.from(table).select('id', { count: 'exact', head: true }).eq('org_id', orgId);
  const core = (table: string) =>
    supabase.schema('core').from(table).select('id', { count: 'exact', head: true }).eq('org_id', orgId);

  const [
    entities,
    accounts,
    opening,
    customers,
    openInvoices,
    vendors,
    openBills,
    debt,
    leases,
    fixedAssets,
    prepaids,
    subscriptions,
    insurance,
    covenants,
    team,
    equity,
  ] = await Promise.all([
    tryCount(core('locations').eq('is_active', true)),
    tryCount(pub('accounts')),
    detectOpeningBalances(supabase, orgId),
    tryCount(core('customers')),
    tryCount(pub('invoices').in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])),
    tryCount(core('vendors')),
    tryCount(pub('bills').in('status', ['PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID', 'ON_HOLD'])),
    tryCount(pub('debt_instruments').eq('status', 'ACTIVE')),
    tryCount(pub('leases').eq('status', 'ACTIVE')),
    tryCount(pub('fixed_assets').eq('status', 'ACTIVE')),
    // `prepaids` has no standalone table today — this probe returns null and the item is
    // omitted gracefully. If a prepaids table lands later, the item lights up unchanged.
    tryCount(pub('prepaids')),
    tryCount(pub('subscriptions')),
    tryCount(pub('insurance_policies').eq('status', 'ACTIVE')),
    tryCount(pub('loan_covenants')),
    tryCount(core('employees')),
    tryCount(core('equity_holders')),
  ]);

  const items: ReadinessItem[] = [];
  const omitted: string[] = [];

  // ── Foundation ────────────────────────────────────────────────────────────
  // Company & chart of accounts: needs at least one entity AND a chart. The count
  // shown is the number of GL accounts; `done` also requires an entity to exist.
  if (accounts === null && entities === null) {
    omitted.push('company');
  } else {
    const acctCount = accounts ?? 0;
    const entityCount = entities ?? 0;
    items.push({
      key: 'company',
      label: 'Company & chart of accounts',
      group: 'foundation',
      count: acctCount,
      done: entityCount > 0 && acctCount > 0,
    });
  }

  if (opening === null) {
    omitted.push('opening_balances');
  } else {
    items.push({
      key: 'opening_balances',
      label: 'Opening balances',
      group: 'foundation',
      done: opening.done,
      tiedOut: opening.tiedOut,
    });
  }

  // ── Receivables ───────────────────────────────────────────────────────────
  pushCountItem(items, omitted, 'customers', 'Customers', 'receivables', customers);
  pushCountItem(items, omitted, 'open_invoices', 'Open invoices', 'receivables', openInvoices);

  // ── Payables ──────────────────────────────────────────────────────────────
  pushCountItem(items, omitted, 'vendors', 'Vendors', 'payables', vendors);
  pushCountItem(items, omitted, 'open_bills', 'Open bills', 'payables', openBills);

  // ── Assets & liabilities ──────────────────────────────────────────────────
  pushCountItem(items, omitted, 'debt', 'Loans & debt', 'assets_liabilities', debt);
  pushCountItem(items, omitted, 'leases', 'Leases', 'assets_liabilities', leases);
  pushCountItem(items, omitted, 'fixed_assets', 'Fixed assets', 'assets_liabilities', fixedAssets);
  pushCountItem(items, omitted, 'prepaids', 'Prepaids', 'assets_liabilities', prepaids);
  pushCountItem(items, omitted, 'subscriptions', 'Subscriptions', 'assets_liabilities', subscriptions);
  pushCountItem(items, omitted, 'insurance', 'Insurance policies', 'assets_liabilities', insurance);

  // ── Governance ────────────────────────────────────────────────────────────
  pushCountItem(items, omitted, 'covenants', 'Covenants', 'governance', covenants);
  pushCountItem(items, omitted, 'team', 'Team', 'governance', team);
  pushCountItem(items, omitted, 'equity', 'Cap table / equity', 'governance', equity);

  // Next best action: first REQUIRED item that exists and is not done.
  const byKey = new Map(items.map((i) => [i.key, i]));
  let nextAction: ReadinessSummary['nextAction'] = null;
  for (const key of REQUIRED_ORDER) {
    const item = byKey.get(key);
    if (item && !item.done) {
      nextAction = { key: item.key, label: item.label };
      break;
    }
  }

  return {
    items,
    nextAction,
    generatedAt: new Date().toISOString(),
    omitted,
  };
}

/**
 * Append a count-based item, or record it as omitted when its count is null (table
 * unavailable). `done` is "populated" — at least one record captured.
 */
function pushCountItem(
  items: ReadinessItem[],
  omitted: string[],
  key: string,
  label: string,
  group: ReadinessGroup,
  value: number | null,
): void {
  if (value === null) {
    omitted.push(key);
    return;
  }
  items.push({ key, label, group, count: value, done: value > 0 });
}
