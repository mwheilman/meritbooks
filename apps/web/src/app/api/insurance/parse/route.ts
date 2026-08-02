export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parsePolicyDocument, INSURANCE_EXTRACT_FEATURE } from '@/lib/insurance/parse-policy';

/**
 * POST /api/insurance/parse — DROP-AND-PARSE extraction of the company's OWN policies.
 *
 * Accepts an uploaded policy / declarations page (multipart `file`), runs it through
 * the Core AI gateway (feature INSURANCE_EXTRACT, metered + budget-capped per tenant),
 * and returns the PROPOSED policies mapped to the `insurance_policies` fields with
 * per-field confidence and a verbatim declarations snippet for traceability.
 *
 * Canon §3 boundary: AI PROPOSES facts — it WRITES NOTHING to the register or the
 * ledger. Its only write is a single `ai_decisions` PROPOSED audit row (feature
 * INSURANCE_EXTRACT) for explainability. The human reviews/edits/confirms in the UI,
 * and only confirmed rows persist via the gated `POST /api/insurance` create path
 * (RLS + Zod apply there).
 *
 * Access: mirrors the insurance create path, which gates on authenticated org context
 * only — there is no dedicated insurance permission today (reported to the lead). RLS
 * enforces tenant isolation on both the gateway metering and the audit write.
 *
 * Storage: the document is TRANSIENT — decoded to base64 and extracted in-request,
 * never persisted (no policy-document bucket exists; standing one up is a follow-up).
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

  // ── Read the uploaded file (transient; never stored) ─────────────────────────
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

  // ── Extract through the metered gateway ──────────────────────────────────────
  const result = await parsePolicyDocument(
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

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ──────
  // Read-only w.r.t. the register: nothing is written to insurance_policies here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: INSURANCE_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Insurance policy extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'insurance_policy_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          policy_count: result.policies.length,
          policies: result.policies,
        },
        reasoning:
          'Policies extracted from an uploaded insurance document; proposed for human review. Each is confirmed via the gated insurance create path — the model never writes a policy.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[insurance/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    policies: result.policies,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
      policyCount: result.policies.length,
    },
  });
}
