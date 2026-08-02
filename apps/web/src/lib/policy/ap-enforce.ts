/**
 * AP-POLICY ENFORCEMENT BRIDGE — the thin, RLS-scoped layer between the pure engine
 * (`ap-engine.ts`) and Postgres. It loads the ACTIVE compiled ruleset (via the shared
 * store in `core.ts`), assembles an `ApBillSubject` from the live bill / lines /
 * PO-link / duplicate signal, and runs the deterministic evaluator.
 *
 * DEGRADE-SAFE (canon): with no active policy (or any read error) this returns a
 * null-policy result with zero violations and `blocked: false`, so the bill flow never
 * breaks and nothing is blocked absent an explicit, human-activated policy.
 *
 * The engine stays pure; ALL I/O is here. Callers are the gated bill create/approve
 * routes (no fork of the AP lifecycle).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { loadActivePolicy, type PolicyDomainConfig, type ActivePolicy } from './core';
import { apPolicyRulesetSchema, DEFAULT_AP_RULESET, type ApPolicyRuleset } from './ap-schema';
import {
  evaluateBill,
  type ApBillSubject,
  type ApBillLine,
  type ApBillEvaluation,
  type ThreeWayMatchStatus,
} from './ap-engine';

/** The AP policy domain — the single config object the shared lifecycle keys on. */
export const AP_POLICY_DOMAIN: PolicyDomainConfig<ApPolicyRuleset> = {
  domain: 'AP',
  table: 'ap_approval_policies',
  schema: apPolicyRulesetSchema,
  defaultRuleset: DEFAULT_AP_RULESET,
  extractFeature: 'AP_POLICY_EXTRACT',
  extractModel: 'claude-sonnet-4-20250514',
};

export async function loadActiveApPolicy(
  db: SupabaseClient,
  orgId: string
): Promise<ActivePolicy<ApPolicyRuleset> | null> {
  return loadActivePolicy(db, AP_POLICY_DOMAIN, orgId);
}

export interface ApPolicyResult {
  /** The active policy identity, or null when none is active (non-blocking). */
  active: { name: string; version: number } | null;
  evaluation: ApBillEvaluation;
}

const EMPTY_RESULT: ApPolicyResult = {
  active: null,
  evaluation: { violations: [], requiredApprovalTier: null, blocked: false },
};

/**
 * A proposed (not-yet-persisted) bill, as the create route knows it. `hasPurchaseOrder`
 * and `threeWayMatchStatus` default to "no PO / no match" at creation; the approve path
 * refreshes them from the persisted PO link.
 */
export interface ProposedBill {
  vendorId: string | null;
  vendorName: string | null;
  billNumber: string | null;
  totalCents: number;
  lines: ApBillLine[];
  hasPurchaseOrder?: boolean;
  threeWayMatchStatus?: ThreeWayMatchStatus;
  /** Exclude this bill id from the duplicate probe (used on the approve path). */
  excludeBillId?: string | null;
}

/**
 * Detect a suspected duplicate: another non-voided bill for the same vendor with the
 * same bill number and the same total. RLS-scoped. Degrades to `false` on error.
 */
export async function detectDuplicateBill(
  db: SupabaseClient,
  orgId: string,
  args: { vendorId: string | null; billNumber: string | null; totalCents: number; excludeBillId?: string | null }
): Promise<boolean> {
  if (!args.vendorId || !args.billNumber) return false;
  try {
    let q = db
      .from('bills')
      .select('id')
      .eq('org_id', orgId)
      .eq('vendor_id', args.vendorId)
      .eq('bill_number', args.billNumber)
      .eq('total_cents', args.totalCents)
      .neq('status', 'VOIDED')
      .limit(1);
    if (args.excludeBillId) q = q.neq('id', args.excludeBillId);
    const { data } = await q;
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/**
 * Evaluate a PROPOSED bill (create path) against the org's ACTIVE AP policy.
 * Degrade-safe: returns the empty, non-blocking result when no policy is active.
 */
export async function evaluateProposedBill(
  db: SupabaseClient,
  orgId: string,
  proposed: ProposedBill
): Promise<ApPolicyResult> {
  const active = await loadActiveApPolicy(db, orgId);
  if (!active) return EMPTY_RESULT;

  const isSuspectedDuplicate = await detectDuplicateBill(db, orgId, {
    vendorId: proposed.vendorId,
    billNumber: proposed.billNumber,
    totalCents: proposed.totalCents,
    excludeBillId: proposed.excludeBillId ?? null,
  });

  const subject: ApBillSubject = {
    billId: proposed.excludeBillId ?? 'proposed',
    vendorId: proposed.vendorId,
    vendorName: proposed.vendorName,
    totalCents: proposed.totalCents,
    lines: proposed.lines,
    hasPurchaseOrder: proposed.hasPurchaseOrder ?? false,
    threeWayMatchStatus: proposed.threeWayMatchStatus ?? 'NONE',
    isSuspectedDuplicate,
  };

  return { active: { name: active.name, version: active.version }, evaluation: evaluateBill(subject, active.ruleset) };
}

/**
 * Evaluate a PERSISTED bill (approve / review path) against the ACTIVE AP policy. Loads
 * the bill, its lines (with GL account numbers), its PO-link match status, and the
 * duplicate signal, then runs the engine. Degrade-safe.
 */
export async function evaluateBillById(
  db: SupabaseClient,
  orgId: string,
  billId: string
): Promise<ApPolicyResult> {
  const active = await loadActiveApPolicy(db, orgId);
  if (!active) return EMPTY_RESULT;

  const { data: bill } = await db
    .from('bills')
    .select('id, vendor_id, bill_number, total_cents')
    .eq('org_id', orgId)
    .eq('id', billId)
    .maybeSingle();
  if (!bill) return { active: { name: active.name, version: active.version }, evaluation: { violations: [], requiredApprovalTier: null, blocked: false } };
  const b = bill as { id: string; vendor_id: string | null; bill_number: string | null; total_cents: number };

  // Vendor name (core schema) — stitched, since PostgREST can't embed core from public.
  let vendorName: string | null = null;
  if (b.vendor_id) {
    const { data: v } = await db.schema('core').from('vendors').select('name, display_name').eq('id', b.vendor_id).maybeSingle();
    if (v) vendorName = (v as { display_name: string | null; name: string }).display_name ?? (v as { name: string }).name;
  }

  // Lines + GL account numbers for category matching.
  const { data: rawLines } = await db
    .from('bill_lines')
    .select('description, amount_cents, account:accounts!bill_lines_account_id_fkey(id, account_number, name)')
    .eq('bill_id', billId);
  const lines: ApBillLine[] = (rawLines ?? []).map((l) => {
    const row = l as { description: string | null; amount_cents: number; account: { id: string; account_number: string; name: string } | { id: string; account_number: string; name: string }[] | null };
    const acct = Array.isArray(row.account) ? row.account[0] ?? null : row.account;
    return {
      accountId: acct?.id ?? null,
      accountNumber: acct?.account_number ?? null,
      categoryLabel: row.description ?? acct?.name ?? null,
      amountCents: row.amount_cents,
    };
  });

  // PO link + 3-way match verdict.
  const { data: link } = await db
    .from('bill_po_links')
    .select('match_status')
    .eq('org_id', orgId)
    .eq('bill_id', billId)
    .order('matched_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const hasPurchaseOrder = !!link;
  const matchStatus = (link as { match_status: string } | null)?.match_status;
  const threeWayMatchStatus: ThreeWayMatchStatus =
    matchStatus === 'MATCHED' || matchStatus === 'EXCEPTION' || matchStatus === 'OVERRIDDEN' || matchStatus === 'PENDING'
      ? (matchStatus as ThreeWayMatchStatus)
      : 'NONE';

  const isSuspectedDuplicate = await detectDuplicateBill(db, orgId, {
    vendorId: b.vendor_id,
    billNumber: b.bill_number,
    totalCents: b.total_cents,
    excludeBillId: billId,
  });

  const subject: ApBillSubject = {
    billId,
    vendorId: b.vendor_id,
    vendorName,
    totalCents: b.total_cents,
    lines,
    hasPurchaseOrder,
    threeWayMatchStatus,
    isSuspectedDuplicate,
  };

  return { active: { name: active.name, version: active.version }, evaluation: evaluateBill(subject, active.ruleset) };
}
