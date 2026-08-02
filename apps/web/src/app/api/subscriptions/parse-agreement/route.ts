export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseAgreementDocument, SUBSCRIPTION_EXTRACT_FEATURE } from '@/lib/subscriptions/parse-agreement';

/**
 * POST /api/subscriptions/parse-agreement — DROP-AND-PARSE the exact terms of a
 * subscription agreement / order form: renewal date, notice period, auto-renew,
 * cancellation method, price + cadence.
 *
 * Runs through the Core AI gateway (feature SUBSCRIPTION_EXTRACT, metered + budget-capped
 * per tenant). Canon §3: AI PROPOSES facts — it WRITES NOTHING to the register or the
 * ledger. Its only write is a single `ai_decisions` PROPOSED audit row for explainability.
 * The human reviews/edits/confirms; confirmed terms persist via the gated create/patch
 * paths (RLS + Zod). The document is TRANSIENT — extracted in-request, never persisted.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

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

  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });

    fileName = file.name || 'document';
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

  const result = await parseAgreementDocument(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType },
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: SUBSCRIPTION_EXTRACT_FEATURE,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Subscription agreement extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'subscription_agreement_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          terms: result.terms,
        },
        reasoning:
          'Terms extracted from an uploaded subscription agreement; proposed for human review. Confirmed via the gated create/patch path — the model never writes the register.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[subscriptions/parse-agreement] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    terms: result.terms,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
