/**
 * Vendor duplicate detection — the vendor-master mirror of lib/customers/dedupe.
 * Duplicate VENDOR masters silently corrupt AP the same way duplicate customers
 * corrupt AR: one payee is recorded under two records, so spend/1099 totals are
 * split, per-vendor payment holds and compliance docs attach to only one
 * fragment, and duplicate-payment controls are defeated (each fragment carries
 * its own bill history). This detector surfaces the near-duplicates so a human
 * can reconcile them — it is READ-ONLY: it proposes facts and NEVER auto-merges
 * (canon §3: AI proposes; a human acts). There is deliberately no vendor merge
 * path — repointing bills/payments across vendors is a high-risk write we do not
 * automate here.
 *
 * Difference from the customer scorer: core.vendors has no plaintext tax-id
 * column (only tin_encrypted, which is never surfaced), so vendor matching keys
 * on name / email / phone / billing address only. The "amount at risk" is open
 * A/P (bills.balance_cents) rather than open A/R.
 *
 * Name similarity reuses the platform's single fuzzy matcher
 * (`vendorSimilarity` / `normalizeText` in reconciliation-match) so the vendor
 * and customer dedupe curves can't drift apart. All money is bigint cents.
 */

import { vendorSimilarity, normalizeText } from '@/lib/services/reconciliation-match';

// ── Tunable thresholds (single source of truth so they can't drift) ───────────
export const VENDOR_DUP_THRESHOLDS = {
  /** name similarity treated as "strong" (near-identical). */
  nameStrong: 0.9,
  /** name similarity treated as "near" (clearly related). */
  nameNear: 0.85,
  /** a weaker name floor that a hard identifier (email/phone) can lift. */
  nameWeak: 0.6,
  /** below this a hit is noise — never surfaced. Matches the review cut-line. */
  minSurface: 0.7,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs / outputs
// ─────────────────────────────────────────────────────────────────────────────

export interface VendorDupInput {
  id: string;
  name: string;
  displayName: string | null;
  email: string | null;
  phone: string | null;
  addressLine1: string | null;
  zip: string | null;
  /** open A/P booked under this master — quantifies what a merge would reunite. */
  openApCents: number;
}

export type VendorMatchField = 'name' | 'email' | 'phone' | 'address';

export interface VendorDupSignal {
  confidence: number; // 0..1 (pre-clamp)
  reason: string; // plain-language, audit-ready
  matchedFields: VendorMatchField[];
}

// ── small local helpers (self-contained; no cross-module coupling) ────────────

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

/** Clamp a 0..1 confidence into the numeric(5,4) range a DB column would accept. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Best name similarity across name/display_name on both sides (0..1). */
function bestNameSimilarity(a: VendorDupInput, b: VendorDupInput): number {
  const namesA = [a.name, a.displayName].filter((x): x is string => !!x);
  const namesB = [b.name, b.displayName].filter((x): x is string => !!x);
  let best = 0;
  for (const na of namesA) for (const nb of namesB) best = Math.max(best, vendorSimilarity(na, nb));
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// The scorer — pure. Score two vendor masters as duplicates of one another.
// Returns null when there is no meaningful duplicate signal (below the floor).
//
//   name ≥ strong + shared email/phone/address              → 0.93
//   shared email  + name ≥ weak                             → 0.90
//   shared phone  + name ≥ weak                             → 0.86
//   name ≥ strong (alone)                                  → 0.82
//   name ≥ near   + shared email/phone/address              → 0.82
//   otherwise                                              → null
// ─────────────────────────────────────────────────────────────────────────────
export function scoreVendorDuplicates(
  a: VendorDupInput,
  b: VendorDupInput,
): VendorDupSignal | null {
  if (a.id === b.id) return null;
  const T = VENDOR_DUP_THRESHOLDS;

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

  const contactField: VendorMatchField | null = sameEmail
    ? 'email'
    : samePhone
      ? 'phone'
      : sameAddr
        ? 'address'
        : null;
  const contactWord = sameEmail ? 'email' : samePhone ? 'phone' : 'remit-to address';
  const label = `"${a.name}" ↔ "${b.name}"`;

  // Highest-signal rule wins; matchedFields records every corroborating field.
  if (nameSim >= T.nameStrong && sharedContact && contactField) {
    return {
      confidence: 0.93,
      reason: `${label} have near-identical names and a shared ${contactWord} — almost certainly the same vendor, splitting spend and 1099 totals.`,
      matchedFields: ['name', contactField],
    };
  }
  if (sameEmail && nameSim >= T.nameWeak) {
    return {
      confidence: 0.9,
      reason: `${label} share an email address and have related names — probable duplicate vendor.`,
      matchedFields: ['email', 'name'],
    };
  }
  if (samePhone && nameSim >= T.nameWeak) {
    return {
      confidence: 0.86,
      reason: `${label} share a phone number and have related names — probable duplicate vendor.`,
      matchedFields: ['phone', 'name'],
    };
  }
  if (nameSim >= T.nameStrong) {
    return {
      confidence: 0.82,
      reason: `${label} have near-identical names — likely duplicate vendor masters fragmenting A/P.`,
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

export interface VendorDupPair {
  a: VendorDupInput;
  b: VendorDupInput;
  signal: VendorDupSignal;
  /** open A/P that a merge would reunite onto one master (the smaller side). */
  amountAtRiskCents: number;
  dedupKey: string;
}

/**
 * Score `target` against every other vendor and return the surfacing-worthy
 * candidate pairs, highest confidence first. Pure — used by the drawer's live
 * "possible duplicates" surface (read-only).
 */
export function pairsForVendor(
  target: VendorDupInput,
  others: VendorDupInput[],
): VendorDupPair[] {
  const out: VendorDupPair[] = [];
  for (const other of others) {
    if (other.id === target.id) continue;
    const signal = scoreVendorDuplicates(target, other);
    if (!signal || signal.confidence < VENDOR_DUP_THRESHOLDS.minSurface) continue;
    out.push({
      a: target,
      b: other,
      signal,
      amountAtRiskCents: Math.min(target.openApCents, other.openApCents),
      dedupKey: pairKey('vendordedupe', target.id, other.id),
    });
  }
  return out.sort((x, y) => y.signal.confidence - x.signal.confidence);
}

/**
 * All surfacing-worthy pairs across a set of vendors (each unordered pair once).
 * Buckets by name-prefix / email / phone to keep the comparison space
 * near-linear rather than a full O(n²) sweep. Pure.
 */
export function allCandidatePairs(vendors: VendorDupInput[]): VendorDupPair[] {
  const buckets = new Map<string, VendorDupInput[]>();
  for (const v of vendors) {
    const keys = new Set<string>();
    const firstTok = normalizeText(v.name).split(' ')[0] ?? '';
    if (firstTok) keys.add(`n:${firstTok.slice(0, 4)}`);
    if (v.email) keys.add(`e:${v.email.trim().toLowerCase()}`);
    const ph = normalizePhone(v.phone);
    if (ph.length === 10) keys.add(`p:${ph}`);
    if (keys.size === 0) keys.add('n:_');
    for (const k of keys) {
      const arr = buckets.get(k) ?? [];
      arr.push(v);
      buckets.set(k, arr);
    }
  }

  const seen = new Set<string>();
  const out: VendorDupPair[] = [];
  for (const group of buckets.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const key = pairKey('vendordedupe', a.id, b.id);
        if (seen.has(key)) continue; // same pair reached via two buckets
        seen.add(key);
        const signal = scoreVendorDuplicates(a, b);
        if (!signal || signal.confidence < VENDOR_DUP_THRESHOLDS.minSurface) continue;
        out.push({
          a,
          b,
          signal,
          amountAtRiskCents: Math.min(a.openApCents, b.openApCents),
          dedupKey: key,
        });
      }
    }
  }
  return out.sort((x, y) => y.signal.confidence - x.signal.confidence);
}
