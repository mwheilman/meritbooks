export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parsePrepaidDocument, PREPAID_EXTRACT_FEATURE } from '@/lib/prepaid/extract';
import { resolvePrepaidAssetAccount } from '@/lib/prepaid/prepaid-asset';

/**
 * POST /api/prepaid/parse — DROP-AND-PARSE a prepaid invoice/agreement.
 *
 * Runs the uploaded document through the Core AI gateway (feature PREPAID_EXTRACT,
 * metered + budget-capped per tenant) and returns the PROPOSED schedule fields
 * (amount, term, start/end, vendor, expense hint) for human review.
 *
 * Canon §3: AI PROPOSES — it writes NOTHING to `posting_schedules` or the ledger.
 * Its only write is one `ai_decisions` PROPOSED audit row for explainability; the
 * human confirms in the UI and the schedule persists via the gated `POST /api/prepaid`.
 * The document is TRANSIENT (decoded in-request, never stored — no storage bucket
 * exists yet; reported as a follow-up).
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
    return NextResponse.json({ error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' }, { status: 503 });
  }

  // Read the uploaded file (transient; never stored).
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
      return NextResponse.json({ error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    base64Data = Buffer.from(await file.arrayBuffer()).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  const result = await parsePrepaidDocument({ supabase, anthropicApiKey: apiKey }, { orgId, userId, base64Data, mediaType });
  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json({ error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' }, { status });
  }

  // Suggest the prepaid-asset credit leg (resolved by role/name), for the form default.
  let prepaidAsset: { id: string; name: string } | null = null;
  try {
    const resolved = await resolvePrepaidAssetAccount(supabase);
    if (resolved) prepaidAsset = { id: resolved.id, name: resolved.name };
  } catch {
    /* best-effort */
  }

  // Log the proposal to the AI decision rail (PROPOSED) — read-only w.r.t. schedules.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: PREPAID_EXTRACT_FEATURE,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Prepaid extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'prepaid_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          prepaid: result.prepaid,
          suggested_prepaid_account: prepaidAsset,
        },
        confidence: result.prepaid.confidence.total ?? null,
        reasoning:
          'Prepaid schedule fields extracted from an uploaded document; proposed for human review. The schedule is created only via the gated /api/prepaid path — the model never posts.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[prepaid/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    prepaid: result.prepaid,
    suggestedPrepaidAccount: prepaidAsset,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
