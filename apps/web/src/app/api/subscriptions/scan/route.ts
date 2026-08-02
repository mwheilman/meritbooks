export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { formatMoney } from '@meritbooks/shared';
import {
  detectSubscriptions,
  type ChargeInput,
  type DetectedSubscription,
} from '@/lib/subscriptions/detect';

/**
 * POST /api/subscriptions/scan — detect recurring subscriptions from the OWNED ledger.
 *
 * Reads the tenant's bank-feed money-OUT charges + AP bills (RLS-scoped), groups them by
 * normalized vendor, infers a regular cadence, and PROPOSES each recurring subscription:
 *   • upserts a DETECTED row into `subscriptions` (idempotent on (org, dedup_key)) —
 *     detection-derived fields are refreshed on every scan, but a subscription a human has
 *     already acted on (KEPT / CANCELLING / CANCELLED) keeps its human status + notes.
 *   • for each subscription carrying a CREEP flag, writes a PROPOSED `ai_decisions` row
 *     (feature SUBSCRIPTION_SCAN) so it also surfaces in the unified /exceptions queue.
 *
 * Canon §3: proposes facts only — writes NOTHING to the GL, cancels NOTHING. The detector
 * math is pure/unit-tested; this route is the I/O shell and never throws mid-scan.
 */

const SUBSCRIPTION_SCAN_FEATURE = 'SUBSCRIPTION_SCAN';
const MAX_BANK_TXNS = 5000;
const MAX_BILLS = 2000;

interface ExistingSub {
  id: string;
  dedup_key: string | null;
  status: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const CREEP_LABEL: Record<string, string> = {
  NEW: 'new subscription',
  PRICE_INCREASE: 'price increase',
  DUPLICATE_CATEGORY: 'overlapping/duplicate category',
  STALE: 'stale / possible zombie',
};

export async function POST(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const asOf = todayIso();
  const charges: ChargeInput[] = [];

  // ── Bank-feed money-OUT (amount_cents < 0 ⇒ debit). Description is the group key. ──
  const { data: bankTxns, error: bankErr } = await supabase
    .from('bank_transactions')
    .select('id, description, transaction_date, amount_cents, category, final_vendor_id, ai_vendor_id')
    .lt('amount_cents', 0)
    .order('transaction_date', { ascending: false })
    .limit(MAX_BANK_TXNS);
  if (bankErr) {
    console.error('[subscriptions/scan] bank read failed:', bankErr.message);
  } else {
    for (const t of (bankTxns ?? []) as Array<Record<string, unknown>>) {
      const amt = Number(t.amount_cents);
      const desc = typeof t.description === 'string' ? t.description : '';
      const date = typeof t.transaction_date === 'string' ? t.transaction_date : '';
      if (!desc || !date || !Number.isFinite(amt)) continue;
      charges.push({
        id: String(t.id),
        vendorRaw: desc,
        vendorId: (t.final_vendor_id as string) ?? (t.ai_vendor_id as string) ?? null,
        amountCents: Math.abs(amt),
        date,
        category: (t.category as string) ?? null,
      });
    }
  }

  // ── AP bills — resolve vendor name via a small vendors map (RLS-scoped). ──
  const { data: bills } = await supabase
    .from('bills')
    .select('id, vendor_id, bill_date, total_cents')
    .order('bill_date', { ascending: false })
    .limit(MAX_BILLS);
  const billRows = (bills ?? []) as Array<Record<string, unknown>>;
  if (billRows.length) {
    const vendorIds = [...new Set(billRows.map((b) => String(b.vendor_id)).filter(Boolean))];
    const vendorName = new Map<string, string>();
    if (vendorIds.length) {
      const { data: vendors } = await supabase.from('vendors').select('id, name, display_name').in('id', vendorIds);
      for (const v of (vendors ?? []) as Array<Record<string, unknown>>) {
        vendorName.set(String(v.id), String(v.display_name || v.name || ''));
      }
    }
    for (const b of billRows) {
      const total = Number(b.total_cents);
      const date = typeof b.bill_date === 'string' ? b.bill_date : '';
      const name = vendorName.get(String(b.vendor_id)) ?? '';
      if (!name || !date || !Number.isFinite(total) || total <= 0) continue;
      charges.push({
        id: String(b.id),
        vendorRaw: name,
        vendorId: (b.vendor_id as string) ?? null,
        amountCents: Math.abs(total),
        date,
        category: null,
      });
    }
  }

  const detected: DetectedSubscription[] = detectSubscriptions(charges, { asOf });

  // ── Load existing subscriptions to preserve human decisions on re-scan. ──
  const { data: existingData } = await supabase.from('subscriptions').select('id, dedup_key, status');
  const existing = new Map<string, ExistingSub>();
  for (const e of (existingData ?? []) as ExistingSub[]) {
    if (e.dedup_key) existing.set(e.dedup_key, e);
  }

  let created = 0;
  let refreshed = 0;
  const HUMAN_DECIDED = new Set(['KEPT', 'CANCELLING', 'CANCELLED']);

  for (const d of detected) {
    const prior = existing.get(d.dedupKey);
    const detectionFields = {
      amount_cents: d.amountCents,
      prior_amount_cents: d.priorAmountCents,
      billing_cadence: d.billingCadence,
      first_seen_date: d.firstSeenDate,
      last_charged_date: d.lastChargedDate,
      next_renewal_date: d.nextRenewalDate,
      creep_flags: d.creepFlags,
      charge_count: d.chargeCount,
      charge_txn_ids: d.chargeTxnIds,
      category: d.category,
      vendor_id: d.vendorId,
      updated_at: new Date().toISOString(),
    };

    if (prior) {
      // Refresh detection facts; NEVER stomp a status a human already set.
      const patch: Record<string, unknown> = { ...detectionFields };
      const { error } = await supabase.from('subscriptions').update(patch).eq('id', prior.id);
      if (!error) refreshed += 1;
    } else {
      const { error } = await supabase.from('subscriptions').insert({
        org_id: orgId,
        vendor_name: d.vendorName,
        status: 'DETECTED',
        source: 'DETECTED',
        auto_renews: true,
        dedup_key: d.dedupKey,
        created_by_user: userId,
        ...detectionFields,
      });
      if (!error) created += 1;
    }

    // Surface creep items into the unified exceptions queue (idempotent on dedup_key).
    if (d.creepFlags.length > 0) {
      const decDedup = `subscription:${d.dedupKey}`;
      const { data: openDec } = await supabase
        .from('ai_decisions')
        .select('id')
        .eq('feature', SUBSCRIPTION_SCAN_FEATURE)
        .eq('status', 'PROPOSED')
        .filter('proposed_output->>dedup_key', 'eq', decDedup)
        .limit(1);
      if (!openDec || openDec.length === 0) {
        const flags = d.creepFlags.map((f) => CREEP_LABEL[f] ?? f).join(', ');
        await supabase.from('ai_decisions').insert({
          org_id: orgId,
          feature: SUBSCRIPTION_SCAN_FEATURE,
          input_summary:
            `Subscription creep — ${d.vendorName} (${formatMoney(d.amountCents)}/${d.billingCadence.toLowerCase()}): ${flags}`.slice(0, 2000),
          proposed_output: {
            kind: 'subscription_creep',
            dedup_key: decDedup,
            vendor_name: d.vendorName,
            amount_cents: d.amountCents,
            annualized_cents: d.annualizedCents,
            billing_cadence: d.billingCadence,
            next_renewal_date: d.nextRenewalDate,
            creep_flags: d.creepFlags,
          },
          confidence: d.confidence,
          reasoning:
            'Recurring subscription detected from the owned bank-feed / AP history with a creep signal; proposed for human keep/cancel review. Nothing is cancelled automatically.',
          status: 'PROPOSED',
          created_by_user: userId,
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: { bankTransactions: (bankTxns ?? []).length, bills: billRows.length, charges: charges.length },
    detected: detected.length,
    created,
    refreshed,
    creepCount: detected.filter((d) => d.creepFlags.length > 0).length,
    asOf,
  });
}
