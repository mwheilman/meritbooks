/**
 * Jobs / WIP import — commit helpers (impure: Supabase writes only).
 *
 * Commit does two deterministic things and NOTHING that hits the GL:
 *   1. create the OPEN job records in `core.jobs` (reusing the canonical job model —
 *      no parallel table), seeding the opening actuals/billed/retainage/EAC; and
 *   2. stage the computed opening WIP totals into the tenant's conversion session
 *      (`ai_decisions.proposed_output.subledgerDetail`) so the extended tie-out fires
 *      (Σ costs = WIP, Σ unbilled = 1180, Σ billings-in-excess = 2410) and the
 *      reconciliation WIP section lights up.
 *
 * It does NOT post a recognition entry — onboarding sets the OPENING POSITION only
 * (per docs/REV-REC-WIP-SPEC.md §3, recognition is the propose-and-approve close).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ImportedSubledgerDetail, ConversionSessionData } from '@/lib/onboarding/conversion';
import { loadSession, saveSessionData } from '@/lib/onboarding/session';
import type { JobCostType, ProposedCostCode, ProposedJob } from './types';
import { effectiveContractCents } from './normalize';

/** Roll cost-code budgets into the four core.jobs budget buckets. */
export function budgetBuckets(costCodes: ProposedCostCode[]): Record<'labor' | 'materials' | 'subcontractor' | 'other', number> {
  const out = { labor: 0, materials: 0, subcontractor: 0, other: 0 };
  for (const c of costCodes) {
    const t: JobCostType = c.costType ?? 'OTHER';
    if (t === 'LABOR') out.labor += c.budgetCents;
    else if (t === 'MATERIALS') out.materials += c.budgetCents;
    else if (t === 'SUBCONTRACTOR') out.subcontractor += c.budgetCents;
    else out.other += c.budgetCents; // EQUIPMENT + OTHER both land in "other"
  }
  return out;
}

export interface CreateJobsResult {
  createdJobNumbers: string[];
  errors: { jobNumber: string; message: string }[];
}

/**
 * Create the imported open jobs in core.jobs. `revRecMethod` is the company's method
 * (a %-completion method for the WIP lane). Idempotent-ish: a duplicate job number
 * (unique(org,location,job_number)) is reported, not fatal, so a re-run is safe.
 */
export async function createOpeningJobs(
  supabase: SupabaseClient,
  orgId: string,
  args: { locationId: string; jobs: ProposedJob[]; revRecMethod: string; userId?: string | null },
): Promise<CreateJobsResult> {
  const createdJobNumbers: string[] = [];
  const errors: { jobNumber: string; message: string }[] = [];

  for (const j of args.jobs) {
    const contract = effectiveContractCents(j);
    const buckets = budgetBuckets(j.costCodes);
    const pct = j.pctCompleteOverride != null ? Math.round(j.pctCompleteOverride * 10000) / 100 : null;

    const { error } = await supabase
      .schema('core')
      .from('jobs')
      .insert({
        org_id: orgId,
        location_id: args.locationId,
        job_number: j.jobNumber,
        name: j.jobName,
        customer_name: j.customerName ?? null,
        job_type: j.jobType ?? 'CONSTRUCTION',
        status: 'ACTIVE',
        pricing_model: 'FIXED_PRICE',
        contract_amount_cents: contract ?? null,
        original_contract_cents: j.originalContractCents ?? contract ?? null,
        approved_co_cents: j.approvedChangeOrdersCents ?? null,
        estimated_cost_cents: j.estimatedCostCents ?? null,
        budget_labor_cents: buckets.labor,
        budget_materials_cents: buckets.materials,
        budget_subcontractor_cents: buckets.subcontractor,
        budget_other_cents: buckets.other,
        actual_cost_cents: j.costsToDateCents ?? 0,
        billed_to_date_cents: j.billedToDateCents ?? 0,
        retainage_held_cents: j.retainageReceivableCents ?? 0,
        rev_rec_method: args.revRecMethod,
        pct_complete: pct,
        external_source: 'ONBOARDING_WIP_IMPORT',
      })
      .select('id')
      .single();

    if (error) {
      errors.push({ jobNumber: j.jobNumber, message: error.code === '23505' ? 'A job with this number already exists' : error.message });
      continue;
    }
    createdJobNumbers.push(j.jobNumber);
  }

  return { createdJobNumbers, errors };
}

/**
 * Merge the opening WIP totals into a conversion session's `subledgerDetail` (never
 * clobbering AR/AP detail already staged there) and persist. Returns false when the
 * session is missing or already posted (can't retro-stage a posted opening entry).
 */
export async function attachWipSubledgerDetail(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string,
  wipDetail: ImportedSubledgerDetail,
): Promise<{ ok: boolean; reason?: string }> {
  const session = await loadSession(supabase, orgId, sessionId);
  if (!session) return { ok: false, reason: 'Conversion session not found' };
  if (session.postedGlEntryId) return { ok: false, reason: 'Opening entry already posted — reopen the conversion to restage WIP' };

  const merged: ConversionSessionData = {
    ...session.data,
    subledgerDetail: { ...(session.data.subledgerDetail ?? {}), ...wipDetail },
    // A restaged subledger must be re-tied before go-live.
    tiedOut: false,
    tiedOutBy: null,
    tiedOutAt: null,
  };
  await saveSessionData(supabase, orgId, sessionId, merged);
  return { ok: true };
}
