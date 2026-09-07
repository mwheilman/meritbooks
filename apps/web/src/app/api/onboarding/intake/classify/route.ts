export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { classifyDocument, INTAKE_CLASSIFY_FEATURE } from '@/lib/onboarding/intake/classify';

/**
 * POST /api/onboarding/intake/classify — UNIVERSAL DOCUMENT CLASSIFIER.
 *
 * The onboarding front door: a user drops ANY document (multipart `file`) and this route
 * reads the first page/portion THROUGH the Core AI gateway (feature INTAKE_CLASSIFY,
 * metered + budget-capped per tenant) and returns WHAT it is and WHERE it should go —
 * a docType, confidence, the destination page, and the dedicated parse endpoint (if one
 * exists). It does NOT extract the document's contents; the destination parser does that.
 *
 * Canon boundary: this is AI PROPOSING a routing decision — it writes NOTHING to the
 * ledger. Its only write is a single `ai_decisions` PROPOSED audit row (feature
 * INTAKE_CLASSIFY) for explainability, wrapped in a non-fatal try/catch. The document is
 * TRANSIENT — decoded and classified in-request, never persisted.
 *
 * Access mirrors the debt parse path: authenticated org context, fail closed with 400 when
 * there is no org; RLS enforces tenant isolation on the gateway metering and the audit write.
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

  const result = await classifyDocument({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'CLASSIFY_FAILED' },
      { status },
    );
  }

  const { classification } = result;

  // Log the routing proposal to the AI decision rail (PROPOSED) for traceability. Read-only
  // w.r.t. the register: nothing is written to any book-of-record table here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: INTAKE_CLASSIFY_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Intake classification — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'intake_classification',
          file_name: fileName,
          doc_type: classification.docType,
          label: classification.label,
          confidence: classification.confidence,
          route: classification.route,
          parse_endpoint: classification.parseEndpoint,
          note: classification.note,
        },
        reasoning:
          'Document classified during onboarding intake to route it to the correct pipeline; proposed for human confirmation. The classifier only decides WHAT the document is and WHERE it goes — the destination parser extracts its contents, and nothing is written to the ledger here.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[onboarding/intake/classify] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    ok: true,
    docType: classification.docType,
    label: classification.label,
    confidence: classification.confidence,
    route: classification.route,
    parseEndpoint: classification.parseEndpoint,
    note: classification.note,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      classifyMs: result.classifyMs,
    },
  });
}
