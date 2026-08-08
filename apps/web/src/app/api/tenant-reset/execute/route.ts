export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireResetAuthority } from '@/lib/tenant-reset/reset-guard';
import type { ResetOptions } from '@/lib/tenant-reset/reset-plan';

/**
 * POST /api/tenant-reset/execute
 *
 * Executes a tenant reset. This is the ONLY destructive entry point and it does
 * NOT perform the deletion itself — the actual clear is a reserved, server-side,
 * transactional RPC (`public.reset_tenant_data`) that the lead installs. This
 * route:
 *   1. Enforces the strongest gate (company_admin + platform staff).
 *   2. Requires the operator to type the EXACT org name (defense in depth; the
 *      RPC re-checks it too).
 *   3. Requires an explicit acknowledgement that an export was taken.
 *   4. Calls the RPC; if the RPC is not installed, DEGRADES SAFE (501) — no
 *      partial/hand-rolled deletion is ever attempted from the app.
 *   5. Writes an append-only audit record of what was cleared.
 *
 * Nothing here runs automatically — it fires only on an authenticated POST from
 * an authorized operator who has typed the confirmation.
 */

const bodySchema = z.object({
  confirmation: z.string().min(1),
  clearMasterData: z.boolean().default(false),
  clearChartOfAccounts: z.boolean().default(false),
  acknowledgeExport: z.literal(true, {
    errorMap: () => ({ message: 'You must export the data before resetting.' }),
  }),
});

export async function POST(request: Request) {
  const gate = await requireResetAuthority();
  if (!gate.ok) return gate.response;
  const { admin, authority } = gate;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', code: 'VALIDATION_ERROR', details: parsed.error.issues },
      { status: 422 },
    );
  }
  const { confirmation, clearMasterData, clearChartOfAccounts } = parsed.data;

  // Typed-confirmation gate: must match the org name exactly (trimmed).
  if (confirmation.trim() !== (authority.orgName ?? '').trim()) {
    return NextResponse.json(
      { error: 'Confirmation does not match the organization name.', code: 'CONFIRMATION_MISMATCH' },
      { status: 422 },
    );
  }

  const options: ResetOptions = { clearMasterData, clearChartOfAccounts };

  // Delegate the actual deletion to the reserved, transactional RPC. It snapshots,
  // deletes only in-scope rows, never removes the org/users/memberships, and
  // returns the per-table deleted counts. We NEVER delete from the app.
  const { data: rpcData, error: rpcError } = await admin.rpc('reset_tenant_data', {
    p_org_id: authority.orgId,
    p_clear_master_data: clearMasterData,
    p_clear_chart_of_accounts: clearChartOfAccounts,
    p_confirmation: confirmation.trim(),
    p_actor: authority.coreUserId,
  });

  if (rpcError) {
    const code = (rpcError as { code?: string }).code;
    // Function not installed yet -> degrade safe. Nothing was deleted.
    if (code === 'PGRST202') {
      return NextResponse.json(
        {
          error:
            'Reset is unavailable until the admin RPC (reset_tenant_data) is installed. Nothing was changed.',
          code: 'RPC_NOT_INSTALLED',
        },
        { status: 501 },
      );
    }
    // Any other RPC error (e.g. its own confirmation re-check failed) — surface it.
    return NextResponse.json(
      { error: rpcError.message || 'Reset failed', code: 'RESET_FAILED' },
      { status: 500 },
    );
  }

  const result = (rpcData ?? {}) as { deleted?: Record<string, number>; total?: number; snapshot_id?: string };

  // Append-only audit record (core.action_log has no UPDATE/DELETE policy). Best
  // effort — the reset already succeeded; a logging hiccup must not 500 the call.
  try {
    await admin.schema('core').from('action_log').insert({
      org_id: authority.orgId,
      actor_type: 'HUMAN',
      actor_user_id: authority.coreUserId,
      action: 'tenant.reset',
      subject_table: 'organizations',
      subject_id: authority.orgId,
      summary: `Tenant reset by platform admin — cleared ${result.total ?? 0} rows` +
        (clearMasterData ? ' incl. master data' : '') +
        (clearChartOfAccounts ? ' incl. chart of accounts' : ''),
      tier: 'escalate',
      metadata: {
        options,
        deleted: result.deleted ?? {},
        total: result.total ?? 0,
        snapshot_id: result.snapshot_id ?? null,
        clerk_user_id: authority.clerkUserId,
      },
    });
  } catch (e) {
    console.error('[tenant-reset] audit log write failed:', e instanceof Error ? e.message : e);
  }

  // Also open/close a platform-admin session row (cross-tenant action is audited).
  try {
    if (authority.coreUserId) {
      await admin.schema('core').from('platform_admin_sessions').insert({
        user_id: authority.coreUserId,
        target_org_id: authority.orgId,
        reason: 'tenant.reset',
        ended_at: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.error('[tenant-reset] platform session write failed:', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    success: true,
    org: { id: authority.orgId, name: authority.orgName },
    options,
    deleted: result.deleted ?? {},
    total: result.total ?? 0,
    snapshotId: result.snapshot_id ?? null,
  });
}
