/**
 * Shared DB access for check processing (mig 182). Server-only.
 *
 * READS go through the caller's client (RLS + client scope) except check_stock_profiles,
 * whose pointer columns are column-revoked from members: those rows are read with an
 * explicit, mask-safe column list (member) or through the service writer (secrets).
 * WRITES go through `writerFor(caller)` (the service role for a member caller) after the
 * route's permission check, pinned to the org, with the owning company asserted in the
 * caller's client scope (lib/db/scoped-writer.ts).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopedWriter } from '@/lib/db/scoped-writer';
import type { CheckLayout } from '@/lib/ap/check-print/layout';
import type { PositivePayFormat } from './positive-pay';
import type { CheckStatus } from './register';

export type DB = SupabaseClient;

export interface CheckServiceOptions {
  /** Service-role writer override (tests). */
  writer?: SupabaseClient;
  /** Clock override (tests). */
  now?: Date;
}

export class CheckError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'CheckError';
    this.status = status;
  }
}

export function isCheckError(e: unknown): e is CheckError {
  return e instanceof CheckError;
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface BankAccountRow {
  id: string;
  location_id: string;
  account_id: string;
  institution_name: string;
  account_name: string;
  account_mask: string | null;
  account_type: string;
  is_active: boolean;
}

export async function loadBankAccount(db: DB, orgId: string, bankAccountId: string): Promise<BankAccountRow> {
  const { data, error } = await db
    .from('bank_accounts')
    .select('id, location_id, account_id, institution_name, account_name, account_mask, account_type, is_active')
    .eq('org_id', orgId)
    .eq('id', bankAccountId)
    .maybeSingle();
  if (error) throw new CheckError(`Could not load the bank account: ${error.message}`, 500);
  if (!data) throw new CheckError('That bank account was not found.', 404);
  return data as BankAccountRow;
}

/** Writer for a write landing on `locationId`'s books (client scope asserted for members). */
export function checkWriter(db: DB, orgId: string, locationId: string, opts: CheckServiceOptions = {}): Promise<DB> {
  return scopedWriter(db, orgId, [locationId], { writer: opts.writer });
}

/** Member-safe profile columns (never the column-revoked pointers). */
export const PROFILE_PUBLIC_COLUMNS =
  'id, org_id, location_id, bank_account_id, layout, offset_x_pt, offset_y_pt, payer_name, payer_address, logo_url, bank_name, bank_address, bank_fraction, routing_mask, account_mask, micr_set_at, micr_set_by, signature_set_at, signature_set_by, signature2_set_at, signature2_set_by, second_signature_over_cents, max_check_cents, void_after_days, stale_after_days, one_check_per_bill, aux_on_us_digits, positive_pay_format, positive_pay_mapping, updated_by, updated_at';

export interface ProfileRow {
  id: string;
  org_id: string;
  location_id: string;
  bank_account_id: string;
  layout: CheckLayout;
  offset_x_pt: number | string;
  offset_y_pt: number | string;
  payer_name: string | null;
  payer_address: string | null;
  logo_url: string | null;
  bank_name: string | null;
  bank_address: string | null;
  bank_fraction: string | null;
  routing_mask: string | null;
  account_mask: string | null;
  micr_set_at: string | null;
  micr_set_by: string | null;
  signature_set_at: string | null;
  signature_set_by: string | null;
  signature2_set_at: string | null;
  signature2_set_by: string | null;
  second_signature_over_cents: number | null;
  max_check_cents: number | null;
  void_after_days: number;
  stale_after_days: number;
  one_check_per_bill: boolean;
  aux_on_us_digits: number;
  positive_pay_format: PositivePayFormat;
  positive_pay_mapping: Record<string, unknown> | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface ProfileSecretRow {
  micr_secret_ref: string | null;
  signature_path: string | null;
  signature2_path: string | null;
}

export async function loadProfile(db: DB, orgId: string, bankAccountId: string): Promise<ProfileRow | null> {
  const { data, error } = await db
    .from('check_stock_profiles')
    .select(PROFILE_PUBLIC_COLUMNS)
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .maybeSingle();
  if (error) throw new CheckError(`Could not load the check stock settings: ${error.message}`, 500);
  return (data as unknown as ProfileRow | null) ?? null;
}

/** The pointer columns — service writer only. */
export async function loadProfileSecrets(writer: DB, orgId: string, bankAccountId: string): Promise<ProfileSecretRow | null> {
  const { data, error } = await writer
    .from('check_stock_profiles')
    .select('micr_secret_ref, signature_path, signature2_path')
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .maybeSingle();
  if (error) throw new CheckError(`Could not load the check stock settings: ${error.message}`, 500);
  return (data as ProfileSecretRow | null) ?? null;
}

export async function loadNextNumber(db: DB, orgId: string, bankAccountId: string): Promise<number> {
  const { data } = await db
    .from('bank_check_sequences')
    .select('next_number')
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .maybeSingle();
  return Number((data as { next_number: number } | null)?.next_number ?? 1001);
}

export interface CheckRow {
  id: string;
  org_id: string;
  location_id: string;
  bank_account_id: string;
  check_number: number;
  check_date: string;
  payee_vendor_id: string | null;
  payee_name: string;
  payee_address: string | null;
  amount_cents: number;
  memo: string | null;
  status: CheckStatus;
  print_run_id: string | null;
  printed_by: string;
  printed_at: string;
  issued_at: string | null;
  mailed_at: string | null;
  cleared_at: string | null;
  cleared_bank_transaction_id: string | null;
  cleared_by: string | null;
  clear_note: string | null;
  void_requested_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  void_kind: 'VOID' | 'SPOIL' | null;
  void_date: string | null;
  reversal_mode: string | null;
  replaces_check_id: string | null;
  positive_pay_issue_export_id: string | null;
  positive_pay_void_export_id: string | null;
}

export interface CheckPaymentRow {
  id: string;
  check_id: string;
  bill_payment_id: string;
  approval_id: string | null;
  bill_id: string;
  amount_cents: number;
  is_current: boolean;
  reversed_at: string | null;
}

export async function loadCheck(db: DB, orgId: string, checkId: string): Promise<CheckRow> {
  const { data, error } = await db.from('ap_checks').select('*').eq('org_id', orgId).eq('id', checkId).maybeSingle();
  if (error) throw new CheckError(`Could not load the check: ${error.message}`, 500);
  if (!data) throw new CheckError('That check was not found.', 404);
  return data as CheckRow;
}

export async function loadCheckPayments(db: DB, orgId: string, checkIds: readonly string[]): Promise<CheckPaymentRow[]> {
  if (checkIds.length === 0) return [];
  const { data, error } = await db
    .from('ap_check_payments')
    .select('id, check_id, bill_payment_id, approval_id, bill_id, amount_cents, is_current, reversed_at')
    .eq('org_id', orgId)
    .in('check_id', [...checkIds]);
  if (error) throw new CheckError(`Could not load the check's payments: ${error.message}`, 500);
  return (data ?? []) as CheckPaymentRow[];
}

/** Append an approval-step audit row (best-effort is NOT acceptable for transitions — throws). */
export async function moveApproval(
  writer: DB,
  orgId: string,
  approvalId: string,
  from: 'RELEASED',
  to: 'RETURNED' | 'SETTLED',
  actor: string,
  note: string,
): Promise<boolean> {
  const { data, error } = await writer
    .from('approvals')
    .update({ status: to })
    .eq('org_id', orgId)
    .eq('id', approvalId)
    .eq('status', from)
    .select('id');
  if (error) throw new CheckError(`Could not update the payment approval: ${error.message}`, 500);
  const moved = ((data ?? []) as unknown[]).length > 0;
  if (moved) {
    await writer.from('approval_steps').insert({
      org_id: orgId,
      approval_id: approvalId,
      action: to,
      actor,
      before_state: from,
      after_state: to,
      note: note.slice(0, 500),
    });
  }
  return moved;
}
