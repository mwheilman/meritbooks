/**
 * Vendor-compliance payment-hold enforcement (Session 22; requirement sets + bank-change
 * call-back, Wave 2A / migration 180 — FPB-vendor-compliance-chase §19).
 *
 * The hold is COMPUTED — there is no stored hold flag to drift:
 *   - when a requirement set governs the vendor (lib/vendor-compliance/requirements), the
 *     vendor is held when any rule the set imposes is missing / short / expired / not met
 *     / waiting for review and the set blocks payment (grace days honoured; a WARN-only set
 *     reports but never holds). At pay time the BILL's company picks the set;
 *   - otherwise (legacy) when any tracked compliance document is MISSING, EXPIRED, or
 *     VALID-but-past-its-expiration.
 * A vendor_payment_holds row is an OVERRIDE that lifts the compliance hold:
 *   ONE_TIME   one payment, then consumed
 *   TEMPORARY  until end_date
 *   PERMANENT  indefinitely
 * A PENDING bank-detail change (VN-10) blocks every payment and is NOT liftable by an
 * override — only a recorded call-back clears it.
 *
 * `enforcePaymentAllowed` is the gate called from the payment lifecycle. Every block /
 * grant / consume / release / auto-expiry / chase writes a vendor_compliance_events row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { assertOrgRefs, isMemberClient, isWriteScopeError, writerFor } from '@/lib/db/scoped-writer';
import { logVendorComplianceEvent, type VendorComplianceEventType } from './vendor-compliance-audit';
import { evaluateRequirements, holdReasons, summarise, type RequirementSet, type RuleResult } from '@/lib/vendor-compliance/requirements';
import { governingSet, isMissingRelation, loadProfiles, loadRequirementSets, loadVendorCompanies, loadVendorFacts } from '@/lib/vendor-compliance/store';
import { bankChangeBlock } from '@/lib/vendor-compliance/bank-change';

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
  issues: { docType: string; label: string; state: string; reason?: string }[];
  docs: ComplianceDoc[];
  activeOverride: OverrideRow | null;
  /** The gaps block payment (legacy: any issue; requirement set: block_payment and a blocking rule). */
  blocks: boolean;
  onHold: boolean; // blocks AND no active override
  /** The requirement set that governed this evaluation (null = legacy doc-row rules). */
  requirementSet: Pick<RequirementSet, 'id' | 'name' | 'blockPayment' | 'graceDays'> | null;
  rules: RuleResult[];
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
export function overrideActive(o: OverrideRow, now: Date): boolean {
  if (o.released_at) return false;
  if (o.hold_type === 'ONE_TIME') return !o.consumed_at; // valid until consumed
  if (o.hold_type === 'PERMANENT') return true;
  // TEMPORARY: within [start, end]
  if (o.start_date && new Date(o.start_date) > now) return false;
  if (o.end_date && new Date(o.end_date) < now) return false;
  return true;
}

/**
 * Thrown when compliance could not be evaluated for a reason OTHER than a confirmed
 * missing table. The pay gate treats it as a hold (fail closed).
 */
export class ComplianceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComplianceUnavailableError';
  }
}

/** Missing table (un-migrated DB) reads as empty; any other error fails closed. */
function rowsOrThrow<T>(res: { data: unknown; error: { code?: string; message: string } | null }, what: string): T[] {
  if (res.error) {
    if (isMissingRelation(res.error)) return [];
    throw new ComplianceUnavailableError(`Could not read ${what}: ${res.error.message}`);
  }
  return (res.data ?? []) as T[];
}

async function loadOverrides(db: DB, orgId: string, vendorId: string): Promise<OverrideRow[]> {
  const res = await db
    .from('vendor_payment_holds')
    .select('id, hold_type, reason, start_date, end_date, consumed_at, released_at, created_at')
    .eq('org_id', orgId)
    .eq('vendor_id', vendorId)
    .order('created_at', { ascending: false });
  return rowsOrThrow<OverrideRow>(res, 'payment-hold overrides');
}

/** The requirement-set evaluation for one vendor, or null when no set governs it (legacy rules apply). */
async function requirementEvaluation(
  db: DB,
  orgId: string,
  vendorId: string,
  locationId: string | null | undefined,
  now: Date,
): Promise<{ set: RequirementSet; rules: RuleResult[] } | null> {
  // loadRequirementSets already reads a missing table as "no sets" (legacy rules apply);
  // any other failure propagates so the pay gate fails closed.
  const sets: RequirementSet[] = await loadRequirementSets(db, orgId);
  if (sets.length === 0) return null;
  const today = now.toISOString().slice(0, 10);
  const [{ data: v }, profiles] = await Promise.all([
    db.schema('core').from('vendors').select('id, is_1099_eligible').eq('org_id', orgId).eq('id', vendorId).maybeSingle(),
    loadProfiles(db, orgId, [vendorId]),
  ]);
  const p = profiles.get(vendorId);
  const vc = {
    vendorType: p?.vendorType ?? null,
    workType: p?.workType ?? null,
    is1099Eligible: typeof (v as { is_1099_eligible?: unknown } | null)?.is_1099_eligible === 'boolean' ? ((v as { is_1099_eligible: boolean }).is_1099_eligible) : null,
  };
  let set: RequirementSet | null;
  if (locationId !== undefined) set = governingSet(sets, vc, { locationId });
  else set = governingSet(sets, vc, { companies: (await loadVendorCompanies(db, orgId, [vendorId])).get(vendorId) ?? [] });
  if (!set) return null;
  const { facts } = await loadVendorFacts(db, orgId, [vendorId], today);
  const f = facts.get(vendorId);
  if (!f) return null;
  return { set, rules: evaluateRequirements(set, f, today) };
}

/**
 * Evaluate a vendor's compliance + hold state. `locationId` = the company the payment is
 * for (its requirement set governs); omitted = the strictest merge across every company
 * that has billed the vendor.
 */
export async function evaluateVendorCompliance(
  db: DB,
  orgId: string,
  vendorId: string,
  opts: { locationId?: string | null; now?: Date } = {},
): Promise<VendorComplianceState> {
  const now = opts.now ?? new Date();
  const docRows = rowsOrThrow<Record<string, unknown>>(
    await db.from('vendor_compliance_docs').select('id, doc_type, status, expiration_date').eq('org_id', orgId).eq('vendor_id', vendorId),
    'vendor compliance documents',
  );

  const docs: ComplianceDoc[] = docRows.map((d: Record<string, unknown>) => ({
    id: d.id as string,
    doc_type: d.doc_type as string,
    status: d.status as string,
    expiration_date: (d.expiration_date as string) ?? null,
    state: classifyDoc(d.status as string, (d.expiration_date as string) ?? null, now),
  }));

  const overrides = await loadOverrides(db, orgId, vendorId);
  const activeOverride = overrides.find((o) => overrideActive(o, now)) ?? null;

  const req = await requirementEvaluation(db, orgId, vendorId, 'locationId' in opts ? opts.locationId ?? null : undefined, now);
  if (req) {
    const sum = summarise(req.set, req.rules);
    const issues = sum.blocking.map((r) => ({ docType: r.rule, label: r.label, state: r.outcome, reason: r.reason }));
    return {
      compliant: issues.length === 0,
      issues,
      docs,
      activeOverride,
      blocks: sum.holds,
      onHold: sum.holds && !activeOverride,
      requirementSet: { id: req.set.id, name: req.set.name, blockPayment: req.set.blockPayment, graceDays: req.set.graceDays },
      rules: req.rules,
    };
  }

  const issues = docs
    .filter((d) => d.state === 'missing' || d.state === 'expired')
    .map((d) => ({ docType: d.doc_type, label: DOC_LABEL[d.doc_type] ?? d.doc_type, state: d.state }));
  const compliant = issues.length === 0;
  return {
    compliant,
    issues,
    docs,
    activeOverride,
    blocks: !compliant,
    onHold: !compliant && !activeOverride,
    requirementSet: null,
    rules: [],
  };
}

function logEvent(
  db: DB,
  orgId: string,
  vendorId: string,
  eventType: VendorComplianceEventType,
  detail: string,
  extra: { billId?: string; overrideId?: string; docId?: string; actor?: string | null } = {},
): Promise<void> {
  // vendor_compliance_events is SELECT-only for members (migration 172): append-only audit
  // evidence, service-role insert after the caller's permission check, org pinned.
  return logVendorComplianceEvent(db, orgId, vendorId, eventType, detail, extra);
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
 * Fails CLOSED: any error while evaluating is a hold. The only tolerated error is a
 * CONFIRMED missing table (42P01 / PGRST205 — an un-migrated DB), which reads as "no rows".
 */
export async function enforcePaymentAllowed(
  db: DB,
  orgId: string,
  vendorId: string,
  billId: string,
  actor: string | null = null,
): Promise<void> {
  // VN-10 first: a pending (or rejected-but-still-on-file) bank change blocks EVERY payment
  // and no override lifts it — only a recorded call-back does.
  let bankBlock: string | null = null;
  try {
    bankBlock = await bankChangeBlock(db, orgId, vendorId);
  } catch (e) {
    console.warn('[vendor-compliance] bank-change check failed, refusing payment:', e);
    bankBlock = 'We could not confirm this vendor’s bank details are verified. Try again, or check Vendor compliance → Bank changes.';
  }
  if (bankBlock) {
    await logEvent(db, orgId, vendorId, 'PAYMENT_BLOCKED', `Payment blocked — ${bankBlock}`, { billId, actor });
    throw new ComplianceHoldError(bankBlock);
  }

  // The bill's company picks the requirement set.
  let state: VendorComplianceState;
  try {
    const { data: bill, error: billErr } = await db.from('bills').select('location_id').eq('org_id', orgId).eq('id', billId).maybeSingle();
    if (billErr) throw new ComplianceUnavailableError(`Could not read the bill: ${billErr.message}`);
    const locationId = ((bill as { location_id?: string | null } | null)?.location_id) ?? null;
    state = await evaluateVendorCompliance(db, orgId, vendorId, { locationId });
  } catch (e) {
    console.warn('[vendor-compliance] evaluation failed, refusing payment:', e);
    const msg = COMPLIANCE_UNAVAILABLE_MESSAGE;
    await logEvent(db, orgId, vendorId, 'PAYMENT_BLOCKED', `Payment blocked — ${msg}`, { billId, actor }).catch(() => undefined);
    throw new ComplianceHoldError(msg);
  }

  if (!state.blocks) return;

  if (state.activeOverride) {
    if (state.activeOverride.hold_type === 'ONE_TIME') {
      // vendor_payment_holds is SELECT-only for members (migration 171): the override was
      // read through the caller's client; consume it with the service role, org pinned.
      await writerFor(db)
        .from('vendor_payment_holds')
        .update({ consumed_at: new Date().toISOString(), consumed_bill_id: billId })
        .eq('id', state.activeOverride.id)
        .eq('org_id', orgId);
      await logEvent(db, orgId, vendorId, 'OVERRIDE_CONSUMED',
        `One-time override consumed for bill payment`, { billId, overrideId: state.activeOverride.id, actor });
    }
    return; // override lifts the hold
  }

  const reasons = state.requirementSet
    ? holdReasons(state.rules)
    : state.issues.map((i) => `${i.label} ${i.state}`).join(', ');
  await logEvent(db, orgId, vendorId, 'PAYMENT_BLOCKED',
    `Payment blocked — compliance issues: ${reasons}`, { billId, actor });
  throw new ComplianceHoldError(
    state.requirementSet
      ? `Vendor is on compliance hold under “${state.requirementSet.name}”: ${reasons}. Accept a document that meets the requirement or grant an override before paying.`
      : `Vendor is on compliance hold (${reasons}). Cure the documents or grant an override before paying.`,
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

  // vendor_payment_holds is SELECT-only for members (migration 171) — a member could
  // otherwise grant themselves an override and pay a non-compliant vendor. The route has
  // authorized the override; the vendor is pinned to the org; service-role write.
  try {
    if (isMemberClient(db)) {
      await assertOrgRefs(orgId, [{ schema: 'core', table: 'vendors', ids: [vendorId], label: 'vendor' }], { caller: db });
    }
  } catch (e) {
    if (isWriteScopeError(e)) return { success: false, error: e.message };
    throw e;
  }
  const { data, error } = await writerFor(db)
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

  // Read through the caller's client above; service-role write (migration 171), org pinned.
  const { error: upErr } = await writerFor(db)
    .from('vendor_payment_holds')
    .update({ released_at: new Date().toISOString(), released_by_user: actor, released_reason: reason })
    .eq('id', overrideId)
    .eq('org_id', orgId);
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
    // vendor_compliance_docs is SELECT-only for members (migration 172): the doc was read via
    // the caller's client above; service-role write, org pinned.
    await writerFor(db).from('vendor_compliance_docs').update({ status: 'EXPIRED', updated_at: now.toISOString() }).eq('id', d.id).eq('org_id', orgId);
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

    await writerFor(db).from('vendor_compliance_docs').update({
      last_chase_at: now.toISOString(),
      next_chase_at: next.toISOString(),
      chase_reminder_count: Number(d.chase_reminder_count ?? 0) + 1,
      updated_at: now.toISOString(),
    }).eq('id', d.id).eq('org_id', orgId);

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

export const COMPLIANCE_UNAVAILABLE_MESSAGE =
  'We could not confirm this vendor’s compliance status, so the payment is held. Try again, or check Vendor compliance.';

/**
 * READ-ONLY re-check of the pay gate for money already released (check print, ACH
 * origination, disbursement export). Same rules as enforcePaymentAllowed — a bank-change
 * block, then the compliance hold — but it never consumes an override and never logs.
 * A ONE_TIME override already consumed FOR THIS BILL still counts (it was spent releasing
 * this very payment). Fails CLOSED on any error except a confirmed missing table.
 * Returns a plain-English reason when the payment must not go out, else null.
 */
export async function paymentBlockReason(
  db: DB,
  orgId: string,
  vendorId: string,
  opts: { billId?: string | null; locationId?: string | null; now?: Date } = {},
): Promise<string | null> {
  try {
    const bank = await bankChangeBlock(db, orgId, vendorId);
    if (bank) return bank;
    const state = await evaluateVendorCompliance(db, orgId, vendorId, { locationId: opts.locationId ?? null, now: opts.now });
    if (!state.blocks || state.activeOverride) return null;
    if (opts.billId) {
      const spent = rowsOrThrow<{ id: string }>(
        await db.from('vendor_payment_holds').select('id').eq('org_id', orgId).eq('vendor_id', vendorId)
          .eq('hold_type', 'ONE_TIME').eq('consumed_bill_id', opts.billId).is('released_at', null).limit(1),
        'payment-hold overrides',
      );
      if (spent.length > 0) return null;
    }
    const reasons = state.requirementSet ? holdReasons(state.rules) : state.issues.map((i) => `${i.label} ${i.state}`).join(', ');
    return state.requirementSet
      ? `Vendor went on compliance hold under “${state.requirementSet.name}” after this payment was released: ${reasons}.`
      : `Vendor went on compliance hold after this payment was released (${reasons}).`;
  } catch (e) {
    console.warn('[vendor-compliance] payment re-check failed, holding:', e);
    return COMPLIANCE_UNAVAILABLE_MESSAGE;
  }
}

/**
 * paymentBlockReason for a batch: one entry per DISTINCT (vendor, bill, company) key.
 * Returns key → reason for the blocked ones only. Key = `${vendorId}|${billId ?? ''}`.
 */
export async function paymentBlockReasons(
  db: DB,
  orgId: string,
  items: ReadonlyArray<{ vendorId: string | null; billId?: string | null; locationId?: string | null }>,
  now: Date = new Date(),
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const it of items) {
    if (!it.vendorId) continue;
    const key = paymentBlockKey(it.vendorId, it.billId);
    if (seen.has(key)) continue;
    seen.add(key);
    const reason = await paymentBlockReason(db, orgId, it.vendorId, { billId: it.billId ?? null, locationId: it.locationId ?? null, now });
    if (reason) out.set(key, reason);
  }
  return out;
}

export function paymentBlockKey(vendorId: string, billId?: string | null): string {
  return `${vendorId}|${billId ?? ''}`;
}
