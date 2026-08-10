export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getSignedUrl } from '@/lib/documents/store';
import {
  generatePortalToken,
  isPortalDocKind,
  evaluateTokenState,
  type PortalDocKind,
} from '@/lib/portal/vendor/tokens';

/**
 * Admin surface for the vendor upload portal (AUTHENTICATED — NOT under /api/portal,
 * so Clerk protects it). Mint / list / revoke a vendor's magic-link, and read what
 * the vendor has submitted (pending human review). All reads/writes go through the
 * RLS-scoped client, so tenant isolation is DB-enforced; minting is gated on the
 * existing `compliance` permission.
 */

// GET /api/vendor-portal/tokens?vendor_id=... → this vendor's links + submissions.
export async function GET(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId } = ctx;
  if (!orgId) return NextResponse.json({ tokens: [], submissions: [] });

  const vendorId = new URL(req.url).searchParams.get('vendor_id');
  if (!vendorId) return NextResponse.json({ error: 'vendor_id is required' }, { status: 400 });

  const [{ data: tokenRows }, { data: docRows }] = await Promise.all([
    supabase
      .from('vendor_portal_tokens')
      .select('id, token, label, status, requested_docs, expires_at, last_used_at, created_at')
      .eq('org_id', orgId)
      .eq('vendor_id', vendorId)
      .order('created_at', { ascending: false }),
    // Portal submissions are `documents` linked to this vendor whose note marks
    // them as a portal upload. RLS scopes to the caller's org.
    supabase
      .from('documents')
      .select('id, file_name, doc_type, notes, created_at')
      .eq('entity_type', 'vendor')
      .eq('entity_id', vendorId)
      .ilike('notes', 'Vendor portal submission%')
      .order('created_at', { ascending: false }),
  ]);

  const now = new Date();
  const tokens = (tokenRows ?? []).map((t: Record<string, unknown>) => ({
    id: t.id as string,
    token: t.token as string,
    label: (t.label as string) ?? null,
    // Report the EFFECTIVE state (an ACTIVE-but-past-expiry link reads 'expired').
    status: evaluateTokenState({ status: t.status as string, expires_at: (t.expires_at as string) ?? null }, now),
    requestedDocs: Array.isArray(t.requested_docs) ? (t.requested_docs as string[]) : [],
    expiresAt: (t.expires_at as string) ?? null,
    lastUsedAt: (t.last_used_at as string) ?? null,
    createdAt: t.created_at as string,
  }));

  // Sign short-lived view URLs for each submission (few per vendor).
  const submissions = await Promise.all(
    (docRows ?? []).map(async (d: Record<string, unknown>) => {
      let viewUrl: string | null = null;
      try {
        const signed = await getSignedUrl(supabase, d.id as string, 300, { download: false });
        viewUrl = signed?.url ?? null;
      } catch {
        viewUrl = null;
      }
      return {
        id: d.id as string,
        fileName: d.file_name as string,
        docType: d.doc_type as string,
        createdAt: d.created_at as string,
        reviewStatus: 'PENDING' as const,
        viewUrl,
      };
    }),
  );

  return NextResponse.json({ tokens, submissions });
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

  let expiresAt: string | null = null;
  if (typeof body.expires_in_days === 'number' && body.expires_in_days > 0) {
    const d = new Date();
    d.setDate(d.getDate() + Math.min(Math.trunc(body.expires_in_days), 365));
    expiresAt = d.toISOString();
  }

  const { data, error } = await supabase
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
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization found' }, { status: 400 });

  const guard = await requirePermission(userId, 'compliance', 'manage');
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as { token_id?: string };
  if (!body.token_id) return NextResponse.json({ error: 'token_id is required' }, { status: 400 });

  const { data, error } = await supabase
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
