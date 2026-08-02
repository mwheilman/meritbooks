export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseAssetInvoice, ASSET_EXTRACT_FEATURE } from '@/lib/fixed-assets/asset-parse';

/**
 * POST /api/fixed-assets/parse-invoice — DROP-AND-PARSE capex → fixed asset.
 *
 * Accepts an uploaded equipment / capital-expenditure invoice (multipart `file`),
 * runs it through the Core AI gateway (feature ASSET_EXTRACT, metered + budget-
 * capped per tenant), and returns the PROPOSED asset(s) with a suggested asset
 * class + useful life + book depreciation method and a capitalize-vs-expense flag.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger
 * or the fixed-asset register. Its only write is a single `ai_decisions` PROPOSED
 * audit row (feature ASSET_EXTRACT). The human reviews/edits/confirms in the UI,
 * and only the confirmed asset persists via the EXISTING gated create path
 * (`POST /api/fixed-assets/parse-invoice/confirm` → `recordAssetAcquisition`,
 * which posts the balanced GL and starts depreciation).
 *
 * Access: gated on `fixed_assets:create` (RBAC) — the same permission the confirm
 * step requires — plus RLS tenant isolation on the gateway metering and audit write.
 *
 * Storage: the document is TRANSIENT — decoded to base64 and extracted in-request,
 * never persisted (no storage bucket for capex invoices today; reported follow-up).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — gate on the existing fixed-asset create permission.
  const guard = await requirePermission(userId, 'fixed_assets', 'create');
  if (!guard.ok) return guard.response;

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

    fileName = file.name || 'invoice';
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
  const result = await parseAssetInvoice(
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
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: ASSET_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Capex invoice extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'asset_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          asset_count: result.assets.length,
          assets: result.assets,
        },
        reasoning:
          'Assets extracted from an uploaded capex invoice; each is proposed with a suggested class/life/method for human review. Confirmation creates the asset via the gated fixed-asset create path — the model never writes an asset or a GL entry.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[fixed-assets/parse-invoice] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    assets: result.assets,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
      assetCount: result.assets.length,
    },
  });
}
