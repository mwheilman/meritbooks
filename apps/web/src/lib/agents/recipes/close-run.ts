/**
 * CLOSE-RUN recipe (M9) — the supervised month-end close loop.
 *
 * Drives the EXISTING close orchestration graph (lib/close/*) and the recurring-JE
 * propose/approve queue (lib/recurring-je/*), pausing at the human gates and NEVER
 * forcing a close:
 *
 *   1. verify_auto        (AUTO)       Load live signals and evaluate the close task
 *                                      graph (lib/close/readiness → orchestration). This
 *                                      AUTO-verifies each ready task from the ledger
 *                                      (bank feeds coded, recs tied, AR/AP subledger
 *                                      ties, leakage cleared). Pure read — it INFORMS,
 *                                      it never blocks or closes.
 *   2. propose_adjustments (PROPOSE)   Generate the period's due recurring / accrual
 *                                      journal entries via the EXISTING propose path
 *                                      (recurring-je/store.generateDue) — which stores
 *                                      them as PROPOSED runs and NEVER posts. Scoped to
 *                                      this entity + period. (Depreciation is posted via
 *                                      its own fixed-asset run and attested as the
 *                                      manual `depreciation_posted` close task; this step
 *                                      never posts it.)
 *   3. post_adjustments   (HUMAN_GATE) ALWAYS pauses. On APPROVE the EXISTING gated
 *                                      poster (recurring-je/store.approveRun) posts each
 *                                      proposed run through the deterministic JE engine
 *                                      (balanced DR/CR). The runner never posts on its own.
 *   4. hard_close         (HUMAN_GATE) Observe-only. It reports the EXISTING blocking
 *                                      hard-close gate (lib/close/readiness →
 *                                      evaluateHardCloseGate) and waits for a human to
 *                                      perform the hard close in the Close Command Center
 *                                      (which runs that same gate, with SoD + audited
 *                                      overrides). The runner only OBSERVES the period
 *                                      reach HARD_CLOSE — it never flips the period, so it
 *                                      can never force a close.
 *
 * SAFETY (canon §3/§4): no step posts money or hits the GL without a human gate, and the
 * period is never hard-closed by the agent. The only ledger effect — posting the proposed
 * adjustments — flows through the pre-existing deterministic engine after a human APPROVES.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import type { AgentRecipe, AgentRunContext, AgentState, StepExecuteResult } from '../types';
import { gatherHardCloseGate } from '@/lib/close/readiness';
import { generateDue, listProposedRuns, approveRun } from '@/lib/recurring-je/store';

const CLOSE_FEATURE = 'CLOSE';

/** Last calendar day of `year`-`month` (1-based month) as ISO yyyy-mm-dd. */
function periodEndIso(year: number, month: number): string {
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

interface PeriodRow {
  id: string;
  status: string;
}

async function loadPeriod(
  supabase: SupabaseClient,
  locationId: string,
  year: number,
  month: number,
): Promise<PeriodRow | null> {
  const { data } = await supabase
    .from('fiscal_periods')
    .select('id, status')
    .eq('location_id', locationId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle();
  return (data as PeriodRow | null) ?? null;
}

async function loadLocationName(supabase: SupabaseClient, locationId: string): Promise<string> {
  const { data } = await supabase
    .schema('core')
    .from('locations')
    .select('name, short_code')
    .eq('id', locationId)
    .maybeSingle();
  const l = data as { name: string; short_code: string | null } | null;
  return l?.name ?? l?.short_code ?? 'entity';
}

/** Proposed recurring-JE runs for this period, scoped to the entity's templates. */
async function proposedRunsForPeriod(
  supabase: SupabaseClient,
  locationId: string,
  year: number,
  month: number,
): Promise<Array<{ id: string; name: string; amountCents: number }>> {
  const periodKey = `${year}-${String(month).padStart(2, '0')}`;
  const all = await listProposedRuns(supabase);
  const inPeriod = all.filter((r) => r.period === periodKey);
  if (inPeriod.length === 0) return [];

  // Scope to this entity: keep runs whose template belongs to this location (or is
  // location-agnostic). Template location is not on the run row, so resolve it.
  const templateIds = Array.from(new Set(inPeriod.map((r) => r.template_id)));
  const locByTemplate = new Map<string, string | null>();
  try {
    const { data } = await supabase
      .from('recurring_je_templates')
      .select('id, location_id')
      .in('id', templateIds);
    for (const t of (data ?? []) as Array<{ id: string; location_id: string | null }>) {
      locByTemplate.set(t.id, t.location_id ?? null);
    }
  } catch {
    /* if the lookup fails, fall back to period-only scope below */
  }

  return inPeriod
    .filter((r) => {
      const loc = locByTemplate.get(r.template_id);
      return loc === undefined || loc === null || loc === locationId;
    })
    .map((r) => ({ id: r.id, name: r.template_name, amountCents: r.amount_cents }));
}

export const closeRunRecipe: AgentRecipe = {
  key: 'CLOSE_RUN',
  label: 'Month-End Close',
  description:
    'Drives an entity/period through the existing close orchestration: auto-verifies the ready close tasks from the ledger, proposes the due recurring/accrual entries, pauses for a human to approve posting them, then waits for the human to hard-close through the existing blocking gate. The agent never forces a close.',
  feature: CLOSE_FEATURE,

  async init(ctx, input) {
    const locationId = typeof input.location_id === 'string' ? input.location_id.trim() : typeof input.locationId === 'string' ? input.locationId.trim() : '';
    const year = Number(input.year ?? input.period_year);
    const month = Number(input.month ?? input.period_month);
    if (!locationId) return { error: 'A location_id is required to run a close.' };
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      return { error: 'A valid year and month (1-12) are required to run a close.' };
    }

    const period = await loadPeriod(ctx.supabase, locationId, year, month);
    if (!period) return { error: `No fiscal period found for ${year}-${String(month).padStart(2, '0')} at this entity.` };
    if (period.status === 'HARD_CLOSE') {
      return { error: `${year}-${String(month).padStart(2, '0')} is already hard-closed — nothing to do.` };
    }

    const name = await loadLocationName(ctx.supabase, locationId);
    const state: AgentState = {
      locationId,
      year,
      month,
      fiscalPeriodId: period.id,
      periodStatus: period.status,
      locationName: name,
    };
    return {
      title: `Close · ${name} · ${year}-${String(month).padStart(2, '0')}`,
      state,
      subject: { table: 'fiscal_periods', id: period.id },
    };
  },

  steps: [
    // ── 1. Auto-verify the close tasks from the ledger (AUTO) ──────────────────
    {
      name: 'verify_auto',
      label: 'Auto-verify close tasks',
      kind: 'AUTO',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const locationId = String(state.locationId ?? '');
        const fiscalPeriodId = String(state.fiscalPeriodId ?? '');
        const bundle = await gatherHardCloseGate(ctx.supabase, ctx.orgId, { locationId, fiscalPeriodId });
        const { evaluation } = bundle;

        const blockers = evaluation.blockers.map((b) => ({ key: b.key, label: b.label, reason: b.reason }));
        const summary =
          blockers.length === 0
            ? `Auto-verified: ${evaluation.autoPass}/${evaluation.autoTotal} auto checks tie; no blocking tasks failing (${evaluation.percentComplete}% complete).`
            : `Auto-verified: ${evaluation.autoPass}/${evaluation.autoTotal} auto checks tie; ${blockers.length} blocking task(s) still open: ${blockers.map((b) => b.label).join(', ')}.`;

        return {
          status: 'DONE',
          summary,
          statePatch: {
            autoPass: evaluation.autoPass,
            autoTotal: evaluation.autoTotal,
            readyToHardClose: evaluation.readyToHardClose,
          },
          output: {
            autoPass: evaluation.autoPass,
            autoTotal: evaluation.autoTotal,
            manualDone: evaluation.manualDone,
            manualTotal: evaluation.manualTotal,
            percentComplete: evaluation.percentComplete,
            readyToHardClose: evaluation.readyToHardClose,
            blockers,
          },
        };
      },
    },

    // ── 2. Propose the due recurring / accrual entries (PROPOSE) ───────────────
    {
      name: 'propose_adjustments',
      label: 'Propose recurring / accrual entries',
      kind: 'PROPOSE',
      feature: CLOSE_FEATURE,
      async execute(ctx, state): Promise<StepExecuteResult> {
        const locationId = String(state.locationId ?? '');
        const year = Number(state.year);
        const month = Number(state.month);
        const asOf = periodEndIso(year, month);

        // Generate PROPOSED runs (never posts) for every template due on/before the
        // period end. Idempotent — re-running does not double-propose.
        let newlyProposed = 0;
        try {
          const gen = await generateDue(ctx.supabase, ctx.orgId, { asOf });
          newlyProposed = gen.proposed.length;
        } catch (e) {
          return {
            status: 'DONE',
            summary: `Could not generate recurring proposals (${e instanceof Error ? e.message : 'error'}). Continuing — any existing proposals can still be reviewed.`,
          };
        }

        const runs = await proposedRunsForPeriod(ctx.supabase, locationId, year, month);
        const totalCents = runs.reduce((s, r) => s + r.amountCents, 0);

        return {
          status: 'DONE',
          summary:
            runs.length === 0
              ? 'No recurring/accrual entries are due to propose for this period.'
              : `Proposed ${runs.length} recurring/accrual entr${runs.length === 1 ? 'y' : 'ies'} (${formatMoney(totalCents)}) for this period — ${newlyProposed} newly generated. None posted.`,
          statePatch: { proposedRunIds: runs.map((r) => r.id) },
          output: { proposed: runs.length, newlyProposed, totalCents, runs },
        };
      },
    },

    // ── 3. Post the proposed adjustments (HUMAN_GATE) ──────────────────────────
    {
      name: 'post_adjustments',
      label: 'Approve & post adjustments',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const ids = (state.proposedRunIds as string[] | undefined) ?? [];
        if (ids.length === 0) {
          return { status: 'DONE', summary: 'No proposed adjustments to post — skipping.' };
        }
        return {
          status: 'WAITING',
          summary: `Awaiting approval to post ${ids.length} proposed adjustment(s).`,
          gatePrompt: `Approve to post ${ids.length} proposed recurring/accrual entr${ids.length === 1 ? 'y' : 'ies'} through the deterministic JE engine (each re-validated to balance). Reject to leave them proposed for later. The agent never posts on your behalf.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        const ids = (state.proposedRunIds as string[] | undefined) ?? [];
        const entryIds: string[] = [];
        const errors: Array<{ runId: string; error: string }> = [];
        for (const runId of ids) {
          const res = await approveRun(ctx.supabase, ctx.orgId, runId);
          if (res.success && res.entry_id) entryIds.push(res.entry_id);
          else errors.push({ runId, error: res.error ?? 'post failed' });
        }
        const summary =
          errors.length === 0
            ? `Reviewer approved — posted ${entryIds.length} adjustment(s) via the deterministic JE engine.`
            : `Posted ${entryIds.length} adjustment(s); ${errors.length} could not post (${errors.map((e) => e.error).join('; ')}).`;
        return {
          status: 'DONE',
          summary,
          statePatch: { postedEntryIds: entryIds },
          output: { postedCount: entryIds.length, entryIds, errors },
        };
      },
    },

    // ── 4. Hard close — observe-only human gate (HUMAN_GATE) ───────────────────
    {
      name: 'hard_close',
      label: 'Hard-close the period',
      kind: 'HUMAN_GATE',
      async execute(ctx, state): Promise<StepExecuteResult> {
        const locationId = String(state.locationId ?? '');
        const fiscalPeriodId = String(state.fiscalPeriodId ?? '');
        const label = `${state.year}-${String(Number(state.month)).padStart(2, '0')}`;
        const bundle = await gatherHardCloseGate(ctx.supabase, ctx.orgId, { locationId, fiscalPeriodId });

        if (bundle.gate.pass) {
          return {
            status: 'WAITING',
            summary: `All blocking close tasks pass for ${label}. Ready to hard-close.`,
            gatePrompt: `Every blocking close task passes for ${label}. Hard-close the period in the Close Command Center (which runs the same blocking gate, with separation of duties and audited overrides), then continue. The agent will only proceed once it observes the period reach HARD_CLOSE — it never closes the period for you.`,
          };
        }

        const blockers = bundle.gate.blockers.map((b) => b.label).join(', ');
        return {
          status: 'WAITING',
          summary: `${bundle.gate.blockers.length} blocking task(s) still failing — the period is not clean to close.`,
          gatePrompt: `${bundle.gate.blockers.length} blocking close task(s) are still failing: ${blockers}. The agent will NOT force a close. Resolve them (or a controller may hard-close with an authorized override in the Close Command Center), then continue. The agent only observes the period reach HARD_CLOSE.`,
        };
      },
      async onAdvance(ctx, state): Promise<StepExecuteResult> {
        // Observe only: proceed solely if the EXISTING gated close path drove the
        // period to HARD_CLOSE. The runner never flips the period itself.
        const fiscalPeriodId = String(state.fiscalPeriodId ?? '');
        const label = `${state.year}-${String(Number(state.month)).padStart(2, '0')}`;
        const { data } = await ctx.supabase
          .from('fiscal_periods')
          .select('status')
          .eq('id', fiscalPeriodId)
          .maybeSingle();
        const status = (data as { status: string } | null)?.status ?? 'UNKNOWN';
        if (status === 'HARD_CLOSE') {
          return {
            status: 'DONE',
            summary: `Confirmed ${label} reached HARD_CLOSE through the gated close path. The agent closed nothing.`,
            statePatch: { periodStatus: status },
            output: { periodStatus: status },
          };
        }
        return {
          status: 'WAITING',
          summary: `Period is still ${status} — it has not been hard-closed yet.`,
          gatePrompt: `The period is still ${status}. Hard-close ${label} in the Close Command Center first, then continue. The agent will not close it for you.`,
        };
      },
    },
  ],
};
