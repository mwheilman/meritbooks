export const dynamic = 'force-dynamic';
import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { createDocIntakeDraft, listDocIntakeDrafts } from '@/lib/ap/doc-intelligence';

/**
 * GET /api/bills/intake-queue — the AP document-reading review inbox.
 *
 * Returns extracted DRAFTS (ai_decisions, feature AP_DOC_INTAKE). `?status=` may
 * be PROPOSED (default), APPROVED, REJECTED, or ALL.
 */
export async function GET(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Viewing the AP intake queue is a Bills view.
  const guard = await requirePermission(userId, 'bills', 'view');
  if (!guard.ok) return guard.response;

  const url = new URL(request.url);
  const statusParam = (url.searchParams.get('status') ?? 'PROPOSED').toUpperCase();
  const status = (['PROPOSED', 'APPROVED', 'REJECTED', 'ALL'].includes(statusParam)
    ? statusParam
    : 'PROPOSED') as 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'ALL';

  try {
    const drafts = await listDocIntakeDrafts(supabase, orgId, status);
    return NextResponse.json({ drafts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load intake queue', code: 'LIST_FAILED' },
      { status: 500 },
    );
  }
}

/**
 * POST /api/bills/intake-queue — upload/receive a document, extract it via the
 * resolved provider (Azure if configured, else the gateway-routed LLM), and land
 * a PROPOSED draft for human review. NEVER creates a bill or posts to the GL.
 *
 * Multipart body: `file` (the invoice) + `location_id` (the company to file under).
 */
export async function POST(request: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Extracting a draft feeds the Bills queue — gate on bills:create.
  const guard = await requirePermission(userId, 'bills', 'create');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' },
      { status: 500 },
    );
  }

  let base64: string;
  let mediaType: string;
  let fileName: string;
  let locationId: string;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    locationId = String(formData.get('location_id') ?? '').trim();

    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });
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
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 },
      );
    }
    if (file.size > 10 * 1024 * 1024) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    base64 = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  const result = await createDocIntakeDraft(
    supabase,
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64, mediaType, fileName, locationId },
  );

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'EXTRACT_FAILED' },
      { status: result.budgetBlocked ? 429 : 422 },
    );
  }

  return NextResponse.json(
    {
      draft_id: result.draftId,
      provider: result.providerName,
      confidence: result.confidence,
      proposal: result.proposal,
    },
    { status: 201 },
  );
}
