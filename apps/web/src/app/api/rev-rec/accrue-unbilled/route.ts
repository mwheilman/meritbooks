export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { PostingError } from '@/lib/posting/account-roles';
import { runUnbilledAccrual } from '@/lib/rev-rec/unbilled-accrual-service';

/**
 * Unbilled-revenue (contract-asset) accrual for UNDER-billed jobs.
 *
 * When a job has EARNED more revenue than it has BILLED (WIP under-billing), this
 * lets the controller accrue the earned-but-unbilled revenue and the contract-asset
 * receivable:  DR Unbilled Receivable (1180) / CR Revenue  for the delta needed to
 * bring 1180 up to the WIP under-billing. Adjust-to-target so it's self-reversing
 * and never double-counts; idempotent per job+period.
 *
 * SoD (reuses the journal_entries feature — the accrual IS a journal entry):
 *   GET  (preview only, no posting) → journal_entries:view   (relaxed: any role that
 *                                     can see the ledger may preview what WOULD accrue)
 *   POST (approve / post)           → journal_entries:post    (posting authority approves)
 * Both fail closed. Company-scoped via location_id (a sub-filter inside tenant RLS).
 */

function asOfFrom(url: string): string {
  const v = new URL(url).searchParams.get('as_of');
  if (v && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // Default: last day of the prior month (typical month-end accrual date).
  const d = new Date();
  const lastOfPrevMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return lastOfPrevMonth.toISOString().slice(0, 10);
}

/** GET — preview what WOULD accrue (no posting). */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Preview is read-only (no GL write), so it only needs view rights on the ledger —
  // a view-only role (e.g. CFO) can see what would accrue. Posting stays :post-gated.
  const guard = await requirePermission(userId, 'journal_entries', 'view');
  if (!guard.ok) return guard.response;

  const asOf = asOfFrom(request.url);
  const locationId = new URL(request.url).searchParams.get('location_id');
  try {
    const result = await runUnbilledAccrual(supabase, orgId, {
      locationId,
      asOf,
      runBy: userId,
      preview: true,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'ACCOUNT_ROLE_UNRESOLVED' }, { status: 422 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Preview failed' }, { status: 500 });
  }
}

/** POST { as_of?, location_id?, job_ids? } — accrue and post. */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Posting authority: only roles that can POST journal entries may book the accrual.
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  let body: { as_of?: string; location_id?: string | null; job_ids?: string[] } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body ok */
  }
  const asOf =
    body.as_of && /^\d{4}-\d{2}-\d{2}$/.test(body.as_of) ? body.as_of : asOfFrom(request.url);
  const jobIds = Array.isArray(body.job_ids) ? body.job_ids.filter((x) => typeof x === 'string') : null;

  try {
    const result = await runUnbilledAccrual(supabase, orgId, {
      locationId: body.location_id ?? null,
      asOf,
      runBy: userId,
      preview: false,
      jobIds,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof PostingError) {
      return NextResponse.json({ error: e.message, code: 'ACCOUNT_ROLE_UNRESOLVED' }, { status: 422 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Accrual failed' }, { status: 500 });
  }
}
