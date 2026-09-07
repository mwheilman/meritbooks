export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseTrialBalance, TRIAL_BALANCE_EXTRACT_FEATURE, type TrialBalanceLine } from '@/lib/onboarding/tb-import/parse-tb';

/**
 * POST /api/onboarding/import/tb — DROP-AND-PARSE trial-balance import.
 *
 * Accepts an uploaded prior-system TRIAL BALANCE (multipart `file`: PDF/JPEG/PNG/WebP),
 * runs it through the Core AI gateway (feature TRIAL_BALANCE_EXTRACT, metered +
 * budget-capped per tenant), and returns the PROPOSED rows PRE-SHAPED for the EXISTING
 * historical-conversion path (`POST /api/onboarding/conversion`, body `{ mapping, rows }`).
 * The UI reviews the proposed rows, then hands them — together with the chosen company
 * and as-of date — to the conversion route, which does the source→COA mapping, the
 * tie-out gate, and the balanced OPENING_BALANCE posting.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger or
 * any conversion session. Its only write is a single `ai_decisions` PROPOSED audit row
 * (feature TRIAL_BALANCE_EXTRACT, org-scoped) for explainability, mirroring the debt and
 * statement parse routes. The document is TRANSIENT — decoded and extracted in-request,
 * never persisted here. AI proposes; a human confirms via the existing conversion path.
 *
 * Access: authenticated org context (fail closed 400 when no org). RLS enforces tenant
 * isolation on both the gateway metering and the audit write.
 *
 * The `{ mapping, rows }` output matches the conversion route's `CreateBody`: `mapping`
 * is `{ [conversionFieldKey]: headerName }` (keys = CONVERSION_SOURCE_FIELDS keys —
 * `source_account`, `source_name`, `debit_cents`, `credit_cents`) and `rows` is an array
 * of `Record<string,string>` keyed by those header names, with DOLLAR-denominated amounts
 * (the conversion route's `money` coercion converts dollars → cents). `amount_cents` is
 * intentionally left unmapped: we emit explicit Debit/Credit columns.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Human-facing header names used as the CSV-equivalent column keys in the emitted rows. */
const HEADER = {
  account: 'Account',
  name: 'Account Name',
  debit: 'Debit',
  credit: 'Credit',
} as const;

/**
 * The mapping the conversion route (`CreateBody.mapping`) expects: its CONVERSION_SOURCE_FIELDS
 * keys pointed at the header names present in our `rows`. `amount_cents` is omitted (we emit
 * separate Debit/Credit columns, so `hasAmountColumn` stays false there).
 */
const CONVERSION_MAPPING: Record<string, string> = {
  source_account: HEADER.account,
  source_name: HEADER.name,
  debit_cents: HEADER.debit,
  credit_cents: HEADER.credit,
};

/** Shape one normalized TB line into a conversion `rows` entry (dollar strings). */
function toConversionRow(line: TrialBalanceLine): Record<string, string> {
  return {
    [HEADER.account]: line.account_number ?? line.account_name,
    [HEADER.name]: line.account_name,
    [HEADER.debit]: line.debit != null ? String(line.debit) : '',
    [HEADER.credit]: line.credit != null ? String(line.credit) : '',
  };
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' },
      { status: 503 },
    );
  }

  // ── Read the uploaded file (PDF/image, max 10MB) ─────────────────────────────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });

    fileName = file.name || 'trial-balance';
    mediaType = file.type || 'application/octet-stream';
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 },
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Extract through the metered gateway ──────────────────────────────────────
  const result = await parseTrialBalance({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });
  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  const rows = result.lines.map(toConversionRow);

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ─────
  // Read-only w.r.t. the ledger and conversion sessions — nothing is posted here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: TRIAL_BALANCE_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Trial-balance import — ${fileName}: ${result.lines.length} account lines`.slice(0, 2000),
        proposed_output: {
          kind: 'trial_balance_extraction',
          file_name: fileName,
          line_count: result.lines.length,
          total_debit_cents: result.totalDebitCents,
          total_credit_cents: result.totalCreditCents,
          difference_cents: result.differenceCents,
          balanced: result.balanced,
          document_note: result.documentNote,
          dropped: result.dropped,
          mapping: CONVERSION_MAPPING,
          rows,
        },
        reasoning:
          'Account balances extracted from an uploaded prior-system trial balance; proposed for human review. Confirmed rows flow through the existing historical-conversion path (POST /api/onboarding/conversion), which does the source→COA mapping, the tie-out gate, and the balanced opening entry — the model never posts a ledger entry.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[import/tb] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  // ── Return the proposal PRE-SHAPED for the conversion route's `{ mapping, rows }` ──
  return NextResponse.json({
    // Feed these two straight into POST /api/onboarding/conversion (add companyId + asOfDate).
    mapping: CONVERSION_MAPPING,
    rows,
    // Review context for the UI (the tie-out here is informational; the conversion route
    // re-derives the authoritative, mapping-aware tie-out and gates go-live on it).
    tieOut: {
      balanced: result.balanced,
      totalDebitCents: result.totalDebitCents,
      totalCreditCents: result.totalCreditCents,
      differenceCents: result.differenceCents,
    },
    lines: result.lines,
    dropped: result.dropped,
    documentNote: result.documentNote,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      extractionMs: result.extractionMs,
      lineCount: result.lines.length,
      droppedCount: result.dropped.length,
    },
  });
}
