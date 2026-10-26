export const dynamic = 'force-dynamic';
export const maxDuration = 300;

import { NextResponse } from 'next/server';
import { apiHandler, apiQueryHandler } from '@/lib/api-handler';
import { assertWriteScope, serviceWriter } from '@/lib/db/scoped-writer';
import { towerAction, towerQuery } from '@/lib/validations/onboarding-migration';
import { guardMigration, migrationErrorResponse, noOrg } from '@/lib/onboarding/migration/server/guard';
import { loadTower } from '@/lib/onboarding/migration/server/tower';
import { createProjects, refreshProject, updatePlan } from '@/lib/onboarding/migration/server/projects';
import { runAndStore } from '@/lib/onboarding/migration/server/preflight';
import { loadProject } from '@/lib/onboarding/migration/server/store';
import { today } from '@/lib/onboarding/migration/server/route-support';

/**
 * Migration Control Tower (spec §6).
 *   GET   every client in migration, grouped by wave (cutover date), with stage, sources,
 *         blockers in dollars, next step, people; plus clients not started and open waves.
 *   POST  create (add clients) · refresh_all · bulk_cutover · bulk_assign · bulk_preflight ·
 *         create_wave · close_wave.
 * Gates: view = journal_entries:view; manage actions = settings_acct:edit; bulk data-quality
 * = journal_entries:create. Every client touched must be inside the caller's client scope.
 */
export const GET = apiQueryHandler(towerQuery, async (_q, { userId, orgId, supabase }) => {
  const g = await guardMigration(userId, 'view', '/api/onboarding/migrations');
  if (!g.ok) return g.response;
  if (!orgId) return noOrg();
  try {
    return NextResponse.json(await loadTower(supabase, orgId, today()));
  } catch (e) {
    return migrationErrorResponse(e, 'Could not load the Tower');
  }
});

export const POST = apiHandler(towerAction, async (body, { userId, orgId, supabase }) => {
  const route = '/api/onboarding/migrations';
  const needs = body.action === 'bulk_preflight' || body.action === 'refresh_all' ? 'work' : 'manage';
  const g = await guardMigration(userId, needs, route);
  if (!g.ok) return g.response;
  if (!orgId) return noOrg();
  const ctx = { supabase, orgId, userId };
  try {
    switch (body.action) {
      case 'create': {
        await assertWriteScope(supabase, orgId, body.location_ids);
        const r = await createProjects(ctx, { locationIds: body.location_ids, waveId: body.wave_id ?? null, preparerUserId: body.preparer_user_id ?? null, reviewerUserId: body.reviewer_user_id ?? null });
        for (const id of r.ids) {
          const p = await loadProject(supabase, orgId, id);
          await refreshProject(supabase, orgId, p, { withTies: false });
        }
        return NextResponse.json({ ...r, message: `${r.created} client${r.created === 1 ? '' : 's'} added to the migration${r.skipped ? ` · ${r.skipped} already in it` : ''}.` });
      }
      case 'refresh_all': {
        const { data } = await supabase.from('migration_projects').select('id').eq('org_id', orgId).is('archived_at', null).limit(500);
        let n = 0;
        for (const row of (data ?? []) as Array<{ id: string }>) {
          const p = await loadProject(supabase, orgId, row.id);
          try {
            await assertWriteScope(supabase, orgId, [p.location_id]);
            await refreshProject(supabase, orgId, p, { withTies: true });
            n++;
          } catch { /* out of scope or a transient read — skip this row */ }
        }
        return NextResponse.json({ refreshed: n, message: `Refreshed ${n} client${n === 1 ? '' : 's'}.` });
      }
      case 'bulk_cutover':
      case 'bulk_assign': {
        let n = 0;
        const errors: string[] = [];
        for (const id of body.project_ids) {
          try {
            const p = await loadProject(supabase, orgId, id);
            await assertWriteScope(supabase, orgId, [p.location_id]);
            const next = body.action === 'bulk_cutover'
              ? await updatePlan(ctx, p, { cutoverDate: body.cutover_date })
              : await updatePlan(ctx, p, { preparerUserId: body.preparer_user_id, reviewerUserId: body.reviewer_user_id });
            await refreshProject(supabase, orgId, next, { withTies: false });
            n++;
          } catch (e) {
            errors.push(e instanceof Error ? e.message : 'failed');
          }
        }
        return NextResponse.json({ updated: n, errors: errors.slice(0, 10), message: `Updated ${n} of ${body.project_ids.length}.${errors.length ? ` ${errors[0]}` : ''}` });
      }
      case 'bulk_preflight': {
        let n = 0;
        for (const id of body.project_ids) {
          const p = await loadProject(supabase, orgId, id);
          await assertWriteScope(supabase, orgId, [p.location_id]);
          await runAndStore(supabase, orgId, p, userId);
          await refreshProject(supabase, orgId, p, { withTies: false });
          n++;
        }
        return NextResponse.json({ ran: n, message: `Ran the 24 checks on ${n} client${n === 1 ? '' : 's'}.` });
      }
      case 'create_wave': {
        const { data, error } = await serviceWriter()
          .from('migration_waves')
          .insert({ org_id: orgId, name: body.name, cutover_date: body.cutover_date, purpose: body.purpose ?? null, target_go_live: body.target_go_live ?? null, created_by: userId })
          .select('id')
          .single();
        if (error) {
          if (/ux_migration_waves_open_cutover/.test(error.message)) return NextResponse.json({ error: 'There is already an open wave on that cutover date — a wave is its cutover date.', code: 'DUP_WAVE' }, { status: 409 });
          throw new Error(error.message);
        }
        return NextResponse.json({ id: (data as { id: string }).id, message: 'Wave created.' });
      }
      case 'close_wave': {
        const { error } = await serviceWriter().from('migration_waves').update({ status: 'closed' }).eq('org_id', orgId).eq('id', body.wave_id);
        if (error) throw new Error(error.message);
        return NextResponse.json({ message: 'Wave closed.' });
      }
    }
  } catch (e) {
    return migrationErrorResponse(e, 'Could not update the migration');
  }
});
