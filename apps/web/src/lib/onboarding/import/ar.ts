/**
 * Customers & Open A/R onboarding — PURE normalizers, dedupe, and subledger math.
 *
 * The Customers/AR section pulls a customer master + a list of OPEN customer
 * invoices from an ERP connector (fetchCustomers + fetchOpenAR) OR a CSV OR manual
 * entry, normalizes them to a proposal the human reviews, and — on commit — writes
 * them as real records: masters into `core.customers`, open items as SENT invoices
 * that age in `v_ar_aging`.
 *
 * This module is PURE (no Supabase, no React, no I/O) so the normalizer, the dedupe,
 * and the Σ-open-AR math can be unit-tested against fixtures. The impure commit
 * (upserting customers, inserting opening invoices, and writing the AR total into the
 * conversion session's `subledgerDetail.arOpenByCustomerCents`) lives in the API
 * route, driven by these pure helpers.
 *
 * ── The opening-balance model (spec §4: "load once as detail then derive the
 *    control — never double-count") ────────────────────────────────────────────────
 * Opening invoices are SUBLEDGER DETAIL, not GL postings. The 1100 A/R control
 * balance is carried by the opening trial-balance journal entry (the Opening Balances
 * section). So these invoices are created with NO gl_entry_id and status SENT — they
 * age in v_ar_aging and their Σ balance must FOOT to the 1100 control (the extended
 * tie-out gate enforces exactly this). They deliberately do NOT re-post revenue or
 * re-book the 1100 balance, which would double-count. This mirrors the existing
 * /api/import "open_ar → invoices" path; the interactive `createInvoice` path (which
 * DOES post DR 1100 / CR Revenue) is for live invoicing, not conversion.
 *
 * Money is integer CENTS throughout.
 */

import { scoreCustomerDuplicates, type CustomerDupInput } from '@/lib/customers/dedupe';
import { normalizeText } from '@/lib/services/reconciliation-match';
import type { ProviderParty, ProviderOpenItem } from '@/lib/integrations/erp/providers/types';

// ─────────────────────────────────────────────────────────────────────────────
// Source-agnostic raw inputs (the route maps ERP records / coerced CSV rows / a
// manual form into these; the normalizer is source-agnostic).
// ─────────────────────────────────────────────────────────────────────────────

/** A raw customer master row from any source. */
export interface RawArParty {
  name: string;
  email?: string | null;
  phone?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  paymentTermsDays?: number | null;
  creditLimitCents?: number | null;
}

/** A raw open receivable (unpaid customer invoice) from any source. */
export interface RawArOpenItem {
  partyName: string;
  docNumber: string;
  /** ISO invoice date (YYYY-MM-DD). */
  date: string;
  /** ISO due date (YYYY-MM-DD). */
  dueDate: string;
  totalCents: number;
  amountPaidCents?: number | null;
  memo?: string | null;
}

export type ArImportSourceKind = 'erp' | 'csv' | 'manual';

// ─────────────────────────────────────────────────────────────────────────────
// Normalized drafts (what the review UI renders and the commit writes).
// ─────────────────────────────────────────────────────────────────────────────

export interface ArCustomerDraft {
  name: string;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  paymentTermsDays: number;
  creditLimitCents: number | null;
  /** True when a master with this normalized name already exists in core.customers. */
  existing: boolean;
  /** True when this master was synthesized from an open-AR row (no customer file). */
  fromInvoice: boolean;
}

export interface ArOpenInvoiceDraft {
  customerName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  totalCents: number;
  amountPaidCents: number;
  /** total − paid; what ages on v_ar_aging and foots to the 1100 control. */
  balanceCents: number;
  memo: string | null;
  /** True when this invoice_number already exists for the org (skipped on commit). */
  duplicate: boolean;
}

/** A near-duplicate customer pair worth a look before commit (never auto-merged). */
export interface ArDedupeWarning {
  aName: string;
  bName: string;
  confidence: number;
  reason: string;
}

/** The full reviewable proposal for the Customers/AR section. */
export interface ArImportProposal {
  source: ArImportSourceKind;
  customers: ArCustomerDraft[];
  invoices: ArOpenInvoiceDraft[];
  /** Σ open balances across the invoices that WILL be committed (cents). */
  openArCents: number;
  /** Near-duplicate customer masters to review (fuzzy; text-conveyed). */
  dedupeWarnings: ArDedupeWarning[];
  newCustomers: number;
  matchedCustomers: number;
  openInvoiceCount: number;
  /** Invoices skipped as already-present duplicates (by invoice number). */
  duplicateInvoices: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Canonical name key for dedupe — collapse case/whitespace/punctuation. */
export function customerNameKey(name: string): string {
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

// ─────────────────────────────────────────────────────────────────────────────
// ERP-provider adapters (fetchCustomers / fetchOpenAR shapes → raw inputs)
// ─────────────────────────────────────────────────────────────────────────────

export function arPartyFromProvider(p: ProviderParty): RawArParty {
  return { name: p.name, email: p.email, phone: p.phone };
}

export function arOpenItemFromProvider(o: ProviderOpenItem): RawArOpenItem {
  // ProviderOpenItem carries total + remaining balance; paid = total − balance.
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

export function normalizeArParty(raw: RawArParty, existing: boolean, fromInvoice = false): ArCustomerDraft {
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
    creditLimitCents: raw.creditLimitCents == null ? null : Math.round(raw.creditLimitCents),
    existing,
    fromInvoice,
  };
}

export function normalizeArOpenItem(raw: RawArOpenItem, duplicate: boolean): ArOpenInvoiceDraft {
  const total = Math.round(raw.totalCents || 0);
  const paid = Math.max(0, Math.round(raw.amountPaidCents || 0));
  const balance = total - paid;
  return {
    customerName: raw.partyName.trim(),
    invoiceNumber: raw.docNumber.trim(),
    invoiceDate: raw.date,
    dueDate: raw.dueDate,
    totalCents: total,
    amountPaidCents: paid,
    balanceCents: balance,
    memo: trimOrNull(raw.memo),
    duplicate,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedupe — reuse the platform customer-dedupe scorer to surface ambiguous masters.
// ─────────────────────────────────────────────────────────────────────────────

/** Near-duplicate warnings across the proposed customer masters (bounded scan). */
export function arDedupeWarnings(customers: ArCustomerDraft[]): ArDedupeWarning[] {
  const inputs: CustomerDupInput[] = customers.map((c, i) => ({
    id: `draft-${i}`,
    name: c.name,
    displayName: null,
    email: c.email,
    phone: c.phone,
    taxId: null,
    addressLine1: c.addressLine1,
    zip: c.zip,
    openArCents: 0,
  }));
  const out: ArDedupeWarning[] = [];
  const seen = new Set<string>();
  // Bounded O(n²) — onboarding customer counts are small; cap defensively.
  const N = Math.min(inputs.length, 400);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const signal = scoreCustomerDuplicates(inputs[i], inputs[j]);
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

export interface BuildArProposalArgs {
  source: ArImportSourceKind;
  parties: RawArParty[];
  openItems: RawArOpenItem[];
  /** Normalized-name keys of customers that already exist in core.customers. */
  existingCustomerKeys: Set<string>;
  /** Lowercased invoice numbers that already exist for the org. */
  existingInvoiceNumbers: Set<string>;
}

/**
 * Assemble the reviewable proposal. Dedupes customer masters by normalized name
 * (within the batch and against existing), synthesizes a minimal master for any
 * open-AR party that has no customer row (so no invoice is ever dropped), flags
 * duplicate invoice numbers, and computes Σ open A/R over the invoices that WILL be
 * committed. Pure and total.
 */
export function buildArProposal(args: BuildArProposalArgs): ArImportProposal {
  const { source, parties, openItems, existingCustomerKeys, existingInvoiceNumbers } = args;

  const byKey = new Map<string, ArCustomerDraft>();
  for (const raw of parties) {
    const name = (raw.name ?? '').trim();
    if (!name) continue;
    const key = customerNameKey(name);
    if (byKey.has(key)) continue; // collapse duplicate masters in the same file
    byKey.set(key, normalizeArParty(raw, existingCustomerKeys.has(key), false));
  }

  // Synthesize a master for any invoice party not already present (import- or existing-side).
  for (const item of openItems) {
    const name = (item.partyName ?? '').trim();
    if (!name) continue;
    const key = customerNameKey(name);
    if (byKey.has(key) || existingCustomerKeys.has(key)) continue;
    byKey.set(key, normalizeArParty({ name }, false, true));
  }

  const customers = [...byKey.values()];

  const invoices: ArOpenInvoiceDraft[] = [];
  const batchNumbers = new Set<string>();
  let openArCents = 0;
  for (const item of openItems) {
    const num = (item.docNumber ?? '').trim();
    const lower = num.toLowerCase();
    // Duplicate if the number already exists in the ledger OR repeats within this batch
    // (invoices carry a UNIQUE(org_id, invoice_number), so a repeat would collide).
    const duplicate = num.length > 0 && (existingInvoiceNumbers.has(lower) || batchNumbers.has(lower));
    if (num.length > 0) batchNumbers.add(lower);
    const draft = normalizeArOpenItem(item, duplicate);
    invoices.push(draft);
    if (!duplicate && draft.balanceCents > 0) openArCents += draft.balanceCents;
  }

  const newCustomers = customers.filter((c) => !c.existing).length;
  const matchedCustomers = customers.filter((c) => c.existing).length;

  return {
    source,
    customers,
    invoices,
    openArCents,
    dedupeWarnings: arDedupeWarnings(customers),
    newCustomers,
    matchedCustomers,
    openInvoiceCount: invoices.filter((i) => !i.duplicate).length,
    duplicateInvoices: invoices.filter((i) => i.duplicate).length,
  };
}

/** Σ open A/R across the committable invoices (cents). Pure. */
export function sumOpenArCents(invoices: ArOpenInvoiceDraft[]): number {
  return invoices.reduce((s, i) => (!i.duplicate && i.balanceCents > 0 ? s + i.balanceCents : s), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic gate — reasons the proposal cannot be committed. Empty ⇒ ready.
// ─────────────────────────────────────────────────────────────────────────────

export function validateArProposal(proposal: ArImportProposal): string[] {
  const blockers: string[] = [];
  for (const inv of proposal.invoices) {
    if (!Number.isFinite(inv.totalCents) || !Number.isFinite(inv.balanceCents)) {
      blockers.push(`Invoice ${inv.invoiceNumber || '(no number)'} has an unreadable amount.`);
      break;
    }
    if (inv.amountPaidCents > inv.totalCents) {
      blockers.push(`Invoice ${inv.invoiceNumber || '(no number)'} shows more paid than its total.`);
      break;
    }
    if (!inv.invoiceNumber) {
      blockers.push('An open invoice is missing its number — every open receivable needs a document number.');
      break;
    }
  }
  if (proposal.openInvoiceCount > 0 && proposal.customers.length === 0) {
    blockers.push('There are open receivables but no customers to book them against.');
  }
  if (!Number.isFinite(proposal.openArCents)) {
    blockers.push('The total open A/R could not be computed.');
  }
  return blockers;
}
