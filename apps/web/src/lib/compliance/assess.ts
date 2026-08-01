/**
 * Vendor-compliance AI assessment + escalation (I/O).
 *
 * Runs the pure risk engine over every tracked vendor, records the AI's judgment
 * on the trust audit trail (core.action_log, actor = AI), and — for the vendors
 * the engine escalates (a human MUST act) — tees up a PROPOSED ai_decisions row.
 * That row is picked up automatically by the unified /exceptions queue as an
 * `ai_proposal` source and is dismissable through the existing resolve route, so
 * high-risk compliance items land in front of a human without any new plumbing.
 *
 * Idempotent: a vendor that already has an open (PROPOSED) compliance-risk
 * proposal is not queued again, so this is safe to run on every maintenance pass.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logAction } from '@/lib/trust/action-log';
import { getTierPolicy, type TierPolicy } from '@/lib/trust/score-tier';
import { getVendorComplianceOverview, type VendorComplianceOverview } from '@/lib/services/vendor-compliance';
import { assessVendorRisk, type RiskAssessment } from '@/lib/compliance/risk';

const RISK_FEATURE = 'VENDOR_COMPLIANCE_RISK';

export interface AssessResult {
  assessed: number; // vendors run through the risk engine
  escalated: number; // vendors the engine flagged as escalate + on hold
  queued: number; // NEW exception-queue items created (deduped)
}

/**
 * Assess every tracked vendor, log the AI judgments, and escalate on-hold /
 * high-risk vendors into the exception queue. Never throws — assessment must not
 * break the maintenance pass it rides on.
 */
export async function assessAndEscalate(
  supabase: SupabaseClient,
  orgId: string,
): Promise<AssessResult> {
  const result: AssessResult = { assessed: 0, escalated: 0, queued: 0 };

  let overview: VendorComplianceOverview;
  let policy: TierPolicy;
  try {
    [overview, policy] = await Promise.all([
      getVendorComplianceOverview(supabase, orgId),
      getTierPolicy(supabase, orgId),
    ]);
  } catch (e) {
    console.warn('[compliance/assess] skipped — overview/policy load failed:', e);
    return result;
  }

  // Which vendors already have an open compliance-risk proposal (dedupe).
  const alreadyQueued = new Set<string>();
  try {
    const { data: open } = await supabase
      .from('ai_decisions')
      .select('proposed_output')
      .eq('feature', RISK_FEATURE)
      .eq('status', 'PROPOSED');
    for (const row of open ?? []) {
      const po = (row as { proposed_output?: { vendor_id?: string } }).proposed_output;
      if (po?.vendor_id) alreadyQueued.add(po.vendor_id);
    }
  } catch {
    /* dedupe is best-effort; worst case we skip queueing below on insert */
  }

  for (const row of overview.rows) {
    const risk: RiskAssessment = assessVendorRisk(
      {
        docs: row.docs.map((d) => ({ doc_type: d.doc_type, state: d.state })),
        onHold: row.onHold,
        hasActiveOverride: !!row.activeOverride,
        openBillsCents: row.openBillsCents,
      },
      policy,
    );
    result.assessed++;

    // 1. Trust audit trail — the AI's assessment, every vendor, every run.
    await logAction(supabase, {
      orgId,
      actorType: 'AI',
      actorUserId: null,
      action: 'vendor_compliance.risk_assessment',
      subjectTable: 'vendors',
      subjectId: row.vendorId,
      summary: `${row.vendorName}: ${risk.priority.toUpperCase()} risk — ${risk.reason}`,
      confidence: risk.confidence,
      tier: risk.tier,
      metadata: {
        priority: risk.priority,
        score: risk.score,
        worstState: risk.worstState,
        onHold: row.onHold,
        openBillsCents: row.openBillsCents,
        chaseRecommended: risk.chaseRecommended,
      },
    });

    // 2. Escalate: a human must act. Blocked payment + escalate tier ⇒ exception.
    if (risk.tier !== 'escalate' || !row.onHold) continue;
    result.escalated++;
    if (alreadyQueued.has(row.vendorId)) continue;

    const issueText = row.issues.map((i) => `${i.label} ${i.state}`).join(', ') || 'compliance issue';
    const { error } = await supabase.from('ai_decisions').insert({
      org_id: orgId,
      feature: RISK_FEATURE,
      input_summary: `${row.vendorName} on payment hold — ${issueText}`,
      proposed_output: {
        vendor_id: row.vendorId,
        vendor_name: row.vendorName,
        action: 'chase_and_hold',
        issues: row.issues,
        open_bills_cents: row.openBillsCents,
        priority: risk.priority,
      },
      confidence: Number(risk.confidence.toFixed(4)),
      reasoning: risk.reason,
      clarifying_question: 'Chase the vendor for the outstanding document, or grant a payment-hold override?',
      status: 'PROPOSED',
      created_by_user: null,
    });
    if (error) {
      console.warn('[compliance/assess] could not queue exception:', error.message);
      continue;
    }
    alreadyQueued.add(row.vendorId);
    result.queued++;
  }

  return result;
}
