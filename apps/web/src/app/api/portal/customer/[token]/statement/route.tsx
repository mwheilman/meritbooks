export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // @react-pdf/renderer needs Node, not edge

import { NextRequest, NextResponse } from 'next/server';
import { createAdminSupabase } from '@/lib/supabase/server';
import { resolvePortalToken } from '@/lib/portal/customer/tokens';
import { loadCustomerStatement } from '@/lib/invoices/statement';
import { StatementPdf } from '@/lib/invoices/statement-pdf';
import { renderToBuffer } from '@react-pdf/renderer';
import { sharedRateLimiter, clientIp, retryAfterSeconds } from '@/lib/security/rate-limit';

// Abuse throttle for this UNAUTHENTICATED endpoint — each call is an expensive
// server-side PDF render. Per-token AND per-IP hourly cap; a customer viewing
// their statement occasionally is never touched.
const STATEMENT_PER_TOKEN = { windowMs: 3_600_000, max: 30 } as const;
const STATEMENT_PER_IP = { windowMs: 3_600_000, max: 90 } as const;

// Short render cache keyed by token so a customer re-opening/refreshing the same
// statement re-serves cached bytes instead of re-rendering. Best-effort, per-instance.
const RENDER_CACHE_TTL_MS = 60_000;
const RENDER_CACHE_MAX = 500;
const renderCache = new Map<string, { bytes: Uint8Array; filename: string; expiresAt: number }>();

function getCached(token: string, now: number) {
  const hit = renderCache.get(token);
  if (hit && now < hit.expiresAt) return hit;
  if (hit) renderCache.delete(token);
  return null;
}

function putCached(token: string, bytes: Uint8Array, filename: string, now: number) {
  if (renderCache.size > RENDER_CACHE_MAX) {
    for (const [k, v] of renderCache) if (now >= v.expiresAt) renderCache.delete(k);
  }
  renderCache.set(token, { bytes, filename, expiresAt: now + RENDER_CACHE_TTL_MS });
}

function pdfResponse(bytes: Uint8Array, filename: string): NextResponse {
  // Uint8Array is a valid BodyInit at runtime; the cast bridges a TS lib generic
  // mismatch (Uint8Array<ArrayBufferLike> vs BodyInit) at this HTTP boundary only.
  return new NextResponse(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * GET /api/portal/customer/[token]/statement — branded AR statement PDF for the
 * PUBLIC customer portal (no login). This is the token-scoped twin of the
 * authenticated /api/customers/[id]/statement route (which sits behind Clerk and
 * 404s for customers, who never have a session).
 *
 * SECURITY: the token is the credential. resolvePortalToken validates it with the
 * service-role client and yields org_id + customer_id; loadCustomerStatement is
 * then called with EXACTLY that org + customer, so the PDF can only ever contain
 * this one customer's data. Revoked/expired tokens fall through to a clean 404.
 */
export async function GET(req: NextRequest, { params }: { params: { token: string } }) {
  const now = Date.now();

  // Serve a recently-rendered PDF for this token without re-rendering (and without
  // consuming the render throttle) — a refresh/re-open is free and correct.
  const cached = getCached(params.token, now);
  if (cached) return pdfResponse(cached.bytes, cached.filename);

  // Throttle the expensive render path — per-token AND per-IP hourly cap.
  const ip = clientIp(req);
  const throttle = sharedRateLimiter.checkAll([
    { key: `statement:token:${params.token}`, rule: STATEMENT_PER_TOKEN },
    { key: `statement:ip:${ip}`, rule: STATEMENT_PER_IP },
  ]);
  if (!throttle.allowed) {
    return NextResponse.json(
      { error: 'This statement has been requested too many times recently. Please try again later.' },
      { status: 429, headers: { 'Retry-After': String(retryAfterSeconds(throttle)) } },
    );
  }

  const admin = createAdminSupabase();
  const resolved = await resolvePortalToken(admin, params.token);
  if (!resolved) {
    return NextResponse.json({ error: 'This link is no longer valid.' }, { status: 404 });
  }

  const doc = await loadCustomerStatement(admin, resolved.orgId, resolved.customerId, { mode: 'open' });
  if (!doc) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const buffer = await renderToBuffer(<StatementPdf doc={doc} />);
  const slug = doc.customer.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'customer';
  const filename = `statement-${slug}-${doc.asOf}.pdf`;
  const bytes = new Uint8Array(buffer);

  putCached(params.token, bytes, filename, now);
  return pdfResponse(bytes, filename);
}
