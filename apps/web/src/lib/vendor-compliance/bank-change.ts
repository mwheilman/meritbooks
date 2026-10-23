/**
 * VN-10 — vendor bank-change call-back (FPB-vendor-compliance-chase §19 A7).
 *
 * Business-email compromise works by sending "our bank details changed" with a phone
 * number the fraudster answers. So: any change to a vendor's banking (a portal banking
 * upload, or a changed account / routing mask on the payment profile — DB trigger, mig
 * 180) opens a PENDING verification, and while one is pending NO payment to that vendor
 * is released (enforcePaymentAllowed; overrides do not lift it). A person verifies by
 * calling a number ALREADY ON FILE (vendor master, a prior document, an independent
 * lookup) — never the number on the request (the DB refuses it too) — and records who
 * called, when, whom they reached and which number they used. The person who made the
 * change may not verify it.
 *
 * All writes are the service role after the route's permission check, org pinned.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { logVendorComplianceEvent } from '@/lib/services/vendor-compliance-audit';
import { isMissingRelation } from './store';

type DB = SupabaseClient;

export const PHONE_SOURCES = ['vendor_master', 'prior_document', 'independent_lookup'] as const;
export type PhoneSource = (typeof PHONE_SOURCES)[number];

export const PHONE_SOURCE_LABEL: Record<PhoneSource, string> = {
  vendor_master: 'Number on the vendor record (before the change)',
  prior_document: 'Number on an earlier invoice or contract',
  independent_lookup: 'Looked up independently (website, directory)',
};

export interface BankChangeRow {
  id: string;
  org_id: string;
  vendor_id: string;
  source: 'vendor_portal' | 'payment_profile' | 'manual';
  document_id: string | null;
  prior_account_mask: string | null;
  new_account_mask: string | null;
  new_routing_mask: string | null;
  new_bank_name: string | null;
  request_phone: string | null;
  status: 'pending' | 'verified' | 'rejected' | 'cancelled';
  opened_by: string | null;
  opened_at: string;
  called_by: string | null;
  called_at: string | null;
  contact_name: string | null;
  phone_used: string | null;
  phone_source: PhoneSource | null;
  notes: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_reason: string | null;
}

export const BANK_CHANGE_COLUMNS =
  'id, org_id, vendor_id, source, document_id, prior_account_mask, new_account_mask, new_routing_mask, new_bank_name, request_phone, status, opened_by, opened_at, called_by, called_at, contact_name, phone_used, phone_source, notes, decided_by, decided_at, decision_reason';

export class BankChangeError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'BankChangeError';
  }
}

/** Last ten digits (US numbers with or without +1). */
export function phoneDigits(p: string | null | undefined): string {
  return (p ?? '').replace(/\D/g, '').slice(-10);
}

/** Pure validation of a call-back (exported for tests). Returns an error sentence or null. */
export function validateCallBack(
  row: Pick<BankChangeRow, 'status' | 'request_phone' | 'opened_by'>,
  input: { actor: string; phoneUsed: string; phoneSource: string; contactName: string },
): string | null {
  if (row.status !== 'pending') return 'This change has already been decided.';
  if (row.opened_by && row.opened_by === input.actor) return 'You made this change, so someone else has to verify it.';
  if (!(PHONE_SOURCES as readonly string[]).includes(input.phoneSource)) return 'Say where the number you called came from.';
  if (phoneDigits(input.phoneUsed).length < 10) return 'Enter the full phone number you called.';
  if (row.request_phone && phoneDigits(row.request_phone) && phoneDigits(row.request_phone) === phoneDigits(input.phoneUsed)) {
    return 'That is the number that came with the change request. Call a number you already had on file.';
  }
  if (input.contactName.trim().length < 2) return 'Record the name of the person who confirmed the change.';
  return null;
}

/**
 * A pending change blocks payment. Tolerates ONLY a confirmed missing table (un-migrated
 * DB, 42P01 / PGRST205); every other error throws so the pay gate fails CLOSED.
 */
export async function pendingBankChange(db: DB, orgId: string, vendorId: string): Promise<BankChangeRow | null> {
  const { data, error } = await db
    .from('vendor_bank_change_verifications')
    .select(BANK_CHANGE_COLUMNS)
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .eq('status', 'pending')
    .order('opened_at', { ascending: true })
    .limit(1);
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(`Could not check vendor bank changes: ${error.message}`);
  }
  return ((data ?? [])[0] as BankChangeRow | undefined) ?? null;
}

/**
 * Does banking block payment to this vendor? A pending change always does. A REJECTED
 * profile change keeps blocking while the payment profile still carries the rejected
 * details (rejecting a fraudulent change must not quietly pay the fraudster's account).
 */
export async function bankChangeBlock(db: DB, orgId: string, vendorId: string): Promise<string | null> {
  const pending = await pendingBankChange(db, orgId, vendorId);
  if (pending) return bankChangeHoldMessage(pending);
  const { data: rejected, error } = await db
    .from('vendor_bank_change_verifications')
    .select('id, new_account_mask, new_routing_mask, new_account_fingerprint, decided_at')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .eq('status', 'rejected')
    .eq('source', 'payment_profile')
    .order('decided_at', { ascending: false })
    .limit(1);
  if (error) {
    if (isMissingRelation(error)) return null;
    throw new Error(`Could not check rejected vendor bank changes: ${error.message}`);
  }
  if (!rejected || rejected.length === 0) return null;
  const r = rejected[0] as { new_account_mask: string | null; new_routing_mask: string | null; new_account_fingerprint: string | null };
  const { data: prof, error: profErr } = await db.from('vendor_payment_profiles').select('account_mask, routing_mask, account_fingerprint').eq('org_id', orgId).eq('vendor_id', vendorId).maybeSingle();
  if (profErr && !isMissingRelation(profErr)) throw new Error(`Could not read the vendor payment profile: ${profErr.message}`);
  const p = prof as { account_mask: string | null; routing_mask: string | null; account_fingerprint: string | null } | null;
  const sameFingerprint = !r.new_account_fingerprint || !p?.account_fingerprint || r.new_account_fingerprint === p.account_fingerprint;
  if (p && sameFingerprint && (r.new_account_mask ?? null) === (p.account_mask ?? null) && (r.new_routing_mask ?? null) === (p.routing_mask ?? null)) {
    return "A bank-detail change for this vendor was rejected as unverified, and the payment profile still carries those details. Restore the vendor's verified bank details before paying.";
  }
  return null;
}

export async function openBankChange(
  orgId: string,
  input: {
    vendorId: string;
    source: BankChangeRow['source'];
    documentId?: string | null;
    newAccountMask?: string | null;
    newRoutingMask?: string | null;
    newBankName?: string | null;
    requestPhone?: string | null;
    openedBy: string;
    notes?: string | null;
  },
  writer?: DB,
): Promise<BankChangeRow> {
  const w = serviceWriter(writer);
  const { data, error } = await w
    .from('vendor_bank_change_verifications')
    .insert({
      org_id: orgId,
      vendor_id: input.vendorId,
      source: input.source,
      document_id: input.documentId ?? null,
      new_account_mask: input.newAccountMask ?? null,
      new_routing_mask: input.newRoutingMask ?? null,
      new_bank_name: input.newBankName?.slice(0, 120) ?? null,
      request_phone: input.requestPhone?.slice(0, 40) ?? null,
      opened_by: input.openedBy,
      notes: input.notes?.slice(0, 1000) ?? null,
    })
    .select(BANK_CHANGE_COLUMNS)
    .single();
  if (error || !data) throw new BankChangeError(`Could not record the bank change: ${error?.message ?? 'no row'}`, 500);
  await logVendorComplianceEvent(w, orgId, input.vendorId, 'BANK_CHANGE_OPENED',
    `Banking details changed (${input.source.replace('_', ' ')}); payments held until a call-back verifies it.`, { actor: input.openedBy, meta: { verification_id: (data as BankChangeRow).id } });
  return data as BankChangeRow;
}

async function loadPending(w: DB, orgId: string, id: string): Promise<BankChangeRow> {
  const { data, error } = await w.from('vendor_bank_change_verifications').select(BANK_CHANGE_COLUMNS).eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw new BankChangeError(`Could not read the bank change: ${error.message}`, 500);
  if (!data) throw new BankChangeError('Bank change not found.', 404);
  return data as BankChangeRow;
}

export async function verifyBankChange(
  orgId: string,
  id: string,
  input: { actor: string; phoneUsed: string; phoneSource: PhoneSource; contactName: string; calledAt?: string | null; notes?: string | null },
  writer?: DB,
  now: Date = new Date(),
): Promise<BankChangeRow> {
  const w = serviceWriter(writer);
  const row = await loadPending(w, orgId, id);
  const problem = validateCallBack(row, input);
  if (problem) throw new BankChangeError(problem, row.status !== 'pending' ? 409 : 400);
  const { data, error } = await w
    .from('vendor_bank_change_verifications')
    .update({
      status: 'verified',
      called_by: input.actor,
      called_at: clampCalledAt(input.calledAt ?? null, row.opened_at, now),
      contact_name: input.contactName.trim().slice(0, 120),
      phone_used: input.phoneUsed.trim().slice(0, 40),
      phone_source: input.phoneSource,
      notes: input.notes?.trim().slice(0, 1000) || row.notes,
      decided_by: input.actor,
      decided_at: now.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('status', 'pending')
    .select(BANK_CHANGE_COLUMNS);
  if (error) throw new BankChangeError(/not_request_phone/.test(error.message) ? 'That is the number that came with the change request. Call a number you already had on file.' : `Could not verify: ${error.message}`, 400);
  const updated = (Array.isArray(data) ? data[0] : null) as BankChangeRow | null;
  if (!updated) throw new BankChangeError('This change has already been decided.', 409);
  await logVendorComplianceEvent(w, orgId, row.vendor_id, 'BANK_CHANGE_VERIFIED',
    `Bank change verified by call-back to ${maskPhone(input.phoneUsed)} (${PHONE_SOURCE_LABEL[input.phoneSource].toLowerCase()}); spoke with ${input.contactName.trim()}.`,
    { actor: input.actor, meta: { verification_id: id } });
  return updated;
}

export async function rejectBankChange(orgId: string, id: string, input: { actor: string; reason: string }, writer?: DB, now: Date = new Date()): Promise<BankChangeRow> {
  const w = serviceWriter(writer);
  const why = input.reason.trim();
  if (why.length < 3) throw new BankChangeError('Say why (it goes on the audit trail).');
  const row = await loadPending(w, orgId, id);
  if (row.status !== 'pending') throw new BankChangeError('This change has already been decided.', 409);
  const { data, error } = await w
    .from('vendor_bank_change_verifications')
    .update({ status: 'rejected', decided_by: input.actor, decided_at: now.toISOString(), decision_reason: why.slice(0, 500), updated_at: now.toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('status', 'pending')
    .select(BANK_CHANGE_COLUMNS);
  if (error) throw new BankChangeError(`Could not reject: ${error.message}`, 500);
  const updated = (Array.isArray(data) ? data[0] : null) as BankChangeRow | null;
  if (!updated) throw new BankChangeError('This change has already been decided.', 409);
  await logVendorComplianceEvent(w, orgId, row.vendor_id, 'BANK_CHANGE_REJECTED', `Bank change rejected: ${why}.${row.source === 'payment_profile' ? ' Payments stay held until the payment profile is back on verified details.' : ''}`, {
    actor: input.actor,
    meta: { verification_id: id },
  });
  return updated;
}

/**
 * When the call happened: the caller may back-date to when they actually phoned, but never
 * before the change was opened (you cannot verify a change before it existed) and never in
 * the future. Unparseable → now.
 */
export function clampCalledAt(calledAt: string | null | undefined, openedAt: string, now: Date): string {
  const t = calledAt ? new Date(calledAt).getTime() : NaN;
  if (!Number.isFinite(t)) return now.toISOString();
  const lo = new Date(openedAt).getTime();
  const hi = now.getTime();
  const clamped = Math.min(Math.max(t, Number.isFinite(lo) ? lo : t), hi);
  return new Date(clamped).toISOString();
}

/** "(•••) •••-1234" — the audit trail never needs the full number. */
export function maskPhone(p: string): string {
  const d = phoneDigits(p);
  return d.length >= 4 ? `•••-•••-${d.slice(-4)}` : '•••';
}

/** The hold message a payer sees. */
export function bankChangeHoldMessage(row: Pick<BankChangeRow, 'opened_at' | 'source'>): string {
  const when = row.opened_at ? row.opened_at.slice(0, 10) : 'recently';
  return `This vendor's bank details changed on ${when}. Call the vendor at a number you already have on file (not one from the change request) and record the call-back in Vendor compliance → Bank changes before paying.`;
}
