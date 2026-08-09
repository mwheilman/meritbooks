export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  parseBankStatement,
  dedupeKey,
  STATEMENT_EXTRACT_FEATURE,
  type StatementAccountType,
} from '@/lib/bank/statement-parse';
import { storeSourceDocument } from '@/lib/documents/store-source';

/**
 * Bank statement PDF import — DROP-AND-PARSE for accounts WITHOUT a Plaid connection.
 *
 * GET  /api/bank-feed/import-statement
 *   Lists the org's bank accounts (RLS-scoped) with a `plaidLinked` flag so the UI can
 *   offer manual/non-Plaid accounts as import targets and refuse Plaid-linked ones (that
 *   live feed is authoritative). Returns account name/mask/type + entity for the picker.
 *
 * POST /api/bank-feed/import-statement   (multipart: `file`, `bank_account_id`)
 *   Runs the uploaded statement through the Core AI gateway (feature STATEMENT_EXTRACT,
 *   metered + budget-capped per tenant), returns the PROPOSED transactions, the balance
 *   tie-out (opening/closing vs the sum of lines — liability-side for credit cards), and a
 *   per-line duplicate flag (matched against existing bank_transactions for that account).
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to bank_transactions
 * or the ledger. Its only write is a single `ai_decisions` PROPOSED audit row. The human
 * reviews/edits/confirms in the UI, and only confirmed lines persist via the sibling
 * `confirm` route (status='PENDING'), flowing into the EXISTING categorize/reconcile
 * pipeline. Refuses Plaid-linked accounts (409) — their live feed is the source of truth.
 *
 * Access: gated on the existing `bank_feed` permission ('edit'). RLS enforces tenant
 * isolation on the account lookup, gateway metering, and the audit write.
 *
 * Storage: the statement PDF IS RETAINED. It is uploaded to the private `documents`
 * bucket BEFORE the AI runs and linked to the bank account (entity_type='bank_account'),
 * so the source is kept even when AI is disabled or a parse fails. Its id is returned as
 * `meta.sourceDocumentId`.
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
  plaid_account_id: string | null;
  is_active: boolean;
}

export async function GET(): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bank_feed', 'view');
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_type, location_id, plaid_account_id, is_active')
    .eq('is_active', true)
    .order('account_name');
  if (error) {
    return NextResponse.json({ error: error.message, code: 'QUERY_ERROR' }, { status: 500 });
  }

  const rows = (data ?? []) as Array<Omit<BankAccountRow, 'account_id'>>;
  // Stitch entity (location) names from core (no cross-schema embed).
  const locIds = [...new Set(rows.map((r) => r.location_id).filter(Boolean))];
  const { data: locs } = locIds.length
    ? await supabase.schema('core').from('locations').select('id, name').in('id', locIds)
    : { data: [] as Array<{ id: string; name: string }> };
  const locById = new Map((locs ?? []).map((l) => [l.id, l.name]));

  const accounts = rows.map((r) => ({
    id: r.id,
    label: r.account_name,
    mask: r.account_mask,
    type: r.account_type,
    locationId: r.location_id,
    locationName: locById.get(r.location_id) ?? 'Entity',
    plaidLinked: r.plaid_account_id != null,
  }));

  return NextResponse.json({ ok: true, accounts });
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'bank_feed', 'edit');
  if (!guard.ok) return guard.response;

  // ── Read the uploaded file + target account FIRST (before any AI gate) ────────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  let bankAccountId: string;
  let sourceFile: File;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    bankAccountId = String(formData.get('bank_account_id') ?? '').trim();
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    if (!bankAccountId) {
      return NextResponse.json({ error: 'A target bank account is required', code: 'NO_ACCOUNT' }, { status: 400 });
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
    sourceFile = file;
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Resolve + guard the target account (RLS-scoped) ──────────────────────────
  const { data: acct, error: acctErr } = await supabase
    .from('bank_accounts')
    .select('id, account_name, account_mask, account_type, plaid_account_id, is_active')
    .eq('id', bankAccountId)
    .maybeSingle();
  if (acctErr) return NextResponse.json({ error: acctErr.message, code: 'QUERY_ERROR' }, { status: 500 });
  const account = acct as Pick<
    BankAccountRow,
    'id' | 'account_name' | 'account_mask' | 'account_type' | 'plaid_account_id' | 'is_active'
  > | null;
  if (!account) {
    return NextResponse.json({ error: 'Bank account not found', code: 'ACCOUNT_NOT_FOUND' }, { status: 404 });
  }
  if (account.plaid_account_id != null) {
    return NextResponse.json(
      {
        error:
          'This account is linked to Plaid — its live feed is the source of truth. Statement import is only for manual (non-Plaid) accounts.',
        code: 'PLAID_LINKED',
      },
      { status: 409 },
    );
  }

  // ── Retain the SOURCE statement regardless of the parse (task #71) ───────────
  // Linked to the bank account immediately (the account is known + RLS-validated
  // here); surfaces in the Documents center as a STATEMENT for this account. Kept
  // even when AI is disabled or the parse fails.
  const stored = await storeSourceDocument({
    supabase, orgId, userId, file: sourceFile, docType: 'STATEMENT',
    entityType: 'bank_account', entityId: account.id,
  });
  const sourceDocumentId = stored?.documentId ?? null;

  // ── Anthropic key — obtained solely to inject into the Core AI gateway ───────
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY', sourceDocumentId },
      { status: 503 },
    );
  }

  // ── Extract through the metered gateway (authoritative account type) ─────────
  const result = await parseBankStatement(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType, accountType: account.account_type },
  );
  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED', sourceDocumentId },
      { status },
    );
  }

  const { statement } = result;

  // ── Duplicate flags: match proposed lines to EXISTING bank_transactions ──────
  // Multiset match by (date, signed cents, normalized description) within the
  // statement's date span, so an already-imported line is flagged (not silently
  // re-added). Two identical NEW lines are both kept unless both match existing rows.
  const dates = statement.transactions
    .map((t) => t.transaction_date)
    .filter((d): d is string => !!d)
    .sort();
  const existingKeyCounts = new Map<string, number>();
  if (dates.length > 0) {
    const { data: existing } = await supabase
      .from('bank_transactions')
      .select('transaction_date, amount_cents, description')
      .eq('bank_account_id', bankAccountId)
      .gte('transaction_date', dates[0])
      .lte('transaction_date', dates[dates.length - 1]);
    for (const e of (existing ?? []) as Array<{ transaction_date: string; amount_cents: number; description: string }>) {
      const k = dedupeKey(e.transaction_date, e.amount_cents, e.description);
      existingKeyCounts.set(k, (existingKeyCounts.get(k) ?? 0) + 1);
    }
  }

  const remaining = new Map(existingKeyCounts);
  const transactions = statement.transactions.map((t) => {
    const k = dedupeKey(t.transaction_date, t.amount_cents, t.description);
    let duplicate = false;
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      duplicate = true;
      remaining.set(k, left - 1);
    }
    return { ...t, dedupeKey: k, duplicate };
  });
  const duplicateCount = transactions.filter((t) => t.duplicate).length;

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ─────
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: STATEMENT_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Bank statement import — ${fileName} → ${account.account_name}`.slice(0, 2000),
        proposed_output: {
          kind: 'bank_statement_extraction',
          file_name: fileName,
          bank_account_id: bankAccountId,
          account_type: account.account_type,
          period: { start: statement.periodStart, end: statement.periodEnd },
          opening_cents: statement.openingCents,
          closing_cents: statement.closingCents,
          balance_tie: statement.balanceTie,
          line_count: transactions.length,
          duplicate_count: duplicateCount,
          document_note: statement.documentNote,
          transactions,
        },
        reasoning:
          'Transactions extracted from an uploaded bank/credit-card statement; proposed for human review. Confirmed lines are inserted into bank_transactions (status=PENDING) and flow through the standard categorize/reconcile pipeline — the model never writes a bank line or a ledger entry.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[import-statement] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    account: {
      id: account.id,
      label: account.account_name,
      mask: account.account_mask,
      type: account.account_type,
    },
    statement: {
      accountHeader: statement.account,
      periodStart: statement.periodStart,
      periodEnd: statement.periodEnd,
      openingCents: statement.openingCents,
      closingCents: statement.closingCents,
      balanceTie: statement.balanceTie,
      documentNote: statement.documentNote,
      transactions,
    },
    meta: {
      fileName,
      model: result.model,
      decisionId,
      sourceDocumentId,
      extractionMs: result.extractionMs,
      lineCount: transactions.length,
      duplicateCount,
    },
  });
}
