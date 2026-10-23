export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { serviceWriter } from '@/lib/db/scoped-writer';
import { REQUESTS_WORK, requireAny } from '@/lib/requests/route-auth';

const query = z.object({ q: z.string().trim().max(80).optional() });

function clean(v: string): string {
  return v.replace(/[,()"'*%_\\]/g, ' ').trim();
}

/**
 * GET /api/requests/recipients?q= — who a new request can go to: vendors (with the
 * email on file) and active teammates. Vendors and memberships are read through the
 * member's RLS client (org scoped); teammate names are stitched from core.users for
 * exactly those memberships (service read, pinned to the ids RLS returned).
 */
export const GET = apiQueryHandler(query, async ({ q }, { userId, orgId, supabase }) => {
  const guard = await requireAny(userId, REQUESTS_WORK, '/api/requests/recipients');
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ vendors: [], members: [] });
  const term = q ? clean(q) : '';

  let vq = supabase.schema('core').from('vendors').select('id, name, display_name, email').eq('org_id', orgId).eq('is_active', true).order('name').limit(25);
  if (term) vq = vq.or(`name.ilike.%${term}%,display_name.ilike.%${term}%,email.ilike.%${term}%`);
  const [{ data: vendors }, { data: memberships }] = await Promise.all([
    vq,
    supabase.schema('core').from('memberships').select('id, user_id, role').eq('org_id', orgId).eq('status', 'active').limit(200),
  ]);

  const ms = (memberships ?? []) as Array<{ id: string; user_id: string; role: string }>;
  const userIds = Array.from(new Set(ms.map((m) => m.user_id)));
  const { data: users } = userIds.length
    ? await serviceWriter().schema('core').from('users').select('id, first_name, last_name, email').in('id', userIds)
    : { data: [] as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }> };
  const byId = new Map(((users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }>).map((u) => [u.id, u]));
  const lower = term.toLowerCase();
  const members = ms
    .map((m) => {
      const u = byId.get(m.user_id);
      const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'Team member';
      return { membershipId: m.id, name, email: u?.email ?? null, role: m.role };
    })
    .filter((m) => !lower || m.name.toLowerCase().includes(lower) || (m.email ?? '').toLowerCase().includes(lower))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 25);

  return NextResponse.json({
    vendors: ((vendors ?? []) as Array<{ id: string; name: string; display_name: string | null; email: string | null }>).map((v) => ({
      id: v.id,
      name: v.display_name || v.name,
      email: v.email,
    })),
    members,
  });
});
