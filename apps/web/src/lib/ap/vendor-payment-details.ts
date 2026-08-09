/**
 * Vendor payment details — MASKED bank details + preferred method for the AP
 * pay-run, plus per-line check-number capture. (Pay-run depth, no live ACH.)
 *
 * HARD RULE (mirrors public.ach_authorizations): MeritBooks NEVER stores a full
 * bank account or routing number. The human types the number once; we take only
 * the last 4 digits, mask them, and persist the mask. `maskLast4` is the single
 * choke point — everything that writes a profile goes through it, and it is
 * idempotent (feeding it an already-masked value returns the same mask), so a
 * round-trip through the DB can never "unmask" or leak.
 *
 * SAFETY / CANON §3: nothing here moves money, contacts a bank, or posts to the
 * GL. It captures reference/remittance data for the human-released pay-run.
 * Every read/write is RLS-scoped by passing the request's scoped Supabase client.
 * Reads degrade SAFE (empty map) when the migration-137 tables are absent.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export type VendorPaymentMethod = 'ACH' | 'CHECK';
export type BankAccountType = 'checking' | 'savings';

export interface VendorPaymentProfile {
  vendorId: string;
  paymentMethod: VendorPaymentMethod;
  accountType: BankAccountType | null;
  /** last-4 mask only (e.g. '****1234'); never the full number. */
  accountMask: string | null;
  routingMask: string | null;
  bankName: string | null;
  notes: string | null;
  capturedAt: string | null;
  /** true when there is enough on file to remit by the chosen method. */
  hasBankDetails: boolean;
}

// ── Pure masking / normalization (no I/O — unit-tested directly) ─────────────

/**
 * Reduce a raw account/routing number to a last-4 mask. Strips all non-digits,
 * keeps the final 4, and prefixes a fixed 4-glyph mask. Returns null when fewer
 * than 4 digits are present. IDEMPOTENT: `maskLast4('****1234') === '****1234'`.
 */
export function maskLast4(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `****${digits.slice(-4)}`;
}

export function normalizeMethod(m: string | null | undefined): VendorPaymentMethod {
  return String(m ?? '').toUpperCase() === 'CHECK' ? 'CHECK' : 'ACH';
}

export function normalizeAccountType(t: string | null | undefined): BankAccountType | null {
  const v = String(t ?? '').toLowerCase();
  return v === 'savings' ? 'savings' : v === 'checking' ? 'checking' : null;
}

/** A profile "has bank details" iff it can be remitted by its method. */
export function hasBankDetails(p: {
  paymentMethod: VendorPaymentMethod;
  accountMask: string | null;
  routingMask: string | null;
}): boolean {
  // CHECK pays to a mailing address (held on the vendor master), so a CHECK
  // profile needs no bank numbers. ACH needs at least a masked account on file.
  if (p.paymentMethod === 'CHECK') return true;
  return !!p.accountMask;
}

// ── Row shapes ───────────────────────────────────────────────────────────────

interface ProfileRow {
  vendor_id: string;
  payment_method: string;
  account_type: string | null;
  account_mask: string | null;
  routing_mask: string | null;
  bank_name: string | null;
  notes: string | null;
  captured_at: string | null;
}

function toProfile(r: ProfileRow): VendorPaymentProfile {
  const paymentMethod = normalizeMethod(r.payment_method);
  const accountMask = r.account_mask;
  const routingMask = r.routing_mask;
  return {
    vendorId: r.vendor_id,
    paymentMethod,
    accountType: normalizeAccountType(r.account_type),
    accountMask,
    routingMask,
    bankName: r.bank_name,
    notes: r.notes,
    capturedAt: r.captured_at,
    hasBankDetails: hasBankDetails({ paymentMethod, accountMask, routingMask }),
  };
}

// ── Profile reads / writes ───────────────────────────────────────────────────

/**
 * Load payment profiles for the caller's org (RLS-scoped), optionally restricted
 * to a set of vendors. Returns a Map keyed by vendorId. Degrades to an empty map
 * if the table is absent, so the pay-run keeps working before migration 137.
 */
export async function loadVendorPaymentProfiles(
  supabase: SupabaseClient,
  vendorIds?: string[],
): Promise<Map<string, VendorPaymentProfile>> {
  const out = new Map<string, VendorPaymentProfile>();
  try {
    let q = supabase
      .from('vendor_payment_profiles')
      .select('vendor_id, payment_method, account_type, account_mask, routing_mask, bank_name, notes, captured_at');
    if (vendorIds && vendorIds.length > 0) q = q.in('vendor_id', vendorIds);
    const { data, error } = await q;
    if (error) return out; // degrade safe (missing table / RLS)
    for (const r of (data ?? []) as ProfileRow[]) out.set(r.vendor_id, toProfile(r));
  } catch {
    /* degrade safe */
  }
  return out;
}

export interface UpsertProfileInput {
  vendorId: string;
  paymentMethod: string;
  accountType?: string | null;
  /** RAW account number — masked to last-4 here and never persisted in full. */
  accountNumber?: string | null;
  /** RAW routing number — masked to last-4 here and never persisted in full. */
  routingNumber?: string | null;
  bankName?: string | null;
  notes?: string | null;
  capturedBy: string;
}

/**
 * Upsert a vendor's payment profile. The RAW account/routing numbers are masked
 * to last-4 BEFORE the write — the full values never leave this function. Upserts
 * on (org_id, vendor_id). Returns the stored (masked) profile.
 */
export async function upsertVendorPaymentProfile(
  supabase: SupabaseClient,
  orgId: string,
  input: UpsertProfileInput,
): Promise<VendorPaymentProfile> {
  const paymentMethod = normalizeMethod(input.paymentMethod);
  const accountMask = maskLast4(input.accountNumber);
  const routingMask = maskLast4(input.routingNumber);
  const row = {
    org_id: orgId,
    vendor_id: input.vendorId,
    payment_method: paymentMethod,
    account_type: normalizeAccountType(input.accountType),
    account_mask: accountMask,
    routing_mask: routingMask,
    bank_name: input.bankName?.trim() || null,
    notes: input.notes?.trim() || null,
    captured_by: input.capturedBy,
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('vendor_payment_profiles')
    .upsert(row, { onConflict: 'org_id,vendor_id' })
    .select('vendor_id, payment_method, account_type, account_mask, routing_mask, bank_name, notes, captured_at')
    .single();
  if (error) throw new Error(error.message);
  return toProfile(data as ProfileRow);
}

// ── Check-number capture ─────────────────────────────────────────────────────

/** Load assigned check numbers for the org, keyed by approvalId. Degrades safe. */
export async function loadCheckNumbers(
  supabase: SupabaseClient,
  approvalIds?: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    let q = supabase.from('disbursement_check_numbers').select('approval_id, check_number');
    if (approvalIds && approvalIds.length > 0) q = q.in('approval_id', approvalIds);
    const { data, error } = await q;
    if (error) return out;
    for (const r of (data ?? []) as Array<{ approval_id: string; check_number: string }>) {
      out.set(r.approval_id, r.check_number);
    }
  } catch {
    /* degrade safe */
  }
  return out;
}

export interface CheckNumberInput {
  approvalId: string;
  checkNumber: string;
}

/**
 * Upsert check numbers for disbursement lines (reference only — never posts). A
 * blank check number clears the assignment. Returns the count written/cleared.
 */
export async function upsertCheckNumbers(
  supabase: SupabaseClient,
  orgId: string,
  entries: CheckNumberInput[],
  assignedBy: string,
): Promise<number> {
  let n = 0;
  for (const e of entries) {
    const num = (e.checkNumber ?? '').trim();
    if (!num) {
      const { error } = await supabase
        .from('disbursement_check_numbers')
        .delete()
        .eq('org_id', orgId)
        .eq('approval_id', e.approvalId);
      if (!error) n += 1;
      continue;
    }
    const { error } = await supabase
      .from('disbursement_check_numbers')
      .upsert(
        { org_id: orgId, approval_id: e.approvalId, check_number: num, assigned_by: assignedBy, assigned_at: new Date().toISOString() },
        { onConflict: 'org_id,approval_id' },
      );
    if (error) throw new Error(error.message);
    n += 1;
  }
  return n;
}
