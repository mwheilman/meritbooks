export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseFormationDocument, FORMATION_EXTRACT_FEATURE } from '@/lib/onboarding/formation/parse-formation';

/**
 * POST /api/onboarding/formation/parse — DROP-AND-PARSE formation extraction.
 *
 * Accepts an uploaded formation document (multipart `file`: EIN letter, articles of
 * organization / incorporation, certificate of formation, or operating agreement),
 * runs it through the Core AI gateway (feature FORMATION_EXTRACT, metered + budget-
 * capped per tenant), and returns the PROPOSED legal record mapped to the
 * `core.company_legal_records` fields with per-field confidence and a verbatim
 * snippet for traceability.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the legal
 * record. Its only write is a single `ai_decisions` PROPOSED audit row (feature
 * FORMATION_EXTRACT) for explainability. The human reviews/edits/confirms in the UI,
 * and only the confirmed record persists via the gated confirm path
 * (`POST /api/onboarding/formation`).
 *
 * Access: authenticated org context (fail-closed — 400 when there is no org). RLS
 * enforces tenant isolation on both the gateway metering and the audit write. The
 * document is TRANSIENT — decoded and extracted in-request, never persisted.
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

  const result = await parseFormationDocument(
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

  // Log the proposal to the AI decision rail (PROPOSED) for traceability. Read-only
  // w.r.t. the legal record: nothing is written to core.company_legal_records here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: FORMATION_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Formation extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'formation_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          formation: result.formation,
        },
        reasoning:
          'Company legal record extracted from an uploaded formation document; proposed for human review. Confirmed via the gated formation confirm path, which upserts core.company_legal_records — the model never writes the legal record.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[formation/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    formation: result.formation,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
