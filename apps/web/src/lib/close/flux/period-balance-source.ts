/**
 * Flux balance source over the 3A report engine's balances store (migration 185).
 *
 * `balances()` (ending debit − credit per company → account at a date) reads
 * `public.report_balances` — one jsonb round-trip, maintained in the posting transaction —
 * instead of `v_trial_balance` minus every line posted after the date. The RPC is NOT
 * executable by members: it goes through the engine adapter's `loadBalances`, which first
 * checks every requested company against the CALLER's org + client scope (EngineScopeError
 * otherwise) and then calls it on the service role with p_org = orgId and that explicit,
 * non-empty company list (never null = "every company"). An empty request returns early
 * here, so the adapter's "empty = all in scope" default is never reached from flux.
 * `lines()` stays on the ledger (`glBalanceSource`): driver analysis needs line detail
 * (entry, memo, counterparty) the store does not hold.
 *
 * If the store is not deployed in this database the source falls back to the GL path, so
 * the flux board and the close gate keep working (the gate fails CLOSED on real errors).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isStoreUnavailable, loadBalances } from '@/lib/reports/engine/adapter';
import { glBalanceSource, type FluxBalanceSource } from './load';

export function periodBalanceFluxSource(db: SupabaseClient, orgId: string): FluxBalanceSource {
  const gl = glBalanceSource(db);
  return {
    lines: (args) => gl.lines(args),
    async balances({ locationIds, asOfDate }) {
      const out = new Map<string, Map<string, number>>();
      if (locationIds.length === 0) return out;
      let rows;
      try {
        rows = await loadBalances(db, orgId, { companyIds: locationIds, from: null, to: asOfDate });
      } catch (e) {
        if (isStoreUnavailable(e)) return gl.balances({ locationIds, asOfDate });
        throw e;
      }
      for (const r of rows) {
        const m = out.get(r.companyId) ?? new Map<string, number>();
        m.set(r.accountId, (m.get(r.accountId) ?? 0) + r.debit - r.credit);
        out.set(r.companyId, m);
      }
      return out;
    },
  };
}
