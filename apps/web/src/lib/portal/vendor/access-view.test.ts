/**
 * Security review M8 — the vendor-portal admin surface: the list never carries a raw
 * token, W-9 images get no URL (they need a logged TIN reveal), other files are download
 * links, the route is gated on compliance:view, and new links default to 45 days.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';
import { memorySupabase } from '@/test/memory-supabase';
import { buildPortalAccessView, portalLinkExpiry, toTokenListItem, DEFAULT_PORTAL_LINK_DAYS } from './access-view';

const ORG = 'org-1';
const V = 'vendor-1';
const RAW = 'S3cr3tPortalTokenValue_abcdefghijklmnopqrstuvwxyzWXYZ';
const NOW = new Date('2026-10-23T12:00:00Z');

function seed() {
  return memorySupabase({
    vendor_portal_tokens: [
      { id: 't1', org_id: ORG, vendor_id: V, token: RAW, label: null, status: 'ACTIVE', requested_docs: ['W9', 'COI'], expires_at: '2026-12-01T00:00:00Z', last_used_at: null, created_at: '2026-10-01T00:00:00Z' },
      { id: 't2', org_id: ORG, vendor_id: V, token: 'old_token_value_0000000000000000000009876', label: null, status: 'ACTIVE', requested_docs: ['W9'], expires_at: '2026-10-01T00:00:00Z', last_used_at: null, created_at: '2026-09-01T00:00:00Z' },
      { id: 't3', org_id: 'other-org', vendor_id: V, token: 'other_org_token_000000000000000000000000', status: 'ACTIVE', requested_docs: [], created_at: '2026-09-01T00:00:00Z' },
    ],
    documents: [
      { id: 'd-w9', org_id: ORG, entity_type: 'vendor', entity_id: V, file_name: 'w9.pdf', doc_type: 'W9', notes: 'Vendor portal submission · Form W-9 · pending review', created_at: '2026-10-02T00:00:00Z' },
      { id: 'd-coi', org_id: ORG, entity_type: 'vendor', entity_id: V, file_name: 'coi.pdf', doc_type: 'COI', notes: 'Vendor portal submission · COI · pending review', created_at: '2026-10-03T00:00:00Z' },
      { id: 'd-staff', org_id: ORG, entity_type: 'vendor', entity_id: V, file_name: 'contract.pdf', doc_type: 'OTHER', notes: 'Uploaded by staff', created_at: '2026-10-03T00:00:00Z' },
    ],
    vendor_document_submissions: [
      { org_id: ORG, document_id: 'd-coi', status: 'accepted', doc_kind: 'COI' },
      { org_id: ORG, document_id: 'd-w9', status: 'received', doc_kind: 'W9' },
    ],
  });
}

describe('buildPortalAccessView', () => {
  it('never returns a raw token — last four + effective state only', async () => {
    const mem = seed();
    const sign = vi.fn(async (_c: unknown, id: string, _e?: number, opts?: { download?: boolean }) => ({ url: `https://files/${id}?download=${String(opts?.download)}`, fileName: id }));
    const view = await buildPortalAccessView(mem.client, ORG, V, { now: NOW, sign });
    const json = JSON.stringify(view);
    expect(json).not.toContain(RAW);
    expect(json).not.toContain('old_token_value');
    expect(json).not.toContain('other_org_token');
    expect(view.tokens.map((t) => [t.id, t.tokenLast4, t.status])).toEqual([['t1', 'WXYZ', 'active'], ['t2', '9876', 'expired']]);
    for (const t of view.tokens) expect(Object.keys(t)).not.toContain('token');
  });
  it('W-9 images get no URL (reveal required); other portal files are download links; non-portal docs are omitted', async () => {
    const mem = seed();
    const sign = vi.fn(async (_c: unknown, id: string, _e?: number, opts?: { download?: boolean }) => ({ url: `https://files/${id}?download=${String(opts?.download)}`, fileName: id }));
    const view = await buildPortalAccessView(mem.client, ORG, V, { now: NOW, sign });
    const byId = Object.fromEntries(view.submissions.map((s) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(['d-coi', 'd-w9']);
    expect(byId['d-w9']).toMatchObject({ viewUrl: null, requiresReveal: true, reviewStatus: 'PENDING' });
    expect(byId['d-coi']).toMatchObject({ viewUrl: 'https://files/d-coi?download=true', requiresReveal: false, reviewStatus: 'ACCEPTED' });
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('toTokenListItem / portalLinkExpiry', () => {
  it('an unknown status reads revoked (fail closed)', () => {
    expect(toTokenListItem({ id: 'x', token: 'abcd1234', status: 'WEIRD', created_at: 'c' }, NOW)).toMatchObject({ status: 'revoked', tokenLast4: '1234' });
  });
  it('defaults a manual link to 45 days and caps at a year', () => {
    expect(portalLinkExpiry(undefined, NOW)).toBe(new Date(NOW.getTime() + DEFAULT_PORTAL_LINK_DAYS * 86_400_000).toISOString());
    expect(portalLinkExpiry(0, NOW)).toBe(portalLinkExpiry(undefined, NOW));
    expect(portalLinkExpiry(10, NOW)).toBe('2026-11-02T12:00:00.000Z');
    expect(portalLinkExpiry(5000, NOW)).toBe(new Date(NOW.getTime() + 365 * 86_400_000).toISOString());
  });
});

// ── route gate: GET needs compliance:view ─────────────────────────────────────
const permission = vi.hoisted(() => ({ allow: true, calls: [] as Array<[string, string]> }));
const mem = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('@/lib/api-handler', () => ({
  requireAuthedContext: async () => ({ userId: 'user_1', orgId: ORG, supabase: mem.client }),
}));
vi.mock('@/lib/rbac/require-permission', () => ({
  requirePermission: async (_u: string, feature: string, action: string) => {
    permission.calls.push([feature, action]);
    return permission.allow ? { ok: true, role: 'controller', orgId: ORG } : { ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  },
}));
vi.mock('@/lib/documents/store', () => ({
  getSignedUrl: async (_c: unknown, id: string) => ({ url: `https://files/${id}`, fileName: id }),
}));

describe('GET /api/vendor-portal/tokens', () => {
  beforeEach(() => {
    permission.calls = [];
    mem.client = seed().client;
  });
  it('refuses without compliance:view', async () => {
    permission.allow = false;
    const { GET } = await import('@/app/api/vendor-portal/tokens/route');
    const res = await GET(new Request(`http://x/api/vendor-portal/tokens?vendor_id=${V}`));
    expect(res.status).toBe(403);
    expect(permission.calls).toEqual([['compliance', 'view']]);
  });
  it('with view: lists last four only', async () => {
    permission.allow = true;
    const { GET } = await import('@/app/api/vendor-portal/tokens/route');
    const res = await GET(new Request(`http://x/api/vendor-portal/tokens?vendor_id=${V}`));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(RAW);
    expect(JSON.parse(text).tokens[0].tokenLast4).toBe('WXYZ');
  });
});
