export const dynamic = 'force-dynamic';

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { declineWithToken, requestMeta, signWithToken } from '@/lib/esign/public';
import { isTokenShape } from '@/lib/esign/token';

/**
 * PUBLIC (no sign-in; middleware lets /api/sign/public/* through). The token in the path is the
 * only credential; the database (esign.sign / esign.decline, anon key, no service role) checks it
 * is unexpired, unused and unrevoked, and records IP / browser / time with the signature.
 */
const Body = z.discriminatedUnion('op', [
  z.object({ op: z.literal('sign'), typedName: z.string().trim().min(2).max(120), signaturePng: z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/), consent: z.literal(true) }),
  z.object({ op: z.literal('decline'), reason: z.string().trim().min(2).max(1000) }),
]);

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

export async function POST(req: NextRequest, { params }: { params: { token: string } }): Promise<NextResponse> {
  if (!isTokenShape(params.token)) return json(404, { ok: false, reason: 'invalid' });
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 450_000) return json(413, { ok: false, reason: 'signature_required', error: 'The signature image is too large.' });
  let raw: unknown;
  try { raw = await req.json(); } catch { return json(400, { ok: false, reason: 'invalid_body' }); }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0]?.path[0];
    const reason = first === 'consent' ? 'consent_required' : first === 'typedName' ? 'name_required' : first === 'signaturePng' ? 'signature_required' : first === 'reason' ? 'reason_required' : 'invalid_body';
    return json(422, { ok: false, reason });
  }
  const meta = requestMeta(req.headers);
  const state = parsed.data.op === 'sign'
    ? await signWithToken(params.token, { typedName: parsed.data.typedName, signaturePng: parsed.data.signaturePng, consent: true }, meta)
    : await declineWithToken(params.token, parsed.data.reason, meta);
  return json(state.ok ? 200 : state.reason === 'unavailable' ? 503 : 409, state);
}
