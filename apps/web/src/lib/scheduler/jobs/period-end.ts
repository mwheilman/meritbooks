/**
 * `close.period_end` — open last month's close for every company and run the readiness
 * checks (CL-08). No posting, ever.
 *
 * Runs on days 2–10 of each month (the close window; day 1 belongs to the depreciation /
 * rev-rec / prepaid runs). For the PRIOR month, per active company with an open fiscal
 * period:
 *
 *   1. creates the close checklist if it isn't there yet — one close_checklists row per
 *      task in the standard close graph (lib/close/orchestration.ts CLOSE_TASK_GRAPH),
 *      MANUAL tasks unchecked, AUTO tasks flagged auto-verified. Existing rows (a person's
 *      sign-offs) are never touched.
 *   2. runs the same readiness board the Close screen shows (lib/close/readiness.ts:
 *      bank recs tied, AR/AP subledger tie, leakage, open exceptions, drafts, holds,
 *      unapplied cash, approvals, WIP review) and stamps each AUTO row with today's answer.
 *   3. tells the tenant's admins once per period: "October close is open — N ready, M blocked".
 *
 * Idempotent: rerunning only refreshes the AUTO rows' answers. HARD_CLOSE periods are left
 * alone; a company without a fiscal period for the month is reported, not invented.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { CLOSE_TASK_GRAPH } from '@/lib/close/orchestration';
import { gatherCloseOrchestration, type EntityCloseOrchestration } from '@/lib/close/readiness';
import { scopedWriter } from '@/lib/db/scoped-writer';
import type { CountValue, JobContext, JobResult } from '../types';
import { lastDayOfPriorMonth, notifyTenantAdmins, scopedOrFail } from './shared';

interface ChecklistRow {
  id: string;
  location_id: string;
  task_name: string;
  is_auto_verified: boolean | null;
  is_complete: boolean | null;
}

/** Create the missing checklist rows + refresh AUTO answers for one open entity. Returns rows created. */
async function syncEntityChecklist(
  db: SupabaseClient,
  orgId: string,
  e: EntityCloseOrchestration,
  existing: ReadonlyArray<ChecklistRow>,
  nowIso: string,
): Promise<{ created: number; refreshed: number }> {
  if (!e.periodId) return { created: 0, refreshed: 0 };
  const writer = await scopedWriter(db, orgId, [e.locationId]);
  const have = new Map(existing.map((r) => [r.task_name, r]));
  const statusByKey = new Map(e.evaluation.tasks.map((t) => [t.key, t.status]));

  const missing = CLOSE_TASK_GRAPH.filter((t) => !have.has(t.key)).map((t) => {
    const autoPass = t.kind === 'AUTO' && statusByKey.get(t.key) === 'pass';
    return {
      org_id: orgId,
      fiscal_period_id: e.periodId,
      location_id: e.locationId,
      phase: t.phase,
      task_name: t.key,
      task_order: t.order,
      due_day: t.dueDay,
      is_auto_verified: t.kind === 'AUTO',
      is_complete: autoPass,
      completed_at: autoPass ? nowIso : null,
      notes: t.kind === 'AUTO' ? 'Checked automatically by the scheduler (close.period_end).' : null,
    };
  });
  if (missing.length > 0) {
    const { error } = await writer.from('close_checklists').insert(missing);
    if (error) throw new Error(`Could not create the close checklist: ${error.message}`);
  }

  // Refresh AUTO rows the scheduler owns (never a person's manual sign-off).
  let refreshed = 0;
  for (const row of existing) {
    if (!row.is_auto_verified) continue;
    const def = CLOSE_TASK_GRAPH.find((t) => t.key === row.task_name);
    if (!def || def.kind !== 'AUTO') continue;
    const pass = statusByKey.get(def.key) === 'pass';
    if (!!row.is_complete === pass) continue;
    const { error } = await writer
      .from('close_checklists')
      .update({ is_complete: pass, completed_at: pass ? nowIso : null, updated_at: nowIso })
      .eq('id', row.id)
      .eq('org_id', orgId);
    if (!error) refreshed++;
  }
  return { created: missing.length, refreshed };
}

export async function runPeriodEndJob(ctx: JobContext): Promise<JobResult> {
  const s = scopedOrFail(ctx);
  if (!s.ok) return s.result;
  const periodEnd = lastDayOfPriorMonth(ctx.slotAt);
  const year = Number(periodEnd.slice(0, 4));
  const month = Number(periodEnd.slice(5, 7));
  const periodKey = periodEnd.slice(0, 7);
  const nowIso = ctx.now.toISOString();

  const board = await gatherCloseOrchestration(s.db, s.orgId, year, month);
  const open = board.entities.filter((e) => e.periodId && (e.periodStatus === 'OPEN' || e.periodStatus === 'SOFT_CLOSE'));
  const periodIds = open.map((e) => e.periodId as string);

  const existingByLoc = new Map<string, ChecklistRow[]>();
  if (periodIds.length > 0) {
    const { data, error } = await s.db
      .from('close_checklists')
      .select('id, location_id, task_name, is_auto_verified, is_complete')
      .in('fiscal_period_id', periodIds);
    if (error) return { status: 'failed', error: `Could not read close checklists: ${error.message}` };
    for (const r of (data ?? []) as ChecklistRow[]) {
      const arr = existingByLoc.get(r.location_id) ?? [];
      arr.push(r);
      existingByLoc.set(r.location_id, arr);
    }
  }

  let created = 0;
  let refreshed = 0;
  let checklistsOpened = 0;
  const failures: string[] = [];
  for (const e of open) {
    if (ctx.signal.aborted) break;
    try {
      const r = await syncEntityChecklist(s.db, s.orgId, e, existingByLoc.get(e.locationId) ?? [], nowIso);
      created += r.created;
      refreshed += r.refreshed;
      if (r.created > 0 && (existingByLoc.get(e.locationId)?.length ?? 0) === 0) checklistsOpened++;
    } catch (err) {
      failures.push(`${e.shortCode || e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const ready = open.filter((e) => e.evaluation.readyToHardClose).length;
  const blocked = open.length - ready;
  const topBlockers = open
    .filter((e) => !e.evaluation.readyToHardClose)
    .slice(0, 4)
    .map((e) => `${e.shortCode || e.name}: ${e.evaluation.blockers.slice(0, 2).map((b) => b.label).join(', ')}`);

  const counts: Record<string, CountValue> = {
    period: periodKey,
    companies: board.summary.totalEntities,
    open: open.length,
    ready_to_close: ready,
    blocked,
    already_closed: board.summary.closed,
    no_period: board.summary.noPeriod,
    checklists_opened: checklistsOpened,
    rows_created: created,
    auto_rows_refreshed: refreshed,
    failed: failures.length,
  };

  if (open.length === 0) {
    return {
      status: 'ok',
      itemsProcessed: 0,
      counts,
      summary:
        board.summary.closed > 0 && board.summary.noPeriod === 0
          ? `${board.period.label} is already closed for every company.`
          : `No open ${board.period.label} periods to close${board.summary.noPeriod ? ` (${board.summary.noPeriod} compan${board.summary.noPeriod === 1 ? 'y has' : 'ies have'} no fiscal period for the month)` : ''}.`,
    };
  }

  await notifyTenantAdmins(ctx.admin, s.orgId, {
    kind: 'scheduler.close',
    title: `${board.period.label} close is open: ${ready} ready, ${blocked} blocked`,
    body: topBlockers.length ? `Still to clear — ${topBlockers.join(' · ')}` : 'Every company passes the automatic checks; sign off the manual tasks to close.',
    deepLink: '/close',
    dedupeKey: `close:${periodKey}`,
    severity: blocked > 0 ? 'attention' : 'info',
  });

  return {
    status: failures.length === 0 ? 'ok' : created + refreshed > 0 ? 'partial' : 'failed',
    itemsProcessed: open.length,
    counts,
    summary: `${board.period.label} close: ${checklistsOpened > 0 ? `opened the checklist for ${checklistsOpened} compan${checklistsOpened === 1 ? 'y' : 'ies'}; ` : ''}${ready} ready to close, ${blocked} blocked. Nothing was posted.`,
    error: failures.length ? failures.join('; ') : undefined,
  };
}
