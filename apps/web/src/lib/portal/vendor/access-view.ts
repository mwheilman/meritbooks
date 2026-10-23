/**
 * The admin "Portal access" view of one vendor's upload links + submissions (security
 * review M8). The magic-link token is a bearer credential, so the list NEVER carries it:
 * only its last four characters and its effective state. The full token is returned once,
 * by the create call, to the person who minted it.
 *
 * Submitted files: a W-9 image shows the vendor's full TIN, so it gets no signed URL here
 * (requiresReveal) — it is opened through a logged TIN reveal (lib/vendor-compliance/
 * doc-access). Other submissions get a 5-minute DOWNLOAD (attachment) link.
 *
 * Reads go through the caller's RLS client (`member`), pinned to org_id; the route has
 * checked compliance:view first.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSignedUrl } from '@/lib/documents/store';
import { evaluateTokenState, type TokenState } from './tokens';
import { isTinBearingDoc } from '@/lib/vendor-compliance/doc-access';

/** Default lifetime of a link minted by hand (no expiry chosen). */
export const DEFAULT_PORTAL_LINK_DAYS = 45;
export const MAX_PORTAL_LINK_DAYS = 365;

export interface PortalTokenListItem {
  id: string;
  tokenLast4: string;
  label: string | null;
  status: Exclude<TokenState, 'not_found'>;
  requestedDocs: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface PortalSubmissionItem {
  id: string;
  fileName: string;
  docType: string;
  createdAt: string;
  reviewStatus: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  /** 5-minute download link; null for a W-9 (requiresReveal) or when signing failed. */
  viewUrl: string | null;
  requiresReveal: boolean;
}

/** Pure: serialize a token row for the list — never the token itself. */
export function toTokenListItem(t: Record<string, unknown>, now: Date): PortalTokenListItem {
  const raw = typeof t.token === 'string' ? t.token : '';
  const state = evaluateTokenState({ status: String(t.status ?? ''), expires_at: (t.expires_at as string | null) ?? null }, now);
  return {
    id: String(t.id),
    tokenLast4: raw.slice(-4),
    label: (t.label as string | null) ?? null,
    status: state === 'not_found' ? 'revoked' : state,
    requestedDocs: Array.isArray(t.requested_docs) ? (t.requested_docs as string[]) : [],
    expiresAt: (t.expires_at as string | null) ?? null,
    lastUsedAt: (t.last_used_at as string | null) ?? null,
    createdAt: String(t.created_at ?? ''),
  };
}

/** Pure: the expiry for a new link (default 45 days; capped at a year). */
export function portalLinkExpiry(expiresInDays: unknown, now: Date): string {
  const n = typeof expiresInDays === 'number' && Number.isFinite(expiresInDays) && expiresInDays > 0 ? Math.trunc(expiresInDays) : DEFAULT_PORTAL_LINK_DAYS;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() + Math.min(Math.max(n, 1), MAX_PORTAL_LINK_DAYS));
  return d.toISOString();
}

export async function buildPortalAccessView(
  member: SupabaseClient,
  orgId: string,
  vendorId: string,
  opts: { now?: Date; sign?: typeof getSignedUrl } = {},
): Promise<{ tokens: PortalTokenListItem[]; submissions: PortalSubmissionItem[] }> {
  const now = opts.now ?? new Date();
  const sign = opts.sign ?? getSignedUrl;
  const [{ data: tokenRows, error: tokErr }, { data: docRows, error: docErr }] = await Promise.all([
    // `token` is read only to derive its last four; it never leaves this function.
    member.from('vendor_portal_tokens').select('id, token, label, status, requested_docs, expires_at, last_used_at, created_at').eq('org_id', orgId).eq('vendor_id', vendorId).order('created_at', { ascending: false }),
    member.from('documents').select('id, file_name, doc_type, notes, created_at').eq('org_id', orgId).eq('entity_type', 'vendor').eq('entity_id', vendorId).order('created_at', { ascending: false }),
  ]);
  if (tokErr) throw new Error(`Could not read portal links: ${tokErr.message}`);
  if (docErr) throw new Error(`Could not read submissions: ${docErr.message}`);

  const tokens = ((tokenRows ?? []) as Record<string, unknown>[]).map((t) => toTokenListItem(t, now));
  const docs = ((docRows ?? []) as Array<{ id: string; file_name: string; doc_type: string; notes: string | null; created_at: string }>).filter((d) =>
    (d.notes ?? '').startsWith('Vendor portal submission'),
  );

  const docIds = docs.map((d) => d.id);
  const { data: subRows } = docIds.length
    ? await member.from('vendor_document_submissions').select('document_id, status, doc_kind').eq('org_id', orgId).in('document_id', docIds)
    : { data: [] };
  const subByDoc = new Map(((subRows ?? []) as Array<{ document_id: string | null; status: string; doc_kind: string }>).map((s) => [s.document_id, s]));

  const submissions = await Promise.all(
    docs.map(async (d): Promise<PortalSubmissionItem> => {
      const s = subByDoc.get(d.id);
      const requiresReveal = isTinBearingDoc(d.doc_type) || s?.doc_kind === 'W9';
      let viewUrl: string | null = null;
      if (!requiresReveal) {
        try {
          viewUrl = (await sign(member, d.id, 300, { download: true }))?.url ?? null;
        } catch {
          viewUrl = null;
        }
      }
      return {
        id: d.id,
        fileName: d.file_name,
        docType: d.doc_type,
        createdAt: d.created_at,
        reviewStatus: s?.status === 'accepted' ? 'ACCEPTED' : s?.status === 'rejected' ? 'REJECTED' : 'PENDING',
        viewUrl,
        requiresReveal,
      };
    }),
  );
  return { tokens, submissions };
}
