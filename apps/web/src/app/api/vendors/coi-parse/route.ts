export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { parseCoiDocument, COI_EXTRACT_FEATURE } from '@/lib/vendors/coi-parse';

/**
 * Vendor COI (Certificate of Insurance) DROP-AND-PARSE intake.
 *
 *   POST /api/vendors/coi-parse   — extract proposed coverages from an uploaded COI.
 *   PUT  /api/vendors/coi-parse   — confirm the reviewed coverages onto the vendor.
 *
 * Canon §3 boundary: POST is AI PROPOSING facts — it writes NOTHING to the
 * compliance record. Its only write is a single `ai_decisions` PROPOSED audit row
 * (feature COI_EXTRACT). The human reviews/edits in the UI; PUT persists each kept
 * GL / WC coverage line as a VALID `vendor_compliance_docs` row (with its limit +
 * expiration), which the existing compliance/payment-hold engine already consumes.
 *
 * OWNERSHIP GAP (reported, not written this wave): `vendor_compliance_docs` has NO
 * column for carrier, policy number, additional-insured, aggregate limit, or the
 * non-GL/WC coverage lines (auto, umbrella, professional). Those are surfaced to the
 * human and retained in the ai_decisions audit row, but they are NOT persisted as
 * structured columns — a schema addition is the follow-up (no migration this wave).
 *
 * Access: gated on the existing `compliance`/`manage` permission.
 * Storage: the document is TRANSIENT — decoded and extracted in-request, never stored.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!userId) return NextResponse.json({ error: 'Unauthenticated', code: 'NO_USER' }, { status: 401 });

  const guard = await requirePermission(userId, 'compliance', 'manage');
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

    fileName = file.name || 'coi';
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

  const result = await parseCoiDocument(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType },
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json({ error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' }, { status });
  }

  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: COI_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `COI extraction — ${fileName}${vendorId ? ` (vendor ${vendorId})` : ''}`.slice(0, 2000),
        proposed_output: {
          kind: 'coi_extraction',
          file_name: fileName,
          vendor_id: vendorId,
          document_note: result.documentNote,
          coverage_count: result.coi.coverages.length,
          coi: result.coi,
        },
        reasoning:
          'Insurance coverages extracted from an uploaded Certificate of Insurance, proposed for human review. Confirmed coverages persist as VALID vendor_compliance_docs rows via the gated path — the model never writes the record.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[vendors/coi-parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    coi: result.coi,
    meta: {
      fileName,
      vendorId,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
      coverageCount: result.coi.coverages.length,
    },
  });
}

// ── Confirm reviewed coverages onto the vendor compliance record ──────────────

const confirmSchema = z.object({
  vendor_id: z.string().uuid(),
  decision_id: z.string().uuid().optional(),
  docs: z
    .array(
      z.object({
        doc_type: z.enum(['GL_COI', 'WC_COI']),
        // Limit in integer cents (already parsed client-side from the proposal).
        coverage_amount_cents: z.number().int().nonnegative().nullable(),
        effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
        expiration_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .min(1),
});

export async function PUT(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  if (!userId) return NextResponse.json({ error: 'Unauthenticated', code: 'NO_USER' }, { status: 401 });

  const guard = await requirePermission(userId, 'compliance', 'manage');
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

  const { data: existing, error: vErr } = await supabase
    .schema('core').from('vendors')
    .select('id')
    .eq('org_id', orgId).eq('id', b.vendor_id)
    .single();
  if (vErr || !existing) return NextResponse.json({ error: 'Vendor not found', code: 'NO_VENDOR' }, { status: 404 });

  // Upsert one VALID compliance doc per coverage line (keyed on vendor + doc_type).
  let recorded = 0;
  const now = new Date().toISOString();
  for (const d of b.docs) {
    const row = {
      status: 'VALID' as const,
      issued_date: d.effective_date,
      expiration_date: d.expiration_date,
      coverage_amount_cents: d.coverage_amount_cents,
      verified_at: now,
      updated_at: now,
    };
    const { data: existingDoc } = await supabase
      .from('vendor_compliance_docs')
      .select('id')
      .eq('org_id', orgId).eq('vendor_id', b.vendor_id).eq('doc_type', d.doc_type)
      .limit(1)
      .maybeSingle();
    if (existingDoc?.id) {
      const { error } = await supabase.from('vendor_compliance_docs').update(row).eq('id', existingDoc.id);
      if (!error) recorded += 1;
    } else {
      const { error } = await supabase
        .from('vendor_compliance_docs')
        .insert({ org_id: orgId, vendor_id: b.vendor_id, doc_type: d.doc_type, ...row });
      if (!error) recorded += 1;
    }
  }

  if (b.decision_id) {
    try {
      await supabase
        .from('ai_decisions')
        .update({
          status: 'APPROVED',
          disposition_by_user: userId,
          disposition_at: now,
          disposition_note: `Confirmed ${recorded} COI coverage line(s) for vendor ${b.vendor_id}`,
        })
        .eq('org_id', orgId).eq('id', b.decision_id).eq('status', 'PROPOSED');
    } catch (e) {
      console.error('[vendors/coi-parse] decision close failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({
    ok: true,
    vendorId: b.vendor_id,
    recorded,
    // Reported: structured COI detail with no column on vendor_compliance_docs.
    reported: {
      structuredDetailNotStored:
        'vendor_compliance_docs has no column for carrier / policy number / additional-insured / aggregate / non-GL-WC coverages — retained in the ai_decisions audit row; a schema addition is the follow-up (no migration this wave).',
    },
  });
}
