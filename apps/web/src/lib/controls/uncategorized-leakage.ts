/**
 * Financial Control Exception EC-4 — Unposted / uncategorized cost leakage.
 *
 * A continuous control that scans the owned ledger for *real economic activity
 * that is not yet in the GL* — money that landed but was never coded or posted.
 * Left alone this quietly wrecks departmental / entity P&L and hides spend, and
 * it is the classic reason a "clean" close is anything but. This control NEVER
 * codes, posts, pays, or edits anything — it DETECTS the aged leakage, quantifies
 * the dollars at risk, and DRAFTS the remediation (re-propose coding / post the
 * obligation) for a human to apply (canon §3: AI proposes facts; a human acts).
 *
 * Three detection signals (all "landed but not in the ledger, and aging"):
 *   A. uncoded_bank      — bank/card lines with no final GL coding and no GL
 *                          entry, still sitting past their aging threshold.
 *   B. unposted_receipt  — receipts captured but never matched/posted (no GL
 *                          entry) past their threshold.
 *   C. unpaid_bill       — APPROVED bills never posted to the GL past their
 *                          threshold — a real obligation missing from the books.
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each
 * aged bucket is written as a PROPOSED row in public.ai_decisions with feature
 * 'UNCATEGORIZED_LEAKAGE'. The existing /exceptions route already folds PROPOSED
 * ai_decisions in as an `ai_proposal` source. This mirrors EC-1 exactly.
 *
 * Aggregation & idempotency: leakage is aggregated by company (location) + fiscal
 * period (YYYY-MM) + kind — because a controller closes a *period for a company*,
 * not a single stray line. Each bucket carries a stable `dedup_key`
 * (`leak:<kind>:<locationId>:<period>`), so a re-scan UPDATES the open bucket
 * rather than duplicating it, leaves human-resolved (APPROVED/REJECTED) buckets
 * untouched, and EXPIRES buckets that have since been cleaned up.
 *
 * The pure scoring / aggregation (`ageInDays`, `aggregateLeakage`,
 * `resolveLeakageTier`, `computeCloseReadiness`) is I/O-free and unit-tested. The
 * `scanUncategorizedLeakage` orchestrator does the RLS-scoped reads/writes.
 *
 * All money is bigint cents. Confidence is clamped into numeric(5,4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import { formatMoney } from '@meritbooks/shared';

export const LEAKAGE_FEATURE = 'UNCATEGORIZED_LEAKAGE';

export type LeakageKind = 'uncoded_bank' | 'unposted_receipt' | 'unpaid_bill';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const LEAKAGE_THRESHOLDS = {
  /** bank/card lines uncoded for longer than this (days) are leakage. */
  uncodedBankDays: 15,
  /** receipts captured & unposted for longer than this (days) are leakage. */
  unpostedReceiptDays: 30,
  /** approved-but-unposted bills older than this (days) are leakage. */
  unpaidBillDays: 30,
  /** a company/period bucket at/above this aggregate $ ESCALATES (blocks close hard). */
  escalateAtRiskCents: 2_500_000, // $25,000
  /** cap subject ids persisted per bucket (jsonb size guard). */
  maxSubjectsPerBucket: 250,
  /** confidence ramp: floor at the aging threshold, ceil once well overdue. */
  confidenceFloor: 0.8,
  confidenceCeil: 0.97,
  /** age (days) at which confidence reaches the ceiling. */
  confidenceCeilDays: 60,
} as const;

const KIND_THRESHOLD_DAYS: Record<LeakageKind, number> = {
  uncoded_bank: LEAKAGE_THRESHOLDS.uncodedBankDays,
  unposted_receipt: LEAKAGE_THRESHOLDS.unpostedReceiptDays,
  unpaid_bill: LEAKAGE_THRESHOLDS.unpaidBillDays,
};

const KIND_LABEL: Record<LeakageKind, string> = {
  uncoded_bank: 'Uncategorized bank/card activity',
  unposted_receipt: 'Captured receipts not posted',
  unpaid_bill: 'Approved bills not posted',
};

const KIND_NOUN: Record<LeakageKind, string> = {
  uncoded_bank: 'bank/card transaction(s)',
  unposted_receipt: 'captured receipt(s)',
  unpaid_bill: 'approved bill(s)',
};

/** The remediation the AI drafts per kind — never auto-applied (canon §3). */
const REMEDIATION_QUESTION: Record<LeakageKind, string> = {
  uncoded_bank:
    'Code and post these transactions to clear the period, or confirm they are intentionally excluded?',
  unposted_receipt:
    'Match and post these receipts, or confirm they are duplicates / already captured elsewhere?',
  unpaid_bill:
    'Post these approved bills to AP so the obligation hits the ledger, or void them if no longer owed?',
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (I/O-free, unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

/** Whole days between a date and an as-of instant; +∞ for an unparseable date. */
export function ageInDays(dateISO: string | null | undefined, asOfISO: string): number {
  if (!dateISO) return Number.POSITIVE_INFINITY;
  const t = new Date(dateISO).getTime();
  const asOf = new Date(asOfISO).getTime();
  if (Number.isNaN(t) || Number.isNaN(asOf)) return Number.POSITIVE_INFINITY;
  return Math.floor((asOf - t) / 86_400_000);
}

/** Fiscal period bucket (YYYY-MM) for a date; 'unknown' when undatable. */
export function periodOf(dateISO: string | null | undefined): string {
  if (!dateISO) return 'unknown';
  const s = String(dateISO);
  // Accept full ISO or bare date; require YYYY-MM prefix.
  if (/^\d{4}-\d{2}/.test(s)) return s.slice(0, 7);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Deterministic, stable dedup key for a company/period/kind bucket. */
export function bucketKey(kind: LeakageKind, locationId: string | null, period: string): string {
  return `leak:${kind}:${locationId ?? 'none'}:${period}`;
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/**
 * Confidence that an aged item is genuine leakage — an item uncoded/unposted for
 * a day past threshold is a soft signal; one sitting for two months is near
 * certain. Ramps LINEARLY from the floor at the kind's aging threshold to the
 * ceiling at `confidenceCeilDays`.
 */
export function agingConfidence(maxAgeDays: number, kind: LeakageKind): number {
  const T = LEAKAGE_THRESHOLDS;
  const start = KIND_THRESHOLD_DAYS[kind];
  const span = Math.max(1, T.confidenceCeilDays - start);
  const t = Math.max(0, Math.min(1, (maxAgeDays - start) / span));
  return T.confidenceFloor + (T.confidenceCeil - T.confidenceFloor) * t;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────────────

export interface LeakageItem {
  id: string;
  kind: LeakageKind;
  locationId: string | null;
  /** the date the economic activity landed (transaction/receipt/bill date). */
  dateISO: string | null;
  /** dollars at risk for this item (already sign-normalized, cents). */
  amountCents: number;
}

export interface LeakageBucket {
  dedupKey: string;
  kind: LeakageKind;
  locationId: string | null;
  period: string;
  count: number;
  amountAtRiskCents: number;
  maxAgeDays: number;
  subjectIds: string[];
  confidence: number; // 0..1 (pre-clamp)
  title: string; // → ai_decisions.input_summary
  reason: string; // → ai_decisions.reasoning
}

/**
 * Filter to aged items and roll them up into company/period/kind buckets. Only
 * items whose age exceeds their kind's threshold are leakage; everything else is
 * normal in-flight work and stays silent (anti-cry-wolf). Pure — `asOfISO` is
 * injected so the logic is deterministic and testable.
 */
export function aggregateLeakage(
  items: LeakageItem[],
  asOfISO: string,
  thresholds: typeof LEAKAGE_THRESHOLDS = LEAKAGE_THRESHOLDS,
): LeakageBucket[] {
  const groups = new Map<
    string,
    { kind: LeakageKind; locationId: string | null; period: string; ids: string[]; sum: number; maxAge: number }
  >();

  for (const it of items) {
    const age = ageInDays(it.dateISO, asOfISO);
    if (!(age > KIND_THRESHOLD_DAYS[it.kind])) continue; // not yet aged → not leakage
    const period = periodOf(it.dateISO);
    const key = bucketKey(it.kind, it.locationId, period);
    const g =
      groups.get(key) ??
      { kind: it.kind, locationId: it.locationId, period, ids: [] as string[], sum: 0, maxAge: 0 };
    g.ids.push(it.id);
    g.sum += Math.abs(Number(it.amountCents) || 0);
    g.maxAge = Math.max(g.maxAge, Number.isFinite(age) ? age : g.maxAge);
    groups.set(key, g);
  }

  const buckets: LeakageBucket[] = [];
  for (const [key, g] of groups) {
    const confidence = agingConfidence(g.maxAge, g.kind);
    const amt = formatMoney(g.sum);
    const title = `${KIND_LABEL[g.kind]} — ${g.period} · ${g.ids.length} item(s) · ${amt} not in the GL`;
    const reason =
      `${g.ids.length} ${KIND_NOUN[g.kind]} in period ${g.period} totaling ${amt} ` +
      `${g.kind === 'unpaid_bill' ? 'are approved but never posted' : 'remain uncoded/unposted'} ` +
      `after ${KIND_THRESHOLD_DAYS[g.kind]}+ days (oldest ${g.maxAge} days) — real economic activity ` +
      `that is not yet in the general ledger, distorting this company's period P&L until it is coded and posted.`;
    buckets.push({
      dedupKey: key,
      kind: g.kind,
      locationId: g.locationId,
      period: g.period,
      count: g.ids.length,
      amountAtRiskCents: g.sum,
      maxAgeDays: g.maxAge,
      subjectIds: g.ids.slice(0, thresholds.maxSubjectsPerBucket),
      confidence,
      title,
      reason,
    });
  }

  // Highest $-at-risk first — the operator sees the biggest hole in the close top.
  buckets.sort((a, b) => b.amountAtRiskCents - a.amountAtRiskCents);
  return buckets;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — a control never auto-suppresses.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Map a leakage bucket to a surfacing tier. EC-4 is a REVIEW control (its
 * aggregate blocks close — Dimension 10), so scoreToTier's `auto` is floored up
 * to `review`; a bucket whose aggregate crosses the materiality escalate line is
 * ESCALATE (a hole this big must block the close, not sit in a queue).
 */
export function resolveLeakageTier(
  amountAtRiskCents: number,
  confidence: number,
  policy: TierPolicy,
  escalateAtRiskCents: number = LEAKAGE_THRESHOLDS.escalateAtRiskCents,
): Tier {
  if (amountAtRiskCents >= escalateAtRiskCents) return 'escalate';
  const { tier } = scoreToTier({ confidence, amountCents: amountAtRiskCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Close-readiness — the summary the caller uses to gate a clean close.
// ─────────────────────────────────────────────────────────────────────────────

export interface CloseReadinessRow {
  locationId: string | null;
  period: string;
  items: number;
  atRiskCents: number;
  byKind: Record<LeakageKind, number>; // $ at risk by kind
  /** worst tier across this company/period (escalate > review > auto). */
  tier: Tier;
  blocksClose: boolean;
}

export interface CloseReadiness {
  /** total uncoded/unposted items across all companies/periods. */
  totalItems: number;
  totalAtRiskCents: number;
  /** the subset that HARD-blocks a clean close (escalate tier). */
  blockingItems: number;
  blockingAtRiskCents: number;
  clean: boolean; // true ⇒ nothing is blocking a close
  byCompanyPeriod: CloseReadinessRow[];
}

interface TieredBucket {
  locationId: string | null;
  period: string;
  kind: LeakageKind;
  count: number;
  amountAtRiskCents: number;
  tier: Tier;
}

const TIER_RANK: Record<Tier, number> = { auto: 0, review: 1, escalate: 2 };

/**
 * Roll tiered buckets into a per-company/period close-readiness picture. Every
 * leakage bucket `blocksClose` (EC-4 is a blocking close condition, Dimension
 * 10); an ESCALATE-tier company/period is a HARD block. Pure & testable.
 */
export function computeCloseReadiness(buckets: TieredBucket[]): CloseReadiness {
  const rows = new Map<string, CloseReadinessRow>();
  let totalItems = 0;
  let totalAtRiskCents = 0;

  for (const b of buckets) {
    totalItems += b.count;
    totalAtRiskCents += b.amountAtRiskCents;
    const key = `${b.locationId ?? 'none'}:${b.period}`;
    const row =
      rows.get(key) ??
      ({
        locationId: b.locationId,
        period: b.period,
        items: 0,
        atRiskCents: 0,
        byKind: { uncoded_bank: 0, unposted_receipt: 0, unpaid_bill: 0 },
        tier: 'review' as Tier,
        blocksClose: true,
      } satisfies CloseReadinessRow);
    row.items += b.count;
    row.atRiskCents += b.amountAtRiskCents;
    row.byKind[b.kind] += b.amountAtRiskCents;
    if (TIER_RANK[b.tier] > TIER_RANK[row.tier]) row.tier = b.tier;
    rows.set(key, row);
  }

  const byCompanyPeriod = Array.from(rows.values()).sort((a, b) => b.atRiskCents - a.atRiskCents);
  let blockingItems = 0;
  let blockingAtRiskCents = 0;
  for (const r of byCompanyPeriod) {
    if (r.tier === 'escalate') {
      blockingItems += r.items;
      blockingAtRiskCents += r.atRiskCents;
    }
  }

  return {
    totalItems,
    totalAtRiskCents,
    blockingItems,
    blockingAtRiskCents,
    clean: blockingItems === 0,
    byCompanyPeriod,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O)
// ─────────────────────────────────────────────────────────────────────────────

export interface LeakageScanSummary {
  scanned: { bank: number; receipts: number; bills: number };
  detectedItems: number; // aged leakage items found this pass
  buckets: number; // company/period/kind buckets found
  queued: number; // NEW ai_decisions rows inserted
  refreshed: number; // existing PROPOSED buckets updated in place
  expired: number; // previously-open buckets now cleaned up
  byTier: Record<Tier, number>; // NEW + refreshed rows by tier
  closeReadiness: CloseReadiness;
  errors: number;
}

export interface LeakageScanOptions {
  /** injectable clock for deterministic tests; defaults to now. */
  asOfISO?: string;
  /** compute + return close-readiness WITHOUT persisting any exception rows. */
  dryRun?: boolean;
}

/**
 * Scan the ledger for EC-4 uncategorized/unposted leakage, queue/refresh the
 * per-company/period exceptions into /exceptions, and return a close-readiness
 * summary. Never throws — a control scan must not break the pass it rides on.
 * Read/write run through the RLS-scoped client; org isolation is enforced by the
 * database, never by hand-filtering org_id.
 */
export async function scanUncategorizedLeakage(
  supabase: SupabaseClient,
  orgId: string,
  opts: LeakageScanOptions = {},
): Promise<LeakageScanSummary> {
  const asOfISO = opts.asOfISO ?? new Date().toISOString();
  const summary: LeakageScanSummary = {
    scanned: { bank: 0, receipts: 0, bills: 0 },
    detectedItems: 0,
    buckets: 0,
    queued: 0,
    refreshed: 0,
    expired: 0,
    byTier: { auto: 0, review: 0, escalate: 0 },
    closeReadiness: {
      totalItems: 0,
      totalAtRiskCents: 0,
      blockingItems: 0,
      blockingAtRiskCents: 0,
      clean: true,
      byCompanyPeriod: [],
    },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  const items: LeakageItem[] = [];

  // ── A. Uncoded bank/card lines: no final coding, no GL entry, not posted/void ─
  try {
    const { data, error } = await supabase
      .from('bank_transactions')
      .select('id, location_id, transaction_date, amount_cents, status, final_account_id, gl_entry_id')
      .is('final_account_id', null)
      .is('gl_entry_id', null)
      .not('status', 'in', '("POSTED","VOIDED")')
      .order('transaction_date', { ascending: true })
      .limit(5000);
    if (error) {
      console.warn('[controls/leakage] bank load failed:', error.message);
    } else {
      const rows = (data ?? []) as Array<{
        id: string;
        location_id: string | null;
        transaction_date: string | null;
        amount_cents: number | string | null;
      }>;
      summary.scanned.bank = rows.length;
      for (const r of rows) {
        items.push({
          id: r.id,
          kind: 'uncoded_bank',
          locationId: r.location_id,
          dateISO: r.transaction_date,
          amountCents: Number(r.amount_cents) || 0,
        });
      }
    }
  } catch (e) {
    console.warn('[controls/leakage] bank scan threw:', e instanceof Error ? e.message : e);
  }

  // ── B. Captured receipts never matched/posted (no GL entry, not voided) ──────
  try {
    const { data, error } = await supabase
      .from('receipts')
      .select('id, location_id, receipt_date, submitted_at, amount_cents, status, gl_entry_id')
      .is('gl_entry_id', null)
      .neq('status', 'VOIDED')
      .limit(5000);
    if (error) {
      console.warn('[controls/leakage] receipts load failed:', error.message);
    } else {
      const rows = (data ?? []) as Array<{
        id: string;
        location_id: string | null;
        receipt_date: string | null;
        submitted_at: string | null;
        amount_cents: number | string | null;
      }>;
      summary.scanned.receipts = rows.length;
      for (const r of rows) {
        items.push({
          id: r.id,
          kind: 'unposted_receipt',
          locationId: r.location_id,
          // age from when the receipt landed; receipt_date preferred, else submit.
          dateISO: r.receipt_date ?? (r.submitted_at ? r.submitted_at.slice(0, 10) : null),
          amountCents: Number(r.amount_cents) || 0,
        });
      }
    }
  } catch (e) {
    console.warn('[controls/leakage] receipts scan threw:', e instanceof Error ? e.message : e);
  }

  // ── C. Approved bills never posted to the GL (obligation missing from books) ─
  try {
    const { data, error } = await supabase
      .from('bills')
      .select('id, location_id, bill_date, total_cents, status, gl_entry_id')
      .eq('status', 'APPROVED')
      .is('gl_entry_id', null)
      .order('bill_date', { ascending: true })
      .limit(5000);
    if (error) {
      console.warn('[controls/leakage] bills load failed:', error.message);
    } else {
      const rows = (data ?? []) as Array<{
        id: string;
        location_id: string | null;
        bill_date: string | null;
        total_cents: number | string | null;
      }>;
      summary.scanned.bills = rows.length;
      for (const r of rows) {
        items.push({
          id: r.id,
          kind: 'unpaid_bill',
          locationId: r.location_id,
          dateISO: r.bill_date,
          amountCents: Number(r.total_cents) || 0,
        });
      }
    }
  } catch (e) {
    console.warn('[controls/leakage] bills scan threw:', e instanceof Error ? e.message : e);
  }

  // ── Aggregate into company/period/kind buckets, then tier ────────────────────
  const buckets = aggregateLeakage(items, asOfISO);
  summary.detectedItems = buckets.reduce((n, b) => n + b.count, 0);
  summary.buckets = buckets.length;

  const tieredForClose: TieredBucket[] = buckets.map((b) => ({
    locationId: b.locationId,
    period: b.period,
    kind: b.kind,
    count: b.count,
    amountAtRiskCents: b.amountAtRiskCents,
    tier: resolveLeakageTier(b.amountAtRiskCents, b.confidence, policy),
  }));
  summary.closeReadiness = computeCloseReadiness(tieredForClose);

  if (opts.dryRun) return summary;

  // ── Load existing exceptions for this feature (idempotency + expiry) ─────────
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', LEAKAGE_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of data ?? []) {
      const r = row as { id: string; status: string; proposed_output?: { dedup_key?: string } };
      const key = r.proposed_output?.dedup_key;
      if (key) existing.set(key, { id: r.id, status: r.status });
    }
  } catch {
    /* best-effort — worst case we re-queue rather than refresh */
  }

  const liveKeys = new Set(buckets.map((b) => b.dedupKey));

  // ── Insert new / refresh open buckets ────────────────────────────────────────
  for (const b of buckets) {
    const tier = resolveLeakageTier(b.amountAtRiskCents, b.confidence, policy);
    const confidence = toConfidence(b.confidence);
    const proposedOutput = {
      control: 'EC-4',
      kind: b.kind,
      dedup_key: b.dedupKey,
      period: b.period,
      amount_at_risk_cents: b.amountAtRiskCents,
      item_count: b.count,
      max_age_days: b.maxAgeDays,
      tier,
      blocks_close: true,
      subject_ids: b.subjectIds,
      reason: b.reason,
    };

    const prior = existing.get(b.dedupKey);

    // A human already dispositioned this bucket — do not resurface it.
    if (prior && (prior.status === 'APPROVED' || prior.status === 'REJECTED')) continue;

    if (prior && prior.status === 'PROPOSED') {
      const { error } = await supabase
        .from('ai_decisions')
        .update({
          input_summary: b.title,
          proposed_output: proposedOutput,
          confidence,
          reasoning: b.reason,
          clarifying_question: REMEDIATION_QUESTION[b.kind],
        })
        .eq('id', prior.id);
      if (error) {
        console.warn('[controls/leakage] refresh failed:', error.message);
        summary.errors += 1;
        continue;
      }
      summary.refreshed += 1;
      summary.byTier[tier] += 1;
      continue;
    }

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: b.locationId,
      feature: LEAKAGE_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: REMEDIATION_QUESTION[b.kind],
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/leakage] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    summary.queued += 1;
    summary.byTier[tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.uncategorized_leakage.detect',
      subjectTable:
        b.kind === 'uncoded_bank' ? 'bank_transactions' : b.kind === 'unposted_receipt' ? 'receipts' : 'bills',
      subjectId: b.subjectIds[0] ?? null,
      summary: b.title,
      locationId: b.locationId,
      confidence,
      tier,
      metadata: {
        kind: b.kind,
        dedup_key: b.dedupKey,
        period: b.period,
        amount_at_risk_cents: b.amountAtRiskCents,
        item_count: b.count,
      },
    });
  }

  // ── Expire previously-open buckets that are now cleaned up (queue hygiene) ────
  for (const [key, prior] of existing) {
    if (prior.status !== 'PROPOSED' || liveKeys.has(key)) continue;
    const { error } = await supabase
      .from('ai_decisions')
      .update({ status: 'EXPIRED' })
      .eq('id', prior.id)
      .eq('status', 'PROPOSED');
    if (!error) summary.expired += 1;
  }

  return summary;
}
