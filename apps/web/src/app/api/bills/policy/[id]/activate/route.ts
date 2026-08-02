export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logAction } from '@/lib/trust/action-log';
import { parseApRuleset } from '@/lib/policy/ap-schema';

/**
 * POST /api/bills/policy/[id]/activate — make a stored DRAFT/ARCHIVED AP policy the single
 * ACTIVE version for the org (archiving whatever was active). This is the human-approval
 * step that turns a compiled ruleset into enforcement.
 *
 * The stored `compiled_rules` is re-validated against the fixed schema before it can go
 * live, so a tampered blob can never enforce. RBAC: `bills:approve` (a control action).
 * One ACTIVE per org (partial unique index is the guarantor).
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'approve');
  if (!guard.ok) return guard.response;

  // Load the target policy (RLS-scoped) and validate its ruleset before going live.
  const { data: policy, error: loadErr } = await supabase
    .from('ap_approval_policies')
    .select('id, version, status, compiled_rules')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .maybeSingle();
  if (loadErr) return NextResponse.json({ error: loadErr.message }, { status: 500 });
  if (!policy) return NextResponse.json({ error: 'Policy not found' }, { status: 404 });

  const row = policy as { id: string; version: number; status: string; compiled_rules: unknown };
  if (row.status === 'ACTIVE') {
    return NextResponse.json({ id: row.id, version: row.version, status: 'ACTIVE', alreadyActive: true });
  }

  const check = parseApRuleset(row.compiled_rules);
  if (!check.ok) {
    return NextResponse.json(
      { error: 'This policy version has an invalid ruleset and cannot be activated', code: 'BAD_RULESET', issues: check.errors },
      { status: 422 }
    );
  }

  // Archive the current active version first (partial unique index guards uniqueness).
  const { error: archErr } = await supabase
    .from('ap_approval_policies')
    .update({ status: 'ARCHIVED' })
    .eq('org_id', orgId)
    .eq('status', 'ACTIVE');
  if (archErr) return NextResponse.json({ error: archErr.message }, { status: 500 });

  const { error: actErr } = await supabase
    .from('ap_approval_policies')
    .update({ status: 'ACTIVE', activated_by_user: userId, activated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', row.id);
  if (actErr) return NextResponse.json({ error: actErr.message }, { status: 500 });

  await logAction(supabase, {
    orgId,
    actorType: 'HUMAN',
    actorUserId: null,
    action: 'ap_policy.activate',
    subjectTable: 'ap_approval_policies',
    subjectId: row.id,
    summary: `AP approval policy v${row.version} activated`,
    metadata: { by_clerk_user: userId, version: row.version },
  });

  return NextResponse.json({ id: row.id, version: row.version, status: 'ACTIVE' });
}
