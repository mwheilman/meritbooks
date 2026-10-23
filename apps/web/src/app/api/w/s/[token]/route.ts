export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { clientIp, retryAfterSeconds, sharedRateLimiter } from '@/lib/security/rate-limit';
import { resolveWorkforceLink } from '@/lib/receipts/links';
import { workforceViewResponse } from '@/lib/receipts/workforce-api';

const PER_TOKEN = { windowMs: 60_000, max: 30 } as const;
const PER_IP = { windowMs: 60_000, max: 60 } as const;

/**
 * GET /api/w/s/[token] — Merit Workforce by magic link (PUBLIC, no login). The token is the
 * only credential: resolved by sha256 (service role) to ONE card assignment; the response
 * lists only that cardholder's charges and receipts. Bad / expired / ended links: 404/410,
 * revealing nothing about the tenant.
 */
export async function GET(req: Request, { params }: { params: { token: string } }) {
  const t = sharedRateLimiter.checkAll([
    { key: `w-link:token:${params.token.slice(0, 64)}`, rule: PER_TOKEN },
    { key: `w-link:ip:${clientIp(req)}`, rule: PER_IP },
  ]);
  if (!t.allowed) return NextResponse.json({ error: 'Too many tries. Wait a minute.' }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(t)) } });
  const admin = createAdminSupabase();
  const link = await resolveWorkforceLink(admin, params.token);
  if (!link.ok) {
    return NextResponse.json(
      { error: link.state === 'not_found' ? 'This link is not valid.' : 'This link has expired. Open the newest reminder email, or ask for a new one.' },
      { status: link.state === 'not_found' ? 404 : 410 },
    );
  }
  return workforceViewResponse(admin, link.assignment.org_id, [link.assignment]);
}
