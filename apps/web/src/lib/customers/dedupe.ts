/**
 * Customer duplicate detection — the customer-side mirror of the EC-1 vendor
 * dedupe (lib/controls/duplicate-payments Rule C). Duplicate CUSTOMER masters
 * silently corrupt AR: they split one buyer's balance across two records, so
 * DSO/aging is understated, credit limits are defeated (each fragment carries
 * its own limit), and statements go out incomplete. This detector surfaces the
 * near-duplicates so a human can merge them — it NEVER auto-merges (canon §3:
 * AI proposes facts; a human acts).
 *
 * Two layers:
 *   1. The pure, I/O-free scorers (`scoreCustomerDuplicates`, `pairsForCustomer`)
 *      — fuzzy match on name/email/phone/address/tax-id, returning a 0..1
 *      confidence + the exact fields that matched. Unit-tested in isolation.
 *   2. `scanCustomerDuplicates` — the RLS-scoped orchestrator that reads the
 *      org's customers, scores candidate pairs, and drafts a merge proposal as a
 *      PROPOSED row in public.ai_decisions (feature CUSTOMER_DEDUPE, dedup_key
 *      `custdedupe:<pair>`). It rides the existing /exceptions rail (any PROPOSED
 *      ai_decisions row folds in) and the migration-070 partial unique index is
 *      the DB-level double-queue guarantor. Idempotent + never throws.
 *
 * Name similarity reuses the platform's single fuzzy matcher
 * (`vendorSimilarity`/`normalizeText` in reconciliation-match) so the customer
 * and vendor dedupe curves can't drift apart. All money is bigint cents.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { vendorSimilarity, normalizeText } from '@/lib/services/reconciliation-match';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { logAction } from '@/lib/trust/action-log';
import { formatMoney } from '@meritbooks/shared';

export const CUSTOMER_DEDUPE_FEATURE = 'CUSTOMER_DEDUPE';

// ── Tunable thresholds (single source of truth so they can't drift) ───────────
export const CUST_DUP_THRESHOLDS = {
  /** name similarity treated as "strong" (near-identical). */
  nameStrong: 0.9,
  /** name similarity treated as "near" (clearly related). */
  nameNear: 0.85,
  /** a weaker name floor that a hard identifier (email/phone) can lift. */
  nameWeak: 0.6,
  /** below this a hit is noise — never surfaced. Matches the review cut-line. */
  minSurface: 0.7,
  /** normalized tax IDs shorter than this are ignored (too weak a key). */
  minTaxIdLen: 4,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomerDupInput {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  addressLine1: string | null;
  zip: string | null;
  /** open AR booked under this master — quantifies what a merge would reunite. */
  openArCents: number;
}

export type CustomerMatchField = 'tax_id' | 'name' | 'email' | 'phone' | 'address';

export interface CustomerDupSignal {
  confidence: number; // 0..1 (pre-clamp)
  reason: string; // plain-language, audit-ready
  matchedFields: CustomerMatchField[];
}

// ── small local helpers (self-contained; no cross-module coupling) ────────────

/** Uppercase alphanumerics only — a stable tax-id key. */
export function normalizeTaxId(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Last 10 digits — collapses formatting so "(515) 555-0100" == "5155550100". */
export function normalizePhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** Deterministic dedup key for an unordered pair (order-independent). */
export function pairKey(prefix: string, a: string, b: string): string {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return `${prefix}:${lo}:${hi}`;
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Best name similarity across name/display_name on both sides (0..1). */
function bestNameSimilarity(a: CustomerDupInput, b: CustomerDupInput): number {
  const namesA = [a.name, a.displayName].filter((x): x is string => !!x);
  const namesB = [b.name, b.displayName].filter((x): x is string => !!x);
  let best = 0;
  for (const na of namesA) for (const nb of namesB) best = Math.max(best, vendorSimilarity(na, nb));
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// The scorer — pure. Score two customer masters as duplicates of one another.
// Returns null when there is no meaningful duplicate signal (below the floor).
//
//   matching tax ID (both present)                          → 0.96
//   name ≥ strong + shared email/phone/address              → 0.93
//   shared email  + name ≥ weak                             → 0.90
//   shared phone  + name ≥ weak                             → 0.86
//   name ≥ strong (alone)                                  → 0.82
//   name ≥ near   + shared email/phone/address              → 0.82
//   otherwise                                              → null
// ─────────────────────────────────────────────────────────────────────────────
export function scoreCustomerDuplicates(
  a: CustomerDupInput,
  b: CustomerDupInput,
): CustomerDupSignal | null {
  if (a.id === b.id) return null;
  const T = CUST_DUP_THRESHOLDS;

  const taxA = normalizeTaxId(a.taxId);
  const taxB = normalizeTaxId(b.taxId);
  const sameTaxId = taxA.length >= T.minTaxIdLen && taxA === taxB;

  const nameSim = bestNameSimilarity(a, b);

  const sameEmail =
    !!a.email && !!b.email && a.email.trim().toLowerCase() === b.email.trim().toLowerCase();
  const samePhone =
    normalizePhone(a.phone).length === 10 && normalizePhone(a.phone) === normalizePhone(b.phone);
  const sameAddr =
    !!a.zip && !!b.zip && a.zip.trim() === b.zip.trim() &&
    normalizeText(a.addressLine1) !== '' &&
    normalizeText(a.addressLine1) === normalizeText(b.addressLine1);
  const sharedContact = sameEmail || samePhone || sameAddr;

  const contactField: CustomerMatchField | null = sameEmail
    ? 'email'
    : samePhone
      ? 'phone'
      : sameAddr
        ? 'address'
        : null;
  const contactWord = sameEmail ? 'email' : samePhone ? 'phone' : 'billing address';
  const label = `"${a.name}" ↔ "${b.name}"`;

  // Highest-signal rule wins; matchedFields records every corroborating field.
  if (sameTaxId) {
    const fields: CustomerMatchField[] = ['tax_id'];
    if (nameSim >= T.nameNear) fields.push('name');
    if (contactField) fields.push(contactField);
    return {
      confidence: 0.96,
      reason: `${label} share the same tax ID — the same buyer is recorded under two masters, splitting AR balance and defeating the credit limit.`,
      matchedFields: fields,
    };
  }
  if (nameSim >= T.nameStrong && sharedContact && contactField) {
    return {
      confidence: 0.93,
      reason: `${label} have near-identical names and a shared ${contactWord} — almost certainly the same customer.`,
      matchedFields: ['name', contactField],
    };
  }
  if (sameEmail && nameSim >= T.nameWeak) {
    return {
      confidence: 0.9,
      reason: `${label} share an email address and have related names — probable duplicate customer.`,
      matchedFields: ['email', 'name'],
    };
  }
  if (samePhone && nameSim >= T.nameWeak) {
    return {
      confidence: 0.86,
      reason: `${label} share a phone number and have related names — probable duplicate customer.`,
      matchedFields: ['phone', 'name'],
    };
  }
  if (nameSim >= T.nameStrong) {
    return {
      confidence: 0.82,
      reason: `${label} have near-identical names — likely duplicate customer masters fragmenting AR.`,
      matchedFields: ['name'],
    };
  }
  if (nameSim >= T.nameNear && sharedContact && contactField) {
    return {
      confidence: 0.82,
      reason: `${label} have similar names and a shared ${contactWord} — review for duplication.`,
      matchedFields: ['name', contactField],
    };
  }
  return null;
}

export interface CustomerDupPair {
  a: CustomerDupInput;
  b: CustomerDupInput;
  signal: CustomerDupSignal;
  /** AR that a merge would reunite onto one master (the smaller side). */
  amountAtRiskCents: number;
  dedupKey: string;
}

/**
 * Score `target` against every other customer and return the surfacing-worthy
 * candidate pairs, highest confidence first. Pure — used by the drawer's live
 * "possible duplicates" surface (read-only) and by the scan orchestrator.
 */
export function pairsForCustomer(
  target: CustomerDupInput,
  others: CustomerDupInput[],
): CustomerDupPair[] {
  const out: CustomerDupPair[] = [];
  for (const other of others) {
    if (other.id === target.id) continue;
    const signal = scoreCustomerDuplicates(target, other);
    if (!signal || signal.confidence < CUST_DUP_THRESHOLDS.minSurface) continue;
    out.push({
      a: target,
      b: other,
      signal,
      amountAtRiskCents: Math.min(target.openArCents, other.openArCents),
      dedupKey: pairKey('custdedupe', target.id, other.id),
    });
  }
  return out.sort((x, y) => y.signal.confidence - x.signal.confidence);
}

/**
 * All surfacing-worthy pairs across a set of customers (each unordered pair once).
 * Buckets by name-prefix / email / phone / tax-id to keep the comparison space
 * near-linear rather than a full O(n²) sweep. Pure.
 */
export function allCandidatePairs(customers: CustomerDupInput[]): CustomerDupPair[] {
  const buckets = new Map<string, CustomerDupInput[]>();
  for (const c of customers) {
    const keys = new Set<string>();
    const firstTok = normalizeText(c.name).split(' ')[0] ?? '';
    if (firstTok) keys.add(`n:${firstTok.slice(0, 4)}`);
    if (c.email) keys.add(`e:${c.email.trim().toLowerCase()}`);
    const ph = normalizePhone(c.phone);
    if (ph.length === 10) keys.add(`p:${ph}`);
    const tax = normalizeTaxId(c.taxId);
    if (tax.length >= CUST_DUP_THRESHOLDS.minTaxIdLen) keys.add(`t:${tax}`);
    if (keys.size === 0) keys.add('n:_');
    for (const k of keys) {
      const arr = buckets.get(k) ?? [];
      arr.push(c);
      buckets.set(k, arr);
    }
  }

  const seen = new Set<string>();
  const out: CustomerDupPair[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const key = pairKey('custdedupe', a.id, b.id);
        if (seen.has(key)) continue; // same pair reached via two buckets
        seen.add(key);
        const signal = scoreCustomerDuplicates(a, b);
        if (!signal || signal.confidence < CUST_DUP_THRESHOLDS.minSurface) continue;
        out.push({
          a,
          b,
          signal,
          amountAtRiskCents: Math.min(a.openArCents, b.openArCents),
          dedupKey: key,
        });
      }
    }
  }
  return out.sort((x, y) => y.signal.confidence - x.signal.confidence);
}

/**
 * A control exception must ALWAYS reach a human, so `scoreToTier`'s `auto`
 * (advisory/suppress) is floored up to `review`. A near-certain duplicate that
 * has fragmented real AR is escalated.
 */
export function resolveCustDupTier(
  confidence: number,
  amountAtRiskCents: number,
  policy: TierPolicy,
): Tier {
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration (I/O) — scan the org's customers, queue merge proposals.
// ─────────────────────────────────────────────────────────────────────────────

export interface CustomerDedupeScanSummary {
  scanned: number; // customers loaded
  detected: number; // candidate pairs found (incl. already-queued)
  queued: number; // NEW proposals inserted (deduped)
  byTier: Record<Tier, number>;
  errors: number;
}

/**
 * Scan the org's customers for duplicates and queue new merge proposals into
 * /exceptions. Never throws — a detection pass must not break its caller.
 */
export async function scanCustomerDuplicates(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CustomerDedupeScanSummary> {
  const summary: CustomerDedupeScanSummary = {
    scanned: 0,
    detected: 0,
    queued: 0,
    byTier: { auto: 0, review: 0, escalate: 0 },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // ── Load active customers (RLS-scoped; not soft-deleted) ────────────────────
  const { data: custRaw, error: custErr } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name, email, phone, tax_id, address_line1, zip')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .limit(5000);
  if (custErr) {
    console.warn('[customers/dedupe] customer load failed:', custErr.message);
    return summary;
  }
  const rows = (custRaw ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
    email: string | null;
    phone: string | null;
    tax_id: string | null;
    address_line1: string | null;
    zip: string | null;
  }>;
  summary.scanned = rows.length;
  if (rows.length < 2) return summary;

  // ── Open AR per customer (quantifies what a merge reunites) ──────────────────
  const openArByCustomer = new Map<string, number>();
  const ids = rows.map((r) => r.id);
  for (let i = 0; i < ids.length; i += 500) {
    const slice = ids.slice(i, i + 500);
    const { data: invs } = await supabase
      .from('invoices')
      .select('customer_id, balance_cents, status')
      .eq('org_id', orgId)
      .in('customer_id', slice)
      .not('status', 'in', '(PAID,VOIDED,DRAFT)');
    for (const inv of (invs ?? []) as Array<{ customer_id: string; balance_cents: number | string }>) {
      const cur = openArByCustomer.get(inv.customer_id) ?? 0;
      openArByCustomer.set(inv.customer_id, cur + (Number(inv.balance_cents) || 0));
    }
  }

  const inputs: CustomerDupInput[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    email: r.email,
    phone: r.phone,
    taxId: r.tax_id,
    addressLine1: r.address_line1,
    zip: r.zip,
    openArCents: openArByCustomer.get(r.id) ?? 0,
  }));

  const pairs = allCandidatePairs(inputs);
  summary.detected = pairs.length;
  if (pairs.length === 0) return summary;

  // ── Idempotency: skip any dedup_key already open OR already resolved ─────────
  const existingKeys = new Set<string>();
  try {
    const { data: prior } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('org_id', orgId)
      .eq('feature', CUSTOMER_DEDUPE_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of prior ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) existingKeys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — the DB unique index is the real double-queue guarantor */
  }

  for (const pair of pairs) {
    if (existingKeys.has(pair.dedupKey)) continue;
    const tier = resolveCustDupTier(pair.signal.confidence, pair.amountAtRiskCents, policy);
    const confidence = toConfidence(pair.signal.confidence);
    const atRisk = pair.amountAtRiskCents;
    const title =
      `Possible duplicate customer: "${pair.a.name}" ≈ "${pair.b.name}"` +
      (atRisk > 0 ? ` · ${formatMoney(atRisk)} AR fragmented` : '');

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      feature: CUSTOMER_DEDUPE_FEATURE,
      input_summary: title.slice(0, 2000),
      proposed_output: {
        control: 'CUSTOMER_DEDUPE',
        kind: 'duplicate_customer',
        dedup_key: pair.dedupKey,
        amount_at_risk_cents: atRisk,
        tier,
        matched_fields: pair.signal.matchedFields,
        // survivor = the master with MORE open AR (the one to keep); dup merges in.
        survivor_id: pair.a.openArCents >= pair.b.openArCents ? pair.a.id : pair.b.id,
        duplicate_id: pair.a.openArCents >= pair.b.openArCents ? pair.b.id : pair.a.id,
        subjects: { customer_id_a: pair.a.id, customer_id_b: pair.b.id },
        reason: pair.signal.reason,
      },
      confidence,
      reasoning: pair.signal.reason,
      clarifying_question:
        'Merge the duplicate into the survivor (re-pointing its invoices & payments), or confirm these are genuinely different customers?',
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      // A unique-index collision (migration 070) means a concurrent scan already
      // queued this pair — not an error, just already handled.
      if (!/duplicate key|unique/i.test(error.message)) {
        console.warn('[customers/dedupe] could not queue proposal:', error.message);
        summary.errors += 1;
      }
      existingKeys.add(pair.dedupKey);
      continue;
    }
    existingKeys.add(pair.dedupKey);
    summary.queued += 1;
    summary.byTier[tier] += 1;

    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'customers.dedupe.detect',
      subjectTable: 'customers',
      subjectId: pair.a.id,
      summary: title,
      confidence,
      tier,
      metadata: {
        dedup_key: pair.dedupKey,
        amount_at_risk_cents: atRisk,
        matched_fields: pair.signal.matchedFields,
      },
    });
  }

  return summary;
}
