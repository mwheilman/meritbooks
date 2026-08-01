/**
 * AI Cash Application (GATE 8 — AI Capability Catalog).
 *
 * A continuous control that scans UNMATCHED incoming bank deposits and, for each,
 * PROPOSES the open customer invoice(s) it most likely settles — for a human to
 * approve. It NEVER applies the payment, creates a customer_payment, or posts GL:
 * it DETECTS and DRAFTS an application (canon §3 — AI proposes facts, the
 * deterministic engine does the accounting, a human approves; auto-post is OFF).
 *
 * How it reaches the queue WITHOUT touching the /exceptions aggregator: each
 * proposed application is written as a PROPOSED row in public.ai_decisions with
 * feature 'CASH_APPLICATION'. The existing /exceptions route already folds
 * PROPOSED ai_decisions in as an `ai_proposal` source (input_summary → title,
 * feature → subtitle, confidence → bar). This mirrors the EC-1 duplicate-payment
 * control exactly.
 *
 * Matching (see the pure scorers below):
 *   - Resolve the PAYER from the deposit description via name similarity to the
 *     customer master (many ACH/lockbox lines carry the payer name).
 *   - SINGLE-INVOICE: an open invoice whose balance equals the deposit (exact or
 *     near). An exact amount that ties to exactly ONE open invoice is near-certain.
 *   - SUM-TO-TOTAL: for a resolved customer, a subset of their open invoices whose
 *     balances sum EXACTLY to the deposit (a lump remittance across invoices).
 *
 * The composite scorer from reconciliation-match.ts is reused for the
 * vendor/amount/date breakdown + explanation; the cash-application confidence
 * model weights AMOUNT as the spine (an exact remittance is the dominating signal)
 * and refines it with payer resolution and date proximity.
 *
 * The pure functions (`scoreCashMatch`, `matchDeposit`, `subsetSumExact`,
 * `resolveCashAppTier`, `cashAppDedupKey`) are I/O-free and unit-tested. The
 * `scanCashApplication` orchestrator does the RLS-scoped reads/writes and is
 * idempotent: dedup_key `cashapp:<bank_txn_id>` means at most ONE open proposal
 * per deposit (migration 070's partial unique index is the DB guarantor), and an
 * already-resolved (APPROVED/REJECTED) proposal does not resurface.
 *
 * All money is bigint cents. Confidence is clamped into numeric(5,4).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  compositeMatchScore,
  vendorSimilarity,
  amountSimilarity,
} from '@/lib/services/reconciliation-match';
import { formatMoney } from '@meritbooks/shared';

export const CASHAPP_FEATURE = 'CASH_APPLICATION';

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const CASHAPP_THRESHOLDS = {
  /** amountSimilarity at/above which the deposit amount is treated as EXACT. */
  amountExactScore: 0.999,
  /** below this amountSimilarity an invoice is too far off to be a candidate. */
  amountCandidateMin: 0.5, // ≈ within 2.5% (amountSimilarity hits 0 at 5% rel diff)
  /** description→customer-name similarity at/above which the payer is "resolved". */
  customerResolveMin: 0.5,
  /** composite confidence below this is noise — never surfaced. */
  minSurface: 0.7,
  /** subset-sum guard: skip a customer with more open invoices than this. */
  maxSubsetInvoices: 15,
  /** subset-sum node budget — hard stop so a scan can never hang. */
  subsetNodeBudget: 20_000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface DepositInput {
  id: string;
  locationId: string | null;
  date: string; // ISO date (bank_transactions.transaction_date)
  amountCents: number; // > 0 (a credit / money-in)
  description: string | null;
}

export interface OpenInvoiceInput {
  id: string;
  customerId: string;
  invoiceNumber: string;
  invoiceDate: string; // ISO
  dueDate: string; // ISO
  balanceCents: number; // > 0
}

// ── small local helpers ─────────────────────────────────────────────────────

/** M/D from an ISO date, for plain-language reasons. Falls back to the raw string. */
function shortDate(iso: string | null | undefined): string {
  if (!iso) return 'unknown date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Deterministic, idempotent dedup key — one open proposal per deposit. */
export function cashAppDedupKey(bankTxnId: string): string {
  return `cashapp:${bankTxnId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence model. Pure.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Cash-application confidence for one deposit↔invoice(s) candidate. Reuses the
 * reconciliation composite scorer for the vendor/amount/date breakdown, then
 * applies a cash-application weighting where AMOUNT is the spine:
 *
 *   base = 0.50·amount + 0.35·payer + 0.15·date
 *   + 0.25  if the amount is EXACT and ties to a UNIQUE candidate (near-certain)
 *   ×0.75   if the amount is EXACT but AMBIGUOUS (several invoices share it)
 *
 * So an exact remittance to a single open invoice surfaces even when the bank
 * line is anonymous, while an exact amount that could be any of several invoices
 * is penalized until the payer resolves it.
 */
export interface CashMatchScore {
  confidence: number; // 0..1 (pre-clamp)
  amountScore: number; // 0..1
  customerScore: number; // 0..1 (composite "vendor" component vs customer name)
  dateScore: number; // 0..1
  amountExact: boolean;
  explanation: string;
}

export function scoreCashMatch(args: {
  deposit: DepositInput;
  matchedBalanceCents: number;
  customerName: string | null;
  representativeDate: string;
  uniqueExactAmount: boolean;
}): CashMatchScore {
  const T = CASHAPP_THRESHOLDS;
  const bd = compositeMatchScore({
    txnText: args.deposit.description,
    txnAmountCents: args.deposit.amountCents,
    txnDate: args.deposit.date,
    candidateText: args.customerName,
    candidateAmountCents: args.matchedBalanceCents,
    candidateDate: args.representativeDate,
  });

  const amountExact = bd.amountScore >= T.amountExactScore;
  let confidence = 0.5 * bd.amountScore + 0.35 * bd.vendorScore + 0.15 * bd.dateScore;
  if (amountExact && args.uniqueExactAmount) confidence += 0.25;
  else if (amountExact && !args.uniqueExactAmount) confidence *= 0.75;
  confidence = Math.max(0, Math.min(0.99, confidence));

  return {
    confidence,
    amountScore: bd.amountScore,
    customerScore: bd.vendorScore,
    dateScore: bd.dateScore,
    amountExact,
    explanation: bd.explanation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subset-sum (lump remittance). Pure, bounded.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Find one subset of `items` whose balances sum EXACTLY to `target` cents,
 * preferring the fewest items. Bounded: caps the item count and the search node
 * budget so a scan can never hang. Returns the chosen items, or null.
 */
export function subsetSumExact<T extends { balanceCents: number }>(
  items: T[],
  target: number,
  opts?: { maxItems?: number; nodeBudget?: number },
): T[] | null {
  const maxItems = opts?.maxItems ?? CASHAPP_THRESHOLDS.maxSubsetInvoices;
  const budget = opts?.nodeBudget ?? CASHAPP_THRESHOLDS.subsetNodeBudget;
  if (target <= 0) return null;

  // Only items that could participate; largest first so pruning bites early.
  const pool = items
    .filter((it) => it.balanceCents > 0 && it.balanceCents <= target)
    .sort((a, b) => b.balanceCents - a.balanceCents)
    .slice(0, maxItems);
  if (pool.length === 0) return null;

  // Suffix sums for a reachability prune.
  const suffix: number[] = new Array(pool.length + 1).fill(0);
  for (let i = pool.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + pool[i].balanceCents;

  let nodes = 0;
  let best: T[] | null = null;

  const dfs = (idx: number, remaining: number, chosen: T[]): void => {
    if (best) return; // first solution wins (fewest-items via ordering below)
    if (remaining === 0) {
      if (chosen.length >= 2) best = chosen.slice();
      return;
    }
    if (idx >= pool.length || remaining < 0) return;
    if (remaining > suffix[idx]) return; // cannot reach target with what's left
    if (++nodes > budget) return; // hard stop

    // Include first (drives toward fewer, larger items).
    chosen.push(pool[idx]);
    dfs(idx + 1, remaining - pool[idx].balanceCents, chosen);
    chosen.pop();
    if (best) return;
    // Exclude.
    dfs(idx + 1, remaining, chosen);
  };

  dfs(0, target, []);
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
// Match one deposit → best application. Pure.
// ─────────────────────────────────────────────────────────────────────────────

export type CashAppKind = 'single' | 'sum_to_total';

export interface CashAppMatch {
  kind: CashAppKind;
  invoiceIds: string[];
  customerId: string;
  customerName: string;
  matchedBalanceCents: number;
  representativeDate: string;
  score: CashMatchScore;
}

/**
 * Best application for one deposit. Considers a single open invoice (exact/near
 * amount) and — for a resolved payer — a lump remittance across several of that
 * customer's invoices. Returns null below the surfacing floor.
 */
export function matchDeposit(
  deposit: DepositInput,
  openInvoices: OpenInvoiceInput[],
  customerNameById: Map<string, string>,
): CashAppMatch | null {
  const T = CASHAPP_THRESHOLDS;
  if (deposit.amountCents <= 0) return null;

  // How many open invoices tie EXACTLY to this deposit amount (ambiguity signal).
  const exactCount = openInvoices.reduce(
    (n, inv) => n + (amountSimilarity(deposit.amountCents, inv.balanceCents) >= T.amountExactScore ? 1 : 0),
    0,
  );

  let best: CashAppMatch | null = null;
  const take = (m: CashAppMatch) => {
    if (
      !best ||
      m.score.confidence > best.score.confidence ||
      (m.score.confidence === best.score.confidence && m.kind === 'single' && best.kind !== 'single')
    ) {
      best = m;
    }
  };

  // ── SINGLE-INVOICE candidates ────────────────────────────────────────────
  for (const inv of openInvoices) {
    const amtScore = amountSimilarity(deposit.amountCents, inv.balanceCents);
    if (amtScore < T.amountCandidateMin) continue;
    const customerName = customerNameById.get(inv.customerId) ?? '';
    const representativeDate = inv.dueDate || inv.invoiceDate;
    const isExact = amtScore >= T.amountExactScore;
    const score = scoreCashMatch({
      deposit,
      matchedBalanceCents: inv.balanceCents,
      customerName: customerName || null,
      representativeDate,
      uniqueExactAmount: isExact && exactCount === 1,
    });
    take({
      kind: 'single',
      invoiceIds: [inv.id],
      customerId: inv.customerId,
      customerName: customerName || 'Unknown customer',
      matchedBalanceCents: inv.balanceCents,
      representativeDate,
      score,
    });
  }

  // ── SUM-TO-TOTAL candidates (resolved payer only) ─────────────────────────
  const byCustomer = new Map<string, OpenInvoiceInput[]>();
  for (const inv of openInvoices) {
    const arr = byCustomer.get(inv.customerId) ?? [];
    arr.push(inv);
    byCustomer.set(inv.customerId, arr);
  }
  for (const [customerId, group] of byCustomer) {
    if (group.length < 2 || group.length > T.maxSubsetInvoices) continue;
    const customerName = customerNameById.get(customerId) ?? '';
    const payerScore = vendorSimilarity(deposit.description, customerName);
    if (payerScore < T.customerResolveMin) continue; // only lump-apply a KNOWN payer

    const subset = subsetSumExact(group, deposit.amountCents);
    if (!subset || subset.length < 2) continue;

    // Nearest (soonest-due) invoice date represents the lump for date proximity.
    const representativeDate = subset
      .map((s) => s.dueDate || s.invoiceDate)
      .sort()[0];
    const score = scoreCashMatch({
      deposit,
      matchedBalanceCents: deposit.amountCents, // exact by construction
      customerName: customerName || null,
      representativeDate,
      uniqueExactAmount: true, // an exact tie-out to a resolved customer's invoices
    });
    take({
      kind: 'sum_to_total',
      invoiceIds: subset.map((s) => s.id),
      customerId,
      customerName: customerName || 'Unknown customer',
      matchedBalanceCents: deposit.amountCents,
      representativeDate,
      score,
    });
  }

  if (!best) return null;
  return (best as CashAppMatch).score.confidence >= T.minSurface ? best : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — a proposed application must always reach a human (auto-post OFF).
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Map a cash-application confidence + $ to a surfacing tier. Because auto-post is
 * OFF by canon (§3 — the AI never moves money), `auto` is floored up to `review`:
 * the machine only ever PROPOSES an application for a human to approve.
 */
export function resolveCashAppTier(
  confidence: number,
  amountCents: number,
  policy: TierPolicy,
): Tier {
  const { tier } = scoreToTier({ confidence, amountCents }, policy);
  return tier === 'auto' ? 'review' : tier;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reason text. Pure.
// ─────────────────────────────────────────────────────────────────────────────
export function cashAppReason(
  deposit: DepositInput,
  match: CashAppMatch,
  invoiceNumberById: Map<string, string>,
): string {
  const amt = formatMoney(deposit.amountCents);
  const when = shortDate(deposit.date);
  if (match.kind === 'single') {
    const inv = invoiceNumberById.get(match.invoiceIds[0]) ?? match.invoiceIds[0];
    return `Deposit ${amt} on ${when} matches ${inv} (balance ${formatMoney(match.matchedBalanceCents)}) for ${match.customerName}.`;
  }
  const nums = match.invoiceIds.map((id) => invoiceNumberById.get(id) ?? id).join(', ');
  return `Deposit ${amt} on ${when} matches ${match.invoiceIds.length} open invoices for ${match.customerName} (${nums}) totaling ${formatMoney(match.matchedBalanceCents)}.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O). Never throws — a control scan must not break its pass.
// ─────────────────────────────────────────────────────────────────────────────

export interface CashAppScanSummary {
  scanned: { deposits: number; invoices: number; customers: number };
  matched: number; // deposits with a surfacing match this pass (incl. already-queued)
  queued: number; // NEW proposals inserted (deduped)
  byKind: Record<CashAppKind, number>;
  byTier: Record<Tier, number>;
  errors: number;
}

const CLARIFYING_QUESTION =
  'Apply this deposit to the proposed invoice(s), or pick different invoices / leave it on account?';

export async function scanCashApplication(
  supabase: SupabaseClient,
  orgId: string,
): Promise<CashAppScanSummary> {
  const summary: CashAppScanSummary = {
    scanned: { deposits: 0, invoices: 0, customers: 0 },
    matched: 0,
    queued: 0,
    byKind: { single: 0, sum_to_total: 0 },
    byTier: { auto: 0, review: 0, escalate: 0 },
    errors: 0,
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // ── Load UNMATCHED deposits (money-in, not yet posted / matched to a bill/receipt) ──
  const { data: depositsRaw, error: depErr } = await supabase
    .from('bank_transactions')
    .select('id, location_id, transaction_date, amount_cents, description, status, gl_entry_id, matched_bill_id, matched_receipt_id')
    .gt('amount_cents', 0)
    .in('status', ['PENDING', 'CATEGORIZED'])
    .is('gl_entry_id', null)
    .is('matched_bill_id', null)
    .is('matched_receipt_id', null)
    .order('transaction_date', { ascending: false })
    .limit(2000);
  if (depErr) {
    console.warn('[controls/cashapp] deposits load failed:', depErr.message);
    return summary;
  }
  const deposits: DepositInput[] = ((depositsRaw ?? []) as Array<{
    id: string;
    location_id: string | null;
    transaction_date: string;
    amount_cents: number | string;
    description: string | null;
  }>).map((d) => ({
    id: d.id,
    locationId: d.location_id,
    date: d.transaction_date,
    amountCents: Number(d.amount_cents) || 0,
    description: d.description,
  }));
  summary.scanned.deposits = deposits.length;
  if (deposits.length === 0) return summary;

  // ── Load OPEN invoices (balance > 0) ──────────────────────────────────────
  const { data: invRaw, error: invErr } = await supabase
    .from('invoices')
    .select('id, customer_id, invoice_number, invoice_date, due_date, balance_cents, status')
    .in('status', ['SENT', 'PARTIALLY_PAID', 'OVERDUE'])
    .gt('balance_cents', 0)
    .limit(5000);
  if (invErr) {
    console.warn('[controls/cashapp] invoices load failed:', invErr.message);
    return summary;
  }
  const openInvoices: OpenInvoiceInput[] = ((invRaw ?? []) as Array<{
    id: string;
    customer_id: string;
    invoice_number: string;
    invoice_date: string;
    due_date: string;
    balance_cents: number | string;
  }>).map((i) => ({
    id: i.id,
    customerId: i.customer_id,
    invoiceNumber: i.invoice_number,
    invoiceDate: i.invoice_date,
    dueDate: i.due_date,
    balanceCents: Number(i.balance_cents) || 0,
  }));
  summary.scanned.invoices = openInvoices.length;
  if (openInvoices.length === 0) return summary;

  const invoiceNumberById = new Map<string, string>();
  for (const i of openInvoices) invoiceNumberById.set(i.id, i.invoiceNumber);

  // ── Load customer masters (core schema; PostgREST can't embed core from public) ──
  const customerIds = Array.from(new Set(openInvoices.map((i) => i.customerId)));
  const customerNameById = new Map<string, string>();
  for (let i = 0; i < customerIds.length; i += 500) {
    const slice = customerIds.slice(i, i + 500);
    const { data: custRaw } = await supabase
      .schema('core')
      .from('customers')
      .select('id, name')
      .in('id', slice);
    for (const c of (custRaw ?? []) as Array<{ id: string; name: string }>) {
      customerNameById.set(c.id, c.name);
    }
  }
  summary.scanned.customers = customerNameById.size;

  // ── Match each deposit → best application ─────────────────────────────────
  const proposals: Array<{ deposit: DepositInput; match: CashAppMatch }> = [];
  for (const deposit of deposits) {
    const match = matchDeposit(deposit, openInvoices, customerNameById);
    if (match) proposals.push({ deposit, match });
  }
  summary.matched = proposals.length;
  if (proposals.length === 0) return summary;

  // ── Idempotency: skip any dedup_key already open OR already resolved ───────
  const existingKeys = new Set<string>();
  try {
    const { data: existing } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', CASHAPP_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of existing ?? []) {
      const po = (row as { proposed_output?: { dedup_key?: string } }).proposed_output;
      if (po?.dedup_key) existingKeys.add(po.dedup_key);
    }
  } catch {
    /* best-effort — the DB partial unique index (migration 070) is the backstop */
  }

  // ── Insert new proposals + write the AI audit trail ───────────────────────
  for (const { deposit, match } of proposals) {
    const dedupKey = cashAppDedupKey(deposit.id);
    if (existingKeys.has(dedupKey)) continue;

    const tier = resolveCashAppTier(match.score.confidence, deposit.amountCents, policy);
    const confidence = toConfidence(match.score.confidence);
    const reason = cashAppReason(deposit, match, invoiceNumberById);
    const title = `Cash application: ${formatMoney(deposit.amountCents)} → ${
      match.kind === 'single' ? invoiceNumberById.get(match.invoiceIds[0]) ?? '1 invoice' : `${match.invoiceIds.length} invoices`
    } · ${match.customerName}`;

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: deposit.locationId,
      feature: CASHAPP_FEATURE,
      input_summary: title,
      proposed_output: {
        control: 'CASH_APP',
        kind: match.kind,
        dedup_key: dedupKey,
        bank_transaction_id: deposit.id,
        customer_id: match.customerId,
        invoice_ids: match.invoiceIds,
        deposit_amount_cents: deposit.amountCents,
        applied_amount_cents: match.matchedBalanceCents,
        tier,
        breakdown: {
          amount: match.score.amountScore,
          customer: match.score.customerScore,
          date: match.score.dateScore,
        },
        // Explicit safety marker: this proposal moves NO money on its own.
        action: 'PROPOSE_ONLY',
        subjects: {
          bank_transaction_id: deposit.id,
          invoice_ids: match.invoiceIds,
          customer_id: match.customerId,
        },
        reason,
      },
      confidence,
      reasoning: reason,
      clarifying_question: CLARIFYING_QUESTION,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[controls/cashapp] could not queue proposal:', error.message);
      summary.errors += 1;
      continue;
    }
    existingKeys.add(dedupKey);
    summary.queued += 1;
    summary.byKind[match.kind] += 1;
    summary.byTier[tier] += 1;

    // Trust audit trail — the AI's detection, actor = AI (canon §3).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.cash_application.propose',
      subjectTable: 'bank_transactions',
      subjectId: deposit.id,
      summary: title,
      locationId: deposit.locationId,
      confidence,
      tier,
      metadata: {
        kind: match.kind,
        dedup_key: dedupKey,
        customer_id: match.customerId,
        invoice_ids: match.invoiceIds,
        applied_amount_cents: match.matchedBalanceCents,
      },
    });
  }

  return summary;
}
