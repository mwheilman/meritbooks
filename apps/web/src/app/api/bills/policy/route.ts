export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logAction } from '@/lib/trust/action-log';
import { parseApRuleset, apPolicyRulesetSchema } from '@/lib/policy/ap-schema';

/**
 * GET  /api/bills/policy — list every AP-policy version + the ACTIVE one.
 * POST /api/bills/policy — create a policy version from a REVIEWED ruleset; optionally
 *                          activate it (archiving the current active).
 *
 * SAFETY: the ruleset is re-validated against the fixed schema here (server-side), so a
 * malformed/hand-tampered blob can never be stored or activated. Activation is the
 * human-approval step — nothing enforces until a version is ACTIVE.
 *
 * RBAC (reported: a dedicated `ap_policy` permission is the right home): read gated on
 * `bills:view`; create/activate on `bills:approve` (governing how bills route/block is a
 * control action).
 */

const POLICY_COLS =
  'id, name, version, status, effective_start, effective_end, compiled_rules, source_note, ' +
  'source_decision_id, created_by_user, activated_by_user, activated_at, created_at, updated_at';

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('ap_approval_policies')
    .select(POLICY_COLS)
    .eq('org_id', orgId)
    .order('version', { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const active = rows.find((r) => r.status === 'ACTIVE') ?? null;
  return NextResponse.json({ data: rows, active });
}

const createSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  compiled_rules: apPolicyRulesetSchema,
  source_note: z.string().max(2000).optional(),
  source_decision_id: z.string().uuid().optional(),
  activate: z.boolean().optional(),
  effective_start: z.string().date().optional(),
  effective_end: z.string().date().optional(),
});

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'bills', 'approve');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_FAILED', issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) },
      { status: 422 }
    );
  }

  // Defense in depth: re-validate the ruleset through the shared parser.
  const ruleCheck = parseApRuleset(parsed.data.compiled_rules);
  if (!ruleCheck.ok) {
    return NextResponse.json({ error: 'Ruleset failed schema validation', code: 'BAD_RULESET', issues: ruleCheck.errors }, { status: 422 });
  }

  // Next version number for this org.
  const { data: maxRow } = await supabase
    .from('ap_approval_policies')
    .select('version')
    .eq('org_id', orgId)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextVersion = ((maxRow as { version: number } | null)?.version ?? 0) + 1;

  const activate = parsed.data.activate === true;

  // If activating, archive the current ACTIVE first (partial unique index guards it).
  if (activate) {
    const { error: archErr } = await supabase
      .from('ap_approval_policies')
      .update({ status: 'ARCHIVED' })
      .eq('org_id', orgId)
      .eq('status', 'ACTIVE');
    if (archErr) return NextResponse.json({ error: archErr.message }, { status: 500 });
  }

  const nowIso = new Date().toISOString();
  const { data: created, error } = await supabase
    .from('ap_approval_policies')
    .insert({
      org_id: orgId,
      name: parsed.data.name ?? 'AP Approval Policy',
      version: nextVersion,
      status: activate ? 'ACTIVE' : 'DRAFT',
      compiled_rules: ruleCheck.ruleset,
      source_note: parsed.data.source_note ?? null,
      source_decision_id: parsed.data.source_decision_id ?? null,
      effective_start: parsed.data.effective_start ?? null,
      effective_end: parsed.data.effective_end ?? null,
      created_by_user: userId,
      activated_by_user: activate ? userId : null,
      activated_at: activate ? nowIso : null,
    })
    .select('id, version, status')
    .single();
  if (error) return NextResponse.json({ error: error.message, code: 'CREATE_FAILED' }, { status: 500 });

  const row = created as { id: string; version: number; status: string };
  await logAction(supabase, {
    orgId,
    actorType: 'HUMAN',
    actorUserId: null,
    action: activate ? 'ap_policy.activate' : 'ap_policy.create',
    subjectTable: 'ap_approval_policies',
    subjectId: row.id,
    summary: `AP approval policy v${row.version} ${activate ? 'ACTIVATED' : 'saved as draft'}`,
    metadata: { by_clerk_user: userId, version: row.version, status: row.status },
  });

  return NextResponse.json(row, { status: 201 });
}
