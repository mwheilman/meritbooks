/**
 * Financial Control Exception EC-14 — Out-of-policy employee expenses.
 *
 * The continuous-control complement to the deterministic expense-policy engine.
 * The engine (`lib/expenses/policy-engine.ts`) already annotates each expense-report
 * line with its policy violations AT SUBMISSION; this control is the "did an
 * out-of-policy expense get submitted, approved, or reimbursed anyway?" catch. It
 * re-evaluates SUBMITTED / APPROVED / REIMBURSED reports against the CURRENT active
 * compiled policy and surfaces any report that still trips a WARN/BLOCK rule into the
 * unified /exceptions queue -> /inbox, where a controller works — not just the
 * expense-detail page. It matters because:
 *   - the active policy can change AFTER a report was submitted (a tightened cap now
 *     makes an already-approved report out-of-policy),
 *   - a report can be approved / reimbursed DESPITE a hard-stop (BLOCK) violation
 *     (an override that a controller should see a second time), and
 *   - a reimbursed out-of-policy expense is money already out the door — the highest-
 *     value catch of all.
 *
 * DETERMINISTIC end-to-end: it reuses the PURE policy engine (`evaluateLinesWithRuleset`
 * -> `policy-engine.ts`) — no AI, no model, no clock in the scoring — so identical
 * input yields identical exceptions. It NEVER blocks the ledger, edits a report,
 * approves it, or reverses a reimbursement — it DETECTS the out-of-policy report,
 * quantifies the $ out of policy, and DRAFTS a review for a human (canon §3: the
 * heuristic proposes a fact; a human with the right role acts).
 *
 * Unit of exception: ONE report (a controller dispositions a whole report, not a
 * line). Each report carries a stable `dedup_key` (`expensepolicy:<report_id>`), so a
 * re-scan UPDATES the open exception rather than duplicating it (migration 070 makes
 * the DB the guarantor: one open PROPOSED row per (org, feature, dedup_key)), leaves
 * human-resolved (APPROVED/REJECTED) exceptions untouched, and EXPIRES exceptions
 * whose report no longer trips a rule (it was corrected or the policy loosened).
 *
 * The scoring (`assessExpensePolicy`, `resolveOutOfPolicyExpenseTier`) is I/O-free
 * and unit-tested. `scanOutOfPolicyExpenses` does the RLS-scoped reads/writes and
 * never throws — a control must not break the pass it rides on.
 *
 * All money is bigint cents. EC-14 is fundamentally a REVIEW control; it ESCALATEs
 * only when a hard-stop (BLOCK) violation was APPROVED / REIMBURSED anyway (the exact
 * control failure) or the out-of-policy dollars are very large.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, scoreToTier, type Tier, type TierPolicy } from '@/lib/trust/score-tier';
import {
  loadAutonomyGovernance,
  decideDisposition,
  type AutonomyGovernance,
} from '@/lib/autonomy/disposition';
import { formatMoney } from '@meritbooks/shared';
import { evaluateLinesWithRuleset, type PolicyLineInput } from '@/lib/expenses/policy';
import { loadActivePolicyRuleset } from '@/lib/expenses/policy-active';
import { DEFAULT_RULESET, type ExpensePolicyRuleset } from '@/lib/expenses/policy-schema';

export const OUT_OF_POLICY_EXPENSE_FEATURE = 'OUT_OF_POLICY_EXPENSE';

/** Report statuses this control scans — a policy breach here is a live control
 *  concern (pending approval, authorized, or already reimbursed). DRAFT is still
 *  being edited; REJECTED is already resolved. */
export const SCANNED_REPORT_STATUSES = ['SUBMITTED', 'APPROVED', 'REIMBURSED'] as const;

/** Statuses where the report is authorized or money has moved — a BLOCK here is the
 *  control-failure that escalates (a hard-stop rule was overridden). */
const AUTHORIZED_STATUSES = new Set(['APPROVED', 'REIMBURSED']);

// ── Tunable thresholds (single source of truth; kept here so they can't drift) ──
export const OUT_OF_POLICY_THRESHOLDS = {
  /** out-of-policy dollars at/above this ESCALATE even absent an authorized BLOCK. */
  escalateAtRiskCents: 5_000_000, // $50,000
  /** a report carrying a hard-stop (BLOCK) violation — near-certain exception. */
  blockConfidence: 0.95,
  /** a report carrying only advisory (WARN) violations. */
  warnConfidence: 0.85,
  /** how many reports to load per scan (most recent by created_at). */
  scanLimit: 2000,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a 0..1 confidence into the numeric(5,4) range the DB column accepts. */
export function toConfidence(score: number): number {
  const s = Number.isFinite(score) ? score : 0;
  return Math.max(0, Math.min(0.9999, Math.round(s * 10000) / 10000));
}

/** Stable dedup key — one open exception per report (idempotency contract). */
export function outOfPolicyDedupKey(reportId: string): string {
  return `expensepolicy:${reportId}`;
}

const num = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─────────────────────────────────────────────────────────────────────────────
// Pure assessment — one report's lines vs the active compiled ruleset
// ─────────────────────────────────────────────────────────────────────────────

export interface FlaggedExpenseLine {
  lineId: string;
  amountCents: number;
  merchant: string | null;
  /** WARN/BLOCK messages (INFO-only flags like weekend-dated are excluded). */
  messages: string[];
  hasBlock: boolean;
}

export interface OutOfPolicyAssessment {
  /** count of BLOCK-severity flags across the report. */
  blockCount: number;
  /** count of WARN-severity flags across the report. */
  warnCount: number;
  /** lines carrying at least one WARN/BLOCK flag. */
  flaggedLineCount: number;
  /** the out-of-policy dollars = Σ amount of every flagged (WARN/BLOCK) line. */
  amountAtRiskCents: number;
  /** the whole report total (for context in the reason). */
  reportTotalCents: number;
  confidence: number; // 0..1
  flaggedLines: FlaggedExpenseLine[];
}

/**
 * Evaluate one report's lines against a compiled ruleset and fold the per-line
 * violations into a single report-level assessment. Returns null when nothing trips
 * a WARN/BLOCK rule (INFO-only flags — e.g. weekend-dated — never raise a control
 * exception). PURE: delegates to the deterministic engine, no I/O, no clock.
 */
export function assessExpensePolicy(
  lines: PolicyLineInput[],
  ruleset: ExpensePolicyRuleset,
): OutOfPolicyAssessment | null {
  const result = evaluateLinesWithRuleset(lines, ruleset);
  const amountByLine = new Map(lines.map((l) => [l.id, l.amountCents]));
  const merchantByLine = new Map(lines.map((l) => [l.id, l.merchant]));

  const flaggedLines: FlaggedExpenseLine[] = [];
  let blockCount = 0;
  let warnCount = 0;

  for (const lr of result.lines) {
    // A control exception is raised only for enforceable (WARN/BLOCK) breaches;
    // INFO flags (weekend-dated) are advisory noise and are intentionally dropped.
    const enforceable = lr.flags.filter((f) => f.severity === 'block' || f.severity === 'warn');
    if (enforceable.length === 0) continue;

    let hasBlock = false;
    for (const f of enforceable) {
      if (f.severity === 'block') {
        blockCount += 1;
        hasBlock = true;
      } else {
        warnCount += 1;
      }
    }
    flaggedLines.push({
      lineId: lr.lineId,
      amountCents: num(amountByLine.get(lr.lineId)),
      merchant: merchantByLine.get(lr.lineId) ?? null,
      messages: enforceable.map((f) => f.message),
      hasBlock,
    });
  }

  if (flaggedLines.length === 0) return null;

  const amountAtRiskCents = flaggedLines.reduce((s, l) => s + Math.max(0, l.amountCents), 0);
  const reportTotalCents = lines.reduce((s, l) => s + Math.max(0, num(l.amountCents)), 0);
  const confidence =
    blockCount > 0 ? OUT_OF_POLICY_THRESHOLDS.blockConfidence : OUT_OF_POLICY_THRESHOLDS.warnConfidence;

  return {
    blockCount,
    warnCount,
    flaggedLineCount: flaggedLines.length,
    amountAtRiskCents,
    reportTotalCents,
    confidence,
    flaggedLines,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tiering — EC-14 is a REVIEW control. It ESCALATEs when a hard-stop (BLOCK) was
// APPROVED/REIMBURSED anyway (the control failure), or the out-of-policy dollars are
// very large. A control never auto-suppresses, so `auto` is floored up to `review`.
// ─────────────────────────────────────────────────────────────────────────────
export function resolveOutOfPolicyExpenseTier(
  assessment: Pick<OutOfPolicyAssessment, 'blockCount' | 'amountAtRiskCents' | 'confidence'>,
  status: string,
  policy: TierPolicy,
  escalateAtRiskCents: number = OUT_OF_POLICY_THRESHOLDS.escalateAtRiskCents,
): Tier {
  const authorized = AUTHORIZED_STATUSES.has(status);
  if (assessment.blockCount > 0 && authorized) return 'escalate';
  if (assessment.blockCount > 0 && assessment.amountAtRiskCents >= escalateAtRiskCents) return 'escalate';
  const { tier } = scoreToTier(
    { confidence: assessment.confidence, amountCents: assessment.amountAtRiskCents },
    policy,
  );
  return tier === 'auto' ? 'review' : tier; // a detection never auto-applies
}

// ─────────────────────────────────────────────────────────────────────────────
// Reason / title composition (pure — deterministic, no wall-clock)
// ─────────────────────────────────────────────────────────────────────────────

const STATUS_WORD: Record<string, string> = {
  SUBMITTED: 'submitted and pending approval',
  APPROVED: 'approved',
  REIMBURSED: 'reimbursed (money already paid to the employee)',
};

export function buildOutOfPolicyReason(
  assessment: OutOfPolicyAssessment,
  status: string,
  reportLabel: string,
): string {
  const statusWord = STATUS_WORD[status] ?? status.toLowerCase();
  const violationWord = assessment.blockCount > 0 ? 'hard-stop (BLOCK)' : 'advisory (WARN)';
  const head =
    `${reportLabel} is ${statusWord} but ${assessment.flaggedLineCount} line(s) — ${formatMoney(
      assessment.amountAtRiskCents,
    )} of ${formatMoney(assessment.reportTotalCents)} — violate the active expense policy ` +
    `(${assessment.blockCount} ${assessment.blockCount === 1 ? 'hard-stop' : 'hard-stops'}, ${assessment.warnCount} advisory).`;

  // Cite the top few offending lines so the reviewer sees the cause without drilling.
  const cited = assessment.flaggedLines
    .slice()
    .sort((a, b) => (b.hasBlock ? 1 : 0) - (a.hasBlock ? 1 : 0) || b.amountCents - a.amountCents)
    .slice(0, 3)
    .map((l) => {
      const who = l.merchant ? `${l.merchant} (${formatMoney(l.amountCents)})` : formatMoney(l.amountCents);
      return `${who}: ${l.messages.join('; ')}`;
    })
    .join(' · ');

  const tail =
    status === 'REIMBURSED'
      ? ' The report was reimbursed despite these violations — confirm the override was authorized, or recover the out-of-policy amount.'
      : AUTHORIZED_STATUSES.has(status) && assessment.blockCount > 0
        ? ' A hard-stop violation was approved anyway — confirm the override was authorized before it is reimbursed.'
        : ' Review before it is approved/reimbursed; record an override + reason if it is allowed, or send it back to the employee to correct.';

  return `${head} ${cited}${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan orchestration (I/O — RLS-scoped; never throws)
// ─────────────────────────────────────────────────────────────────────────────

export interface OutOfPolicyBucket {
  dedupKey: string;
  reportId: string;
  status: string;
  locationId: string | null;
  employeeId: string | null;
  assessment: OutOfPolicyAssessment;
  tier: Tier;
  title: string;
  reason: string;
  question: string;
}

export interface OutOfPolicyScanSummary {
  scanned: { reports: number; lines: number };
  detected: number; // reports with ≥1 WARN/BLOCK violation
  queued: number;
  refreshed: number;
  expired: number;
  byTier: Record<Tier, number>;
  totalAtRiskCents: number;
  policyActive: boolean; // did an active compiled policy drive the scan?
  errors: number;
  exceptions: Array<{
    reportId: string;
    status: string;
    blockCount: number;
    warnCount: number;
    amountAtRiskCents: number;
    tier: Tier;
    title: string;
  }>;
}

export interface OutOfPolicyScanOptions {
  /** cap the population loaded (default OUT_OF_POLICY_THRESHOLDS.scanLimit). */
  limit?: number;
  /** compute + return the exceptions WITHOUT persisting any rows. */
  dryRun?: boolean;
  /** inject a ruleset (tests) — otherwise the org's active compiled policy is loaded. */
  rulesetOverride?: ExpensePolicyRuleset;
}

interface ReportRow {
  id: string;
  title: string | null;
  status: string;
  employee_id: string | null;
  location_id: string | null;
}

interface LineRow {
  id: string;
  report_id: string;
  expense_date: string;
  merchant: string | null;
  account_id: string | null;
  amount_cents: number | string | null;
  has_receipt: boolean | null;
  payment_source: string | null;
}

/**
 * Scan the org's live (SUBMITTED / APPROVED / REIMBURSED) expense reports for
 * out-of-policy lines, queue / refresh them into /exceptions (PROPOSED ai_decisions,
 * feature 'OUT_OF_POLICY_EXPENSE'), and return a summary. Never throws. Reads/writes
 * run through the RLS-scoped client; org isolation is enforced by the database, never
 * by hand-filtering org_id. Deterministic: the same reports + policy yield the same
 * exceptions.
 */
export async function scanOutOfPolicyExpenses(
  supabase: SupabaseClient,
  orgId: string,
  opts: OutOfPolicyScanOptions = {},
): Promise<OutOfPolicyScanSummary> {
  const limit = opts.limit ?? OUT_OF_POLICY_THRESHOLDS.scanLimit;
  const summary: OutOfPolicyScanSummary = {
    scanned: { reports: 0, lines: 0 },
    detected: 0,
    queued: 0,
    refreshed: 0,
    expired: 0,
    byTier: { auto: 0, review: 0, escalate: 0 },
    totalAtRiskCents: 0,
    policyActive: false,
    errors: 0,
    exceptions: [],
  };

  let policy: TierPolicy;
  try {
    policy = await getTierPolicy(supabase, orgId);
  } catch {
    policy = { autoThreshold: 0.85, reviewThreshold: 0.7, autoMaxCents: 1_000_000 };
  }

  // Autonomy Control Plane: kill-switch + per-feature dial, resolved once; the
  // ADVISORY disposition is recorded on each queued exception (detect-only).
  const gov: AutonomyGovernance = await loadAutonomyGovernance(
    supabase,
    orgId,
    OUT_OF_POLICY_EXPENSE_FEATURE,
  );

  // The ruleset that governs enforcement: the org's ACTIVE compiled policy, else the
  // conservative DEFAULT_RULESET (degrade-safe — a missing policy never breaks scan).
  let ruleset: ExpensePolicyRuleset = opts.rulesetOverride ?? DEFAULT_RULESET;
  if (!opts.rulesetOverride) {
    try {
      const active = await loadActivePolicyRuleset(supabase, orgId);
      if (active) {
        ruleset = active.ruleset;
        summary.policyActive = true;
      }
    } catch {
      /* degrade to DEFAULT_RULESET */
    }
  } else {
    summary.policyActive = true;
  }

  // 1. Load the live report population.
  let reports: ReportRow[] = [];
  try {
    const { data, error } = await supabase
      .from('expense_reports')
      .select('id, title, status, employee_id, location_id')
      .in('status', SCANNED_REPORT_STATUSES as unknown as string[])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('[controls/out-of-policy-expense] report load failed:', error.message);
      summary.errors += 1;
      return summary;
    }
    reports = (data ?? []) as ReportRow[];
  } catch (e) {
    console.warn('[controls/out-of-policy-expense] report load threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
    return summary;
  }
  summary.scanned.reports = reports.length;
  if (reports.length === 0) return summary;

  const reportIds = reports.map((r) => r.id);

  // 2. Lines for those reports.
  const linesByReport = new Map<string, PolicyLineInput[]>();
  try {
    const { data, error } = await supabase
      .from('expense_report_lines')
      .select('id, report_id, expense_date, merchant, account_id, amount_cents, has_receipt, payment_source')
      .in('report_id', reportIds.slice(0, 5000));
    if (error) {
      console.warn('[controls/out-of-policy-expense] line load failed:', error.message);
      summary.errors += 1;
      return summary;
    }
    for (const l of (data ?? []) as LineRow[]) {
      const arr = linesByReport.get(l.report_id) ?? [];
      arr.push({
        id: l.id,
        expenseDate: l.expense_date,
        merchant: l.merchant,
        // Category key = GL account id (matches the live expense-report mapping).
        categoryKey: l.account_id,
        amountCents: num(l.amount_cents),
        hasReceipt: l.has_receipt === true,
        paymentSource: l.payment_source === 'CORPORATE_CARD' ? 'CORPORATE_CARD' : 'OUT_OF_POCKET',
      });
      linesByReport.set(l.report_id, arr);
      summary.scanned.lines += 1;
    }
  } catch (e) {
    console.warn('[controls/out-of-policy-expense] line load threw:', e instanceof Error ? e.message : e);
    summary.errors += 1;
    return summary;
  }

  // 3. Employee display names (best-effort — readable titles; core schema, stitched).
  const employeeNameById = new Map<string, string>();
  const employeeIds = Array.from(new Set(reports.map((r) => r.employee_id).filter((x): x is string => !!x)));
  if (employeeIds.length > 0) {
    try {
      const { data } = await supabase
        .schema('core')
        .from('employees')
        .select('id, first_name, last_name')
        .in('id', employeeIds);
      for (const e of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
        const name = `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim();
        if (name) employeeNameById.set(e.id, name);
      }
    } catch {
      /* best-effort — fall back to the report title / id below */
    }
  }

  // 4. Assess each report.
  const buckets: OutOfPolicyBucket[] = [];
  for (const r of reports) {
    const lines = linesByReport.get(r.id) ?? [];
    if (lines.length === 0) continue;

    const assessment = assessExpensePolicy(lines, ruleset);
    if (!assessment) continue;

    const employeeName = r.employee_id ? employeeNameById.get(r.employee_id) : undefined;
    const reportLabel = employeeName
      ? `${employeeName}'s expense report${r.title ? ` "${r.title}"` : ''}`
      : r.title
        ? `Expense report "${r.title}"`
        : 'This expense report';

    const tier = resolveOutOfPolicyExpenseTier(assessment, r.status, policy);
    const flagWord = assessment.blockCount > 0 ? 'hard-stop' : 'advisory';
    const title =
      `Out-of-policy expense (${flagWord}): ${employeeName ?? r.title ?? 'report'} · ` +
      `${assessment.flaggedLineCount} line(s) · ${formatMoney(assessment.amountAtRiskCents)} out of policy`;
    const reason = buildOutOfPolicyReason(assessment, r.status, reportLabel);
    const question =
      assessment.blockCount > 0
        ? 'Was the override of this hard-stop policy rule authorized — approve/reimburse with a recorded reason, or send the report back to the employee?'
        : 'Approve/reimburse this report despite the advisory policy flags (recording a reason), or send it back to the employee to correct?';

    buckets.push({
      dedupKey: outOfPolicyDedupKey(r.id),
      reportId: r.id,
      status: r.status,
      locationId: r.location_id,
      employeeId: r.employee_id,
      assessment,
      tier,
      title,
      reason,
      question,
    });
  }

  // Highest out-of-policy $ first.
  buckets.sort((a, b) => b.assessment.amountAtRiskCents - a.assessment.amountAtRiskCents);
  summary.detected = buckets.length;
  for (const b of buckets) {
    summary.totalAtRiskCents += b.assessment.amountAtRiskCents;
    summary.exceptions.push({
      reportId: b.reportId,
      status: b.status,
      blockCount: b.assessment.blockCount,
      warnCount: b.assessment.warnCount,
      amountAtRiskCents: b.assessment.amountAtRiskCents,
      tier: b.tier,
      title: b.title,
    });
  }

  if (opts.dryRun) return summary;

  // ── Idempotency: load existing OUT_OF_POLICY_EXPENSE rows keyed by dedup_key ──
  const existing = new Map<string, { id: string; status: string }>();
  try {
    const { data } = await supabase
      .from('ai_decisions')
      .select('id, status, proposed_output')
      .eq('feature', OUT_OF_POLICY_EXPENSE_FEATURE)
      .in('status', ['PROPOSED', 'APPROVED', 'REJECTED']);
    for (const row of data ?? []) {
      const rr = row as { id: string; status: string; proposed_output?: { dedup_key?: string } };
      const key = rr.proposed_output?.dedup_key;
      if (key) existing.set(key, { id: rr.id, status: rr.status });
    }
  } catch {
    /* best-effort — worst case we re-queue rather than refresh */
  }

  const liveKeys = new Set(buckets.map((b) => b.dedupKey));

  for (const b of buckets) {
    const a = b.assessment;
    const confidence = toConfidence(a.confidence);
    const { disposition } = decideDisposition({
      killSwitchEngaged: gov.killSwitchEngaged,
      setting: gov.setting,
      scoreTier: b.tier,
      amountCents: a.amountAtRiskCents,
    });
    const proposedOutput = {
      control: 'EC-14',
      dedup_key: b.dedupKey,
      report_id: b.reportId,
      report_status: b.status,
      block_count: a.blockCount,
      warn_count: a.warnCount,
      flagged_line_count: a.flaggedLineCount,
      amount_at_risk_cents: a.amountAtRiskCents,
      report_total_cents: a.reportTotalCents,
      money_already_out: b.status === 'REIMBURSED',
      tier: b.tier,
      disposition,
      subjects: { expense_report_id: b.reportId, employee_id: b.employeeId },
      flagged_lines: a.flaggedLines.map((l) => ({
        line_id: l.lineId,
        amount_cents: l.amountCents,
        merchant: l.merchant,
        has_block: l.hasBlock,
        messages: l.messages,
      })),
      reason: b.reason,
    };

    const prior = existing.get(b.dedupKey);
    if (prior && (prior.status === 'APPROVED' || prior.status === 'REJECTED')) continue; // human dispositioned

    if (prior && prior.status === 'PROPOSED') {
      const { error } = await supabase
        .from('ai_decisions')
        .update({
          input_summary: b.title,
          proposed_output: proposedOutput,
          confidence,
          reasoning: b.reason,
          clarifying_question: b.question,
        })
        .eq('id', prior.id);
      if (error) {
        console.warn('[controls/out-of-policy-expense] refresh failed:', error.message);
        summary.errors += 1;
        continue;
      }
      summary.refreshed += 1;
      summary.byTier[b.tier] += 1;
      continue;
    }

    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      location_id: b.locationId,
      feature: OUT_OF_POLICY_EXPENSE_FEATURE,
      input_summary: b.title,
      proposed_output: proposedOutput,
      confidence,
      reasoning: b.reason,
      clarifying_question: b.question,
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      // A concurrent scan may have won the unique index (migration 070) — not fatal.
      console.warn('[controls/out-of-policy-expense] could not queue exception:', error.message);
      summary.errors += 1;
      continue;
    }
    summary.queued += 1;
    summary.byTier[b.tier] += 1;

    // Trust audit trail — the detection, actor = AI (canon §3 / FPB D7).
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'controls.out_of_policy_expense.detect',
      subjectTable: 'expense_reports',
      subjectId: b.reportId,
      summary: b.title,
      locationId: b.locationId,
      confidence,
      tier: b.tier,
      metadata: {
        dedup_key: b.dedupKey,
        report_status: b.status,
        block_count: a.blockCount,
        warn_count: a.warnCount,
        amount_at_risk_cents: a.amountAtRiskCents,
      },
    });
  }

  // ── Expire previously-open exceptions no longer tripping (corrected / policy loosened) ──
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
