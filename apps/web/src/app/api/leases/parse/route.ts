export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseLeaseDocument, LEASE_EXTRACT_FEATURE } from '@/lib/leases/parse-lease';
import { storeSourceDocument } from '@/lib/documents/store-source';

/**
 * POST /api/leases/parse — DROP-AND-PARSE lease extraction (ASC 842).
 *
 * Accepts an uploaded lease agreement (multipart `file`), runs it through the Core AI
 * gateway (feature LEASE_EXTRACT, metered + budget-capped per tenant), and returns the
 * PROPOSED lease terms + a suggested classification with per-field confidence and a
 * verbatim clause snippet.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger or
 * the lease register. Its only write is a single `ai_decisions` PROPOSED audit row for
 * explainability. The human reviews/edits/confirms in the UI; only confirmed terms
 * persist via the gated `POST /api/leases` create path (RLS + Zod + the schedule engine
 * all apply there).
 *
 * Storage: the source document IS RETAINED. It is uploaded to the private `documents`
 * bucket BEFORE the AI runs (kept even when AI is disabled or a parse fails), tagged
 * entity_type='lease', and returned as `meta.sourceDocumentId`. The create path
 * (`POST /api/leases`) links it to the lease it produces.
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

  // ── Retain the SOURCE lease document regardless of the parse (task #71) ──────
  const stored = await storeSourceDocument({
    supabase, orgId, userId, file: sourceFile, docType: 'LEASE', entityType: 'lease',
  });
  const sourceDocumentId = stored?.documentId ?? null;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY', sourceDocumentId },
      { status: 503 },
    );
  }

  const result = await parseLeaseDocument({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED', sourceDocumentId },
      { status },
    );
  }

  // Log the proposal to the AI decision rail (PROPOSED) — writes nothing to the ledger.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: LEASE_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Lease extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'lease_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          lease: result.lease,
        },
        reasoning:
          'Lease terms extracted from an uploaded agreement; proposed for human review. Confirmed via the gated lease create path — the model never writes a lease, ROU asset, liability, or journal line.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[leases/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    lease: result.lease,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      sourceDocumentId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
