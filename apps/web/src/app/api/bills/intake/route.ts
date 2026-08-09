export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { intakeInvoice } from '@/lib/ap/intake';
import { storeSourceDocument, linkSourceDocument } from '@/lib/documents/store-source';

/**
 * POST /api/bills/intake — autonomous AP intake.
 *
 * Multipart body: `file` (the invoice) + `location_id` (the company to file under).
 * Parses the invoice, resolves-or-creates the vendor, tiers it, and writes a
 * PENDING (or ON_HOLD, when low-confidence) bill. NEVER posts to the GL.
 */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  }

  // Authorize — AP intake writes a PENDING bill, so gate on bills:create.
  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  // ── Parse multipart form data FIRST (before any AI gate) ──
  let base64: string;
  let mediaType: string;
  let fileName: string;
  let locationId: string;
  let sourceFile: File;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    locationId = String(formData.get('location_id') ?? '').trim();

    if (!file) {
      return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
    }
    if (!locationId) {
      return NextResponse.json(
        { error: 'Select a company to file this invoice under.', code: 'NO_LOCATION' },
        { status: 400 },
      );
    }

    fileName = file.name;
    mediaType = file.type || 'application/octet-stream';

    const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowed.includes(mediaType)) {
      return NextResponse.json(
        {
          error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`,
          code: 'BAD_FILE_TYPE',
        },
        { status: 400 },
      );
    }

    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json(
        { error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' },
        { status: 400 },
      );
    }

    sourceFile = file;
    const buffer = await file.arrayBuffer();
    base64 = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json(
      { error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' },
      { status: 400 },
    );
  }

  // ── Retain the SOURCE invoice regardless of the parse (task #71) ──
  // Stored as an unfiled 'bill' document up front; linked to the created bill below.
  // Even with AI disabled, the source invoice is retained in the Documents center.
  const stored = await storeSourceDocument({
    supabase, orgId, userId, file: sourceFile, docType: 'BILL', entityType: 'bill',
  });

  // ── Anthropic key — obtained solely to inject into the Core AI gateway ──
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'AI is not configured (Anthropic key missing). Add it to your environment variables.',
        code: 'NO_API_KEY',
        sourceDocumentId: stored?.documentId ?? null,
      },
      { status: 500 },
    );
  }

  // ── Run the intake pipeline ───────────────────────────────
  const result = await intakeInvoice(supabase, {
    orgId,
    locationId,
    apiKey,
    base64,
    mediaType,
    fileName,
    userId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: 'INTAKE_FAILED', sourceDocumentId: stored?.documentId ?? null },
      { status: 422 },
    );
  }

  // Link the retained source invoice to the bill it produced, so it shows on the
  // bill's Documents panel. Best-effort — never fails the intake.
  if (stored?.documentId && result.billId) {
    await linkSourceDocument(supabase, stored.documentId, 'bill', result.billId);
  }

  return NextResponse.json(
    {
      bill_id: result.billId,
      vendor_id: result.vendorId,
      vendor_created: result.vendorCreated,
      tier: result.tier,
      status: result.status,
      confidence: result.confidence,
      lines_created: result.linesCreated,
      source_document_id: stored?.documentId ?? null,
    },
    { status: 201 },
  );
}
