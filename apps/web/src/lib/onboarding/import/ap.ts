/**
 * Vendors & Open A/P onboarding — PURE normalizers, dedupe, and subledger math.
 *
 * The mirror of lib/onboarding/import/ar.ts for the payables side: pull a vendor
 * master + open vendor bills from an ERP connector (fetchVendors + fetchOpenAP) OR a
 * CSV OR manual entry, normalize to a reviewable proposal, and — on commit — write
 * masters into `core.vendors` and open items as APPROVED bills that age in
 * `v_ap_aging`.
 *
 * Opening bills are SUBLEDGER DETAIL (spec §4): the A/P control (2000) balance is
 * carried by the opening trial-balance journal entry, so these bills post NO GL entry
 * (no gl_entry_id) and are created APPROVED — they age in v_ap_aging and their Σ
 * balance must FOOT to the 2000 control (extended tie-out gate). This mirrors the
 * existing /api/import "open_ap → bills" path and never double-counts the control.
 *
 * Money is integer CENTS throughout. PURE module — no Supabase / React / I/O.
 */

import { scoreVendorDuplicates, type VendorDupInput } from '@/lib/vendors/dedupe';
import { normalizeText } from '@/lib/services/reconciliation-match';
import type { ProviderParty, ProviderOpenItem } from '@/lib/integrations/erp/providers/types';

// ─────────────────────────────────────────────────────────────────────────────
// Source-agnostic raw inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface RawApParty {
  name: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  paymentTermsDays?: number | null;
  is1099Eligible?: boolean | null;
}

export interface RawApOpenItem {
  partyName: string;
  /** Bill / reference number (nullable in the schema; may be blank). */
  docNumber: string;
  date: string;
  dueDate: string;
  totalCents: number;
  amountPaidCents?: number | null;
}

export type ApImportSourceKind = 'erp' | 'csv' | 'manual';

// ─────────────────────────────────────────────────────────────────────────────
// Normalized drafts
// ─────────────────────────────────────────────────────────────────────────────

export interface ApVendorDraft {
  name: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  paymentTermsDays: number;
  is1099Eligible: boolean;
  existing: boolean;
  fromBill: boolean;
}

export interface ApOpenBillDraft {
  vendorName: string;
  /** May be empty — bills.bill_number is nullable. */
  billNumber: string;
  billDate: string;
  dueDate: string;
  totalCents: number;
  amountPaidCents: number;
  /** total − paid; what ages on v_ap_aging and foots to the 2000 control. */
  balanceCents: number;
  /** True when a bill with the same (vendor, number) is already present (skipped). */
  duplicate: boolean;
}

export interface ApDedupeWarning {
  aName: string;
  bName: string;
  confidence: number;
  reason: string;
}

export interface ApImportProposal {
  source: ApImportSourceKind;
  vendors: ApVendorDraft[];
  bills: ApOpenBillDraft[];
  /** Σ open balances across the bills that WILL be committed (cents). */
  openApCents: number;
  dedupeWarnings: ApDedupeWarning[];
  newVendors: number;
  matchedVendors: number;
  openBillCount: number;
  duplicateBills: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function vendorNameKey(name: string): string {
  return normalizeText(name);
}

function trimOrNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s.length > 0 ? s : null;
}

function toInt(v: number | null | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

/** Stable dedupe key for a bill within a vendor (number when present, else amount+date). */
export function billKey(vendorKey: string, billNumber: string, totalCents: number, billDate: string): string {
  const num = billNumber.trim().toLowerCase();
  return num ? `${vendorKey}|#${num}` : `${vendorKey}|~${totalCents}@${billDate}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ERP-provider adapters
// ─────────────────────────────────────────────────────────────────────────────

export function apPartyFromProvider(p: ProviderParty): RawApParty {
  return { name: p.name, email: p.email, phone: p.phone };
}

export function apOpenItemFromProvider(o: ProviderOpenItem): RawApOpenItem {
  const total = Math.round(o.totalCents || 0);
  const balance = Math.round(o.balanceCents || 0);
  const paid = Math.max(0, total - balance);
  return {
    partyName: o.partyName,
    docNumber: o.docNumber,
    date: o.date,
    dueDate: o.dueDate,
    totalCents: total,
    amountPaidCents: paid,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalizers
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeApParty(raw: RawApParty, existing: boolean, fromBill = false): ApVendorDraft {
  return {
    name: raw.name.trim(),
    email: trimOrNull(raw.email),
    phone: trimOrNull(raw.phone),
    addressLine1: trimOrNull(raw.addressLine1),
    addressLine2: trimOrNull(raw.addressLine2),
    city: trimOrNull(raw.city),
    state: trimOrNull(raw.state),
    zip: trimOrNull(raw.zip),
    paymentTermsDays: toInt(raw.paymentTermsDays, 30),
    is1099Eligible: raw.is1099Eligible === true,
    existing,
    fromBill,
  };
}

export function normalizeApOpenItem(raw: RawApOpenItem, duplicate: boolean): ApOpenBillDraft {
  const total = Math.round(raw.totalCents || 0);
  const paid = Math.max(0, Math.round(raw.amountPaidCents || 0));
  const balance = total - paid;
  return {
    vendorName: raw.partyName.trim(),
    billNumber: (raw.docNumber ?? '').trim(),
    billDate: raw.date,
    dueDate: raw.dueDate,
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: balance,
    duplicate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe — reuse the platform vendor-dedupe scorer.
// ─────────────────────────────────────────────────────────────────────────────

export function apDedupeWarnings(vendors: ApVendorDraft[]): ApDedupeWarning[] {
  const inputs: VendorDupInput[] = vendors.map((v, i) => ({
    id: `draft-${i}`,
    name: v.name,
    displayName: null,
    email: v.email,
    phone: v.phone,
    addressLine1: v.addressLine1,
    zip: v.zip,
    openApCents: 0,
  }));
  const out: ApDedupeWarning[] = [];
  const seen = new Set<string>();
  const N = Math.min(inputs.length, 400);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const signal = scoreVendorDuplicates(inputs[i], inputs[j]);
      if (!signal || signal.confidence < 0.82) continue;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ aName: inputs[i].name, bName: inputs[j].name, confidence: signal.confidence, reason: signal.reason });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence);
}

// ─────────────────────────────────────────────────────────────────────────────
// Proposal assembly
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildApProposalArgs {
  source: ApImportSourceKind;
  parties: RawApParty[];
  openItems: RawApOpenItem[];
  /** Normalized-name keys of vendors that already exist in core.vendors. */
  existingVendorKeys: Set<string>;
  /** Bill keys (vendorKey|#num or vendorKey|~amt@date) already present for the org. */
  existingBillKeys: Set<string>;
}

export function buildApProposal(args: BuildApProposalArgs): ApImportProposal {
  const { source, parties, openItems, existingVendorKeys, existingBillKeys } = args;

  const byKey = new Map<string, ApVendorDraft>();
  for (const raw of parties) {
    const name = (raw.name ?? '').trim();
    if (!name) continue;
    const key = vendorNameKey(name);
    if (byKey.has(key)) continue;
    byKey.set(key, normalizeApParty(raw, existingVendorKeys.has(key), false));
  }

  for (const item of openItems) {
    const name = (item.partyName ?? '').trim();
    if (!name) continue;
    const key = vendorNameKey(name);
    if (byKey.has(key) || existingVendorKeys.has(key)) continue;
    byKey.set(key, normalizeApParty({ name }, false, true));
  }

  const vendors = [...byKey.values()];

  const bills: ApOpenBillDraft[] = [];
  const batchKeys = new Set<string>();
  let openApCents = 0;
  for (const item of openItems) {
    const total = Math.round(item.totalCents || 0);
    const vKey = vendorNameKey((item.partyName ?? '').trim());
    const k = billKey(vKey, item.docNumber ?? '', total, item.date);
    // A bill is a duplicate if already present in the ledger OR repeated in this batch.
    const duplicate = existingBillKeys.has(k) || batchKeys.has(k);
    batchKeys.add(k);
    const draft = normalizeApOpenItem(item, duplicate);
    bills.push(draft);
    if (!duplicate && draft.balanceCents > 0) openApCents += draft.balanceCents;
  }

  return {
    source,
    vendors,
    bills,
    openApCents,
    dedupeWarnings: apDedupeWarnings(vendors),
    newVendors: vendors.filter((v) => !v.existing).length,
    matchedVendors: vendors.filter((v) => v.existing).length,
    openBillCount: bills.filter((b) => !b.duplicate).length,
    duplicateBills: bills.filter((b) => b.duplicate).length,
  };
}

export function sumOpenApCents(bills: ApOpenBillDraft[]): number {
  return bills.reduce((s, b) => (!b.duplicate && b.balanceCents > 0 ? s + b.balanceCents : s), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic gate
// ─────────────────────────────────────────────────────────────────────────────

export function validateApProposal(proposal: ApImportProposal): string[] {
  const blockers: string[] = [];
  for (const b of proposal.bills) {
    if (!Number.isFinite(b.totalCents) || !Number.isFinite(b.balanceCents)) {
      blockers.push(`A bill for ${b.vendorName || '(no vendor)'} has an unreadable amount.`);
      break;
    }
    if (b.amountPaidCents > b.totalCents) {
      blockers.push(`A bill for ${b.vendorName || '(no vendor)'} shows more paid than its total.`);
      break;
    }
  }
  if (proposal.openBillCount > 0 && proposal.vendors.length === 0) {
    blockers.push('There are open bills but no vendors to book them against.');
  }
  if (!Number.isFinite(proposal.openApCents)) {
    blockers.push('The total open A/P could not be computed.');
  }
  return blockers;
}
