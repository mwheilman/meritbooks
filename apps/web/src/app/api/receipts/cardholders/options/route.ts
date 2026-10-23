export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiQueryHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';

const q = z.object({ location_id: z.string().uuid() });

/**
 * GET /api/receipts/cardholders/options?location_id= — pickers for the cardholder dialog:
 * the company's card / bank accounts, the org's active team members (with names) and
 * active employees (with email / phone). receipts:view; RLS-scoped reads.
 */
export const GET = apiQueryHandler(q, async ({ location_id }, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'receipts', 'view', { route: '/api/receipts/cardholders/options' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const [accts, members, emps] = await Promise.all([
    supabase
      .from('bank_accounts')
      .select('id, account_name, account_mask, account_type, institution_name')
      .eq('org_id', orgId)
      .eq('location_id', location_id)
      .eq('is_active', true)
      .order('account_type', { ascending: true }),
    supabase.schema('core').from('memberships').select('id, user_id, role').eq('org_id', orgId).eq('status', 'active').limit(500),
    supabase
      .schema('core')
      .from('employees')
      .select('id, first_name, last_name, email, phone, title')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .order('last_name', { ascending: true })
      .limit(1000),
  ]);
  const ms = (members.data ?? []) as Array<{ id: string; user_id: string; role: string }>;
  const users = new Map<string, { email: string | null; first_name: string | null; last_name: string | null }>();
  if (ms.length) {
    const { data: us } = await supabase.schema('core').from('users').select('id, email, first_name, last_name').in('id', ms.map((m) => m.user_id));
    for (const u of (us ?? []) as Array<{ id: string; email: string | null; first_name: string | null; last_name: string | null }>) users.set(u.id, u);
  }
  return NextResponse.json({
    accounts: ((accts.data ?? []) as Array<{ id: string; account_name: string; account_mask: string | null; account_type: string; institution_name: string }>).map((a) => ({
      id: a.id,
      label: `${a.account_name}${a.account_mask ? ` ••${a.account_mask}` : ''}`,
      type: a.account_type,
      institution: a.institution_name,
      mask: a.account_mask,
    })),
    members: ms
      .map((m) => {
        const u = users.get(m.user_id);
        const name = [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.email || 'Team member';
        return { id: m.id, name, email: u?.email ?? null, role: m.role };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    employees: ((emps.data ?? []) as Array<{ id: string; first_name: string; last_name: string; email: string | null; phone: string | null; title: string | null }>).map((e) => ({
      id: e.id,
      name: `${e.first_name} ${e.last_name}`.trim(),
      email: e.email,
      phone: e.phone,
      title: e.title,
    })),
  });
});
