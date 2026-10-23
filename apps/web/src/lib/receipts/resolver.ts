/**
 * The request engine's resolver for `receipt` requests (lib/requests/resolvers.ts
 * registry): a receipt request is satisfied when its charge (subject bank_transaction)
 * has a receipt — linked on the receipt, on the bank line, or recorded on the charge
 * state — or a person marked the charge "not required". Batch-shaped, org pinned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { BatchResolver, Resolution } from '@/lib/requests/resolvers';
import type { RequestRow } from '@/lib/requests/types';

export interface ChargeEvidence {
  receiptTxnIds: ReadonlySet<string>;
  matchedTxnIds: ReadonlySet<string>;
  states: ReadonlyMap<string, string>;
}

/** Pure decision for one request. */
export function decideReceiptRequest(r: Pick<RequestRow, 'subject_type' | 'subject_id'>, ev: ChargeEvidence): Resolution {
  if (r.subject_type !== 'bank_transaction' || !r.subject_id) return { satisfied: false };
  const id = r.subject_id;
  if (ev.receiptTxnIds.has(id) || ev.matchedTxnIds.has(id) || ev.states.get(id) === 'matched') {
    return { satisfied: true, via: 'resolver', note: 'A receipt is in for this charge.' };
  }
  if (ev.states.get(id) === 'not_required') return { satisfied: true, via: 'resolver', note: 'Marked not required.' };
  return { satisfied: false };
}

export const receiptResolver: BatchResolver = async (db: SupabaseClient, orgId, requests) => {
  const out = new Map<string, Resolution>();
  const ids = Array.from(new Set(requests.filter((r) => r.subject_type === 'bank_transaction' && r.subject_id).map((r) => r.subject_id as string)));
  if (ids.length === 0) return out;
  const receiptTxnIds = new Set<string>();
  const matchedTxnIds = new Set<string>();
  const states = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [rc, bt, st] = await Promise.all([
      db.from('receipts').select('bank_transaction_id').eq('org_id', orgId).in('bank_transaction_id', chunk),
      db.from('bank_transactions').select('id, matched_receipt_id').eq('org_id', orgId).in('id', chunk),
      db.from('receipt_charge_states').select('bank_transaction_id, status').eq('org_id', orgId).in('bank_transaction_id', chunk),
    ]);
    if (rc.error) throw new Error(`Could not read receipts: ${rc.error.message}`);
    if (bt.error) throw new Error(`Could not read charges: ${bt.error.message}`);
    if (st.error) throw new Error(`Could not read charge states: ${st.error.message}`);
    for (const r of (rc.data ?? []) as Array<{ bank_transaction_id: string | null }>) if (r.bank_transaction_id) receiptTxnIds.add(r.bank_transaction_id);
    for (const t of (bt.data ?? []) as Array<{ id: string; matched_receipt_id: string | null }>) if (t.matched_receipt_id) matchedTxnIds.add(t.id);
    for (const s of (st.data ?? []) as Array<{ bank_transaction_id: string; status: string }>) states.set(s.bank_transaction_id, s.status);
  }
  const ev = { receiptTxnIds, matchedTxnIds, states };
  for (const r of requests) out.set(r.id, decideReceiptRequest(r, ev));
  return out;
};
