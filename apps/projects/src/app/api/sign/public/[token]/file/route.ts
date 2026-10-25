export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { documentForToken } from '@/lib/esign/public';
import { fetchSignerDocument } from '@/lib/esign/file';
import { isTokenShape } from '@/lib/esign/token';

/**
 * PUBLIC (no sign-in): GET /api/sign/public/<token>/file — the document being signed. The token is
 * re-validated on every request (esign.document, anon key); a link that can no longer act gets 410.
 * The bytes are streamed through lib/esign/file (one object, 60-second server-side URL). Never cached.
 */
const HEADERS = { 'Cache-Control': 'no-store, private, max-age=0', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };

function gone(status: number, reason: string): NextResponse {
  return NextResponse.json({ ok: false, reason }, { status, headers: HEADERS });
}

export async function GET(_req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  if (!isTokenShape(params.token)) return gone(404, 'invalid');
  const doc = await documentForToken(params.token);
  if (!doc.ok) return doc.reason === 'invalid' ? gone(404, 'invalid') : doc.reason === 'unavailable' ? gone(503, 'unavailable') : gone(410, doc.reason);
  const file = await fetchSignerDocument(doc.path);
  if (!file) return gone(503, 'unavailable');
  const safeName = doc.fileName.replace(/[^\w .()-]+/g, '_').slice(0, 120) || 'document.pdf';
  return new NextResponse(file.body, {
    status: 200,
    headers: {
      ...HEADERS,
      'Content-Type': doc.mimeType === 'application/pdf' ? 'application/pdf' : 'application/octet-stream',
      'Content-Disposition': `inline; filename="${safeName}"`,
      ...(file.contentLength ? { 'Content-Length': file.contentLength } : {}),
    },
  });
}
