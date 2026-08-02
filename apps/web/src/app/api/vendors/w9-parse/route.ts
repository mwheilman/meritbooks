export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseW9Document, W9_EXTRACT_FEATURE } from '@/lib/vendors/w9-parse';

/**
 * Vendor W-9 DROP-AND-PARSE intake.
 *
 *   POST /api/vendors/w9-parse   — extract a proposed tax identity from an uploaded W-9.
 *   PUT  /api/vendors/w9-parse   — confirm the reviewed proposal onto the vendor.
 *
 * Canon §3 boundary: POST is AI PROPOSING facts — it writes NOTHING to the vendor.
 * Its only write is a single `ai_decisions` PROPOSED audit row (feature W9_EXTRACT).
 * The human reviews/edits in the UI; PUT persists ONLY the fields Books OWNS on
 * `core.vendors` per the ownership matrix, and flips `w9_status` → RECEIVED (which
 * feeds 1099 readiness). It also upserts a `vendor_compliance_docs` W-9 row so the
 * compliance surface reflects the document on file.
 *
 * OWNERSHIP GAPS (reported, not written this wave):
 *  - The raw TIN is masked in the proposal and NEVER persisted. `core.vendors` has
 *    only `tin_encrypted` and Books has no server-side encryption path — TIN
 *    persistence is a Core-owned follow-up. The confirm records tin_last4 in the
 *    audit row only.
 *  - There is NO federal-tax-classification / exempt-payee-code column on
 *    core.vendors; entity type is surfaced + audited but not stored as a column.
 *
 * Access: gated on the existing `vendors`/`edit` permission (identity write).
 * Storage: the document is TRANSIENT — decoded to base64 and extracted in-request,
 * never persisted (no W-9 storage bucket exists; standing one up is a follow-up).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!userId) return NextResponse.json({ error: 'Unauthenticated', code: 'NO_USER' }, { status: 401 });

  const guard = await requirePermission(userId, 'vendors', 'edit');
  if (!guard.ok) return guard.response;

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
  let vendorId: string | null = null;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    vendorId = (formData.get('vendor_id') as string | null) || null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });

    fileName = file.name || 'w9';
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

  const result = await parseW9Document(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType },
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json({ error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' }, { status });
  }

  // Log the proposal to the AI decision rail (PROPOSED). Nothing is written to the
  // vendor here. The raw TIN is already masked in the proposal — only tin_last4 is
  // audited, never the full number.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: W9_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `W-9 extraction — ${fileName}${vendorId ? ` (vendor ${vendorId})` : ''}`.slice(0, 2000),
        proposed_output: {
          kind: 'w9_extraction',
          file_name: fileName,
          vendor_id: vendorId,
          document_note: result.documentNote,
          proposal: result.proposal,
        },
        reasoning:
          'Tax identity extracted from an uploaded Form W-9, proposed for human review. Confirmed via the gated vendor identity path — the model never writes the vendor. Raw TIN masked; not persisted.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[vendors/w9-parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    proposal: result.proposal,
    meta: {
      fileName,
      vendorId,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}

// ── Confirm the reviewed W-9 onto the vendor ──────────────────────────────────

const confirmSchema = z.object({
  vendor_id: z.string().uuid(),
  decision_id: z.string().uuid().optional(),
  legal_name: z.string().trim().min(1).max(255),
  business_name: z.string().trim().max(255).nullish(),
  address_line1: z.string().trim().max(255).nullish(),
  address_line2: z.string().trim().max(255).nullish(),
  city: z.string().trim().max(120).nullish(),
  state: z.string().trim().max(60).nullish(),
  zip: z.string().trim().max(20).nullish(),
  is_1099_eligible: z.boolean(),
  /** Record tin_last4 on the audit trail only (never the full number). */
  tin_last4: z.string().trim().regex(/^\d{4}$/).nullish(),
  /** When true, flip w9_status → RECEIVED and record a VALID W-9 compliance doc. */
  mark_w9_on_file: z.boolean().default(true),
});

export async function PUT(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!userId) return NextResponse.json({ error: 'Unauthenticated', code: 'NO_USER' }, { status: 401 });

  const guard = await requirePermission(userId, 'vendors', 'edit');
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 422 });
  }
  const b = parsed.data;

  // Confirm the vendor belongs to this org (RLS already scopes, but fail explicitly).
  const { data: existing, error: vErr } = await supabase
    .schema('core').from('vendors')
    .select('id')
    .eq('org_id', orgId).eq('id', b.vendor_id)
    .single();
  if (vErr || !existing) return NextResponse.json({ error: 'Vendor not found', code: 'NO_VENDOR' }, { status: 404 });

  // Write ONLY the fields Books owns on core.vendors (ownership matrix). TIN and
  // federal-tax-classification are intentionally NOT written (no owned column).
  const update: Record<string, unknown> = {
    name: b.legal_name,
    is_1099_eligible: b.is_1099_eligible,
    updated_at: new Date().toISOString(),
  };
  if (b.business_name !== undefined && b.business_name !== null) update.display_name = b.business_name;
  if (b.address_line1 !== undefined) update.address_line1 = b.address_line1 ?? null;
  if (b.address_line2 !== undefined) update.address_line2 = b.address_line2 ?? null;
  if (b.city !== undefined) update.city = b.city ?? null;
  if (b.state !== undefined) update.state = b.state ? b.state.toUpperCase() : null;
  if (b.zip !== undefined) update.zip = b.zip ?? null;
  if (b.mark_w9_on_file) update.w9_status = 'RECEIVED';

  const { error: upErr } = await supabase
    .schema('core').from('vendors')
    .update(update)
    .eq('org_id', orgId).eq('id', b.vendor_id);
  if (upErr) {
    console.error('[vendors/w9-parse] vendor update failed:', upErr.message);
    return NextResponse.json({ error: 'Failed to update vendor', detail: upErr.message }, { status: 500 });
  }

  // Reflect the document on the compliance surface: upsert a VALID W-9 doc row.
  let complianceDocRecorded = false;
  if (b.mark_w9_on_file) {
    const today = new Date().toISOString().slice(0, 10);
    const { data: existingDoc } = await supabase
      .from('vendor_compliance_docs')
      .select('id')
      .eq('org_id', orgId).eq('vendor_id', b.vendor_id).eq('doc_type', 'W9')
      .limit(1)
      .maybeSingle();
    if (existingDoc?.id) {
      const { error } = await supabase
        .from('vendor_compliance_docs')
        .update({ status: 'VALID', issued_date: today, verified_by: null, verified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('id', existingDoc.id);
      complianceDocRecorded = !error;
    } else {
      const { error } = await supabase
        .from('vendor_compliance_docs')
        .insert({ org_id: orgId, vendor_id: b.vendor_id, doc_type: 'W9', status: 'VALID', issued_date: today });
      complianceDocRecorded = !error;
    }
  }

  // Close out the PROPOSED decision (ai_decisions.status ∈ PROPOSED|APPROVED|
  // REJECTED|EXPIRED — APPROVED is the confirm state). tin_last4 only in the note.
  if (b.decision_id) {
    try {
      await supabase
        .from('ai_decisions')
        .update({
          status: 'APPROVED',
          disposition_by_user: userId,
          disposition_at: new Date().toISOString(),
          disposition_note:
            `Confirmed W-9 for vendor ${b.vendor_id}: ${b.legal_name}` +
            ` · 1099 ${b.is_1099_eligible ? 'eligible' : 'exempt'}` +
            (b.tin_last4 ? ` · TIN …${b.tin_last4}` : '') +
            (b.mark_w9_on_file ? ' · W-9 on file' : ''),
        })
        .eq('org_id', orgId).eq('id', b.decision_id).eq('status', 'PROPOSED');
    } catch (e) {
      console.error('[vendors/w9-parse] decision close failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({
    ok: true,
    vendorId: b.vendor_id,
    complianceDocRecorded,
    // Reported: fields Books cannot persist without a Core-owned schema change.
    reported: {
      tinNotStored: 'core.vendors has only tin_encrypted and no Books encryption path — TIN not persisted (tin_last4 audited only).',
      entityTypeNotStored: 'No federal-tax-classification column on core.vendors — entity type surfaced + audited, not stored.',
    },
  });
}
