export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import {
  generatePortalToken,
  portalTokenStatus,
  type PortalTokenRow,
} from '@/lib/portal/customer/tokens';

/**
 * Admin control plane for a customer's self-service portal link (migration 141).
 * AUTHENTICATED + RBAC-gated + RLS-scoped — this is the tenant side, the opposite
 * of the public /portal/customer/[token] route.
 *
 *   GET    — list this customer's portal link(s) with effective status + share URL.
 *            Gated on customers:view.
 *   POST   — mint a fresh high-entropy token (optional expiry/label), superseding
 *            any existing ACTIVE link so exactly one live link exists. customers:edit.
 *   DELETE — revoke the active link(s). customers:edit.
 *
 * All reads/writes go through the caller's RLS-scoped client and filter by both
 * org_id and customer_id; the token value itself is only returned to the tenant
 * user who minted it (they hand it to the customer).
 */

function appBaseUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
}
const portalUrl = (token: string) => `${appBaseUrl()}/portal/customer/${token}`;

interface TokenView {
  id: string;
  label: string | null;
  status: 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  url: string | null; // only for ACTIVE links
  token: string | null; // only for ACTIVE links (the shareable value)
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

function toView(row: PortalTokenRow): TokenView {
  const status = portalTokenStatus(row);
  const active = status === 'ACTIVE';
  return {
    id: row.id,
    label: row.label,
    status,
    url: active ? portalUrl(row.token) : null,
    token: active ? row.token : null,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  };
}

/** Confirm the customer exists in this org — never mint/list against a foreign id. */
async function customerInOrg(supabase: import('@supabase/supabase-js').SupabaseClient, orgId: string, customerId: string) {
  const { data } = await supabase
    .schema('core').from('customers').select('id')
    .eq('org_id', orgId).eq('id', customerId).maybeSingle();
  return !!data;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const perm = await requirePermission(userId, 'customers', 'view');
  if (!perm.ok) return perm.response;

  if (!(await customerInOrg(supabase, orgId, params.id))) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  const { data } = await supabase
    .from('customer_portal_tokens')
    .select('id, org_id, customer_id, token, label, status, expires_at, last_used_at, created_by, created_at')
    .eq('org_id', orgId)
    .eq('customer_id', params.id)
    .order('created_at', { ascending: false });

  const rows = (data ?? []) as PortalTokenRow[];
  const tokens = rows.map(toView);
  const active = tokens.find((t) => t.status === 'ACTIVE') ?? null;
  return NextResponse.json({ active, tokens });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const perm = await requirePermission(userId, 'customers', 'edit');
  if (!perm.ok) return perm.response;

  if (!(await customerInOrg(supabase, orgId, params.id))) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  const body = (await req.json().catch(() => ({}))) as { expiresAt?: string | null; label?: string | null };
  const expiresAt = normalizeExpiry(body.expiresAt);
  if (body.expiresAt && expiresAt === undefined) {
    return NextResponse.json({ error: 'Invalid expiry date' }, { status: 422 });
  }
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 120) : null;

  // Supersede any existing ACTIVE link so there's a single live magic link per
  // customer — regenerating a link should invalidate the old one immediately.
  await supabase
    .from('customer_portal_tokens')
    .update({ status: 'REVOKED', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('customer_id', params.id)
    .eq('status', 'ACTIVE');

  const token = generatePortalToken();
  const { data, error } = await supabase
    .from('customer_portal_tokens')
    .insert({
      org_id: orgId,
      customer_id: params.id,
      token,
      label,
      status: 'ACTIVE',
      expires_at: expiresAt ?? null,
      created_by: userId,
    })
    .select('id, org_id, customer_id, token, label, status, expires_at, last_used_at, created_by, created_at')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: 'Could not create the portal link.' }, { status: 500 });
  }
  return NextResponse.json({ active: toView(data as PortalTokenRow) });
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  const perm = await requirePermission(userId, 'customers', 'edit');
  if (!perm.ok) return perm.response;

  await supabase
    .from('customer_portal_tokens')
    .update({ status: 'REVOKED', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('customer_id', params.id)
    .eq('status', 'ACTIVE');

  return NextResponse.json({ ok: true });
}

/**
 * Accept a YYYY-MM-DD or ISO datetime and return an ISO string end-of-day, or
 * null when empty. Returns undefined for a malformed value so the caller 422s.
 */
function normalizeExpiry(v: string | null | undefined): string | null | undefined {
  if (v == null || v === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const d = new Date(`${v}T23:59:59Z`);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
