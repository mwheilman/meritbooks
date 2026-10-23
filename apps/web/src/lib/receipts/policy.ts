/**
 * Receipt policy (public.receipt_policies, migration 181) and the receipt-chase switch.
 *
 *   policy   code default ← tenant row (location_id null) ← client row; a null column
 *            inherits. Defaults: receipt over 75.00 (the IRS substantiation line), no
 *            grace, 60-day chase window, reminders day 0 / 2 / 5 / 10, escalate to the
 *            cardholder's manager, match ±5.00 / tip ≤ 25 % / ±3 days, auto ≥ 0.90,
 *            suggest ≥ 0.70 (the bank-feed bands).
 *   switch   effective = tenant on AND (client null or on) — FPB-workforce-app §4.9. A
 *            client can never turn chase on while the tenant has it off.
 *
 * The cadence's FIRST ask and the quiet hours stay in Settings → Receipt chase
 * (core.organizations.chase_*), read by the request engine — one source of truth.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { EscalateTo } from './types';

export interface ReceiptPolicy {
  receiptRequiredOverCents: number;
  memoRequired: boolean;
  memoRequiredOverCents: number;
  graceDays: number;
  chaseWindowDays: number;
  reminderDays: number[];
  escalateTo: EscalateTo;
  bookkeeperMembershipId: string | null;
  amountToleranceCents: number;
  tipToleranceBp: number;
  dateWindowDays: number;
  autoMatchMinScore: number;
  suggestMinScore: number;
  digestEnabled: boolean;
}

export const RECEIPT_POLICY_DEFAULTS: ReceiptPolicy = {
  receiptRequiredOverCents: 7500,
  memoRequired: false,
  memoRequiredOverCents: 0,
  graceDays: 0,
  chaseWindowDays: 60,
  reminderDays: [0, 2, 5, 10],
  escalateTo: 'manager',
  bookkeeperMembershipId: null,
  amountToleranceCents: 500,
  tipToleranceBp: 2500,
  dateWindowDays: 3,
  autoMatchMinScore: 0.9,
  suggestMinScore: 0.7,
  digestEnabled: true,
};

/** A receipt_policies row as stored (every policy column nullable = inherit). */
export interface ReceiptPolicyRow {
  id?: string;
  location_id: string | null;
  receipt_required_over_cents: number | null;
  memo_required: boolean | null;
  memo_required_over_cents: number | null;
  grace_days: number | null;
  chase_window_days: number | null;
  reminder_days: number[] | null;
  escalate_to: EscalateTo | null;
  bookkeeper_membership_id: string | null;
  amount_tolerance_cents: number | null;
  tip_tolerance_bp: number | null;
  date_window_days: number | null;
  auto_match_min_score: number | string | null;
  suggest_min_score: number | string | null;
  digest_enabled: boolean | null;
}

export const RECEIPT_POLICY_COLUMNS =
  'id, location_id, receipt_required_over_cents, memo_required, memo_required_over_cents, grace_days, chase_window_days, reminder_days, escalate_to, bookkeeper_membership_id, amount_tolerance_cents, tip_tolerance_bp, date_window_days, auto_match_min_score, suggest_min_score, digest_enabled';

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function layer(base: ReceiptPolicy, row: ReceiptPolicyRow | null | undefined): ReceiptPolicy {
  if (!row) return base;
  const days = row.reminder_days?.length ? Array.from(new Set(row.reminder_days.map((d) => Math.max(0, Math.trunc(d))))).sort((a, b) => a - b) : null;
  return {
    receiptRequiredOverCents: num(row.receipt_required_over_cents) ?? base.receiptRequiredOverCents,
    memoRequired: row.memo_required ?? base.memoRequired,
    memoRequiredOverCents: num(row.memo_required_over_cents) ?? base.memoRequiredOverCents,
    graceDays: num(row.grace_days) ?? base.graceDays,
    chaseWindowDays: num(row.chase_window_days) ?? base.chaseWindowDays,
    reminderDays: days ?? base.reminderDays,
    escalateTo: row.escalate_to ?? base.escalateTo,
    bookkeeperMembershipId: row.bookkeeper_membership_id ?? base.bookkeeperMembershipId,
    amountToleranceCents: num(row.amount_tolerance_cents) ?? base.amountToleranceCents,
    tipToleranceBp: num(row.tip_tolerance_bp) ?? base.tipToleranceBp,
    dateWindowDays: num(row.date_window_days) ?? base.dateWindowDays,
    autoMatchMinScore: num(row.auto_match_min_score) ?? base.autoMatchMinScore,
    suggestMinScore: num(row.suggest_min_score) ?? base.suggestMinScore,
    digestEnabled: row.digest_enabled ?? base.digestEnabled,
  };
}

/** Pure merge for one client: default ← tenant ← client. */
export function mergeReceiptPolicy(rows: ReadonlyArray<ReceiptPolicyRow>, locationId: string | null): ReceiptPolicy {
  const tenant = rows.find((r) => r.location_id == null) ?? null;
  const client = locationId ? rows.find((r) => r.location_id === locationId) ?? null : null;
  return layer(layer(RECEIPT_POLICY_DEFAULTS, tenant), client);
}

/** Does a charge of this size need a receipt? (strictly over the threshold — "over $75"). */
export function receiptRequired(policy: Pick<ReceiptPolicy, 'receiptRequiredOverCents'>, amountCents: number): boolean {
  return Math.abs(amountCents) > policy.receiptRequiredOverCents;
}

/** Does this charge need a memo / business purpose? */
export function memoRequired(policy: Pick<ReceiptPolicy, 'memoRequired' | 'memoRequiredOverCents'>, amountCents: number): boolean {
  return policy.memoRequired && Math.abs(amountCents) > policy.memoRequiredOverCents;
}

// ── the switch ────────────────────────────────────────────────────────────────

export interface ChaseSwitches {
  tenantEnabled: boolean;
  tenantChangedAt: string | null;
  /** location_id → client switch (null = follow the tenant). Missing = follow. */
  clients: Map<string, { enabled: boolean | null; changedAt: string | null }>;
}

/** Effective receipt chase for one client (FPB §4.9). */
export function chaseEnabledFor(sw: ChaseSwitches, locationId: string): boolean {
  if (!sw.tenantEnabled) return false;
  const c = sw.clients.get(locationId);
  return c?.enabled == null ? true : c.enabled;
}

/**
 * The moment chase (re)started for a client — the later of the tenant's and the
 * client's last switch-on. Charges before it are only chased while still inside the
 * chase window (no burst on re-enable). null = never switched (on since the start).
 */
export function chaseResumedAt(sw: ChaseSwitches, locationId: string): string | null {
  const c = sw.clients.get(locationId);
  const times = [sw.tenantChangedAt, c?.enabled === false ? null : c?.changedAt ?? null].filter((t): t is string => !!t);
  if (times.length === 0) return null;
  return times.sort()[times.length - 1];
}

export interface ReceiptPolicyContext {
  rows: ReceiptPolicyRow[];
  switches: ChaseSwitches;
  /** core.organizations.chase_first_reminder_minutes (Settings → Receipt chase). */
  firstReminderMinutes: number;
  chaseChannel: string | null;
  orgTimezone: string | null;
}

/** Load the tenant's receipt policy rows + switches (service role, org pinned). */
export async function loadReceiptPolicyContext(db: SupabaseClient, orgId: string): Promise<ReceiptPolicyContext> {
  const [{ data: org, error: orgErr }, { data: rows, error: rowErr }, { data: cps, error: cpErr }] = await Promise.all([
    db
      .schema('core')
      .from('organizations')
      .select('receipt_chase_enabled, receipt_chase_changed_at, chase_first_reminder_minutes, chase_channel, timezone')
      .eq('id', orgId)
      .maybeSingle(),
    db.from('receipt_policies').select(RECEIPT_POLICY_COLUMNS).eq('org_id', orgId),
    db.from('company_policies').select('location_id, receipt_chase_enabled, receipt_chase_changed_at').eq('org_id', orgId),
  ]);
  if (orgErr) throw new Error(`Could not read the receipt chase switch: ${orgErr.message}`);
  if (rowErr) throw new Error(`Could not read receipt policies: ${rowErr.message}`);
  if (cpErr) throw new Error(`Could not read client receipt switches: ${cpErr.message}`);
  const o = (org ?? {}) as {
    receipt_chase_enabled?: boolean | null;
    receipt_chase_changed_at?: string | null;
    chase_first_reminder_minutes?: number | null;
    chase_channel?: string | null;
    timezone?: string | null;
  };
  const clients = new Map<string, { enabled: boolean | null; changedAt: string | null }>();
  for (const c of (cps ?? []) as Array<{ location_id: string; receipt_chase_enabled: boolean | null; receipt_chase_changed_at: string | null }>) {
    clients.set(c.location_id, { enabled: c.receipt_chase_enabled ?? null, changedAt: c.receipt_chase_changed_at ?? null });
  }
  return {
    rows: (rows ?? []) as ReceiptPolicyRow[],
    switches: { tenantEnabled: o.receipt_chase_enabled !== false, tenantChangedAt: o.receipt_chase_changed_at ?? null, clients },
    firstReminderMinutes: Math.max(0, Number(o.chase_first_reminder_minutes ?? 30)),
    chaseChannel: o.chase_channel ?? null,
    orgTimezone: o.timezone ?? null,
  };
}

/** Validate a policy patch from the settings screen. Returns an error message or null. Pure. */
export function validatePolicyPatch(p: Partial<ReceiptPolicy>): string | null {
  if (p.receiptRequiredOverCents != null && (p.receiptRequiredOverCents < 0 || p.receiptRequiredOverCents > 100_000_000)) return 'The receipt threshold must be between 0.00 and 1,000,000.00.';
  if (p.graceDays != null && (p.graceDays < 0 || p.graceDays > 30)) return 'Grace days must be between 0 and 30.';
  if (p.chaseWindowDays != null && (p.chaseWindowDays < 1 || p.chaseWindowDays > 365)) return 'The chase window must be between 1 and 365 days.';
  if (p.reminderDays) {
    if (p.reminderDays.length < 1 || p.reminderDays.length > 12) return 'Use between 1 and 12 reminder days.';
    if (p.reminderDays.some((d) => !Number.isInteger(d) || d < 0 || d > 90)) return 'Reminder days must be whole days from 0 to 90.';
  }
  if (p.tipToleranceBp != null && (p.tipToleranceBp < 0 || p.tipToleranceBp > 10_000)) return 'The tip allowance must be between 0 % and 100 %.';
  if (p.dateWindowDays != null && (p.dateWindowDays < 0 || p.dateWindowDays > 14)) return 'The date window must be between 0 and 14 days.';
  if (p.amountToleranceCents != null && (p.amountToleranceCents < 0 || p.amountToleranceCents > 100_000)) return 'The amount tolerance must be between 0.00 and 1,000.00.';
  if (p.autoMatchMinScore != null && p.suggestMinScore != null && p.suggestMinScore > p.autoMatchMinScore) return 'The suggest score cannot be above the auto-match score.';
  if (p.autoMatchMinScore != null && (p.autoMatchMinScore < 0.5 || p.autoMatchMinScore > 1)) return 'The auto-match score must be between 50 and 100.';
  if (p.suggestMinScore != null && (p.suggestMinScore < 0.3 || p.suggestMinScore > 1)) return 'The suggest score must be between 30 and 100.';
  return null;
}

/** camelCase patch → receipt_policies columns (undefined keys are left out). Pure. */
export function policyPatchToRow(p: Partial<ReceiptPolicy>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[keyof ReceiptPolicy, string]> = [
    ['receiptRequiredOverCents', 'receipt_required_over_cents'],
    ['memoRequired', 'memo_required'],
    ['memoRequiredOverCents', 'memo_required_over_cents'],
    ['graceDays', 'grace_days'],
    ['chaseWindowDays', 'chase_window_days'],
    ['reminderDays', 'reminder_days'],
    ['escalateTo', 'escalate_to'],
    ['bookkeeperMembershipId', 'bookkeeper_membership_id'],
    ['amountToleranceCents', 'amount_tolerance_cents'],
    ['tipToleranceBp', 'tip_tolerance_bp'],
    ['dateWindowDays', 'date_window_days'],
    ['autoMatchMinScore', 'auto_match_min_score'],
    ['suggestMinScore', 'suggest_min_score'],
    ['digestEnabled', 'digest_enabled'],
  ];
  for (const [k, col] of map) if (p[k] !== undefined) out[col] = p[k];
  return out;
}
