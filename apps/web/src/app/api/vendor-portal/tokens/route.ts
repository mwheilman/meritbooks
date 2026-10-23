export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  generatePortalToken,
  isPortalDocKind,
  type PortalDocKind,
} from '@/lib/portal/vendor/tokens';
import { buildPortalAccessView, portalLinkExpiry } from '@/lib/portal/vendor/access-view';
import { serviceWriter } from '@/lib/db/scoped-writer';

/**
 * Admin surface for the vendor upload portal (AUTHENTICATED — NOT under /api/portal,
 * so Clerk protects it). Mint / list / revoke a vendor's magic-link, and read what
 * the vendor has submitted (pending human review). Reads go through the RLS-scoped
 * client, so tenant isolation is DB-enforced.
 *
 * Security review M8:
 *   • GET needs compliance:view (a portal link is a bearer credential for the vendor's
 *     documents); POST / PATCH need compliance:manage.
 *   • The list NEVER returns a raw token — only its last four + state. The full token
 *     (and its path) is in the create response only, once, to the person who minted it.
 *   • A W-9 image carries the full TIN: no signed URL in the list; it is opened through
 *     POST /api/vendor-portal/tokens/document (logged TIN reveal). Others: download link.
 *   • A link minted without an expiry expires in 45 days.
 */

// GET /api/vendor-portal/tokens?vendor_id=... → this vendor's links + submissions.
export async function GET(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;

  const guard = await requirePermission(userId, 'compliance', 'view', { route: '/api/vendor-portal/tokens' });
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ tokens: [], submissions: [] });

  const vendorId = new URL(req.url).searchParams.get('vendor_id');
  if (!vendorId) return NextResponse.json({ error: 'vendor_id is required' }, { status: 400 });

  try {
    return NextResponse.json(await buildPortalAccessView(supabase, orgId, vendorId));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not load portal access' }, { status: 500 });
  }
}

// POST /api/vendor-portal/tokens → mint a link for a vendor.
export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const guard = await requirePermission(userId, 'compliance', 'manage');
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    vendor_id?: string;
    requested_docs?: unknown;
    expires_in_days?: number;
    label?: string;
  };
  if (!body.vendor_id) return NextResponse.json({ error: 'vendor_id is required' }, { status: 400 });

  // The vendor must belong to the caller's org (RLS-scoped read).
  const { data: vendor } = await supabase
    .schema('core')
    .from('vendors')
    .select('id')
    .eq('id', body.vendor_id)
    .eq('org_id', orgId)
    .maybeSingle();
  if (!vendor) return NextResponse.json({ error: 'Vendor not found' }, { status: 404 });

  const requested = Array.isArray(body.requested_docs)
    ? (body.requested_docs.filter(isPortalDocKind) as PortalDocKind[])
    : [];
  const requestedDocs = requested.length > 0 ? requested : (['W9', 'COI'] as PortalDocKind[]);

  // No expiry chosen → 45 days (a forgotten link must not live forever); capped at a year.
  const expiresAt = portalLinkExpiry(body.expires_in_days, new Date());

  // vendor_portal_tokens is SELECT-only for members (migration 171): written with the
  // service role after compliance:manage; the vendor was verified in-org above.
  const { data, error } = await serviceWriter()
    .from('vendor_portal_tokens')
    .insert({
      org_id: orgId,
      vendor_id: body.vendor_id,
      token: generatePortalToken(),
      label: body.label?.trim() || null,
      status: 'ACTIVE',
      requested_docs: requestedDocs,
      expires_at: expiresAt,
      created_by: userId,
    })
    .select('id, token, requested_docs, expires_at, created_at')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Failed to create link' }, { status: 500 });
  }

  return NextResponse.json(
    {
      id: data.id,
      token: data.token,
      requestedDocs: data.requested_docs,
      expiresAt: data.expires_at,
      path: `/portal/vendor/${data.token}`,
    },
    { status: 201 },
  );
}

// PATCH /api/vendor-portal/tokens → revoke a link.
export async function PATCH(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const guard = await requirePermission(userId, 'compliance', 'manage');
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as { token_id?: string };
  if (!body.token_id) return NextResponse.json({ error: 'token_id is required' }, { status: 400 });

  // Service-role write (migration 171), pinned to the caller's org.
  const { data, error } = await serviceWriter()
    .from('vendor_portal_tokens')
    .update({ status: 'REVOKED', updated_at: new Date().toISOString() })
    .eq('id', body.token_id)
    .eq('org_id', orgId)
    .select('id')
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Link not found' }, { status: 404 });
  return NextResponse.json({ ok: true });
}
