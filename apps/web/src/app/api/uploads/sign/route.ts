export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { DOCUMENTS_BUCKET } from '@/lib/uploads/resolve-upload';

/**
 * POST /api/uploads/sign — mint a one-time SIGNED UPLOAD URL so the browser can send
 * a large document DIRECTLY to the private `documents` bucket, bypassing Vercel's
 * ~4.5MB serverless request-body limit. The object path is namespaced to the caller's
 * org (`intake/{orgId}/…`); the matching download in resolveUploadedFile enforces the
 * same prefix, so a signed URL can only ever land in — and be read from — this tenant's
 * space. Object I/O uses the service role because the bucket's object policies are a
 * separate surface; tenant isolation is enforced by the org-prefixed path on both ends.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  let fileName = 'document';
  try {
    const body = (await request.json()) as { fileName?: unknown };
    if (typeof body?.fileName === 'string' && body.fileName.trim()) fileName = body.fileName;
  } catch {
    /* body optional — default the name */
  }
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'document';
  const path = `intake/${orgId}/${randomUUID()}-${safe}`;

  const admin = createAdminSupabase();
  const { data, error } = await admin.storage.from(DOCUMENTS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    return NextResponse.json({ error: 'Could not prepare the upload', code: 'SIGN_FAILED' }, { status: 500 });
  }
  return NextResponse.json({ path: data.path, token: data.token });
}
