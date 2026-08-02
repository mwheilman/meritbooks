export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { deleteDocument } from '@/lib/documents/store';

/**
 * /api/documents/[id]
 *
 * DELETE — remove a document: the Storage object first, then the metadata row.
 *          Ownership is enforced by RLS on the row read/delete (wrong tenant → 404).
 */

interface Params {
  params: { id: string };
}

export async function DELETE(_request: Request, { params }: Params): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;

  try {
    const ok = await deleteDocument(ctx.supabase, params.id);
    if (!ok) return NextResponse.json({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[documents] delete failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Delete failed', code: 'DELETE_FAILED' },
      { status: 500 },
    );
  }
}
