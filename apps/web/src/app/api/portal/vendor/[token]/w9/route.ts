export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { validatePortalToken, touchTokenUsage } from '@/lib/portal/vendor/tokens';
import { sharedRateLimiter, clientIp, retryAfterSeconds } from '@/lib/security/rate-limit';
import { w9FormBody } from '@/lib/validations/vendor-compliance';
import { submitW9Form, W9FormError } from '@/lib/vendor-compliance/w9-form';

const PER_TOKEN = { windowMs: 60_000, max: 6 } as const;
const PER_IP = { windowMs: 60_000, max: 20 } as const;

/**
 * POST /api/portal/vendor/[token]/w9 — the fill-here W-9 (public, no login).
 *
 * The token is the only credential: org + vendor come from its row; the token must have
 * requested a W-9. The body is validated (zod + TIN plausibility + matching entries +
 * signature = signer name + perjury certification + e-sign consent). The TIN is encrypted
 * server-side and NEVER echoed — the response carries the last four digits only, and no
 * log line includes the request body. The W-9 lands for human review like an upload.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const ip = clientIp(req);
  const throttle = sharedRateLimiter.checkAll([
    { key: `vendor-w9:token:${params.token}`, rule: PER_TOKEN },
    { key: `vendor-w9:ip:${ip}`, rule: PER_IP },
  ]);
  if (!throttle.allowed) {
    return NextResponse.json({ error: 'Too many tries. Please wait a minute.' }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(throttle)) } });
  }

  const admin = createAdminSupabase();
  const result = await validatePortalToken(admin, params.token);
  if (!result.ok) {
    return NextResponse.json({ error: result.state === 'not_found' ? 'This link is not valid.' : 'This link is no longer active. Ask for a new one.' }, { status: result.state === 'not_found' ? 404 : 410 });
  }
  const { tokenId, orgId, vendorId, requestedDocs } = result.token;
  if (!requestedDocs.includes('W9')) return NextResponse.json({ error: 'A W-9 was not requested on this link.' }, { status: 400 });

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Send the form as JSON.' }, { status: 400 });
  }
  const parsed = w9FormBody.safeParse(raw);
  if (!parsed.success) {
    // Field names + messages only — never the submitted values.
    const fields: Record<string, string> = {};
    for (const i of parsed.error.issues) fields[i.path.join('.') || '_root'] ??= i.message;
    return NextResponse.json({ error: 'Some answers need attention.', fields }, { status: 422 });
  }

  try {
    const { submission, tinStored } = await submitW9Form(admin, { tokenId, orgId, vendorId }, parsed.data, {
      ip: ip === 'unknown' ? null : ip,
      userAgent: req.headers.get('user-agent'),
    });
    await touchTokenUsage(admin, tokenId);
    return NextResponse.json({
      ok: true,
      submission_id: submission.id,
      tin_last4: submission.tin_last4,
      tin_stored: tinStored,
      message: 'Signed and received. A person will confirm it — you will hear from us only if something else is needed.',
    });
  } catch (e) {
    if (e instanceof W9FormError) return NextResponse.json({ error: e.message, fields: e.field ? { [e.field]: e.message } : undefined }, { status: 422 });
    console.error('[vendor-portal] w9 form failed:', e instanceof Error ? e.name : 'error');
    return NextResponse.json({ error: 'We could not save the form. Please try again in a moment.' }, { status: 502 });
  }
}
