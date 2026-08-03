export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { logHumanAction } from '@/lib/trust/action-log';
import { computeGlCashBalanceCents } from '@/lib/services/reconciliation-gl';
import {
  parseBankStatement,
  STATEMENT_EXTRACT_FEATURE,
  type StatementAccountType,
} from '@/lib/bank/statement-parse';
import {
  buildStatementMatchPlan,
  AUTO_CLEAR_THRESHOLD,
  REVIEW_THRESHOLD,
  type StatementLineInput,
  type BookLineInput,
} from '@/lib/services/reconciliation-statement-match';

/**
 * POST /api/reconciliation/import-statement   (multipart: file, bank_account_id, fiscal_period_id)
 *
 * Drops a bank/credit-card statement onto the reconciliation workspace and, in one
 * pass: (1) ANCHORS the reconciliation's statement ending balance (the must-tie
 * target) from the parsed closing balance, and (2) AUTO-CHECKS-OFF the book/bank
 * lines in the period that the statement confirms cleared — matched with the same
 * documented composite matcher the autopilot uses (Vendor 40% + Amount 40% + Date 20%).
 *
 * Disposition (canonical bank-feed cut-lines): composite ≥ 90% ⇒ auto-clear (the book
 * line is linked to the draft reconciliation, exactly as a manual check-off would);
 * 70–89% ⇒ surfaced as a suggested match for the human to accept; below ⇒ reported as
 * "on the statement, no book entry" to investigate. Book lines the statement never
 * mentions are reported as outstanding/in-transit.
 *
 * Canon boundary: this NEVER finalizes and NEVER posts to the GL. It only sets the
 * header target balance and stamps `reconciliation_id` on high-confidence book lines
 * (the same, fully-reversible "cleared, not locked" state as a manual click — undoable
 * by unchecking or unreconciling). The human still runs the must-tie finalize (Wave B).
 * It also writes NOTHING new to `bank_transactions` — it matches against existing lines,
 * so it is safe on both Plaid-fed and manually-imported accounts. The parsed statement
 * lines + the full disposition are persisted to the `ai_decisions` rail (no new table).
 *
 * Degrade-safe: if the AI key is missing (503) or extraction fails (422/429) nothing is
 * mutated. Access: gated on `bank_feed` 'edit'; RLS scopes every read/write to the org.
 */

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface BankAccountRow {
  id: string;
  account_name: string;
  account_mask: string | null;
  account_type: StatementAccountType;
  location_id: string;
  account_id: string;
}

interface PeriodRow {
  id: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface BookTxnRow {
  id: string;
  description: string | null;
  amount_cents: number | string;
  transaction_date: string;
  reconciliation_id: string | null;
  reconciled_at: string | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' },
      { status: 503 },
    );
  }

  // ── Read the upload + targets (statement is transient; never persisted) ───────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  let bankAccountId: string;
  let fiscalPeriodId: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    bankAccountId = String(formData.get('bank_account_id') ?? '').trim();
    fiscalPeriodId = String(formData.get('fiscal_period_id') ?? '').trim();
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    if (!bankAccountId || !fiscalPeriodId) {
      return NextResponse.json(
        { error: 'A target bank account and fiscal period are required', code: 'MISSING_TARGET' },
        { status: 400 },
      );
    }
    fileName = file.name || 'statement';
    mediaType = file.type || 'application/octet-stream';
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 15MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    base64Data = Buffer.from(await file.arrayBuffer()).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Resolve the target account + period (RLS-scoped) ─────────────────────────
  const { data: acctRaw, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_type, location_id, account_id')
    .eq('id', bankAccountId)
    .maybeSingle();
  if (acctErr) return NextResponse.json({ error: acctErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  const account = acctRaw as BankAccountRow | null;
  if (!account) {
    return NextResponse.json({ error: 'Bank account not found', code: 'ACCOUNT_NOT_FOUND' }, { status: 404 });
  }

  const { data: periodRaw, error: pErr } = await supabase
    .from('fiscal_periods')
    .select('id, start_date, end_date, status')
    .eq('org_id', orgId)
    .eq('id', fiscalPeriodId)
    .maybeSingle();
  if (pErr) return NextResponse.json({ error: pErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  const period = periodRaw as PeriodRow | null;
  if (!period) return NextResponse.json({ error: 'Fiscal period not found', code: 'PERIOD_NOT_FOUND' }, { status: 404 });
  if (period.status === 'HARD_CLOSE') {
    return NextResponse.json({ error: 'Period is hard-closed — cannot reconcile', code: 'PERIOD_LOCKED' }, { status: 409 });
  }

  // ── Extract through the metered gateway (authoritative account type) ─────────
  const parsed = await parseBankStatement(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType, accountType: account.account_type },
  );
  if (!parsed.ok) {
    const status = parsed.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: parsed.error, code: parsed.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }
  const { statement } = parsed;

  // ── Anchor the draft reconciliation header (never a finalized one) ───────────
  const closingCents = statement.closingCents;
  const anchored = closingCents != null;
  const glBalanceCents = await computeGlCashBalanceCents(supabase, {
    orgId,
    locationId: account.location_id,
    accountId: account.account_id,
    endDate: period.end_date,
  });

  const { data: existingHdr } = await supabase
    .from('bank_reconciliations')
    .select('id, is_reconciled, reconciled_at, statement_ending_balance_cents')
    .eq('bank_account_id', bankAccountId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const existing = existingHdr as
    | { id: string; is_reconciled: boolean; reconciled_at: string | null; statement_ending_balance_cents: number | string }
    | null;
  if (existing && (existing.reconciled_at != null || existing.is_reconciled)) {
    return NextResponse.json(
      { error: 'This period is already reconciled — undo it before importing a statement', code: 'ALREADY_FINALIZED' },
      { status: 409 },
    );
  }

  let reconciliationId: string;
  if (existing) {
    // Only overwrite the target balance when we actually parsed a closing balance.
    const update: Record<string, unknown> = { gl_balance_cents: glBalanceCents, statement_date: period.end_date };
    if (anchored) update.statement_ending_balance_cents = closingCents;
    const { data, error } = await supabase
      .from('bank_reconciliations')
      .update(update)
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: error.message, code: 'ANCHOR_FAILED' }, { status: 500 });
    reconciliationId = (data as { id: string }).id;
  } else {
    const { data, error } = await supabase
      .from('bank_reconciliations')
      .insert({
        org_id: orgId,
        bank_account_id: bankAccountId,
        fiscal_period_id: fiscalPeriodId,
        // NOT NULL column; use the parsed closing balance, else 0 until the human sets it.
        statement_ending_balance_cents: closingCents ?? 0,
        gl_balance_cents: glBalanceCents,
        statement_date: period.end_date,
        is_reconciled: false,
      })
      .select('id')
      .single();
    if (error) return NextResponse.json({ error: error.message, code: 'ANCHOR_FAILED' }, { status: 500 });
    reconciliationId = (data as { id: string }).id;
  }

  // ── Load candidate book lines in the period (unlocked, not linked elsewhere) ──
  const { data: bookRaw, error: bookErr } = await supabase
    .from('bank_transactions')
    .select('id, description, amount_cents, transaction_date, reconciliation_id, reconciled_at')
    .eq('bank_account_id', bankAccountId)
    .gte('transaction_date', period.start_date)
    .lte('transaction_date', period.end_date)
    .is('reconciled_at', null)
    .order('transaction_date', { ascending: true });
  if (bookErr) return NextResponse.json({ error: bookErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  const bookLines: BookLineInput[] = (bookRaw ?? [])
    .map((r) => r as BookTxnRow)
    // Selectable = not already checked into a DIFFERENT reconciliation.
    .filter((r) => r.reconciliation_id == null || r.reconciliation_id === reconciliationId)
    .map((r) => ({
      id: r.id,
      description: r.description,
      amountCents: num(r.amount_cents),
      transactionDate: r.transaction_date,
    }));

  // ── Build the auto-check-off plan from the parsed statement lines ────────────
  const statementLines: StatementLineInput[] = statement.transactions
    .filter((t): t is typeof t & { transaction_date: string; amount_cents: number } =>
      t.transaction_date != null && t.amount_cents != null && t.amount_cents !== 0,
    )
    .map((t) => ({
      id: t._id,
      description: t.description,
      amountCents: t.amount_cents,
      transactionDate: t.transaction_date,
    }));

  const plan = buildStatementMatchPlan(statementLines, bookLines);

  // ── Apply the auto-clears (fully reversible "cleared, not locked" state) ─────
  let autoClearedCount = 0;
  for (const pair of plan.autoCleared) {
    const { data, error } = await supabase
      .from('bank_transactions')
      .update({ reconciliation_id: reconciliationId, match_confidence: pair.confidence })
      .eq('id', pair.bookLineId)
      .is('reconciliation_id', null)
      .is('reconciled_at', null)
      .select('id')
      .maybeSingle();
    if (!error && data) autoClearedCount += 1;
  }

  // ── Persist the parsed lines + disposition to the AI decision rail ───────────
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: STATEMENT_EXTRACT_FEATURE,
        model_used: parsed.model,
        correlation_id: parsed.correlationId,
        input_summary: `Reconciliation statement import — ${fileName} → ${account.account_name}`.slice(0, 2000),
        proposed_output: {
          kind: 'reconciliation_statement_import',
          file_name: fileName,
          bank_account_id: bankAccountId,
          fiscal_period_id: fiscalPeriodId,
          reconciliation_id: reconciliationId,
          account_type: account.account_type,
          period: { start: statement.periodStart, end: statement.periodEnd },
          opening_cents: statement.openingCents,
          closing_cents: statement.closingCents,
          anchored,
          balance_tie: statement.balanceTie,
          document_note: statement.documentNote,
          statement_lines: statement.transactions,
          disposition: {
            auto_cleared: plan.autoCleared,
            auto_cleared_applied: autoClearedCount,
            needs_review: plan.needsReview,
            unmatched_statement: plan.unmatchedStatement,
            unmatched_book_line_ids: plan.unmatchedBookLineIds,
          },
          thresholds: { auto: AUTO_CLEAR_THRESHOLD, review: REVIEW_THRESHOLD },
        },
        reasoning:
          'Statement dropped on the reconciliation workspace. The closing balance anchors the must-tie target; ' +
          'high-confidence lines are auto-checked-off (cleared, not locked) via the composite matcher. Nothing is ' +
          'posted to the GL and nothing is finalized — the human still runs the must-tie finalize.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[recon/import-statement] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'reconciliation.statement_import',
    subjectTable: 'bank_reconciliations',
    subjectId: reconciliationId,
    summary:
      `Imported statement "${fileName}"${anchored ? ` — anchored ending balance ${closingCents} cents` : ' — closing balance not detected'}` +
      `; auto-cleared ${autoClearedCount} line(s), ${plan.needsReview.length} to review, ${plan.unmatchedStatement.length} on statement with no book entry.`,
    metadata: {
      anchored,
      closingCents,
      autoClearedCount,
      needsReviewCount: plan.needsReview.length,
      unmatchedStatementCount: plan.unmatchedStatement.length,
      unmatchedBookCount: plan.unmatchedBookLineIds.length,
    },
  });

  return NextResponse.json({
    ok: true,
    reconciliationId,
    anchored,
    statementEndingBalanceCents: anchored ? closingCents : null,
    period: { start: statement.periodStart, end: statement.periodEnd },
    balanceTie: statement.balanceTie,
    documentNote: statement.documentNote,
    autoCleared: plan.autoCleared,
    autoClearedCount,
    needsReview: plan.needsReview,
    unmatchedStatement: plan.unmatchedStatement,
    unmatchedBookLineIds: plan.unmatchedBookLineIds,
    counts: {
      statementLines: statementLines.length,
      autoCleared: autoClearedCount,
      needsReview: plan.needsReview.length,
      unmatchedStatement: plan.unmatchedStatement.length,
      unmatchedBook: plan.unmatchedBookLineIds.length,
    },
    meta: { fileName, model: parsed.model, decisionId, extractionMs: parsed.extractionMs },
  });
}
