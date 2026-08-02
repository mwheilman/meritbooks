/**
 * Assemble the APPROVED AP disbursement batch from owned data (money-out MVP).
 *
 * Reads the AP_DISBURSEMENT approvals that a human has already APPROVED (the
 * separation-of-duties gate on /checks), stitches the underlying bill + vendor,
 * and shapes them into the pure batch-builder's input. RLS scopes every read to
 * the caller's org (pass the request's RLS-scoped Supabase client).
 *
 * SAFETY: read-only. Assembling a batch NEVER moves money, posts to the GL, or
 * contacts a bank. Releasing is a separate, explicitly-gated human action.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { DisbursementItemInput, DisbursementMethod } from './disbursement-batch';
import type { RemittanceDetail } from './disbursement-export';

export interface AssembledBatchInput {
  items: DisbursementItemInput[];
  remittance: Map<string, RemittanceDetail>;
  /** approvalIds whose bill could not be resolved (skipped from the batch). */
  unresolved: string[];
}

interface ApprovalRow {
  id: string;
  subject_id: string;
  amount_cents: number | null;
  prepared_by: string;
}
interface BillRow {
  id: string;
  vendor_id: string;
  location_id: string | null;
  bill_number: string | null;
  due_date: string | null;
  payment_method: string | null;
  balance_cents: number | string | null;
  status: string;
}
interface VendorRow {
  id: string;
  name: string;
  display_name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  email: string | null;
}

function methodFor(paymentMethod: string | null): DisbursementMethod {
  return (paymentMethod ?? '').toUpperCase() === 'CHECK' ? 'CHECK' : 'ACH';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Load approved disbursements as batch inputs. Optionally restrict to specific
 * approval ids (used by the release path). Returns empty inputs when nothing is
 * approved — the caller degrades safely.
 */
export async function assembleApprovedBatch(
  supabase: SupabaseClient,
  opts: { approvalIds?: string[] } = {},
): Promise<AssembledBatchInput> {
  let q = supabase
    .from('approvals')
    .select('id, subject_id, amount_cents, prepared_by')
    .eq('kind', 'AP_DISBURSEMENT')
    .eq('subject_table', 'bills')
    .eq('status', 'APPROVED');
  if (opts.approvalIds && opts.approvalIds.length > 0) {
    q = q.in('id', opts.approvalIds);
  }
  const { data: apprData, error: apprErr } = await q;
  if (apprErr) throw new Error(apprErr.message);
  const approvals = (apprData ?? []) as ApprovalRow[];
  if (approvals.length === 0) return { items: [], remittance: new Map(), unresolved: [] };

  const billIds = Array.from(new Set(approvals.map((a) => a.subject_id)));
  const { data: billData, error: billErr } = await supabase
    .from('bills')
    .select('id, vendor_id, location_id, bill_number, due_date, payment_method, balance_cents, status')
    .in('id', billIds);
  if (billErr) throw new Error(billErr.message);
  const billById = new Map<string, BillRow>(((billData ?? []) as BillRow[]).map((b) => [b.id, b]));

  const vendorIds = Array.from(
    new Set(((billData ?? []) as BillRow[]).map((b) => b.vendor_id).filter(Boolean)),
  );
  const remittance = new Map<string, RemittanceDetail>();
  const vendorNameById = new Map<string, string>();
  if (vendorIds.length > 0) {
    const { data: vData } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, name, display_name, address_line1, address_line2, city, state, zip, email')
      .in('id', vendorIds);
    for (const v of (vData ?? []) as VendorRow[]) {
      vendorNameById.set(v.id, v.display_name || v.name);
      remittance.set(v.id, {
        vendorId: v.id,
        addressLine1: v.address_line1,
        addressLine2: v.address_line2,
        city: v.city,
        state: v.state,
        zip: v.zip,
        email: v.email,
      });
    }
  }

  const items: DisbursementItemInput[] = [];
  const unresolved: string[] = [];
  for (const a of approvals) {
    const bill = billById.get(a.subject_id);
    if (!bill) {
      unresolved.push(a.id);
      continue;
    }
    const amountCents = a.amount_cents ?? Number(bill.balance_cents) ?? 0;
    if (!amountCents || amountCents <= 0) {
      unresolved.push(a.id);
      continue;
    }
    items.push({
      approvalId: a.id,
      billId: bill.id,
      vendorId: bill.vendor_id,
      vendorName: vendorNameById.get(bill.vendor_id) ?? 'Unknown vendor',
      invoiceRef: bill.bill_number,
      amountCents,
      paymentDate: bill.due_date ?? today(),
      method: methodFor(bill.payment_method),
      locationId: bill.location_id,
      preparedBy: a.prepared_by,
    });
  }

  return { items, remittance, unresolved };
}
