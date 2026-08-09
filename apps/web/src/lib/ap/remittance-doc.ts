/**
 * Assemble a remittance-advice document for ONE vendor from the approved AP
 * pay-run batch. The remittance tells a vendor exactly which invoices a payment
 * covers — the standard courtesy that ships with an ACH/check disbursement.
 *
 * SAFETY: read-only. Assembling a remittance NEVER moves money, posts to the GL,
 * or contacts a bank. RLS scopes every read to the caller's org (pass the
 * request's scoped client). Reuses the same approved-batch assembly the release
 * path uses, so the remittance can never disagree with what actually posts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assembleApprovedBatch } from './assemble-batch';
import { buildDisbursementBatch } from './disbursement-batch';
import { loadVendorPaymentProfiles, loadCheckNumbers, type VendorPaymentProfile } from './vendor-payment-details';

export interface RemittanceLine {
  approvalId: string;
  invoiceRef: string | null;
  paymentDate: string;
  amountCents: number;
  method: 'ACH' | 'CHECK';
  checkNumber: string | null;
}

export interface RemittanceDoc {
  /** the paying company/entity (location name, else org name). */
  payerName: string;
  vendorId: string;
  vendorName: string;
  vendorAddress: string[];
  vendorEmail: string | null;
  paymentMethod: 'ACH' | 'CHECK';
  profile: VendorPaymentProfile | null;
  /** ISO date the remittance is generated. */
  generatedDate: string;
  reference: string;
  lines: RemittanceLine[];
  totalCents: number;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the remittance doc for `vendorId` from the org's APPROVED, ready-to-release
 * batch. Returns null when that vendor has no approved lines in the batch.
 */
export async function loadRemittanceDoc(
  supabase: SupabaseClient,
  orgId: string,
  vendorId: string,
): Promise<RemittanceDoc | null> {
  const assembled = await assembleApprovedBatch(supabase);
  if (assembled.items.length === 0) return null;

  const batch = buildDisbursementBatch(assembled.items);
  const group = batch.groups.find((g) => g.vendorId === vendorId);
  if (!group) return null;

  const [profiles, checkNumbers] = await Promise.all([
    loadVendorPaymentProfiles(supabase, [vendorId]),
    loadCheckNumbers(
      supabase,
      group.items.map((i) => i.approvalId),
    ),
  ]);
  const profile = profiles.get(vendorId) ?? null;

  // Payer = the paying company. Use the (single) location name when the batch's
  // lines share one, else fall back to the org name.
  const payerName = await resolvePayerName(supabase, orgId, group.items.map((i) => i.locationId));

  const remit = assembled.remittance.get(vendorId);
  const vendorAddress: string[] = [];
  if (remit) {
    if (remit.addressLine1) vendorAddress.push(remit.addressLine1);
    if (remit.addressLine2) vendorAddress.push(remit.addressLine2);
    const cityStateZip = [remit.city, remit.state].filter(Boolean).join(', ');
    const csz = [cityStateZip, remit.zip].filter(Boolean).join(' ');
    if (csz) vendorAddress.push(csz);
  }

  const lines: RemittanceLine[] = group.items.map((i) => ({
    approvalId: i.approvalId,
    invoiceRef: i.invoiceRef,
    paymentDate: i.paymentDate,
    amountCents: i.amountCents,
    method: i.method,
    checkNumber: checkNumbers.get(i.approvalId) ?? null,
  }));

  return {
    payerName,
    vendorId,
    vendorName: group.vendorName,
    vendorAddress,
    vendorEmail: remit?.email ?? null,
    paymentMethod: profile?.paymentMethod ?? lines[0]?.method ?? 'ACH',
    profile,
    generatedDate: today(),
    reference: `REM-${today()}-${vendorId.slice(0, 8)}`,
    lines,
    totalCents: group.subtotalCents,
  };
}

async function resolvePayerName(
  supabase: SupabaseClient,
  orgId: string,
  locationIds: Array<string | null>,
): Promise<string> {
  const distinct = Array.from(new Set(locationIds.filter((l): l is string => !!l)));
  if (distinct.length === 1) {
    try {
      const { data } = await supabase.schema('core').from('locations').select('name').eq('id', distinct[0]).maybeSingle();
      const name = (data as { name?: string } | null)?.name;
      if (name) return name;
    } catch {
      /* fall through to org */
    }
  }
  try {
    const { data } = await supabase.schema('core').from('organizations').select('name').eq('id', orgId).maybeSingle();
    const name = (data as { name?: string } | null)?.name;
    if (name) return name;
  } catch {
    /* fall through */
  }
  return 'Your company';
}
