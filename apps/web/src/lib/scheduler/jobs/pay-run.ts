/**
 * `ap.pay_run_propose` — the weekly DRAFT pay run (AP-13).
 *
 * Every Monday, per tenant, it starts the existing PAY_RUN agent recipe
 * (lib/agents/recipes/pay-run.ts) as a system run: the recipe assembles the approved bills
 * due in the next 7 days PLUS bills due later whose early-pay discount date falls in that
 * window (migration 184), ordered by pay-by date, and then PAUSES at its release gate.
 *
 * It is a PROPOSAL ONLY. Nothing is approved, released, paid or posted. A person opens the
 * run in Agents, reviews the list and presses Release — which only PREPARES disbursement
 * approvals in their name; a DIFFERENT authorized person approves and releases each payment
 * on Checks / Payments (separation of duties, DB-enforced). No autonomy dial: there is no
 * auto mode for money out.
 *
 * Idempotent: one proposal per tenant at a time — while a scheduler-started pay run is
 * still waiting at its gate, the job does not start another (it says so in the run log).
 */

import { startRun } from '@/lib/agents/runner';
import { payRunRecipe } from '@/lib/agents/recipes/pay-run';
import type { CountValue, JobContext, JobResult } from '../types';
import { dollars, isoDate, notifyTenantAdmins, scopedOrFail } from './shared';

export const PAY_RUN_WINDOW_DAYS = 7;

interface OpenRunRow {
  id: string;
  created_at: string;
  context: Record<string, unknown> | null;
}

export async function runPayRunProposeJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const week = isoDate(ctx.slotAt);

  // One live scheduler proposal at a time (created_by_user null = a system run).
  const { data: open, error: openErr } = await s.db
    .from('agent_runs')
    .select('id, created_at, context')
    .eq('org_id', s.orgId)
    .eq('recipe', payRunRecipe.key)
    .in('status', ['RUNNING', 'PAUSED'])
    .is('created_by_user', null)
    .order('created_at', { ascending: false })
    .limit(5);
  if (openErr) return { status: 'failed', error: `Could not check for an open pay-run proposal: ${openErr.message}` };
  const waiting = ((open ?? []) as OpenRunRow[]).find((r) => r.context?.scheduled === true);
  if (waiting) {
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts: { week, open_run: waiting.id, mode: 'already_waiting' },
      summary: `Last pay-run proposal (started ${waiting.created_at.slice(0, 10)}) is still waiting for someone to review and release it — not starting another.`,
    };
  }

  const started = await startRun(
    { supabase: s.db, orgId: s.orgId, userId: null, locationId: null },
    payRunRecipe,
    { due_within_days: PAY_RUN_WINDOW_DAYS, include_discounts: true, source: 'scheduler' },
  );
  if ('error' in started) return { status: 'failed', error: started.error };
  const run = started.run;
  if (!run.persisted) {
    return { status: 'failed', error: 'The pay-run proposal could not be saved (agent run tables unavailable), so nobody could review it.' };
  }
  const assemble = run.steps.find((st) => st.name === 'assemble');
  const out = (assemble?.output ?? {}) as Record<string, unknown>;
  const count = Number(out.count ?? 0);
  const totalCents = Number(out.totalCents ?? 0);
  const savingsCents = Number(out.savingsCents ?? 0);
  const discountCount = Number(out.discountCount ?? 0);

  const counts: Record<string, CountValue> = {
    week,
    run_id: run.id,
    run_status: run.status,
    bills: count,
    total_cents: totalCents,
    discount_bills: discountCount,
    discount_savings_cents: savingsCents,
    already_queued: Number(out.alreadyQueued ?? 0),
  };

  if (count === 0) {
    return { status: 'ok', itemsProcessed: 0, counts: { ...counts, mode: 'nothing_due' }, summary: assemble?.summary ?? 'No approved bills are payable this week.' };
  }

  await notifyTenantAdmins(ctx.admin, s.orgId, {
    kind: 'scheduler.pay_run',
    title: `This week's pay run is ready to review: ${count} bill(s), ${dollars(totalCents)}`,
    body: `${discountCount > 0 ? `${discountCount} carry an early-pay discount worth ${dollars(savingsCents)} if paid on time. ` : ''}Nothing has been paid. Review it and release it to Checks / Payments, where a second person approves each payment.`,
    deepLink: '/agents',
    dedupeKey: `pay_run:${week}`,
    severity: 'attention',
  });

  return {
    status: 'ok',
    itemsProcessed: count,
    counts: { ...counts, mode: 'proposed' },
    summary: `Proposed a pay run of ${count} bill(s), ${dollars(totalCents)}${discountCount > 0 ? ` (${discountCount} early-pay discount(s) worth ${dollars(savingsCents)})` : ''}. It is waiting in Agents for someone to review and release — nothing was paid.`,
  };
}
