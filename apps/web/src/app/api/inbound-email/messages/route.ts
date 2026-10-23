export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { listMessages } from '@/lib/email/inbound-log';
import { inboundMessagesQuery } from '@/lib/validations/inbound-email';

/**
 * GET /api/inbound-email/messages?location_id=&outcome=&purpose=&page=&per_page=
 *
 * The inbound log: what came in, to which company address, and what happened (draft
 * bill created, duplicate, rejected sender, …) with links to the drafts/documents.
 * bills:view. Read through the caller's RLS client — tenant + client scope are
 * enforced by the database (migration 183 member_read + client_scope_rls).
 * `outcome=problems` = everything that needs a person's attention. Messages that reached
 * no company (location_id null) are shown to org-level admins (settings_system:edit) only.
 */
export const GET = apiQueryHandler(inboundMessagesQuery, async (q, { userId, supabase }) => {
  const guard = await requirePermission(userId, 'bills', 'view', { route: '/api/inbound-email/messages' });
  if (!guard.ok) return guard.response;
  const orgAdmin = (await requirePermission(userId, 'settings_system', 'edit', { route: '/api/inbound-email/messages' })).ok;
  const result = await listMessages(supabase, {
    includeNoCompany: orgAdmin,
    orgId: guard.orgId,
    locationId: q.location_id ?? null,
    outcome: q.outcome ?? null,
    purpose: q.purpose ?? null,
    page: q.page,
    perPage: q.per_page,
  });
  return NextResponse.json(result);
});
