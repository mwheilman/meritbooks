/**
 * Vendor categorization memory (Modality M14 — LEARNING / PERSONALIZATION).
 *
 * The first real learning layer in MeritBooks. It makes auto-categorization
 * smarter per-tenant by remembering how a HUMAN has coded each vendor in the
 * past, and using that history to (a) surface a one-click "you usually code
 * {vendor} to {account}" hint in the bank-feed edit panel, and (b) BOOST the
 * confidence of a fresh AI/pattern proposal when it agrees with a consistent
 * history — so repeat vendors clear the review bar faster.
 *
 * CANON ALIGNMENT (docs/canon/CANON-ANCHOR.md §3):
 *   - AI PROPOSES facts; a human APPROVES. Memory only ever raises a *proposal's*
 *     confidence; it never posts a debit/credit and never auto-posts beyond the
 *     tenant's existing autonomy rules. The confidence is capped below 1.0 so the
 *     machine never claims certainty.
 *   - Corrections WIN for free: memory is DERIVED (not cached) from the latest
 *     approved history, and it is recency-weighted, so the moment a human re-codes
 *     a vendor the new coding both enters the sample and outranks stale codings.
 *   - RLS + org scoping: every query is filtered by org_id and runs on the
 *     caller's RLS-scoped client. Money stays bigint cents.
 *
 * SOURCE OF TRUTH: `bank_transactions` rows a human APPROVED/POSTED (status in
 * POSTED/APPROVED) with a `final_account_id` and `final_vendor_id`. Those are the
 * human's confirmed codings — the AI's `ai_*` columns are proposals and are
 * deliberately NOT used as evidence. No new table: this is computed on read.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** One human-confirmed coding of a vendor, the atom the ranker learns from. */
export interface ApprovedCoding {
  accountId: string;
  /** ISO timestamp the human approved it; drives recency weighting. */
  approvedAt: string | null;
  /** Absolute amount in cents; used only for the optional amount-affinity boost. */
  amountCents: number;
}

/** A ranked account suggestion for a vendor, with the evidence behind it. */
export interface AccountSuggestion {
  accountId: string;
  accountNumber: string | null;
  accountName: string | null;
  accountType: string | null;
  /** Raw number of times this vendor was coded to this account (the "n of m"). */
  count: number;
  /** Total confirmed codings for the vendor (the "m"). */
  total: number;
  /** count / total — the historical consistency (0..1). */
  share: number;
  /** Confidence derived from consistency AND sample size, capped < 1.0. */
  confidence: number;
  /** Most recent time this vendor was coded to this account (ISO), if known. */
  lastUsedAt: string | null;
  /** Internal recency-weighted score used for ranking; recent codings weigh more. */
  weightedScore: number;
}

export interface VendorMemory {
  vendorId: string | null;
  vendorName: string | null;
  /** Total confirmed codings observed for the vendor. */
  total: number;
  /** Suggestions, best first. */
  suggestions: AccountSuggestion[];
  /** The single best suggestion, or null when there is no history. */
  top: AccountSuggestion | null;
}

/** Tuning constants — documented so the behaviour is auditable, not magic. */
const RECENCY_DECAY = 0.92; // weight of the k-th newest coding = DECAY^k.
const AMOUNT_TOLERANCE = 0.25; // ±25% band counts as "a similar-sized charge".
const AMOUNT_AFFINITY = 1.25; // similar-sized codings weigh 25% more.
/** Codings needed for an account before its consistency counts at full strength. */
const FULL_CONFIDENCE_COUNT = 4;
/** Never claim total certainty — a human still approves. */
const MAX_MEMORY_CONFIDENCE = 0.97;

/**
 * PURE core: rank the accounts a vendor has been coded to, newest codings first.
 *
 * Confidence = consistency (share) damped by sample size, so 9-of-10 Home-Depot
 * charges to "Job Supplies" is high-confidence while 1-of-1 is not. Ranking is
 * recency-weighted so a recent correction can top an older majority even before
 * it becomes the raw majority — this is what makes "corrections win".
 *
 * Deterministic and side-effect-free → unit-testable without a database.
 */
export function rankSuggestions(
  history: ApprovedCoding[],
  opts?: { amountCents?: number },
): AccountSuggestion[] {
  const total = history.length;
  if (total === 0) return [];

  // Newest first (nulls sort last) so index 0 is the most recent coding.
  const sorted = [...history].sort((a, b) => {
    const ta = a.approvedAt ? Date.parse(a.approvedAt) : Number.NEGATIVE_INFINITY;
    const tb = b.approvedAt ? Date.parse(b.approvedAt) : Number.NEGATIVE_INFINITY;
    return tb - ta;
  });

  const targetAmount = opts?.amountCents != null ? Math.abs(opts.amountCents) : null;

  interface Acc { count: number; weighted: number; lastUsedAt: string | null }
  const byAccount = new Map<string, Acc>();

  sorted.forEach((rec, index) => {
    let weight = Math.pow(RECENCY_DECAY, index);
    if (targetAmount != null && targetAmount > 0 && rec.amountCents > 0) {
      const ratio = Math.abs(rec.amountCents) / targetAmount;
      if (ratio >= 1 - AMOUNT_TOLERANCE && ratio <= 1 + AMOUNT_TOLERANCE) {
        weight *= AMOUNT_AFFINITY;
      }
    }
    const cur = byAccount.get(rec.accountId) ?? { count: 0, weighted: 0, lastUsedAt: null };
    cur.count += 1;
    cur.weighted += weight;
    // sorted is newest-first, so the first time we see an account is its latest use.
    if (cur.lastUsedAt === null) cur.lastUsedAt = rec.approvedAt;
    byAccount.set(rec.accountId, cur);
  });

  const suggestions: AccountSuggestion[] = [];
  for (const [accountId, acc] of byAccount) {
    const share = acc.count / total;
    const sampleFactor = Math.min(1, acc.count / FULL_CONFIDENCE_COUNT);
    const confidence = Math.min(MAX_MEMORY_CONFIDENCE, share * sampleFactor);
    suggestions.push({
      accountId,
      accountNumber: null,
      accountName: null,
      count: acc.count,
      total,
      share,
      accountType: null,
      confidence,
      lastUsedAt: acc.lastUsedAt,
      weightedScore: acc.weighted,
    });
  }

  // Rank by recency-weighted score, then raw count, then most-recent use.
  suggestions.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) return b.weightedScore - a.weightedScore;
    if (b.count !== a.count) return b.count - a.count;
    const ta = a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0;
    const tb = b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0;
    return tb - ta;
  });

  return suggestions;
}

/** Strength of the memory nudge on an agreeing proposal (0..1). */
const MEMORY_BOOST_STRENGTH = 0.7;
/** Don't boost off a single data point — require a little corroboration. */
const MIN_BOOST_COUNT = 2;

/**
 * PURE: raise a proposal's confidence when a consistent history AGREES with it.
 *
 * Only ever raises, never lowers (memory is a booster/signal, not a veto — the
 * base composite score still stands). Caps below 1.0 so the machine keeps its
 * humility. Returns `applied: false` when memory is absent, thin, or disagrees.
 */
export function boostConfidenceWithMemory(
  baseConfidence: number,
  baseAccountId: string | null,
  memoryTop: AccountSuggestion | null,
  vendorLabel?: string,
): { confidence: number; applied: boolean; note: string | null } {
  if (
    !baseAccountId ||
    !memoryTop ||
    memoryTop.accountId !== baseAccountId ||
    memoryTop.count < MIN_BOOST_COUNT
  ) {
    return { confidence: baseConfidence, applied: false, note: null };
  }
  const lift = memoryTop.confidence * (1 - baseConfidence) * MEMORY_BOOST_STRENGTH;
  const confidence = Math.min(MAX_MEMORY_CONFIDENCE, baseConfidence + lift);
  const who = vendorLabel ? `${vendorLabel} is` : 'This vendor is';
  const note = `${who} usually coded here (${memoryTop.count} of ${memoryTop.total} past codings).`;
  return { confidence, applied: confidence > baseConfidence, note };
}

interface AccountLite { id: string; account_number: string; name: string; account_type?: string | null }

/**
 * QUERYABLE entrypoint: derive a vendor's coding memory from confirmed history.
 *
 * `suggestAccountForVendor` — for an org + vendor (and optionally an amount to
 * bias toward similar-sized charges) returns the ranked accounts the vendor is
 * usually coded to, with a confidence per account and the last-used date. Reads
 * the caller's RLS-scoped client, so it is org-isolated by construction.
 */
export async function suggestAccountForVendor(
  supabase: SupabaseClient,
  args: {
    orgId: string;
    vendorId?: string | null;
    /** Resolve a vendor by name when no id is on hand (edit-panel free text). */
    vendorName?: string | null;
    amountCents?: number;
    /** Pre-fetched COA rows for name/number enrichment (batch callers pass these). */
    preloadedAccounts?: AccountLite[];
    /** Cap on history rows pulled; a vendor's confirmed history is naturally bounded. */
    limit?: number;
  },
): Promise<VendorMemory> {
  const { orgId, amountCents, preloadedAccounts } = args;
  let vendorId = args.vendorId ?? null;
  let vendorName = args.vendorName ?? null;

  const empty: VendorMemory = { vendorId, vendorName, total: 0, suggestions: [], top: null };

  try {
    // Resolve a name → id when only a name was supplied.
    if (!vendorId && vendorName) {
      const { data: v } = await supabase
        .schema('core')
        .from('vendors')
        .select('id, name')
        .eq('org_id', orgId)
        .ilike('name', vendorName)
        .limit(1)
        .maybeSingle();
      const row = v as { id: string; name: string } | null;
      if (row) { vendorId = row.id; vendorName = row.name; }
    }
    if (!vendorId) return empty;

    const { data: rows, error } = await supabase
      .from('bank_transactions')
      .select('final_account_id, amount_cents, approved_at')
      .eq('org_id', orgId)
      .eq('final_vendor_id', vendorId)
      .in('status', ['POSTED', 'APPROVED'])
      .not('final_account_id', 'is', null)
      .order('approved_at', { ascending: false })
      .limit(args.limit ?? 500);

    if (error || !rows?.length) return { ...empty, vendorId, vendorName };

    const history: ApprovedCoding[] = (rows as Array<{ final_account_id: string; amount_cents: number; approved_at: string | null }>).map(
      (r) => ({ accountId: r.final_account_id, approvedAt: r.approved_at, amountCents: Math.abs(r.amount_cents) }),
    );

    const ranked = rankSuggestions(history, amountCents != null ? { amountCents } : undefined);
    if (ranked.length === 0) return { ...empty, vendorId, vendorName };

    // Enrich with account number/name for display.
    let accounts = preloadedAccounts ?? null;
    if (!accounts) {
      const ids = ranked.map((s) => s.accountId);
      const { data: acc } = await supabase
        .from('accounts')
        .select('id, account_number, name, account_type')
        .eq('org_id', orgId)
        .in('id', ids);
      accounts = (acc ?? []) as AccountLite[];
    }
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const enriched = ranked.map((s) => {
      const a = byId.get(s.accountId);
      return {
        ...s,
        accountNumber: a?.account_number ?? null,
        accountName: a?.name ?? null,
        accountType: a?.account_type ?? null,
      };
    });

    // Resolve a vendor display name if we still don't have one.
    if (!vendorName) {
      const { data: v } = await supabase
        .schema('core')
        .from('vendors')
        .select('name')
        .eq('org_id', orgId)
        .eq('id', vendorId)
        .maybeSingle();
      vendorName = (v as { name: string } | null)?.name ?? null;
    }

    return {
      vendorId,
      vendorName,
      total: history.length,
      suggestions: enriched,
      top: enriched[0] ?? null,
    };
  } catch {
    // Absent/stale columns or a transient error → behave as "no memory yet".
    return { ...empty, vendorId, vendorName };
  }
}
