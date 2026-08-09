export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseCovenantDocument, COVENANT_EXTRACT_FEATURE } from '@/lib/covenants/parse-document';
import { storeSourceDocument } from '@/lib/documents/store-source';

/**
 * POST /api/covenants/parse — DROP-AND-PARSE covenant extraction.
 *
 * Accepts an uploaded credit agreement / loan document (multipart `file`), runs it
 * through the Core AI gateway (feature COVENANT_EXTRACT, metered + budget-capped per
 * tenant), and returns the PROPOSED covenants mapped to the `loan_covenants` fields
 * with per-field confidence and a verbatim clause snippet for traceability.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger or
 * the covenant monitor. Its only write is a single `ai_decisions` PROPOSED audit row
 * (feature COVENANT_EXTRACT) for explainability. The human reviews/edits/confirms in
 * the UI, and only confirmed rows persist via the EXISTING gated `POST /api/covenants`
 * create path (RLS + Zod + the compute engine all apply there).
 *
 * Access: mirrors the existing covenant create path (`POST /api/covenants`), which
 * gates on authenticated org context only — there is no dedicated covenant permission
 * today (see report note). RLS enforces tenant isolation on both the gateway metering
 * and the audit write.
 *
 * Storage: the source document IS RETAINED. It is uploaded to the private `documents`
 * bucket BEFORE the AI runs (so it's kept even when AI is disabled or a parse fails),
 * tagged entity_type='covenant', and its id is returned as `meta.sourceDocumentId`. The
 * create path (`POST /api/covenants`) links it to the covenant it produces.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // ── Read the uploaded file FIRST (before any AI gate) ────────────────────────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  let sourceFile: File;
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
    sourceFile = file;
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Retain the SOURCE document regardless of the parse (task #71) ────────────
  // Stored as an unfiled 'covenant' document; the create path links it to the
  // covenant it produces. Best-effort — never blocks the flow.
  const stored = await storeSourceDocument({
    supabase, orgId, userId, file: sourceFile, docType: 'LOAN', entityType: 'covenant',
  });
  const sourceDocumentId = stored?.documentId ?? null;

  // Anthropic key — obtained solely to inject into the Core AI gateway (canon §2).
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY', sourceDocumentId },
      { status: 503 },
    );
  }

  // ── Extract through the metered gateway ──────────────────────────────────────
  const result = await parseCovenantDocument(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType },
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED', sourceDocumentId },
      { status },
    );
  }

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ──────
  // Read-only w.r.t. the covenant monitor: nothing is written to loan_covenants here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: COVENANT_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Covenant extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'covenant_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          covenant_count: result.covenants.length,
          covenants: result.covenants,
        },
        reasoning:
          'Covenants extracted from an uploaded credit agreement; proposed for human review. Each is confirmed via the gated covenant create path — the model never writes a covenant.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[covenants/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    covenants: result.covenants,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      sourceDocumentId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
      covenantCount: result.covenants.length,
    },
  });
}
