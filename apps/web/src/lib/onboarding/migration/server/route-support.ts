/**
 * One gate for every migration route: permission for the action → org resolved → the
 * project is visible through the caller's RLS client (org + client scope; else 404) →
 * for writes, the client is inside the caller's write scope (assertWriteScope).
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertWriteScope } from '@/lib/db/scoped-writer';
import { guardMigration, migrationErrorResponse, noOrg, type MigrationAction } from './guard';
import { loadProject, type ProjectRow } from './store';

export interface ProjectCtx {
  supabase: SupabaseClient;
  orgId: string;
  userId: string;
  project: ProjectRow;
}

export async function withProject(
  ctx: { supabase: SupabaseClient; orgId: string | null; userId: string },
  projectId: string,
  action: MigrationAction,
  route: string,
): Promise<ProjectCtx | NextResponse> {
  const guard = await guardMigration(ctx.userId, action, route);
  if (!guard.ok) return guard.response;
  if (!ctx.orgId) return noOrg();
  try {
    const project = await loadProject(ctx.supabase, ctx.orgId, projectId);
    if (action !== 'view') await assertWriteScope(ctx.supabase, ctx.orgId, [project.location_id]);
    return { supabase: ctx.supabase, orgId: ctx.orgId, userId: ctx.userId, project };
  } catch (e) {
    return migrationErrorResponse(e, 'Could not open the client migration');
  }
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
