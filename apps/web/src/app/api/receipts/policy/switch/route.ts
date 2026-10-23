export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { assertWriteScope, isWriteScopeError, serviceWriter } from '@/lib/db/scoped-writer';
import { requirePermission } from '@/lib/rbac/require-permission';
import { setReceiptChase, SwitchError } from '@/lib/receipts/switch';
import { chaseSwitchBody } from '@/lib/validations/receipts';

/**
 * POST /api/receipts/policy/switch — turn receipt chase on / off for the whole tenant or
 * one client (FPB-workforce-app §4.9). settings_acct:edit (tenant: settings_system:edit as
 * well — it stops reminders for every client). Typed reason required; audit_log records
 * old → new and the reason. Off cancels live reminders in scope; nothing is deleted.
 */
export const POST = apiHandler(chaseSwitchBody, async (b, { userId, orgId, supabase }) => {
  const guard = await requirePermission(userId, 'settings_acct', 'edit', { route: '/api/receipts/policy/switch' });
  if (!guard.ok) return guard.response;
  if (b.scope === 'tenant') {
    const sys = await requirePermission(userId, 'settings_system', 'edit', { route: '/api/receipts/policy/switch' });
    if (!sys.ok) return sys.response;
  }
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (b.scope === 'client' && !b.location_id) return NextResponse.json({ error: 'Pick the company.' }, { status: 422 });
  try {
    if (b.location_id) await assertWriteScope(supabase, orgId, [b.location_id]);
  } catch (e) {
    if (isWriteScopeError(e)) return NextResponse.json({ error: e.message }, { status: 403 });
    throw e;
  }
  try {
    const r = await setReceiptChase(
      serviceWriter(),
      orgId,
      b.scope === 'tenant' ? { kind: 'tenant' } : { kind: 'client', locationId: b.location_id as string, follow: b.follow },
      b.enabled,
      b.reason,
      userId,
      new Date(),
    );
    const what = r.enabled === null ? 'now follows the organization' : r.enabled ? 'is on' : 'is off';
    return NextResponse.json({
      ...r,
      message: `Receipt chase ${what}${r.paused ? ` — ${r.paused} open reminder${r.paused === 1 ? '' : 's'} stopped` : ''}.`,
    });
  } catch (e) {
    if (e instanceof SwitchError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
});
