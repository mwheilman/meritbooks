/**
 * What a cardholder sees in Merit Workforce (FPB-workforce-app §4.2, §15.2): their own
 * charges that still need a receipt, and their recent receipts. Scope is ONE card
 * assignment (or the signed-in person's assignments) — every query pins org + assignment.
 *
 * When receipt chase is off for the company (or the cardholder is opted out) the
 * "Receipts needed" list is hidden (§4.9); uploading a receipt still works and still matches.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { aliasAddress } from '@/lib/email/inbound-config';
import { chaseEnabledFor, loadReceiptPolicyContext, memoRequired, mergeReceiptPolicy } from './policy';
import type { CardAssignmentRow, ChargeState, MatchStatus } from './types';
import { brandCache } from '@/lib/branding/resolve';

export interface HolderCharge {
  transactionId: string;
  merchant: string;
  chargeDate: string;
  amountCents: number;
  asks: number;
  status: ChargeState;
  memoRequired: boolean;
}

export interface HolderReceipt {
  id: string;
  merchant: string | null;
  amountCents: number | null;
  receiptDate: string | null;
  submittedAt: string;
  matchStatus: MatchStatus;
  matchedTo: { merchant: string; chargeDate: string; amountCents: number } | null;
}

export interface HolderBrand {
  logoUrl: string | null;
  logoDarkUrl: string | null;
  primary: string;
}

export interface HolderCard {
  assignmentId: string;
  locationId: string;
  companyName: string;
  cardLabel: string;
  chaseOn: boolean;
  /** The company's receipts-<company>@… forwarding address (Wave 2D), when set up. */
  receiptsAddress: string | null;
  /** The company's brand for the app header (FPB-branding); null = Merit look. */
  brand: HolderBrand | null;
  needed: HolderCharge[];
  neededTotalCents: number;
  recent: HolderReceipt[];
}

export interface HolderView {
  holderName: string;
  cards: HolderCard[];
}

export function cardLabelOf(a: Pick<CardAssignmentRow, 'card_label' | 'card_last4'>, accountName?: string | null): string {
  if (a.card_label && a.card_last4) return `${a.card_label} ••${a.card_last4}`;
  if (a.card_last4) return `Card ••${a.card_last4}`;
  return a.card_label ?? accountName ?? 'Company card';
}

export async function loadHolderView(db: SupabaseClient, orgId: string, assignments: ReadonlyArray<CardAssignmentRow>): Promise<HolderView> {
  if (assignments.length === 0) return { holderName: '', cards: [] };
  const ctx = await loadReceiptPolicyContext(db, orgId);
  const ids = assignments.map((a) => a.id);
  const locIds = Array.from(new Set(assignments.map((a) => a.location_id)));
  const acctIds = assignments.map((a) => a.bank_account_id).filter((x): x is string => !!x);

  const [{ data: locs }, { data: accts }, { data: states }, { data: receipts }] = await Promise.all([
    db.schema('core').from('locations').select('id, name').eq('org_id', orgId).in('id', locIds),
    acctIds.length ? db.from('bank_accounts').select('id, account_name').eq('org_id', orgId).in('id', acctIds) : Promise.resolve({ data: [] }),
    db
      .from('receipt_charge_states')
      .select('bank_transaction_id, card_assignment_id, merchant, charge_date, amount_cents, chase_count, status, location_id')
      .eq('org_id', orgId)
      .in('card_assignment_id', ids)
      .in('status', ['needed', 'requested'])
      .order('charge_date', { ascending: true })
      .limit(200),
    db
      .from('receipts')
      .select('id, card_assignment_id, vendor_name, amount_cents, receipt_date, submitted_at, match_status, bank_transaction_id')
      .eq('org_id', orgId)
      .in('card_assignment_id', ids)
      .order('submitted_at', { ascending: false })
      .limit(30),
  ]);
  // Forwarding addresses (core.inbound_aliases, Wave 2D) — best-effort: absent table / rows → none.
  const fwd = new Map<string, string>();
  try {
    const { data: al, error: alErr } = await db
      .schema('core')
      .from('inbound_aliases')
      .select('location_id, local_part, domain, is_active, purpose')
      .eq('org_id', orgId)
      .eq('purpose', 'receipts')
      .in('location_id', locIds);
    if (!alErr) {
      for (const a of (al ?? []) as Array<{ location_id: string; local_part: string; domain: string | null; is_active: boolean }>) {
        if (a.is_active) fwd.set(a.location_id, aliasAddress(a.local_part, a.domain));
      }
    }
  } catch {
    // forwarding is optional
  }
  const locName = new Map(((locs ?? []) as Array<{ id: string; name: string }>).map((l) => [l.id, l.name]));
  const acctName = new Map(((accts ?? []) as Array<{ id: string; account_name: string }>).map((a) => [a.id, a.account_name]));
  type StateLite = { bank_transaction_id: string; card_assignment_id: string; merchant: string | null; charge_date: string; amount_cents: number; chase_count: number; status: ChargeState; location_id: string };
  const st = (states ?? []) as StateLite[];
  type RecLite = { id: string; card_assignment_id: string; vendor_name: string | null; amount_cents: number | null; receipt_date: string | null; submitted_at: string; match_status: MatchStatus; bank_transaction_id: string | null };
  const rc = (receipts ?? []) as RecLite[];

  // What each matched receipt was matched to (the holder's own charges only).
  const matchedIds = rc.map((r) => r.bank_transaction_id).filter((x): x is string => !!x);
  const matchedMap = new Map<string, { merchant: string; chargeDate: string; amountCents: number }>();
  if (matchedIds.length) {
    const { data: ms } = await db.from('receipt_charge_states').select('bank_transaction_id, merchant, charge_date, amount_cents').eq('org_id', orgId).in('bank_transaction_id', matchedIds).in('card_assignment_id', ids);
    for (const m of (ms ?? []) as Array<{ bank_transaction_id: string; merchant: string | null; charge_date: string; amount_cents: number }>) {
      matchedMap.set(m.bank_transaction_id, { merchant: m.merchant ?? 'Card charge', chargeDate: m.charge_date, amountCents: Number(m.amount_cents) });
    }
  }

  // FPB-branding: each company's brand (company → tenant → Merit default), one read per company.
  const brandOf = brandCache(db, orgId);
  const brands = new Map<string, HolderBrand | null>();
  await Promise.all(locIds.map(async (id) => {
    const b = await brandOf(id);
    brands.set(id, b.source === 'MERIT_DEFAULT' ? null : { logoUrl: b.logoUrl, logoDarkUrl: b.logoDarkUrl, primary: b.palette.primary });
  }));

  const cards: HolderCard[] = assignments.map((a) => {
    const policy = mergeReceiptPolicy(ctx.rows, a.location_id);
    const chaseOn = chaseEnabledFor(ctx.switches, a.location_id) && !a.chase_opt_out;
    const needed = chaseOn
      ? st
          .filter((s) => s.card_assignment_id === a.id)
          .map((s) => ({
            transactionId: s.bank_transaction_id,
            merchant: s.merchant ?? 'Card charge',
            chargeDate: s.charge_date,
            amountCents: Number(s.amount_cents),
            asks: s.chase_count,
            status: s.status,
            memoRequired: memoRequired(policy, Number(s.amount_cents)),
          }))
      : [];
    return {
      assignmentId: a.id,
      locationId: a.location_id,
      companyName: locName.get(a.location_id) ?? 'Your company',
      cardLabel: cardLabelOf(a, a.bank_account_id ? acctName.get(a.bank_account_id) : null),
      chaseOn,
      receiptsAddress: fwd.get(a.location_id) ?? null,
      brand: brands.get(a.location_id) ?? null,
      needed,
      neededTotalCents: needed.reduce((n, c) => n + c.amountCents, 0),
      recent: rc
        .filter((r) => r.card_assignment_id === a.id)
        .map((r) => ({
          id: r.id,
          merchant: r.vendor_name,
          amountCents: r.amount_cents != null ? Number(r.amount_cents) : null,
          receiptDate: r.receipt_date,
          submittedAt: r.submitted_at,
          matchStatus: r.match_status,
          matchedTo: r.bank_transaction_id ? matchedMap.get(r.bank_transaction_id) ?? null : null,
        })),
    };
  });
  return { holderName: assignments[0].holder_name, cards };
}
