export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { loadCheckNumbers, upsertCheckNumbers, type CheckNumberInput } from '@/lib/ap/vendor-payment-details';

/**
 * Check-number capture for CHECK-method disbursement lines — the alternative to
 * exporting a bank file for checks the human writes by hand. A check number is a
 * REFERENCE only; it never posts to the GL and never moves money. GET returns the
 * org's assigned numbers keyed by approvalId; POST upserts a set (blank clears).
 *
 * Gated on checks:create (preparer step); fails closed. RLS-scoped.
 */

export async function GET() {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const map = await loadCheckNumbers(supabase);
  return NextResponse.json({ checkNumbers: Object.fromEntries(map) });
}

interface CheckNumbersBody {
  entries?: Array<{ approvalId?: string; checkNumber?: string }>;
}

export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'checks', 'create');
  if (!guard.ok) return guard.response;

  let body: CheckNumbersBody = {};
  try {
    body = (await request.json()) as CheckNumbersBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const entries: CheckNumberInput[] = (body.entries ?? [])
    .filter((e): e is { approvalId: string; checkNumber?: string } => typeof e?.approvalId === 'string')
    .map((e) => ({ approvalId: e.approvalId, checkNumber: e.checkNumber ?? '' }));
  if (entries.length === 0) {
    return NextResponse.json({ error: 'No entries provided' }, { status: 400 });
  }

  let count: number;
  try {
    count = await upsertCheckNumbers(supabase, orgId, entries, userId);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Failed to save check numbers' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'ap.disbursements.check_numbers',
    subjectTable: 'disbursement_check_numbers',
    summary: `Assigned/updated ${count} check number(s) for the pay-run`,
    metadata: { count },
  }).catch(() => {});

  return NextResponse.json({ ok: true, count });
}
