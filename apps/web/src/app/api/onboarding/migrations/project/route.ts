export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { projectAction, projectQuery } from '@/lib/validations/onboarding-migration';
import { migrationErrorResponse } from '@/lib/onboarding/migration/server/guard';
import { withProject } from '@/lib/onboarding/migration/server/route-support';
import { addSource, refreshProject, removeSource, skipStage, updatePlan } from '@/lib/onboarding/migration/server/projects';
import { pullQbo } from '@/lib/onboarding/migration/server/staging';
import { loadPeople, logEvent } from '@/lib/onboarding/migration/server/store';
import { deriveStages, nextAction, blockerSummary } from '@/lib/onboarding/migration/stages';

/**
 * One client's migration workspace.
 *   GET  ?id=  the project, its eight stages (live), next step, sources with their recipe
 *              file slots, people, the trail, QuickBooks status, the opening session and
 *              the certificate. (journal_entries:view; RLS: org + client scope)
 *   POST       update_plan / add_source / remove_source / skip_practice_close (manage or
 *              work) · comment · pull_qbo · refresh (work).
 */
export const GET = apiQueryHandler(projectQuery, async (q, ctx) => {
  const pc = await withProject(ctx, q.id, 'view', '/api/onboarding/migrations/project');
  if (pc instanceof NextResponse) return pc;
  try {
    // Persist the recomputed stage only for callers who may write this client.
    const canWrite = await assertWriteScope(pc.supabase, pc.orgId, [pc.project.location_id]).then(() => true, () => false);
    const { project, facts } = await refreshProject(pc.supabase, pc.orgId, pc.project, { withTies: true, persist: canWrite });
    const [{ data: loc }, { data: wave }, people, { data: events }] = await Promise.all([
      pc.supabase.schema('core').from('locations').select('id, name, short_code').eq('id', project.location_id).maybeSingle(),
      project.wave_id ? pc.supabase.from('migration_waves').select('id, name, cutover_date, purpose').eq('id', project.wave_id).maybeSingle() : Promise.resolve({ data: null }),
      loadPeople(pc.supabase, pc.orgId),
      pc.supabase.from('migration_events').select('id, kind, actor, actor_kind, summary, created_at').eq('project_id', project.id).order('created_at', { ascending: false }).limit(60),
      ]);
    const nameOf = new Map(people.map((p) => [p.userId, p.name]));
    const { stages, current } = deriveStages(facts.facts);
    return NextResponse.json({
      project,
      client: loc,
      wave,
      stages,
      current,
      next: nextAction(facts.facts),
      blockers: blockerSummary(facts.facts),
      facts: facts.facts,
      sources: facts.sources.map(({ system, ...s }) => ({ ...s, systemName: system?.name ?? s.systemId, bridgeViaQuickBooks: !!system?.bridgeViaQuickBooks, ongoingFeed: !!system?.ongoingFeed })),
      people,
      names: { lead: project.lead_user_id ? nameOf.get(project.lead_user_id) ?? null : null, preparer: project.preparer_user_id ? nameOf.get(project.preparer_user_id) ?? null : null, reviewer: project.reviewer_user_id ? nameOf.get(project.reviewer_user_id) ?? null : null },
      events: ((events ?? []) as Array<{ id: string; kind: string; actor: string | null; actor_kind: string; summary: string; created_at: string }>).map((e) => ({ ...e, actorName: e.actor ? nameOf.get(e.actor) ?? null : null })),
      qbo: facts.qbo,
      session: facts.session,
      certificate: facts.certificate,
      me: pc.userId,
    });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the client migration');
  }
});

export const POST = apiHandler(projectAction, async (body, ctx) => {
  const route = '/api/onboarding/migrations/project';
  const needs = body.action === 'update_plan' ? 'manage' : 'work';
  const pc = await withProject(ctx, body.id, needs, route);
  if (pc instanceof NextResponse) return pc;
  const c = { supabase: pc.supabase, orgId: pc.orgId, userId: pc.userId };
  try {
    let message = 'Saved.';
    let extra: Record<string, unknown> = {};
    switch (body.action) {
      case 'update_plan':
        await updatePlan(c, pc.project, {
          cutoverDate: body.cutover_date,
          waveId: body.wave_id,
          historyDepth: body.history_depth,
          targetGoLive: body.target_go_live,
          shadowMode: body.shadow_mode,
          chartStrategy: body.chart_strategy,
          systemsConfirmed: body.systems_confirmed,
          leadUserId: body.lead_user_id,
          preparerUserId: body.preparer_user_id,
          reviewerUserId: body.reviewer_user_id,
          notes: body.notes,
        });
        message = 'Plan saved.';
        break;
      case 'add_source': {
        const s = await addSource(c, pc.project, body.system_id);
        message = 'Source added.';
        extra = { sourceId: s.id };
        break;
      }
      case 'remove_source':
        await removeSource(c, pc.project, body.source_id);
        message = 'Source removed.';
        break;
      case 'skip_practice_close':
        await skipStage(c, pc.project, 'shadow_close', body.reason);
        message = 'Practice close skipped — the reason prints on the certificate.';
        break;
      case 'comment':
        await logEvent(pc.orgId, pc.project, 'comment', body.text, { actor: pc.userId });
        message = 'Comment added.';
        break;
      case 'pull_qbo': {
        const { data: loc } = await pc.supabase.schema('core').from('locations').select('name').eq('id', pc.project.location_id).maybeSingle();
        const r = await pullQbo(pc.supabase, c, pc.project, (loc as { name: string } | null)?.name ?? 'this client');
        message = `Pulled from QuickBooks: ${r.results.map((x) => x.label).join(' · ')}`;
        extra = { warnings: r.warnings };
        break;
      }
      case 'refresh':
        message = 'Refreshed.';
        break;
    }
    const fresh = await withProject(ctx, body.id, 'view', route);
    if (!(fresh instanceof NextResponse)) await refreshProject(fresh.supabase, fresh.orgId, fresh.project, { withTies: false });
    return NextResponse.json({ message, ...extra });
  } catch (e) {
    return migrationErrorResponse(e, 'Could not update the client migration');
  }
});
