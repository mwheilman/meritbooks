export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { dbErrorResponse, resolveGovActor } from '@/lib/access-governance/server';

/**
 * POST /api/access/template-updates/dismiss-note — hide the "MeritBooks suggests…" line in
 * the role library until the next batch arrives (05 §6.10). Suggestions themselves stay
 * available; nothing about any role changes.
 */
export const POST = apiHandler(null, async (_body, ctx) => {
  const admin = createAdminSupabase();
  const actor = await resolveGovActor(ctx.userId, ctx.orgId, admin);
  if (actor instanceof NextResponse) return actor;
  const { data, error } = await admin.schema('core').rpc('template_updates_dismiss_note', { p_org: actor.orgId, p_user: actor.userId });
  if (error) return dbErrorResponse(error);
  return NextResponse.json({ data: { hidden: data as number } });
});
