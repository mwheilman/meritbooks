/**
 * Vendor-compliance payment-hold enforcement (Session 22).
 *
 * A vendor is on payment hold when any tracked compliance document is MISSING,
 * EXPIRED, or VALID-but-past-its-expiration. The hold is COMPUTED from document
 * state — there is no stored hold flag to drift. A vendor_payment_holds row is an
 * OVERRIDE that lifts the hold:
 *   ONE_TIME   one payment, then consumed
 *   TEMPORARY  until end_date
 *   PERMANENT  indefinitely
 *
 * `enforcePaymentAllowed` is the gate called from the payment lifecycle: it
 * blocks a non-compliant vendor's payment unless an active override applies
 * (consuming a ONE_TIME override). Every block / grant / consume / release /
 * auto-expiry / chase writes a vendor_compliance_events audit row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;

export const DOC_LABEL: Record<string, string> = {
  W9: 'W-9',
  GL_COI: 'General Liability COI',
  WC_COI: "Workers' Comp COI",
  WC_EXEMPTION: "Workers' Comp Exemption",
};

export type OverrideType = 'ONE_TIME' | 'TEMPORARY' | 'PERMANENT';

export interface ComplianceDoc {
  id: string;
  doc_type: string;
  status: string; // MISSING | PENDING | VALID | EXPIRED
  expiration_date: string | null;
  state: 'valid' | 'expiring' | 'expired' | 'missing' | 'pending';
}

export interface OverrideRow {
  id: string;
  hold_type: OverrideType;
  reason: string;
  start_date: string | null;
  end_date: string | null;
  consumed_at: string | null;
  released_at: string | null;
  created_at: string;
}

export interface VendorComplianceState {
  compliant: boolean;
  issues: { docType: string; label: string; state: string }[];
  docs: ComplianceDoc[];
  activeOverride: OverrideRow | null;
  onHold: boolean; // not compliant AND no active override
}

const EXPIRING_SOON_DAYS = 60;

function classifyDoc(status: string, expiration: string | null, now: Date): ComplianceDoc['state'] {
  if (status === 'MISSING') return 'missing';
  if (status === 'PENDING') return 'pending';
  if (status === 'EXPIRED') return 'expired';
  // VALID
  if (expiration) {
    const exp = new Date(expiration);
    if (exp < now) return 'expired';
    const soon = new Date(now);
    soon.setDate(soon.getDate() + EXPIRING_SOON_DAYS);
    if (exp <= soon) return 'expiring';
  }
  return 'valid';
}

/** Is an override row currently in force (lifts the hold) as of `now`? */
function overrideActive(o: OverrideRow, now: Date): boolean {
  if (o.released_at) return false;
  if (o.hold_type === 'ONE_TIME') return !o.consumed_at; // valid until consumed
  if (o.hold_type === 'PERMANENT') return true;
  // TEMPORARY: within [start, end]
  if (o.start_date && new Date(o.start_date) > now) return false;
  if (o.end_date && new Date(o.end_date) < now) return false;
  return true;
}

async function loadOverrides(db: DB, orgId: string, vendorId: string): Promise<OverrideRow[]> {
  const { data } = await db
    .from('vendor_payment_holds')
    .select('id, hold_type, reason, start_date, end_date, consumed_at, released_at, created_at')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false });
  return (data ?? []) as OverrideRow[];
}

/** Evaluate a vendor's compliance + hold state. */
export async function evaluateVendorCompliance(db: DB, orgId: string, vendorId: string): Promise<VendorComplianceState> {
  const now = new Date();
  const { data: docRows } = await db
    .from('vendor_compliance_docs')
    .select('id, doc_type, status, expiration_date')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId);

  const docs: ComplianceDoc[] = (docRows ?? []).map((d: Record<string, unknown>) => ({
    id: d.id as string,
    doc_type: d.doc_type as string,
    status: d.status as string,
    expiration_date: (d.expiration_date as string) ?? null,
    state: classifyDoc(d.status as string, (d.expiration_date as string) ?? null, now),
  }));

  const issues = docs
    .filter((d) => d.state === 'missing' || d.state === 'expired')
    .map((d) => ({ docType: d.doc_type, label: DOC_LABEL[d.doc_type] ?? d.doc_type, state: d.state }));

  const compliant = issues.length === 0;

  const overrides = await loadOverrides(db, orgId, vendorId);
  const activeOverride = overrides.find((o) => overrideActive(o, now)) ?? null;

  return {
    compliant,
    issues,
    docs,
    activeOverride,
    onHold: !compliant && !activeOverride,
  };
}

async function logEvent(
  db: DB,
  orgId: string,
  vendorId: string,
  eventType: string,
  detail: string,
  extra: { billId?: string; overrideId?: string; docId?: string; actor?: string | null } = {},
): Promise<void> {
  // Audit logging must never break the financial transaction it accompanies.
  try {
    await db.from('vendor_compliance_events').insert({
      org_id: orgId,
      vendor_id: vendorId,
      event_type: eventType,
      detail,
      bill_id: extra.billId ?? null,
      override_id: extra.overrideId ?? null,
      doc_id: extra.docId ?? null,
      created_by_user: extra.actor ?? null,
    });
  } catch (e) {
    console.warn('[vendor-compliance] audit log failed:', e);
  }
}

export class ComplianceHoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceHoldError';
  }
}

/**
 * Gate a payment on vendor compliance. Throws ComplianceHoldError if the vendor
 * is on hold with no active override. Consumes a ONE_TIME override when used.
 * Safe to call even if the enforcement tables aren't present yet (degrades open
 * with a console warning) so an un-migrated deploy never hard-breaks payments.
 */
export async function enforcePaymentAllowed(
  db: DB,
  orgId: string,
  vendorId: string,
  billId: string,
  actor: string | null = null,
): Promise<void> {
  let state: VendorComplianceState;
  try {
    state = await evaluateVendorCompliance(db, orgId, vendorId);
  } catch (e) {
    console.warn('[vendor-compliance] evaluation skipped (tables not ready?):', e);
    return; // fail open rather than block all payments on an un-migrated DB
  }

  if (state.compliant) return;

  if (state.activeOverride) {
    if (state.activeOverride.hold_type === 'ONE_TIME') {
      await db
        .from('vendor_payment_holds')
        .update({ consumed_at: new Date().toISOString(), consumed_bill_id: billId })
        .eq('id', state.activeOverride.id);
      await logEvent(db, orgId, vendorId, 'OVERRIDE_CONSUMED',
        `One-time override consumed for bill payment`, { billId, overrideId: state.activeOverride.id, actor });
    }
    return; // override lifts the hold
  }

  const reasons = state.issues.map((i) => `${i.label} ${i.state}`).join(', ');
  await logEvent(db, orgId, vendorId, 'PAYMENT_BLOCKED',
    `Payment blocked — compliance issues: ${reasons}`, { billId, actor });
  throw new ComplianceHoldError(
    `Vendor is on compliance hold (${reasons}). Cure the documents or grant an override before paying.`,
  );
}

/** Grant an override that lifts the hold. */
export async function grantOverride(
  db: DB,
  orgId: string,
  input: { vendorId: string; holdType: OverrideType; reason: string; endDate?: string | null; actor?: string | null },
): Promise<{ success: boolean; overrideId?: string; error?: string }> {
  const { vendorId, holdType, reason, endDate, actor } = input;
  if (!reason || reason.trim().length < 3) return { success: false, error: 'A reason is required for an override.' };
  if (holdType === 'TEMPORARY' && !endDate) return { success: false, error: 'A temporary override needs an end date.' };

  const { data, error } = await db
    .from('vendor_payment_holds')
    .insert({
      org_id: orgId,
      vendor_id: vendorId,
      hold_type: holdType,
      reason: reason.trim(),
      start_date: new Date().toISOString().slice(0, 10),
      end_date: holdType === 'TEMPORARY' ? endDate : null,
      created_by: null,
      created_by_user: actor ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return { success: false, error: error?.message ?? 'Failed to grant override.' };

  await logEvent(db, orgId, vendorId, 'OVERRIDE_GRANTED',
    `${holdType} override granted: ${reason.trim()}`, { overrideId: data.id, actor });
  return { success: true, overrideId: data.id };
}

/** Manually end an override before it would otherwise expire. */
export async function releaseOverride(
  db: DB,
  orgId: string,
  overrideId: string,
  reason: string,
  actor: string | null = null,
): Promise<{ success: boolean; error?: string }> {
  const { data: ov, error } = await db
    .from('vendor_payment_holds')
    .select('id, vendor_id, released_at')
    .eq('org_id', orgId)
    .eq('id', overrideId)
    .single();
  if (error || !ov) return { success: false, error: 'Override not found.' };
  if (ov.released_at) return { success: false, error: 'Already released.' };

  const { error: upErr } = await db
    .from('vendor_payment_holds')
    .update({ released_at: new Date().toISOString(), released_by_user: actor, released_reason: reason })
    .eq('id', overrideId);
  if (upErr) return { success: false, error: upErr.message };

  await logEvent(db, orgId, ov.vendor_id as string, 'OVERRIDE_RELEASED',
    `Override released: ${reason}`, { overrideId, actor });
  return { success: true };
}

/**
 * Maintenance pass (run on a schedule or on demand):
 *   - auto-expire VALID docs whose expiration_date has passed (-> EXPIRED)
 *   - advance the chase cadence for docs expired or expiring within 60 days:
 *       expired or <=14 days out -> chase weekly; otherwise -> chase biweekly.
 * No email is sent here (that rides the GATE 4 ingestion/notification layer);
 * this maintains the schedule + audit so a notifier can pick it up.
 */
export async function runComplianceMaintenance(db: DB, orgId: string): Promise<{ expired: number; chased: number }> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // 1. Auto-expire
  const { data: toExpire } = await db
    .from('vendor_compliance_docs')
    .select('id, vendor_id, doc_type, expiration_date')
    .eq('org_id', orgId)
    .eq('status', 'VALID')
    .not('expiration_date', 'is', null)
    .lt('expiration_date', today);
  let expired = 0;
  for (const d of toExpire ?? []) {
    await db.from('vendor_compliance_docs').update({ status: 'EXPIRED', updated_at: now.toISOString() }).eq('id', d.id);
    await logEvent(db, orgId, d.vendor_id as string, 'DOC_EXPIRED',
      `${DOC_LABEL[d.doc_type as string] ?? d.doc_type} expired ${d.expiration_date}`, { docId: d.id as string });
    expired++;
  }

  // 2. Advance chase cadence for at-risk docs.
  const soon = new Date(now);
  soon.setDate(soon.getDate() + EXPIRING_SOON_DAYS);
  const { data: atRisk } = await db
    .from('vendor_compliance_docs')
    .select('id, vendor_id, doc_type, status, expiration_date, next_chase_at, chase_reminder_count')
    .eq('org_id', orgId)
    .in('status', ['MISSING', 'EXPIRED', 'VALID']);

  let chased = 0;
  for (const d of atRisk ?? []) {
    const status = d.status as string;
    const exp = d.expiration_date ? new Date(d.expiration_date as string) : null;
    const isExpired = status === 'EXPIRED' || (exp != null && exp < now);
    const isMissing = status === 'MISSING';
    const isExpiringSoon = status === 'VALID' && exp != null && exp <= soon && exp >= now;
    if (!isExpired && !isMissing && !isExpiringSoon) continue;

    const nextChase = d.next_chase_at ? new Date(d.next_chase_at as string) : null;
    if (nextChase && nextChase > now) continue; // not due yet

    // Weekly once expired/missing or within 14 days; biweekly otherwise.
    const within14 = exp != null && (exp.getTime() - now.getTime()) / 86400000 <= 14;
    const intervalDays = isExpired || isMissing || within14 ? 7 : 14;
    const next = new Date(now);
    next.setDate(next.getDate() + intervalDays);

    await db.from('vendor_compliance_docs').update({
      last_chase_at: now.toISOString(),
      next_chase_at: next.toISOString(),
      chase_reminder_count: Number(d.chase_reminder_count ?? 0) + 1,
      updated_at: now.toISOString(),
    }).eq('id', d.id);

    await logEvent(db, orgId, d.vendor_id as string, 'CHASE_SCHEDULED',
      `${DOC_LABEL[d.doc_type as string] ?? d.doc_type} chase #${Number(d.chase_reminder_count ?? 0) + 1} (every ${intervalDays} days)`,
      { docId: d.id as string });
    chased++;
  }

  return { expired, chased };
}

// ---- Overview ---------------------------------------------------------------

export interface VendorComplianceRow {
  vendorId: string;
  vendorName: string;
  compliant: boolean;
  onHold: boolean;
  issues: { docType: string; label: string; state: string }[];
  docs: ComplianceDoc[];
  activeOverride: { id: string; type: OverrideType; reason: string; endDate: string | null } | null;
  openBillsCents: number; // approved/unpaid balance exposed to the hold
}

export interface VendorComplianceOverview {
  rows: VendorComplianceRow[];
  summary: { total: number; onHold: number; withOverride: number; compliant: number; blockedBalanceCents: number };
}

export async function getVendorComplianceOverview(db: DB, orgId: string): Promise<VendorComplianceOverview> {
  const now = new Date();

  // Only vendors that actually track at least one compliance doc are in scope.
  const { data: docRows } = await db
    .from('vendor_compliance_docs')
    .select('vendor_id, id, doc_type, status, expiration_date')
    .eq('org_id', orgId);
  const docsByVendor = new Map<string, Record<string, unknown>[]>();
  for (const d of docRows ?? []) {
    const arr = docsByVendor.get(d.vendor_id as string) ?? [];
    arr.push(d);
    docsByVendor.set(d.vendor_id as string, arr);
  }
  const vendorIds = [...docsByVendor.keys()];
  if (vendorIds.length === 0) {
    return { rows: [], summary: { total: 0, onHold: 0, withOverride: 0, compliant: 0, blockedBalanceCents: 0 } };
  }

  // Names
  const { data: vendorRows } = await db
    .schema('core').from('vendors')
    .select('id, name, display_name')
    .in('id', vendorIds);
  const vendorName = new Map((vendorRows ?? []).map((v: Record<string, unknown>) => [v.id as string, (v.display_name as string) || (v.name as string)]));

  // Overrides
  const { data: overrideRows } = await db
    .from('vendor_payment_holds')
    .select('id, vendor_id, hold_type, reason, start_date, end_date, consumed_at, released_at, created_at')
    .eq('org_id', orgId)
    .in('vendor_id', vendorIds);
  const overridesByVendor = new Map<string, OverrideRow[]>();
  for (const o of overrideRows ?? []) {
    const arr = overridesByVendor.get(o.vendor_id as string) ?? [];
    arr.push(o as OverrideRow);
    overridesByVendor.set(o.vendor_id as string, arr);
  }

  // Open (approved/unpaid) bill balances per vendor — the exposure behind a hold.
  const { data: openBills } = await db
    .from('bills')
    .select('vendor_id, total_cents, amount_paid_cents, status')
    .eq('org_id', orgId)
    .in('vendor_id', vendorIds)
    .in('status', ['APPROVED', 'SCHEDULED', 'PARTIALLY_PAID']);
  const openBalByVendor = new Map<string, number>();
  for (const b of openBills ?? []) {
    const bal = Number(b.total_cents ?? 0) - Number(b.amount_paid_cents ?? 0);
    openBalByVendor.set(b.vendor_id as string, (openBalByVendor.get(b.vendor_id as string) ?? 0) + Math.max(0, bal));
  }

  const rows: VendorComplianceRow[] = vendorIds.map((vid) => {
    const docs: ComplianceDoc[] = (docsByVendor.get(vid) ?? []).map((d) => ({
      id: d.id as string,
      doc_type: d.doc_type as string,
      status: d.status as string,
      expiration_date: (d.expiration_date as string) ?? null,
      state: classifyDoc(d.status as string, (d.expiration_date as string) ?? null, now),
    }));
    const issues = docs
      .filter((d) => d.state === 'missing' || d.state === 'expired')
      .map((d) => ({ docType: d.doc_type, label: DOC_LABEL[d.doc_type] ?? d.doc_type, state: d.state }));
    const compliant = issues.length === 0;
    const active = (overridesByVendor.get(vid) ?? []).find((o) => overrideActive(o, now)) ?? null;
    const onHold = !compliant && !active;
    return {
      vendorId: vid,
      vendorName: vendorName.get(vid) ?? 'Unknown vendor',
      compliant,
      onHold,
      issues,
      docs,
      activeOverride: active ? { id: active.id, type: active.hold_type, reason: active.reason, endDate: active.end_date } : null,
      openBillsCents: openBalByVendor.get(vid) ?? 0,
    };
  });

  // On-hold and at-risk first.
  rows.sort((a, b) => Number(b.onHold) - Number(a.onHold) || b.openBillsCents - a.openBillsCents);

  const summary = rows.reduce(
    (acc, r) => ({
      total: acc.total + 1,
      onHold: acc.onHold + (r.onHold ? 1 : 0),
      withOverride: acc.withOverride + (r.activeOverride ? 1 : 0),
      compliant: acc.compliant + (r.compliant ? 1 : 0),
      blockedBalanceCents: acc.blockedBalanceCents + (r.onHold ? r.openBillsCents : 0),
    }),
    { total: 0, onHold: 0, withOverride: 0, compliant: 0, blockedBalanceCents: 0 },
  );

  return { rows, summary };
}
