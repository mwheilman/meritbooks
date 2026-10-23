/**
 * The autonomy gate every GL-posting scheduled job goes through (IA R14, canon §3:
 * "writes are proposals unless the autonomy dial allows").
 *
 * The scheduled engines (rev-rec run, prepaid amortization, event drains) are
 * deterministic — there is no AI confidence to score — so the gate treats the
 * engine as the `auto` confidence tier and lets the TENANT'S GOVERNANCE decide:
 *
 *   kill switch engaged          → BLOCKED  (never posts)
 *   dial OFF                     → BLOCKED
 *   dial PROPOSE (the default)   → REVIEW   (job computes a preview only)
 *   dial AUTO_UNDER_LIMIT        → AUTO only when a materiality cap is set AND the
 *                                  total the run would post is known and ≤ the cap.
 *
 * It reuses the M10 helpers verbatim (loadAutonomyGovernance → decideDisposition),
 * which DEGRADE SAFE: any read error resolves to PROPOSE, i.e. never posts.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decideDisposition,
  loadAutonomyGovernance,
  DEFAULT_MODE,
  type AutonomyMode,
  type Disposition,
} from '@/lib/autonomy/disposition';

/** Autonomy feature keys owned by the scheduler (registered in lib/autonomy/catalog.ts). */
export const SCHEDULED_REV_REC_FEATURE = 'SCHEDULED_REV_REC';
export const SCHEDULED_PREPAID_FEATURE = 'SCHEDULED_PREPAID_AMORTIZATION';
export const SCHEDULED_EVENT_DRAIN_FEATURE = 'SCHEDULED_EVENT_DRAIN';
export const SCHEDULED_RECURRING_INVOICES_FEATURE = 'SCHEDULED_RECURRING_INVOICES';
export const SCHEDULED_DEPRECIATION_FEATURE = 'SCHEDULED_DEPRECIATION';
export const SCHEDULED_INSURANCE_FEATURE = 'SCHEDULED_INSURANCE_AMORTIZATION';
/** Not a GL post: gates whether a dunning reminder SENDS on its own or waits for a person. */
export const SCHEDULED_DUNNING_FEATURE = 'SCHEDULED_DUNNING_SEND';

export interface PostingGateResult {
  allowed: boolean;
  disposition: Disposition;
  mode: AutonomyMode;
  reason: string;
}

export async function postingGate(
  db: SupabaseClient,
  orgId: string,
  feature: string,
  amountCents: number | null,
): Promise<PostingGateResult> {
  const gov = await loadAutonomyGovernance(db, orgId, feature);
  const decision = decideDisposition({
    killSwitchEngaged: gov.killSwitchEngaged,
    setting: gov.setting,
    scoreTier: 'auto',
    amountCents,
  });
  return {
    allowed: decision.disposition === 'AUTO',
    disposition: decision.disposition,
    mode: gov.setting?.mode ?? DEFAULT_MODE,
    reason: decision.reason,
  };
}
