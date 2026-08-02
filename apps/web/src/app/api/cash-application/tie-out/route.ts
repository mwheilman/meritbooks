export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { computeArTieOut } from '@/lib/controls/cash-application';

/**
 * GET /api/cash-application/tie-out
 *
 * AR subledger ↔ GL control tie-out (a standard controllership control).
 * READ-ONLY. Compares:
 *   - subledger  = Σ open invoice balances (v_ar_aging)
 *   - GL control = the AR control account's balance (v_trial_balance net_balance)
 * and surfaces any variance as a reconciling item. Every query runs through the
 * RLS-scoped client — org isolation is enforced by the database.
 *
 * Query: ?location_id=<uuid|all> or ?location_ids=a,b — optional location filter.
 * Authorization: reports:view (a financial control report).
 */

function toNum(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, userId, orgId: claimOrgId } = ctx;

  const guard = await requirePermission(userId, 'reports', 'view');
  if (!guard.ok) return guard.response;

  // Org is the caller's RESOLVED tenant (ctx.orgId; identity gate #9) for the
  // AR-control account lookup (RLS still scopes the reads). No first-org fallback.
  const orgId = claimOrgId;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization found', code: 'NO_ORG' }, { status: 400 });
  }

  const { searchParams } = new URL(request.url);
  const locationIds = searchParams.get('location_ids');
  const locationId = searchParams.get('location_id');
  const locFilter = locationIds
    ? locationIds.split(',').filter(Boolean)
    : locationId && locationId !== 'all'
      ? [locationId]
      : [];

  // 1. Subledger — Σ open invoice balances from v_ar_aging.
  // `> 0` defensively drops WRITTEN_OFF (balance 0) rows from the subledger Σ
  // even before the v_ar_aging view is re-created to exclude that status.
  let arQ = supabase.from('v_ar_aging').select('balance_cents, location_id').gt('balance_cents', 0);
  if (locFilter.length === 1) arQ = arQ.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) arQ = arQ.in('location_id', locFilter);
  const { data: arData, error: arErr } = await arQ;
  if (arErr) {
    console.error('[cash-application/tie-out] AR aging failed:', arErr.message);
    return NextResponse.json({ error: 'Failed to load AR subledger', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  const subledgerCents = (arData ?? []).reduce((s, r) => s + toNum((r as { balance_cents: number | string }).balance_cents), 0);

  // 2. GL control — the AR control account's net balance from v_trial_balance.
  let arAccountId: string | null = null;
  let arAccountNumber: string | null = null;
  try {
    const ar = await resolveRole(supabase, orgId, 'AR_CONTROL');
    arAccountId = ar.id;
    arAccountNumber = ar.account_number;
  } catch (e) {
    // The AR control account isn't mapped/seeded — report it as a reconciling gap
    // rather than 500. The subledger still renders.
    const message = e instanceof PostingError ? e.message : 'AR control account not resolved';
    return NextResponse.json({
      data: {
        subledgerCents,
        glControlCents: null,
        varianceCents: null,
        tiesOut: false,
        arAccountNumber: null,
        note: message,
        asOf: new Date().toISOString(),
        locationFilter: locFilter,
      },
    });
  }

  let tbQ = supabase.from('v_trial_balance').select('net_balance, location_id').eq('account_id', arAccountId);
  if (locFilter.length === 1) tbQ = tbQ.eq('location_id', locFilter[0]);
  else if (locFilter.length > 1) tbQ = tbQ.in('location_id', locFilter);
  const { data: tbData, error: tbErr } = await tbQ;
  if (tbErr) {
    console.error('[cash-application/tie-out] trial balance failed:', tbErr.message);
    return NextResponse.json({ error: 'Failed to load GL control balance', code: 'INTERNAL_ERROR' }, { status: 500 });
  }
  const glControlCents = (tbData ?? []).reduce((s, r) => s + toNum((r as { net_balance: number | string }).net_balance), 0);

  const tie = computeArTieOut(subledgerCents, glControlCents);

  return NextResponse.json({
    data: {
      ...tie,
      arAccountNumber,
      reconcilingItem: tie.tiesOut
        ? null
        : {
            label: 'Unreconciled AR difference (GL − subledger)',
            amountCents: tie.varianceCents,
          },
      asOf: new Date().toISOString(),
      locationFilter: locFilter,
    },
  });
}
