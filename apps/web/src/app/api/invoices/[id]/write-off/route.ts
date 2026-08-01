export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { recordInvoiceEvent } from '@/lib/invoices/invoice-events';
import {
  buildWriteOffJournalLines,
  computeWriteOff,
  resolveBadDebtAccount,
  WriteOffAccountUnresolvedError,
} from '@/lib/invoices/write-off-posting';

/**
 * POST /api/invoices/[id]/write-off — write off an uncollectible receivable.
 *
 * Posts a balanced entry:  DR Bad Debt Expense / CR Accounts Receivable (role
 * AR_CONTROL) for the invoice's open balance. The issuance entry is left intact
 * (the revenue was earned); this recognizes the loss and relieves AR. The
 * invoice's paid-amount is advanced to its total so `balance_cents` goes to zero
 * and it drops out of AR aging totals, and status → WRITTEN_OFF.
 *
 * Idempotent two ways: (1) a WRITTEN_OFF invoice short-circuits; (2) the GL post
 * carries source_ref `invoice_writeoff:<id>`, and migration 064's UNIQUE index
 * (org_id, source_ref, entry_type) makes the DB the double-post guarantor.
 *
 * Requires invoices:approve. GL author columns stay null (canon §2).
 */
const bodySchema = z.object({ reason: z.string().min(1).max(500).optional() });

const WRITE_OFF_SOURCE_REF = (id: string) => `invoice_writeoff:${id}`;

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const guard = await requirePermission(userId, 'invoices', 'approve');
  if (!guard.ok) return guard.response;

  let reason = 'Uncollectible — bad debt write-off';
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (parsed.success && parsed.data.reason) reason = parsed.data.reason.trim();
  } catch {
    /* empty body is fine */
  }

  const supabase = createAdminSupabase();

  const { data: inv, error } = await supabase
    .from('invoices')
    .select('id, status, gl_entry_id, location_id, job_id, invoice_date, total_cents, amount_paid_cents, balance_cents, invoice_number')
    .eq('org_id', orgId)
    .eq('id', params.id)
    .single();
  if (error || !inv) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

  const status = inv.status as string;

  // Idempotency: already written off.
  if (status === 'WRITTEN_OFF') {
    return NextResponse.json({ ok: true, already_written_off: true, status: 'WRITTEN_OFF' });
  }
  // Terminal / invalid states.
  if (status === 'VOIDED') {
    return NextResponse.json(
      { error: 'A voided invoice has no receivable to write off.', code: 'CANNOT_WRITE_OFF_VOIDED' },
      { status: 409 },
    );
  }
  if (status === 'PAID') {
    return NextResponse.json(
      { error: 'This invoice is fully paid — there is nothing to write off.', code: 'NOTHING_TO_WRITE_OFF' },
      { status: 409 },
    );
  }
  // A DRAFT (never posted) has no AR on the books; void it instead.
  if (!inv.gl_entry_id) {
    return NextResponse.json(
      {
        error: 'This invoice was never posted to the GL, so there is no receivable to write off. Void it instead.',
        code: 'INVOICE_NOT_POSTED',
      },
      { status: 409 },
    );
  }

  const { writeOffCents, newPaidCents } = computeWriteOff({
    totalCents: Number(inv.total_cents ?? 0),
    amountPaidCents: Number(inv.amount_paid_cents ?? 0),
  });
  if (writeOffCents <= 0) {
    return NextResponse.json(
      { error: 'The open balance is zero — there is nothing to write off.', code: 'NOTHING_TO_WRITE_OFF' },
      { status: 409 },
    );
  }

  try {
    const ar = await resolveRole(supabase, orgId, 'AR_CONTROL');
    const badDebt = await resolveBadDebtAccount(supabase, orgId);

    const jeLines = buildWriteOffJournalLines({
      badDebtAccountId: badDebt.id,
      arAccountId: ar.id,
      locationId: inv.location_id as string,
      jobId: inv.job_id as string | null,
      amountCents: writeOffCents,
    });

    const jeResult = await postJournalEntry(supabase, {
      org_id: orgId,
      location_id: inv.location_id as string,
      entry_date: inv.invoice_date as string,
      entry_type: 'STANDARD',
      memo: `Bad debt write-off — invoice ${inv.invoice_number}: ${reason}`,
      source_module: 'AR',
      source_id: inv.id,
      // migration 064 UNIQUE (org_id, source_ref, entry_type) WHERE source_ref
      // NOT NULL — a concurrent/duplicate write-off fails at insert rather than
      // orphaning a second bad-debt entry.
      source_ref: WRITE_OFF_SOURCE_REF(inv.id),
      created_by: null,
      lines: jeLines,
    });

    if (!jeResult.success || !jeResult.entry_id) {
      return NextResponse.json({ error: `GL post failed: ${jeResult.error ?? 'unknown'}` }, { status: 500 });
    }

    // Relieve the balance + mark WRITTEN_OFF. Guard on the prior status so two
    // racing write-offs can't both advance the paid-amount.
    const { error: upErr } = await supabase
      .from('invoices')
      .update({ status: 'WRITTEN_OFF', amount_paid_cents: newPaidCents, updated_at: new Date().toISOString() })
      .eq('id', inv.id)
      .eq('org_id', orgId)
      .neq('status', 'WRITTEN_OFF');
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    await recordInvoiceEvent(supabase, {
      orgId,
      invoiceId: inv.id,
      type: 'WRITTEN_OFF',
      actor: userId,
      meta: { reason, write_off_cents: writeOffCents, gl_entry_id: jeResult.entry_id, bad_debt_account_id: badDebt.id },
    });

    await supabase.from('audit_log').insert({
      org_id: orgId,
      table_name: 'invoices',
      record_id: inv.id,
      action: 'UPDATE',
      field_name: 'status',
      old_value: status,
      new_value: 'WRITTEN_OFF',
      user_id: userId,
    });

    return NextResponse.json({
      ok: true,
      status: 'WRITTEN_OFF',
      write_off_cents: writeOffCents,
      gl_entry_id: jeResult.entry_id,
    });
  } catch (err) {
    if (err instanceof WriteOffAccountUnresolvedError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 });
    }
    if (err instanceof PostingError) {
      return NextResponse.json({ error: err.message, code: 'ACCOUNT_ROLE_UNRESOLVED' }, { status: 422 });
    }
    console.error('[invoice write-off]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Internal error' }, { status: 500 });
  }
}
