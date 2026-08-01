export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { getAccountRef, resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  buildAdjustmentLines,
  signedStatementAmountCents,
  DEFAULT_CASH_EFFECT,
  type CashEffect,
} from '@/lib/services/reconciliation-adjustment';

/**
 * POST /api/reconciliation/adjustment — book an adjusting entry from inside a
 * reconciliation (FPB Bank Reconciliation, Wave B / Dimension 6, D6.1).
 *
 * A bank fee or interest credit on the statement that isn't yet in the book keeps
 * a reconciliation from tying. This route:
 *   1. Posts a BALANCED GL entry via `postJournalEntry`
 *        • bank_fee → DR Bank-Fee Expense (MERCHANT_FEE_EXPENSE role, acct 6630)
 *                     / CR Cash (bank_accounts.account_id)
 *        • interest → DR Cash / CR the chosen income account
 *        • other    → the chosen offset account, caller-directed cash effect
 *      Debit/credit direction is derived mechanically from account type; cash is
 *      always the reconciled bank account's OWN GL cash account.
 *   2. Mirrors the entry as a POSTED `bank_transactions` line linked to this
 *      reconciliation (reconciliation_id set, reconciled_at null = cleared, not
 *      yet locked) so it clears immediately and drives the running difference
 *      toward $0.
 *
 * Money-sensitive: RLS-scoped client, require-permission (journal_entries:post),
 * idempotent (gl_entries.source_ref = recadj:<key>), period-lock respected,
 * bigint cents, GL attribution written null (Clerk ids are text). Never posts
 * into a HARD_CLOSE period or a finalized reconciliation.
 */

const bodySchema = z
  .object({
    reconciliation_id: z.string().uuid(),
    adjustment_type: z.enum(['bank_fee', 'interest', 'other']),
    // Positive magnitude in cents; the sign is expressed by the cash effect.
    amount_cents: z.number().int().positive().max(1_000_000_000),
    entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'entry_date must be YYYY-MM-DD'),
    memo: z.string().trim().min(1).max(200),
    // Required for interest/other; optional override for bank_fee.
    offset_account_id: z.string().uuid().optional(),
    // Required for 'other' (which way cash moves); ignored for fee/interest.
    cash_effect: z.enum(['increase', 'decrease']).optional(),
    // Client-generated idempotency token — a retry is a no-op.
    idempotency_key: z.string().uuid(),
  })
  .refine((b) => b.adjustment_type !== 'interest' || !!b.offset_account_id, {
    message: 'interest requires an income offset_account_id',
    path: ['offset_account_id'],
  })
  .refine((b) => b.adjustment_type !== 'other' || (!!b.offset_account_id && !!b.cash_effect), {
    message: 'other requires offset_account_id and cash_effect',
    path: ['offset_account_id'],
  });

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  // Money gate: posting a GL adjustment requires the journal-entry post permission.
  const guard = await requirePermission(userId, 'journal_entries', 'post');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Validation failed', details: parsed.error.flatten() },
      { status: 422 },
    );
  }
  const body = parsed.data;

  // ── Load the reconciliation header (RLS-scoped) ────────────────────────────────
  const { data: recRaw, error: recErr } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, fiscal_period_id, is_reconciled, reconciled_at')
    .eq('id', body.reconciliation_id)
    .maybeSingle();
  if (recErr) return NextResponse.json({ error: 'Failed to load reconciliation' }, { status: 500 });
  if (!recRaw) return NextResponse.json({ error: 'Reconciliation not found' }, { status: 404 });
  const rec = recRaw as {
    id: string;
    bank_account_id: string;
    fiscal_period_id: string;
    is_reconciled: boolean;
    reconciled_at: string | null;
  };
  if (rec.reconciled_at != null || rec.is_reconciled) {
    return NextResponse.json(
      { error: 'Reconciliation is finalized — undo it before adding an adjustment' },
      { status: 409 },
    );
  }

  // ── Resolve the bank account → its GL cash account + location ───────────────────
  const { data: baRaw, error: baErr } = await supabase
    .from('bank_accounts')
    .select('id, account_id, location_id')
    .eq('id', rec.bank_account_id)
    .maybeSingle();
  if (baErr || !baRaw) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  const ba = baRaw as { id: string; account_id: string; location_id: string };

  // ── Period: entry date must fall in the rec's period and not be hard-closed ─────
  const { data: period, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, start_date, end_date, status')
    .eq('id', rec.fiscal_period_id)
    .maybeSingle();
  if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });
  if (period.status === 'HARD_CLOSE') {
    return NextResponse.json({ error: 'Period is hard-closed — cannot adjust' }, { status: 409 });
  }
  if (body.entry_date < (period.start_date as string) || body.entry_date > (period.end_date as string)) {
    return NextResponse.json(
      { error: 'entry_date must fall within the reconciliation period' },
      { status: 422 },
    );
  }

  // ── Idempotency: a repeat with the same key returns the existing entry ──────────
  const sourceRef = `recadj:${body.idempotency_key}`;
  const { data: existing } = await supabase
    .from('gl_entries')
    .select('id, entry_number')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      ok: true,
      idempotent: true,
      entryId: (existing as { id: string }).id,
      entryNumber: (existing as { entry_number: string }).entry_number,
    });
  }

  // ── Resolve accounts (by role / explicit choice) ────────────────────────────────
  const cashEffect: CashEffect =
    body.adjustment_type === 'other'
      ? (body.cash_effect as CashEffect)
      : (DEFAULT_CASH_EFFECT[body.adjustment_type] as CashEffect);

  let cashAccount;
  let offsetAccount;
  try {
    cashAccount = await getAccountRef(supabase, orgId, ba.account_id);
    if (body.offset_account_id) {
      offsetAccount = await getAccountRef(supabase, orgId, body.offset_account_id);
    } else {
      // bank_fee with no explicit choice → the Bank Fees expense role (acct 6630).
      offsetAccount = await resolveRole(supabase, orgId, 'MERCHANT_FEE_EXPENSE', ba.location_id);
    }
  } catch (e) {
    if (e instanceof PostingError) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: 'Failed to resolve accounts' }, { status: 500 });
  }

  // ── Build + post the balanced GL entry ──────────────────────────────────────────
  let lines;
  try {
    lines = buildAdjustmentLines({
      cashAccount,
      offsetAccount,
      amountCents: body.amount_cents,
      cashEffect,
      locationId: ba.location_id,
      memo: body.memo,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Invalid adjustment' }, { status: 422 });
  }

  const posted = await postJournalEntry(supabase, {
    org_id: orgId,
    location_id: ba.location_id,
    entry_date: body.entry_date,
    entry_type: 'ADJUSTING',
    memo: `Bank reconciliation adjustment — ${body.memo}`,
    source_module: 'RECONCILIATION',
    source_ref: sourceRef,
    created_by: null, // GL attribution is uuid + nullable; Clerk ids are text.
    lines,
  });
  if (!posted.success || !posted.entry_id) {
    const msg = posted.error ?? 'Failed to post adjustment';
    const status = /hard-closed/i.test(msg) ? 409 : /fiscal period/i.test(msg) ? 422 : 500;
    return NextResponse.json({ error: msg }, { status });
  }

  // ── Mirror as a POSTED, auto-cleared bank line so the rec ties ───────────────────
  const signedAmount = signedStatementAmountCents(cashEffect, body.amount_cents);
  const { data: txn, error: txnErr } = await supabase
    .from('bank_transactions')
    .insert({
      org_id: orgId,
      bank_account_id: ba.id,
      location_id: ba.location_id,
      transaction_date: body.entry_date,
      description: body.memo,
      amount_cents: signedAmount,
      status: 'POSTED',
      gl_entry_id: posted.entry_id,
      match_type: 'NONE',
      // Auto-clear into THIS reconciliation (cleared, not yet locked).
      reconciliation_id: rec.id,
      reconciled_at: null,
    })
    .select('id')
    .single();

  if (txnErr || !txn) {
    // Roll the GL entry back so the idempotency key is free to retry cleanly.
    await supabase.from('gl_entry_lines').delete().eq('gl_entry_id', posted.entry_id);
    await supabase.from('gl_entries').delete().eq('id', posted.entry_id);
    return NextResponse.json({ error: 'Failed to record the statement line for the adjustment' }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'reconciliation.adjustment',
    subjectTable: 'bank_reconciliations',
    subjectId: rec.id,
    summary: `Adjusting entry ${body.adjustment_type} (${signedAmount} cents) — ${body.memo}`,
    metadata: {
      adjustmentType: body.adjustment_type,
      amountCents: body.amount_cents,
      signedAmountCents: signedAmount,
      entryId: posted.entry_id,
      entryNumber: posted.entry_number,
      bankTransactionId: (txn as { id: string }).id,
    },
  });

  return NextResponse.json(
    {
      ok: true,
      entryId: posted.entry_id,
      entryNumber: posted.entry_number,
      bankTransactionId: (txn as { id: string }).id,
      signedAmountCents: signedAmount,
    },
    { status: 201 },
  );
}
