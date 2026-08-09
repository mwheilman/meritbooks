export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { signedUrlQuery } from '@/lib/documents/schema';
import { getSignedUrl } from '@/lib/documents/store';

/**
 * /api/documents/[id]/signed-url
 *
 * GET — mint a short-lived signed URL (default 5 min) to view/download the object.
 *       The private `documents` bucket is never publicly readable; ownership is
 *       enforced by first re-fetching the row through the RLS client (wrong tenant →
 *       404), so a caller can only sign an object for a row they can see.
 */

interface Params {
  params: { id: string };
}

export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const parsed = signedUrlQuery.safeParse(Object.fromEntries(searchParams.entries()));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query parameters', code: 'VALIDATION_ERROR' }, { status: 422 });
  }

  try {
    const signed = await getSignedUrl(ctx.supabase, params.id, parsed.data.expires_in, {
      download: parsed.data.download !== '0',
    });
    if (!signed) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json(signed);
  } catch (err) {
    console.error('[documents] sign failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to sign URL', code: 'SIGN_FAILED' },
      { status: 500 },
    );
  }
}
