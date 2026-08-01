export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { resolveInvoiceCreditAccounts } from '@/lib/invoices/rev-rec-credit';
import { buildCreditMemoJournalLines } from '@/lib/invoices/credit-memo-posting';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';

/**
 * POST /api/credit-memos/[id]/post — approve a draft credit memo and post its
 * balanced GL entry:
 *
 *   DR each line's revenue account (or Deferred Revenue 2410 for a rev-rec-
 *      managed linked invoice's job — the SAME resolution the invoice used)
 *   DR Sales Tax Payable for any tax being reversed
 *   CR Accounts Receivable control (role AR_CONTROL) for the full total
 *
 * Idempotent: a memo that already carries a gl_entry_id is not re-posted. Status
 * DRAFT → POSTED. GL author columns are uuid+nullable → null (canon §2). Approval
 * requires invoices:approve.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  const supabase = createAdminSupabase();

  const { data: memo, error: memoErr } = await supabase
    .from('credit_memos')
    .select('id, status, location_id, credit_date, total_cents, subtotal_cents, tax_cents, gl_entry_id, invoice_id, credit_number, memo')
    .eq('org_id', orgId).eq('id', params.id).single();
  if (memoErr || !memo) return NextResponse.json({ error: 'Credit memo not found' }, { status: 404 });

  // Idempotency guard: never post the same credit twice.
  if (memo.gl_entry_id) {
    return NextResponse.json({ ok: true, already_posted: true, gl_entry_id: memo.gl_entry_id, status: memo.status });
  }
  if (memo.status === 'VOIDED') {
    return NextResponse.json({ error: 'A voided credit memo cannot be posted' }, { status: 409 });
  }
  if (memo.status !== 'DRAFT') {
    return NextResponse.json({ error: `Cannot post a credit memo in status ${memo.status}` }, { status: 409 });
  }

  const totalCents = Number(memo.total_cents ?? 0);
  const taxCents = Number(memo.tax_cents ?? 0);
  if (totalCents <= 0) return NextResponse.json({ error: 'Credit memo total must be positive to post' }, { status: 422 });

  const { data: lineRows, error: linesErr } = await supabase
    .from('credit_memo_lines')
    .select('account_id, amount_cents')
    .eq('credit_memo_id', memo.id);
  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 });
  const lines = (lineRows ?? []) as { account_id: string; amount_cents: number }[];
  if (lines.length === 0) return NextResponse.json({ error: 'Credit memo has no lines' }, { status: 422 });

  try {
    // Rev-rec parity: if the credit is tied to an invoice on a rev-rec-managed
    // job, the reversal must DEBIT Deferred Revenue (2410), not the line's
    // revenue account — mirroring how the invoice CREDITED it. Reuse the shared
    // resolver so the two paths never disagree. Ad-hoc credits debit revenue.
    let jobId: string | null = null;
    if (memo.invoice_id) {
      const { data: inv } = await supabase
        .from('invoices').select('job_id').eq('org_id', orgId).eq('id', memo.invoice_id).maybeSingle();
      jobId = (inv as { job_id: string | null } | null)?.job_id ?? null;
    }

    const resolved = await resolveInvoiceCreditAccounts(supabase, {
      orgId,
      locationId: memo.location_id as string,
      jobId,
      lines: lines.map((l) => ({ account_id: l.account_id, amount_cents: Number(l.amount_cents) })),
    });

    const ar = await resolveRole(supabase, orgId, 'AR_CONTROL');
    const salesTax = taxCents > 0 ? await resolveRole(supabase, orgId, 'SALES_TAX_PAYABLE') : null;

    const jeLines = buildCreditMemoJournalLines({
      arAccountId: ar.id,
      locationId: memo.location_id as string,
      jobId,
      debitLines: resolved.map((r) => ({ account_id: r.account_id, amount_cents: r.amount_cents, deferred: r.deferred })),
      taxCents,
      salesTaxAccountId: salesTax?.id ?? null,
    });

    const jeResult = await postJournalEntry(supabase, {
      org_id: orgId,
      location_id: memo.location_id as string,
      entry_date: memo.credit_date as string,
      entry_type: 'STANDARD',
      memo: `Credit memo ${memo.credit_number} — ${memo.memo ?? ''}`.trim(),
      source_module: 'AR',
      source_id: memo.id,
      // Stable dedupe key: migration 064's unique index (org_id, source_ref,
      // entry_type) WHERE source_ref NOT NULL makes the DB the double-post
      // guarantor — a concurrent second post of the same memo fails on insert
      // rather than orphaning a duplicate JE.
      source_ref: `credit_memo:${memo.id}`,
      created_by: null,
      lines: jeLines,
    });

    if (!jeResult.success || !jeResult.entry_id) {
      return NextResponse.json({ error: `GL post failed: ${jeResult.error ?? 'unknown'}` }, { status: 500 });
    }

    const { error: upErr } = await supabase
      .from('credit_memos')
      .update({ gl_entry_id: jeResult.entry_id, status: 'POSTED', updated_at: new Date().toISOString() })
      .eq('id', memo.id).eq('org_id', orgId)
      // Concurrency guard: only claim the DRAFT row, so two racing posts can't
      // both write a GL entry (the loser sees no row updated).
      .is('gl_entry_id', null);
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    // Timeline: a CREDITED event on the linked invoice (best-effort).
    if (memo.invoice_id) {
      await recordInvoiceEvent(supabase, {
        orgId, invoiceId: memo.invoice_id as string, type: 'CREDITED', actor: userId,
        meta: { credit_memo_id: memo.id, credit_number: memo.credit_number, total_cents: totalCents, gl_entry_id: jeResult.entry_id },
      });
    }

    return NextResponse.json({ ok: true, gl_entry_id: jeResult.entry_id, status: 'POSTED' });
  } catch (err) {
    if (err instanceof PostingError) {
      return NextResponse.json({ error: err.message, code: 'ACCOUNT_ROLE_UNRESOLVED' }, { status: 422 });
    }
    console.error('[credit-memo post]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
  }
}
