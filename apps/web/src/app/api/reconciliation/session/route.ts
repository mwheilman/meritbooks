export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { fetchCoreMap } from '@/lib/stitch-core';
import { resolveActor } from '@/lib/trust/actor';
import { logHumanAction } from '@/lib/trust/action-log';
import { computeGlCashBalanceCents } from '@/lib/services/reconciliation-gl';
import {
  reconciliationDifferenceCents,
  splitClearedTotals,
  isReconcilable,
  lineClearedUpdate,
  lineFinalizedUpdate,
  lineUnreconciledUpdate,
} from '@/lib/services/reconciliation-balance';

/**
 * /api/reconciliation/session — the per-line reconciliation workspace (FPB Wave A).
 *
 * Replaces the old read-time "cleared = POSTED && gl_entry_id" INFERENCE with an
 * EXPLICIT, persisted per-line reconciliation state (migration 065:
 * bank_transactions.reconciliation_id + reconciled_at):
 *
 *   • GET  → the workspace read model for one bank account + fiscal period:
 *            the statement lines with their cleared/locked state, the beginning
 *            balance (carried from the prior finalized reconciliation), the
 *            running cleared totals, and the difference-to-$0.
 *   • POST → four controller actions on a reconciliation:
 *            - start        upsert a DRAFT header (statement ending balance);
 *                           the GL book balance is computed server-side.
 *            - toggle_line  check / uncheck a statement line (stamp / clear
 *                           reconciliation_id) — cleared, but not yet locked.
 *            - finalize     require difference = 0, then LOCK: stamp the header
 *                           (is_reconciled, reconciled_at, reconciled_by) and
 *                           reconciled_at on every cleared line.
 *            - unreconcile  UNDO: clear the header flags and detach every line
 *                           (reconciliation_id/reconciled_at → null). Audited.
 *
 * This route never posts to the GL and never marks a bank line POSTED — clearing
 * to the book stays the job of the bank-feed approve/posting path. Reconciliation
 * only proves the book ties to the statement. All writes go through the RLS-scoped
 * client; money is bigint cents; cross-schema (core) entities are stitched in JS.
 */

interface BankAccountRow {
  id: string;
  account_name: string;
  account_mask: string | null;
  account_type: string;
  account_id: string; // GL cash account
  location_id: string;
}

interface TxnRow {
  id: string;
  description: string | null;
  amount_cents: number | string;
  transaction_date: string;
  status: string;
  gl_entry_id: string | null;
  reconciliation_id: string | null;
  reconciled_at: string | null;
}

interface RecHeader {
  id: string;
  statement_ending_balance_cents: number | string;
  gl_balance_cents: number | string;
  is_reconciled: boolean;
  reconciled_at: string | null;
  statement_date: string;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── GET: workspace read model ─────────────────────────────────────────────────
export async function GET(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const { searchParams } = new URL(request.url);
  const bankAccountId = searchParams.get('bank_account_id');
  const fiscalPeriodId = searchParams.get('fiscal_period_id');
  if (!bankAccountId || !fiscalPeriodId) {
    return NextResponse.json({ error: 'bank_account_id and fiscal_period_id are required' }, { status: 400 });
  }

  const { data: acctRaw, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_type, account_id, location_id')
    .eq('id', bankAccountId)
    .maybeSingle();
  if (acctErr) return NextResponse.json({ error: 'Failed to load bank account' }, { status: 500 });
  if (!acctRaw) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });
  const account = acctRaw as BankAccountRow;

  const { data: period, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, period_year, period_month, start_date, end_date, status')
    .eq('org_id', orgId)
    .eq('id', fiscalPeriodId)
    .maybeSingle();
  if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });

  // Statement lines within the period window.
  const { data: txnsRaw, error: txnErr } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date, status, gl_entry_id, reconciliation_id, reconciled_at')
    .eq('bank_account_id', bankAccountId)
    .gte('transaction_date', period.start_date)
    .lte('transaction_date', period.end_date)
    .order('transaction_date', { ascending: true });
  if (txnErr) return NextResponse.json({ error: 'Failed to load transactions' }, { status: 500 });
  const txns = (txnsRaw ?? []) as TxnRow[];

  // The current reconciliation header for this account + period (most recent).
  const { data: recRaw } = await supabase
    .from('bank_reconciliations')
    .select('id, statement_ending_balance_cents, gl_balance_cents, is_reconciled, reconciled_at, statement_date')
    .eq('bank_account_id', bankAccountId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const header = (recRaw as RecHeader | null) ?? null;
  const recId = header?.id ?? null;
  const isFinalized = !!header && (header.reconciled_at != null || header.is_reconciled);

  // Beginning balance: carry forward the prior FINALIZED reconciliation's
  // statement ending balance for this bank account (migration 065 does not add a
  // beginning-balance column — Dimension 13 item 2 is a later wave — so we derive
  // it from the prior finalized header instead of persisting it).
  let beginningBalanceCents = 0;
  const { data: prior } = await supabase
    .from('bank_reconciliations')
    .select('statement_ending_balance_cents, statement_date')
    .eq('bank_account_id', bankAccountId)
    .eq('is_reconciled', true)
    .lt('statement_date', period.end_date)
    .order('statement_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (prior) beginningBalanceCents = num(prior.statement_ending_balance_cents);

  const clearedLines = txns
    .filter((t) => recId != null && t.reconciliation_id === recId)
    .map((t) => ({ amountCents: num(t.amount_cents) }));
  const totals = splitClearedTotals(clearedLines);

  const statementEndingBalanceCents = header ? num(header.statement_ending_balance_cents) : null;
  const glCashBalanceCents = await computeGlCashBalanceCents(supabase, {
    orgId,
    locationId: account.location_id,
    accountId: account.account_id,
    endDate: period.end_date,
  });

  const differenceCents =
    statementEndingBalanceCents != null
      ? reconciliationDifferenceCents({ statementEndingBalanceCents, beginningBalanceCents, clearedLines })
      : null;

  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase,
    'locations',
    'id, name, short_code',
    [account.location_id],
  );
  const loc = locMap.get(account.location_id) ?? null;

  const lines = txns.map((t) => {
    const amountCents = num(t.amount_cents);
    return {
      id: t.id,
      description: t.description ?? 'Bank transaction',
      amountCents,
      isOutflow: amountCents < 0,
      transactionDate: t.transaction_date,
      status: t.status,
      // cleared = checked off into THIS reconciliation (persisted, not inferred).
      cleared: recId != null && t.reconciliation_id === recId,
      // locked = part of a finalized reconciliation (its own, or another period's).
      locked: t.reconciled_at != null,
      // informational: whether this line has hit the GL book.
      glPosted: t.status === 'POSTED' && !!t.gl_entry_id,
      // linked to a DIFFERENT reconciliation → not selectable here.
      linkedElsewhere: t.reconciliation_id != null && t.reconciliation_id !== recId,
    };
  });

  return NextResponse.json({
    account: {
      id: account.id,
      accountName: account.account_name,
      accountMask: account.account_mask ?? '',
      accountType: account.account_type,
      locationId: account.location_id,
      locationName: loc?.name ?? '',
      locationCode: loc?.short_code ?? '',
    },
    period: {
      id: period.id,
      year: period.period_year,
      month: period.period_month,
      startDate: period.start_date,
      endDate: period.end_date,
      status: period.status,
    },
    reconciliation: header
      ? {
          id: header.id,
          statementEndingBalanceCents: num(header.statement_ending_balance_cents),
          glBalanceCents: num(header.gl_balance_cents),
          isReconciled: header.is_reconciled,
          reconciledAt: header.reconciled_at,
          isFinalized,
        }
      : null,
    summary: {
      beginningBalanceCents,
      statementEndingBalanceCents,
      glCashBalanceCents,
      clearedDepositsCents: totals.depositsCents,
      clearedPaymentsCents: totals.paymentsCents,
      clearedNetCents: totals.netCents,
      clearedBalanceCents: beginningBalanceCents + totals.netCents,
      clearedCount: clearedLines.length,
      unclearedCount: lines.filter((l) => !l.cleared && !l.linkedElsewhere).length,
      differenceCents,
      ties: differenceCents === 0,
    },
    lines,
  });
}

// ── POST: controller actions ──────────────────────────────────────────────────
const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start'),
    bank_account_id: z.string().uuid(),
    fiscal_period_id: z.string().uuid(),
    statement_ending_balance_cents: z.number().int(),
  }),
  z.object({
    action: z.literal('toggle_line'),
    reconciliation_id: z.string().uuid(),
    transaction_id: z.string().uuid(),
    cleared: z.boolean(),
  }),
  z.object({ action: z.literal('finalize'), reconciliation_id: z.string().uuid() }),
  z.object({ action: z.literal('unreconcile'), reconciliation_id: z.string().uuid() }),
]);

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

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

  // ── start: create / update a draft header ────────────────────────────────────
  if (body.action === 'start') {
    const { data: ba, error: baErr } = await supabase
      .from('bank_accounts')
      .select('id, account_id, location_id')
      .eq('id', body.bank_account_id)
      .maybeSingle();
    if (baErr || !ba) return NextResponse.json({ error: 'Bank account not found' }, { status: 404 });

    const { data: period, error: pErr } = await supabase
      .from('fiscal_periods')
      .select('id, end_date, status')
      .eq('org_id', orgId)
      .eq('id', body.fiscal_period_id)
      .maybeSingle();
    if (pErr || !period) return NextResponse.json({ error: 'Fiscal period not found' }, { status: 404 });
    if (period.status === 'HARD_CLOSE') {
      return NextResponse.json({ error: 'Period is hard-closed — cannot reconcile' }, { status: 409 });
    }

    const glBalanceCents = await computeGlCashBalanceCents(supabase, {
      orgId,
      locationId: ba.location_id as string,
      accountId: ba.account_id as string,
      endDate: period.end_date as string,
    });

    // Reuse an existing NON-finalized header for this account+period, else insert.
    const { data: existing } = await supabase
      .from('bank_reconciliations')
      .select('id, is_reconciled, reconciled_at')
      .eq('bank_account_id', body.bank_account_id)
      .eq('fiscal_period_id', body.fiscal_period_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing && (existing.reconciled_at != null || existing.is_reconciled)) {
      return NextResponse.json(
        { error: 'This period is already reconciled — undo it before editing' },
        { status: 409 },
      );
    }

    if (existing) {
      const { data, error } = await supabase
        .from('bank_reconciliations')
        .update({
          statement_ending_balance_cents: body.statement_ending_balance_cents,
          gl_balance_cents: glBalanceCents,
          statement_date: period.end_date,
        })
        .eq('id', existing.id)
        .select('id')
        .single();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true, reconciliationId: data.id, glBalanceCents });
    }

    const { data, error } = await supabase
      .from('bank_reconciliations')
      .insert({
        org_id: orgId,
        bank_account_id: body.bank_account_id,
        fiscal_period_id: body.fiscal_period_id,
        statement_ending_balance_cents: body.statement_ending_balance_cents,
        gl_balance_cents: glBalanceCents,
        statement_date: period.end_date,
        is_reconciled: false,
      })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, reconciliationId: data.id, glBalanceCents }, { status: 201 });
  }

  // Load the target header (shared by the remaining actions), RLS-scoped.
  const { data: recRaw, error: recErr } = await supabase
    .from('bank_reconciliations')
    .select('id, bank_account_id, fiscal_period_id, statement_ending_balance_cents, is_reconciled, reconciled_at')
    .eq('id', body.reconciliation_id)
    .maybeSingle();
  if (recErr) return NextResponse.json({ error: 'Failed to load reconciliation' }, { status: 500 });
  if (!recRaw) return NextResponse.json({ error: 'Reconciliation not found' }, { status: 404 });
  const header = recRaw as {
    id: string;
    bank_account_id: string;
    fiscal_period_id: string;
    statement_ending_balance_cents: number | string;
    is_reconciled: boolean;
    reconciled_at: string | null;
  };
  const finalized = header.reconciled_at != null || header.is_reconciled;

  // ── toggle_line: check / uncheck a statement line ────────────────────────────
  if (body.action === 'toggle_line') {
    if (finalized) {
      return NextResponse.json({ error: 'Reconciliation is finalized — undo it to change lines' }, { status: 409 });
    }
    const { data: txn, error: txnErr } = await supabase
      .from('bank_transactions')
      .select('id, bank_account_id, reconciliation_id, reconciled_at')
      .eq('id', body.transaction_id)
      .maybeSingle();
    if (txnErr) return NextResponse.json({ error: 'Failed to load transaction' }, { status: 500 });
    if (!txn) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
    const t = txn as { id: string; bank_account_id: string; reconciliation_id: string | null; reconciled_at: string | null };
    if (t.bank_account_id !== header.bank_account_id) {
      return NextResponse.json({ error: 'Transaction is not on this bank account' }, { status: 400 });
    }
    if (t.reconciled_at != null) {
      return NextResponse.json({ error: 'Line is locked by a finalized reconciliation' }, { status: 409 });
    }
    if (body.cleared) {
      if (t.reconciliation_id != null && t.reconciliation_id !== header.id) {
        return NextResponse.json({ error: 'Line is already part of another reconciliation' }, { status: 409 });
      }
      const { error } = await supabase
        .from('bank_transactions')
        .update(lineClearedUpdate(header.id))
        .eq('id', body.transaction_id)
        .is('reconciled_at', null);
      if (error) return NextResponse.json({ error: 'Failed to clear line' }, { status: 500 });
    } else {
      // Only detach if it currently belongs to THIS draft.
      const { error } = await supabase
        .from('bank_transactions')
        .update(lineUnreconciledUpdate())
        .eq('id', body.transaction_id)
        .eq('reconciliation_id', header.id)
        .is('reconciled_at', null);
      if (error) return NextResponse.json({ error: 'Failed to uncheck line' }, { status: 500 });
    }
    return NextResponse.json({ ok: true, cleared: body.cleared });
  }

  // ── finalize: require difference = 0, then lock ──────────────────────────────
  if (body.action === 'finalize') {
    if (finalized) return NextResponse.json({ error: 'Reconciliation is already finalized' }, { status: 409 });

    // Period lock: no finalize into a hard-closed period.
    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('status, end_date')
      .eq('id', header.fiscal_period_id)
      .maybeSingle();
    if (period?.status === 'HARD_CLOSE') {
      return NextResponse.json({ error: 'Period is hard-closed — cannot finalize' }, { status: 409 });
    }

    // Recompute the difference server-side from the CLEARED lines — never trust
    // a client-asserted "it ties".
    const { data: clearedRaw } = await supabase
      .from('bank_transactions')
      .select('amount_cents')
      .eq('reconciliation_id', header.id);
    const clearedLines = (clearedRaw ?? []).map((r) => ({ amountCents: num((r as { amount_cents: number }).amount_cents) }));

    const beginningBalanceCents = await priorEndingBalanceCents(
      supabase,
      header.bank_account_id,
      (period?.end_date as string) ?? null,
    );
    const differenceCents = reconciliationDifferenceCents({
      statementEndingBalanceCents: num(header.statement_ending_balance_cents),
      beginningBalanceCents,
      clearedLines,
    });
    if (!isReconcilable(differenceCents)) {
      return NextResponse.json(
        { error: 'Difference is not zero — reconciliation does not tie', differenceCents },
        { status: 422 },
      );
    }

    const finalizedAt = new Date().toISOString();
    const { coreUserId } = await resolveActor(supabase, userId);

    const { error: hdrErr } = await supabase
      .from('bank_reconciliations')
      .update({ is_reconciled: true, reconciled_at: finalizedAt, reconciled_by: coreUserId })
      .eq('id', header.id)
      .is('reconciled_at', null); // guard against a concurrent finalize
    if (hdrErr) return NextResponse.json({ error: 'Failed to finalize reconciliation' }, { status: 500 });

    // Lock every cleared line by stamping reconciled_at.
    const stamp = lineFinalizedUpdate(header.id, finalizedAt);
    const { error: lineErr } = await supabase
      .from('bank_transactions')
      .update({ reconciled_at: stamp.reconciled_at })
      .eq('reconciliation_id', header.id)
      .is('reconciled_at', null);
    if (lineErr) return NextResponse.json({ error: 'Failed to lock reconciled lines' }, { status: 500 });

    await logHumanAction(supabase, userId, orgId, {
      action: 'reconciliation.finalize',
      subjectTable: 'bank_reconciliations',
      subjectId: header.id,
      summary: `Finalized reconciliation — ${clearedLines.length} lines cleared, difference $0`,
      metadata: { clearedCount: clearedLines.length, differenceCents },
    });

    return NextResponse.json({ ok: true, reconciledAt: finalizedAt, clearedCount: clearedLines.length });
  }

  // ── unreconcile: undo, detach all lines ──────────────────────────────────────
  if (body.action === 'unreconcile') {
    if (!finalized) return NextResponse.json({ error: 'Reconciliation is not finalized' }, { status: 409 });

    const { data: period } = await supabase
      .from('fiscal_periods')
      .select('status')
      .eq('id', header.fiscal_period_id)
      .maybeSingle();
    if (period?.status === 'HARD_CLOSE') {
      return NextResponse.json({ error: 'Period is hard-closed — cannot unreconcile' }, { status: 409 });
    }

    const { data: clearedRaw } = await supabase
      .from('bank_transactions')
      .select('id')
      .eq('reconciliation_id', header.id);
    const clearedCount = (clearedRaw ?? []).length;

    const { error: lineErr } = await supabase
      .from('bank_transactions')
      .update(lineUnreconciledUpdate())
      .eq('reconciliation_id', header.id);
    if (lineErr) return NextResponse.json({ error: 'Failed to detach reconciled lines' }, { status: 500 });

    const { error: hdrErr } = await supabase
      .from('bank_reconciliations')
      .update({ is_reconciled: false, reconciled_at: null, reconciled_by: null })
      .eq('id', header.id);
    if (hdrErr) return NextResponse.json({ error: 'Failed to reopen reconciliation' }, { status: 500 });

    await logHumanAction(supabase, userId, orgId, {
      action: 'reconciliation.unreconcile',
      subjectTable: 'bank_reconciliations',
      subjectId: header.id,
      summary: `Unreconciled — reopened and detached ${clearedCount} lines`,
      metadata: { clearedCount },
    });

    return NextResponse.json({ ok: true, detachedCount: clearedCount });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}

/**
 * Beginning balance for a reconciliation: the statement ending balance of the
 * most recent FINALIZED reconciliation on the same bank account dated before
 * this period end. Zero if there is none (first-ever reconciliation).
 */
async function priorEndingBalanceCents(
  supabase: Parameters<typeof computeGlCashBalanceCents>[0],
  bankAccountId: string,
  endDate: string | null,
): Promise<number> {
  if (!endDate) return 0;
  const { data } = await supabase
    .from('bank_reconciliations')
    .select('statement_ending_balance_cents, statement_date')
    .eq('bank_account_id', bankAccountId)
    .eq('is_reconciled', true)
    .lt('statement_date', endDate)
    .order('statement_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ? Number(data.statement_ending_balance_cents ?? 0) : 0;
}
