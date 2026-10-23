export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Each attachment is one AI read; give a multi-invoice email room to finish.
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { readInboundConfig } from '@/lib/email/inbound-config';
import { preVerifyInboundHeaders, verifyInboundRequest } from '@/lib/email/inbound-auth';
import { parseInbound } from '@/lib/email/inbound-adapters';
import { processInboundEmail } from '@/lib/email/inbound-process';

/**
 * POST /api/webhooks/inbound-email — the payables / receipts email inbox ingress
 * (FPB-ap-intake). PUBLIC route (middleware matcher `/api/webhooks(.*)`): there is no
 * user session, so it is authenticated by the PROVIDER instead — and fails closed:
 *
 *   INBOUND_EMAIL_PROVIDER=postmark (default)  HTTP Basic auth from the webhook URL
 *                                             (Postmark does not sign webhooks)
 *   INBOUND_EMAIL_PROVIDER=sendgrid           ECDSA signature (security policy) or Basic auth
 *   INBOUND_EMAIL_PROVIDER=generic            HMAC-SHA256 signature or the shared secret
 *
 * The IP allowlist and header-only credentials are checked BEFORE the body is read;
 * signature verification then runs on the RAW bytes before any parsing. Then the provider adapter
 * normalizes the body to an `InboundEmail`, and the orchestrator routes each
 * recipient to a company address (ap-<company>@… / receipts-<company>@…), dedupes,
 * applies sender rules and hands it to the purpose handler. Nothing here posts to
 * the GL: AP mail becomes PROPOSED draft bills for a human to approve.
 *
 * Status codes: 401 unauthenticated · 400 unreadable body · 413 too large · 403 no
 * inbox matches (Postmark stops retrying) · 500 a step failed (the provider retries;
 * dedupe makes that safe) · 200 otherwise.
 */

/** Larger than any provider's inbound message limit (Postmark: 35 MB). */
const MAX_BODY_BYTES = 40 * 1024 * 1024;

function callerIp(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]?.trim() || null;
  return req.headers.get('x-real-ip');
}

function unauthorized(reason: string, provider: string): NextResponse {
  if (reason === 'not_configured') {
    console.warn(`[inbound-email] rejected: ${provider} credential is not configured or too short (fail closed)`);
  }
  return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401 });
}

export async function POST(req: Request): Promise<NextResponse> {
  const cfg = readInboundConfig();
  const ip = callerIp(req);

  // IP allowlist + header-only credentials BEFORE reading an unauthenticated body.
  const pre = preVerifyInboundHeaders({ cfg, headers: req.headers, ip });
  if (pre) return unauthorized(pre.reason, cfg.provider);

  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Message too large', code: 'TOO_LARGE' }, { status: 413 });
  }
  let raw: Uint8Array;
  try {
    raw = new Uint8Array(await req.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Unreadable body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Message too large', code: 'TOO_LARGE' }, { status: 413 });
  }

  const verified = verifyInboundRequest({ cfg, headers: req.headers, rawBody: raw, ip });
  if (!verified.ok) return unauthorized(verified.reason, cfg.provider);

  const parsed = await parseInbound(cfg.provider, raw, req.headers.get('content-type') ?? '', new Date(), { trustedAuthservIds: cfg.trustedAuthservIds });
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, code: 'PARSE_ERROR' }, { status: 400 });
  }

  try {
    const result = await processInboundEmail(parsed.email, { admin: createAdminSupabase(), cfg });
    return NextResponse.json(result.body, { status: result.status });
  } catch (e) {
    console.error('[inbound-email] unhandled', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'Processing failed', code: 'PROCESSING_FAILED' }, { status: 500 });
  }
}
