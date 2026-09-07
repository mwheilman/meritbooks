export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseLoanDocument, DEBT_EXTRACT_FEATURE } from '@/lib/debt/parse-loan';
import { resolveUploadedFile } from '@/lib/uploads/resolve-upload';

/**
 * POST /api/debt/parse — DROP-AND-PARSE loan extraction.
 *
 * Accepts an uploaded loan agreement / promissory note (multipart `file`), runs it
 * through the Core AI gateway (feature DEBT_EXTRACT, metered + budget-capped per
 * tenant), and returns the PROPOSED debt terms mapped to the `debt_instruments`
 * fields with per-field confidence and a verbatim snippet for traceability.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger
 * or the register. Its only write is a single `ai_decisions` PROPOSED audit row
 * (feature DEBT_EXTRACT) for explainability. The human reviews/edits/confirms in the
 * UI, and only confirmed terms persist via the gated `POST /api/debt` create path,
 * which then generates the amortization schedule deterministically.
 *
 * Access mirrors the covenant parse path: authenticated org context; RLS enforces
 * tenant isolation on both the gateway metering and the audit write. The document is
 * TRANSIENT — decoded and extracted in-request, never persisted.
 */


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

  // Accepts BOTH a multipart file (small) and a JSON { storagePath } pointing at a
  // file the browser uploaded directly to storage (large — up to 15MB, bypassing the
  // ~4.5MB serverless body limit). resolveUploadedFile enforces org-scoped paths.
  const resolved = await resolveUploadedFile(request, orgId);
  if (resolved instanceof NextResponse) return resolved;
  const { base64Data, mediaType, fileName } = resolved;

  const result = await parseLoanDocument({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  // Log the proposal to the AI decision rail (PROPOSED) for traceability. Read-only
  // w.r.t. the register: nothing is written to debt_instruments here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: DEBT_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Loan extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'loan_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          loan: result.loan,
        },
        reasoning:
          'Debt terms extracted from an uploaded loan document; proposed for human review. Confirmed via the gated debt create path, which generates the amortization schedule deterministically — the model never creates an instrument or writes a schedule.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[debt/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    loan: result.loan,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
