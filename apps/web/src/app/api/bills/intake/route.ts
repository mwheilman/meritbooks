export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { intakeInvoice } from '@/lib/ap/intake';

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
  const { supabase, orgId } = ctx;
  if (!orgId) {
    return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'ANTHROPIC_API_KEY not configured. Add it to your environment variables.',
        code: 'NO_API_KEY',
      },
      { status: 500 },
    );
  }

  // ── Parse multipart form data ─────────────────────────────
  let base64: string;
  let mediaType: string;
  let fileName: string;
  let locationId: string;

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

    const buffer = await file.arrayBuffer();
    base64 = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json(
      { error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' },
      { status: 400 },
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
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error, code: 'INTAKE_FAILED' }, { status: 422 });
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
    },
    { status: 201 },
  );
}
