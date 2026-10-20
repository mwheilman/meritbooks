export const dynamic = 'force-dynamic';

import { apiQueryHandler } from '@/lib/api-handler';
import type { z } from 'zod';
import { dealerAction } from '@/lib/dealer/route';
import { DEALER_PERMS, type DealerCtx } from '@/lib/dealer/service/context';
import { DealerError, dbFail } from '@/lib/dealer/service/errors';
import { coerceMoney } from '@/lib/dealer/service/rows';
import { byId } from '@/lib/validations/dealer';
import type {
  DealDetailView,
  DealInvoiceView,
  DealPayoffView,
  NoteView,
  SaleView,
  TradeView,
  UnitView,
} from '@/lib/dealer/ui/unit-deal-types';

/**
 * /api/dealer/deal-detail — one deal (sale) with its trade-in, unit, the unit's
 * floor-plan notes, the Books invoice, any payoff proposed for the note, and how
 * many unit cost rows still await posting (a sale can't post until none remain).
 * Read-only (D2 slice A read helper for the deal recap page). Every read goes
 * through the caller's RLS client (`d.db`), pinned to the org + client.
 * Contract style: docs/dealer-pack-api.md §1 (success `{ data }`).
 */
async function loadDealDetail(d: DealerCtx, saleId: string): Promise<DealDetailView> {
  const s = await d.db
    .from('dealer_unit_sales')
    .select('*')
    .eq('org_id', d.orgId)
    .eq('location_id', d.locationId)
    .eq('id', saleId)
    .maybeSingle();
  if (s.error) dbFail('Deal lookup failed', s.error);
  if (!s.data) throw new DealerError('NOT_FOUND', 'Deal not found for this client');
  const sale = coerceMoney<SaleView>(s.data as Record<string, unknown>);

  const [u, t, n, inv, pc] = await Promise.all([
    d.db.from('dealer_units').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', sale.unit_id).maybeSingle(),
    sale.trade_in_id
      ? d.db.from('trade_ins').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('id', sale.trade_in_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    d.db.from('floor_plan_notes').select('*').eq('org_id', d.orgId).eq('location_id', d.locationId).eq('unit_id', sale.unit_id).order('floored_date'),
    sale.invoice_id
      ? d.db.from('invoices').select('id, invoice_number, status, total_cents, balance_cents').eq('org_id', d.orgId).eq('id', sale.invoice_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    d.db.from('dealer_unit_costs').select('id', { count: 'exact', head: true }).eq('org_id', d.orgId).eq('location_id', d.locationId).eq('unit_id', sale.unit_id).eq('status', 'PROPOSED'),
  ]);
  for (const r of [u, t, n, inv, pc]) if (r.error) dbFail('Deal detail lookup failed', r.error);
  if (!u.data) throw new DealerError('NOT_FOUND', 'The deal’s unit was not found for this client');

  const notes = ((n.data ?? []) as Record<string, unknown>[]).map((x) => coerceMoney<NoteView>(x));
  let payoffs: DealPayoffView[] = [];
  if (notes.length > 0) {
    const p = await d.db
      .from('floor_plan_transactions')
      .select('id, note_id, status, principal_cents, txn_date')
      .eq('org_id', d.orgId)
      .eq('location_id', d.locationId)
      .eq('txn_type', 'PAYOFF')
      .in('note_id', notes.map((x) => x.id))
      .order('txn_date');
    if (p.error) dbFail('Payoff lookup failed', p.error);
    payoffs = ((p.data ?? []) as Record<string, unknown>[]).map((x) => coerceMoney<DealPayoffView>(x));
  }

  return {
    sale,
    trade: t.data ? coerceMoney<TradeView>(t.data as Record<string, unknown>) : null,
    unit: coerceMoney<UnitView>(u.data as Record<string, unknown>),
    notes,
    invoice: inv.data ? coerceMoney<DealInvoiceView>(inv.data as Record<string, unknown>) : null,
    payoffs,
    proposedCostCount: pc.count ?? 0,
  };
}

export const GET = apiQueryHandler(
  byId,
  dealerAction<z.infer<typeof byId>>(DEALER_PERMS.view, async (b, d) => loadDealDetail(d, b.id)),
);
