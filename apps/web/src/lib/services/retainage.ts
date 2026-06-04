/**
 * Retainage payable service (Session 22) — subcontractor withholding + release.
 *
 * Withholding itself happens at bill approval (see bill-ap.ts): the bill's
 * total_cents is already net of retainage, and approval credits Retainage
 * Payable (role RETAINAGE_PAYABLE / 2010) for the withheld portion. This service
 * owns the back half: the register (what's held, released, outstanding per bill)
 * and the release, which relieves the liability and pays the subcontractor:
 *
 *     DR Retainage Payable / CR Operating bank      (for the released amount)
 *
 * Releases are tracked in retainage_releases (one row + GL entry each); partial
 * releases are allowed, and outstanding = bill.retainage_cents − Σ released.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from './gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

export interface ReleaseRetainageInput {
  orgId: string;
  billId: string;
  amountCents: number;
  releaseDate: string; // YYYY-MM-DD
  method?: string | null;
  memo?: string | null;
}

export interface ReleaseRetainageResult {
  success: boolean;
  releaseId?: string;
  entryNumber?: string;
  outstandingCents?: number;
  error?: string;
}

/** Sum of prior releases for a bill. */
async function releasedTotalCents(db: DB, orgId: string, billId: string): Promise<number> {
  const { data } = await db
    .from('retainage_releases')
    .select('amount_cents')
    .eq('org_id', orgId)
    .eq('bill_id', billId);
  return (data ?? []).reduce((s: number, r: Record<string, unknown>) => s + Number(r.amount_cents ?? 0), 0);
}

/**
 * Release (and pay) withheld retainage on a bill. Posts DR Retainage Payable /
 * CR Operating bank for the released amount and records the release row.
 */
export async function releaseRetainage(db: DB, input: ReleaseRetainageInput): Promise<ReleaseRetainageResult> {
  const { orgId, billId, amountCents, releaseDate, method, memo } = input;

  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { success: false, error: 'Release amount must be a positive whole number of cents.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    return { success: false, error: 'release_date must be YYYY-MM-DD.' };
  }

  const { data: bill, error: billErr } = await db
    .from('bills')
    .select('id, location_id, bill_number, retainage_cents, status, vendor_id')
    .eq('org_id', orgId)
    .eq('id', billId)
    .single();
  if (billErr || !bill) return { success: false, error: 'Bill not found.' };

  const withheld = Number(bill.retainage_cents ?? 0);
  if (withheld <= 0) return { success: false, error: 'This bill has no retainage withheld.' };
  if (bill.status === 'VOIDED') return { success: false, error: 'Cannot release retainage on a voided bill.' };
  if (bill.status === 'PENDING' || bill.status === 'ON_HOLD') {
    return { success: false, error: 'Approve the bill before releasing its retainage.' };
  }

  const alreadyReleased = await releasedTotalCents(db, orgId, billId);
  const outstanding = withheld - alreadyReleased;
  if (amountCents > outstanding) {
    return { success: false, error: `Release exceeds outstanding retainage (${(outstanding / 100).toFixed(2)} remaining).` };
  }

  try {
    const retPayable = await resolveRole(db, orgId, 'RETAINAGE_PAYABLE');
    const bank = await resolveRole(db, orgId, 'OPERATING_BANK', bill.location_id as string);

    const je = await postJournalEntry(db, {
      org_id: orgId,
      location_id: bill.location_id as string,
      entry_date: releaseDate,
      entry_type: 'STANDARD',
      memo: `Retainage release — bill ${bill.bill_number ?? billId}${memo ? ` (${memo})` : ''}`,
      source_module: 'RETAINAGE',
      source_id: billId,
      created_by: null,
      lines: [
        { account_id: retPayable.id, debit_cents: amountCents, credit_cents: 0, location_id: bill.location_id as string, memo: 'Relieve retainage payable' },
        { account_id: bank.id, debit_cents: 0, credit_cents: amountCents, location_id: bill.location_id as string, memo: 'Retainage paid' },
      ],
    });
    if (!je.success || !je.entry_id) {
      return { success: false, error: je.error ?? 'Failed to post the retainage release to the general ledger.' };
    }

    const { data: rel, error: relErr } = await db
      .from('retainage_releases')
      .insert({
        org_id: orgId,
        bill_id: billId,
        release_date: releaseDate,
        amount_cents: amountCents,
        payment_method: method ?? null,
        memo: memo ?? null,
        gl_entry_id: je.entry_id,
        created_by: null,
      })
      .select('id')
      .single();
    if (relErr || !rel) {
      // Compensate: the GL entry posted but the tracking row failed — void the entry.
      const { voidJournalEntry } = await import('./gl-posting');
      await voidJournalEntry(db, orgId, je.entry_id, null, 'Auto-reversed: retainage release row failed to save');
      return { success: false, error: `Failed to record the release: ${relErr?.message ?? 'unknown'}` };
    }

    return {
      success: true,
      releaseId: rel.id,
      entryNumber: je.entry_number,
      outstandingCents: outstanding - amountCents,
    };
  } catch (err) {
    if (err instanceof PostingError) return { success: false, error: err.message };
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ---- Register / overview ----------------------------------------------------

export interface RetainageRow {
  billId: string;
  billNumber: string | null;
  billDate: string;
  vendorName: string;
  locationName: string | null;
  status: string;
  retainagePct: number;
  withheldCents: number;
  releasedCents: number;
  outstandingCents: number;
}

export interface RetainageOverview {
  rows: RetainageRow[];
  totals: { withheldCents: number; releasedCents: number; outstandingCents: number };
}

/** Every bill that has retainage withheld, with released + outstanding amounts. */
export async function getRetainageRegister(db: DB, orgId: string): Promise<RetainageOverview> {
  const { data: bills } = await db
    .from('bills')
    .select('id, bill_number, bill_date, status, vendor_id, location_id, retainage_pct, retainage_cents')
    .eq('org_id', orgId)
    .gt('retainage_cents', 0)
    .order('bill_date', { ascending: false });

  const billRows = bills ?? [];
  if (billRows.length === 0) {
    return { rows: [], totals: { withheldCents: 0, releasedCents: 0, outstandingCents: 0 } };
  }

  // Released totals per bill (one query, grouped in JS).
  const billIds = billRows.map((b: Record<string, unknown>) => b.id as string);
  const { data: releases } = await db
    .from('retainage_releases')
    .select('bill_id, amount_cents')
    .eq('org_id', orgId)
    .in('bill_id', billIds);
  const releasedByBill = new Map<string, number>();
  for (const r of releases ?? []) {
    const id = r.bill_id as string;
    releasedByBill.set(id, (releasedByBill.get(id) ?? 0) + Number(r.amount_cents ?? 0));
  }

  // Vendor + location names from core.
  const vendorIds = [...new Set(billRows.map((b: Record<string, unknown>) => b.vendor_id as string).filter(Boolean))];
  const locationIds = [...new Set(billRows.map((b: Record<string, unknown>) => b.location_id as string).filter(Boolean))];
  const [vendorRes, locRes] = await Promise.all([
    vendorIds.length
      ? db.schema('core').from('vendors').select('id, name, display_name').in('id', vendorIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
    locationIds.length
      ? db.schema('core').from('locations').select('id, name').in('id', locationIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);
  const vendorName = new Map((vendorRes.data ?? []).map((v: Record<string, unknown>) => [v.id as string, (v.display_name as string) || (v.name as string)]));
  const locName = new Map((locRes.data ?? []).map((l: Record<string, unknown>) => [l.id as string, l.name as string]));

  const rows: RetainageRow[] = billRows.map((b: Record<string, unknown>) => {
    const withheld = Number(b.retainage_cents ?? 0);
    const released = releasedByBill.get(b.id as string) ?? 0;
    return {
      billId: b.id as string,
      billNumber: (b.bill_number as string) ?? null,
      billDate: b.bill_date as string,
      vendorName: vendorName.get(b.vendor_id as string) ?? 'Unknown vendor',
      locationName: locName.get(b.location_id as string) ?? null,
      status: b.status as string,
      retainagePct: Number(b.retainage_pct ?? 0),
      withheldCents: withheld,
      releasedCents: released,
      outstandingCents: withheld - released,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      withheldCents: acc.withheldCents + r.withheldCents,
      releasedCents: acc.releasedCents + r.releasedCents,
      outstandingCents: acc.outstandingCents + r.outstandingCents,
    }),
    { withheldCents: 0, releasedCents: 0, outstandingCents: 0 },
  );

  return { rows, totals };
}
