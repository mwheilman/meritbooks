export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logAction } from '@/lib/trust/action-log';

/**
 * POST /api/customers/merge — human-approved duplicate-customer merge.
 *
 * The dedupe detector only PROPOSES (canon §3); the actual merge happens here,
 * behind a human, gated on `customers:edit`. It re-points the Books-owned AR
 * artifacts (invoices, customer payments, credit memos, recurring templates)
 * from the duplicate to the survivor and soft-deletes the duplicate master.
 *
 * SAFETY / RECONCILIATION (canon §3 — money must reconcile):
 *   - refuses self-merge, a missing/other-org customer, or an already-deleted side;
 *   - the duplicate is SOFT-deleted (deleted_at), never hard-deleted, so any
 *     core-owned FK that still points at it (e.g. core.jobs.customer_id, owned by
 *     the Projects module) stays valid — we never write a core business object we
 *     don't own; job references are reported as advisory, not silently rewritten;
 *   - after re-pointing it VERIFIES the survivor's open-AR equals the pre-merge
 *     (survivor + duplicate) open-AR and that the duplicate retains zero open
 *     invoices. If reconciliation fails, the duplicate is NOT retired and the
 *     route returns 409 so nothing is stranded.
 */

interface MergeBody {
  survivor_id?: string;
  duplicate_id?: string;
}

const OPEN_STATUSES = ['SENT', 'PARTIALLY_PAID', 'OVERDUE'];

async function openArFor(
  supabase: SupabaseClient,
  orgId: string,
  customerId: string,
): Promise<{ balanceCents: number; openCount: number }> {
  const { data } = await supabase
    .from('invoices')
    .select('balance_cents, status')
    .eq('org_id', orgId)
    .eq('customer_id', customerId)
    .in('status', OPEN_STATUSES);
  let balanceCents = 0;
  let openCount = 0;
  for (const inv of (data ?? []) as Array<{ balance_cents: number | string }>) {
    const bal = Number(inv.balance_cents) || 0;
    if (bal > 0) {
      balanceCents += bal;
      openCount += 1;
    }
  }
  return { balanceCents, openCount };
}

export async function POST(req: NextRequest) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  // RBAC: merging masters mutates AR ownership — require the customers write grant.
  const guard = await requirePermission(userId, 'customers', 'edit');
  if (!guard.ok) return guard.response;

  let body: MergeBody;
  try {
    body = (await req.json()) as MergeBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const survivorId = body.survivor_id?.trim();
  const duplicateId = body.duplicate_id?.trim();
  if (!survivorId || !duplicateId) {
    return NextResponse.json({ error: 'survivor_id and duplicate_id are required' }, { status: 400 });
  }
  if (survivorId === duplicateId) {
    return NextResponse.json({ error: 'Cannot merge a customer into itself' }, { status: 400 });
  }

  // ── Load both masters, org-scoped, and validate mergeability ────────────────
  const { data: custRows, error: custErr } = await supabase
    .schema('core')
    .from('customers')
    .select('id, name, display_name, deleted_at, notes')
    .eq('org_id', orgId)
    .in('id', [survivorId, duplicateId]);
  if (custErr) {
    return NextResponse.json({ error: 'Failed to load customers' }, { status: 500 });
  }
  const rows = (custRows ?? []) as Array<{
    id: string;
    name: string;
    display_name: string | null;
    deleted_at: string | null;
    notes: string | null;
  }>;
  const survivor = rows.find((r) => r.id === survivorId);
  const duplicate = rows.find((r) => r.id === duplicateId);
  if (!survivor || !duplicate) {
    return NextResponse.json({ error: 'Both customers must exist in this organization' }, { status: 404 });
  }
  if (survivor.deleted_at || duplicate.deleted_at) {
    return NextResponse.json({ error: 'Cannot merge a customer that is already deleted/merged' }, { status: 409 });
  }

  // ── Pre-merge reconciliation baseline ───────────────────────────────────────
  const survivorBefore = await openArFor(supabase, orgId, survivorId);
  const dupBefore = await openArFor(supabase, orgId, duplicateId);
  const expectedSurvivorOpenAr = survivorBefore.balanceCents + dupBefore.balanceCents;
  const expectedSurvivorOpenCount = survivorBefore.openCount + dupBefore.openCount;

  // ── Advisory: core.jobs is owned by the Projects module; we NEVER rewrite it.
  //    Report references so a human knows the soft-deleted master still backs them.
  let jobsReferencing = 0;
  try {
    const { count } = await supabase
      .schema('core')
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('customer_id', duplicateId);
    jobsReferencing = count ?? 0;
  } catch {
    /* jobs table optional; advisory only */
  }

  // ── Re-point Books-owned AR artifacts (fail fast; do NOT retire dup on error) ─
  const repoint = { invoices: 0, payments: 0, creditMemos: 0, recurringTemplates: 0 };

  const inv = await supabase
    .from('invoices')
    .update({ customer_id: survivorId, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('customer_id', duplicateId)
    .select('id');
  if (inv.error) {
    return NextResponse.json({ error: 'Failed to re-point invoices', detail: inv.error.message }, { status: 500 });
  }
  repoint.invoices = inv.data?.length ?? 0;

  const pay = await supabase
    .from('customer_payments')
    .update({ customer_id: survivorId })
    .eq('org_id', orgId)
    .eq('customer_id', duplicateId)
    .select('id');
  if (pay.error) {
    return NextResponse.json({ error: 'Failed to re-point customer payments', detail: pay.error.message }, { status: 500 });
  }
  repoint.payments = pay.data?.length ?? 0;

  // credit_memos + recurring_invoice_templates: best-effort (tables may be sparse),
  // but a hard error still aborts before retiring the duplicate.
  const cm = await supabase
    .from('credit_memos')
    .update({ customer_id: survivorId, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('customer_id', duplicateId)
    .select('id');
  if (cm.error) {
    return NextResponse.json({ error: 'Failed to re-point credit memos', detail: cm.error.message }, { status: 500 });
  }
  repoint.creditMemos = cm.data?.length ?? 0;

  const rt = await supabase
    .from('recurring_invoice_templates')
    .update({ customer_id: survivorId, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('customer_id', duplicateId)
    .select('id');
  if (rt.error) {
    return NextResponse.json({ error: 'Failed to re-point recurring templates', detail: rt.error.message }, { status: 500 });
  }
  repoint.recurringTemplates = rt.data?.length ?? 0;

  // ── Post-merge reconciliation: nothing may be stranded ──────────────────────
  const survivorAfter = await openArFor(supabase, orgId, survivorId);
  const dupAfter = await openArFor(supabase, orgId, duplicateId);
  const reconciled =
    dupAfter.openCount === 0 &&
    survivorAfter.balanceCents === expectedSurvivorOpenAr &&
    survivorAfter.openCount === expectedSurvivorOpenCount;

  if (!reconciled) {
    // Leave the duplicate ACTIVE so nothing is orphaned; a human can re-run.
    return NextResponse.json(
      {
        error: 'Merge did not reconcile — the duplicate was NOT retired',
        code: 'RECONCILE_FAILED',
        reconciliation: {
          expectedSurvivorOpenArCents: expectedSurvivorOpenAr,
          actualSurvivorOpenArCents: survivorAfter.balanceCents,
          duplicateOpenInvoicesRemaining: dupAfter.openCount,
        },
      },
      { status: 409 },
    );
  }

  // ── Retire the duplicate (SOFT delete — keeps core FKs valid) ────────────────
  const mergeNote = `Merged into ${survivor.display_name || survivor.name} (${survivorId}) on ${new Date().toISOString().slice(0, 10)}.`;
  const { error: delErr } = await supabase
    .schema('core')
    .from('customers')
    .update({
      deleted_at: new Date().toISOString(),
      is_active: false,
      notes: duplicate.notes ? `${duplicate.notes}\n${mergeNote}` : mergeNote,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('id', duplicateId);
  if (delErr) {
    return NextResponse.json({ error: 'Re-pointed AR but failed to retire the duplicate', detail: delErr.message }, { status: 500 });
  }

  // ── Audit trail (HUMAN actor; the merge is a human decision) ─────────────────
  await logAction(supabase, {
    orgId,
    actorType: 'HUMAN',
    actorUserId: null,
    action: 'customers.merge',
    subjectTable: 'customers',
    subjectId: survivorId,
    summary: `Merged "${duplicate.name}" into "${survivor.name}" — ${repoint.invoices} invoice(s), ${repoint.payments} payment(s) re-pointed`,
    metadata: {
      survivor_id: survivorId,
      duplicate_id: duplicateId,
      repoint,
      jobs_referencing_duplicate: jobsReferencing,
      merged_by_clerk_user: userId,
    },
  });

  return NextResponse.json({
    merged: true,
    survivorId,
    duplicateId,
    repoint,
    jobsReferencing,
    reconciliation: {
      survivorOpenArCents: survivorAfter.balanceCents,
      survivorOpenInvoices: survivorAfter.openCount,
    },
  });
}
