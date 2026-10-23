export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

import { NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { clientIp, retryAfterSeconds, sharedRateLimiter } from '@/lib/security/rate-limit';
import { resolveWorkforceLink } from '@/lib/receipts/links';
import { workforceUploadResponse } from '@/lib/receipts/workforce-api';

const PER_TOKEN = { windowMs: 60_000, max: 12 } as const;
const PER_IP = { windowMs: 60_000, max: 30 } as const;

/**
 * POST /api/w/s/[token]/upload — the ONLY write a magic link can make (PUBLIC, no login).
 * Throttled per token and per IP BEFORE any work. The link resolves to one card assignment;
 * org, company and cardholder come FROM THAT ROW. A `transaction_id` that is not this
 * cardholder's charge is refused (404). Nothing is posted; the receipt is evidence.
 */
export async function POST(req: Request, { params }: { params: { token: string } }) {
  const t = sharedRateLimiter.checkAll([
    { key: `w-upload:token:${params.token.slice(0, 64)}`, rule: PER_TOKEN },
    { key: `w-upload:ip:${clientIp(req)}`, rule: PER_IP },
  ]);
  if (!t.allowed) return NextResponse.json({ error: 'Too many uploads in a short time. Wait a moment.' }, { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(t)) } });
  const admin = createAdminSupabase();
  const link = await resolveWorkforceLink(admin, params.token);
  if (!link.ok) return NextResponse.json({ error: 'This link has expired. Open the newest reminder email.' }, { status: link.state === 'not_found' ? 404 : 410 });
  return workforceUploadResponse(req, admin, link.assignment.org_id, [link.assignment], `cardholder:${link.assignment.id}`);
}
