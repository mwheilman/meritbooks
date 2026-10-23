/**
 * Resolvers: "is the thing we're asking for already here?" — one per request kind,
 * pluggable. The dispatcher runs them over every live request BEFORE it sends anything,
 * so a request whose need is met closes itself and the recipient is never asked again.
 *
 * Batch-shaped (one query per kind per cycle, not one per request). Every read is
 * pinned to org_id (the dispatcher runs on the service role, like the event drains).
 *
 *   w9 / coi   satisfied when every document type the request asks for is VALID and
 *              unexpired beyond the request's due date (a renewed certificate), OR a
 *              vendor-portal submission of that type landed after the request was made
 *              ("uploaded — waiting for review"; Wave 2A's review loop corrects/reopens).
 *   receipt    satisfied when the card charge has a receipt or was marked not required
 *              (lib/receipts/resolver.ts, Wave 2B).
 *   others     no resolver yet → people mark them fulfilled (or Wave 2 adds one).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { receiptResolver } from '@/lib/receipts/resolver';
import type { FulfilledVia, RequestKind, RequestRow } from './types';

export type Resolution = { satisfied: true; via: FulfilledVia; note: string } | { satisfied: false };

export type BatchResolver = (db: SupabaseClient, orgId: string, requests: ReadonlyArray<RequestRow>, now: Date) => Promise<Map<string, Resolution>>;

export type ResolverRegistry = Partial<Record<RequestKind, BatchResolver>>;

const W9_TYPES = ['W9'];
const COI_TYPES = ['GL_COI', 'WC_COI', 'WC_EXEMPTION'];

/** The vendor_compliance_docs types a w9/coi request is waiting on (meta.doc_types, else the kind's default). */
export function requiredDocTypes(r: Pick<RequestRow, 'kind' | 'meta'>): string[] {
  const m = r.meta?.doc_types;
  const fromMeta = Array.isArray(m) ? (m.filter((x) => typeof x === 'string') as string[]) : [];
  if (fromMeta.length) return fromMeta;
  return r.kind === 'w9' ? W9_TYPES : ['GL_COI'];
}

/** documents.doc_type the vendor portal files a submission under (lib/portal/vendor/tokens.ts docKindToDocType). */
function portalDocType(vendorDocType: string): 'W9' | 'COI' {
  return vendorDocType === 'W9' ? 'W9' : 'COI';
}

interface DocRow {
  vendor_id: string;
  doc_type: string;
  status: string;
  expiration_date: string | null;
}
interface PortalDocRow {
  entity_id: string;
  doc_type: string;
  created_at: string;
}

/** Pure decision for one request (exported for tests). */
export function decideVendorDoc(
  r: Pick<RequestRow, 'kind' | 'meta' | 'due_date' | 'created_at' | 'recipient_vendor_id'>,
  docs: ReadonlyArray<DocRow>,
  portal: ReadonlyArray<PortalDocRow>,
  today: string,
): Resolution {
  const vendorId = r.recipient_vendor_id;
  if (!vendorId) return { satisfied: false };
  const need = requiredDocTypes(r);
  const validBeyond = r.due_date && r.due_date > today ? r.due_date : today;
  const onFile = need.every((t) =>
    docs.some((d) => d.vendor_id === vendorId && d.doc_type === t && d.status === 'VALID' && (!d.expiration_date || d.expiration_date > validBeyond)),
  );
  if (onFile) return { satisfied: true, via: 'resolver', note: 'The document is on file and current.' };
  const created = new Date(r.created_at).getTime();
  const uploaded = Array.from(new Set(need.map(portalDocType))).every((pt) =>
    portal.some((p) => p.entity_id === vendorId && p.doc_type === pt && new Date(p.created_at).getTime() >= created),
  );
  if (uploaded) return { satisfied: true, via: 'magic_link', note: 'Uploaded through the vendor portal — waiting for review.' };
  return { satisfied: false };
}

export const vendorDocResolver: BatchResolver = async (db, orgId, requests, now) => {
  const out = new Map<string, Resolution>();
  const vendorIds = Array.from(new Set(requests.map((r) => r.recipient_vendor_id).filter((v): v is string => !!v)));
  if (vendorIds.length === 0) return out;
  const [{ data: docs, error: docErr }, { data: portal, error: portalErr }] = await Promise.all([
    db.from('vendor_compliance_docs').select('vendor_id, doc_type, status, expiration_date').eq('org_id', orgId).in('vendor_id', vendorIds),
    db
      .from('documents')
      .select('entity_id, doc_type, created_at')
      .eq('org_id', orgId)
      .eq('entity_type', 'vendor')
      .in('entity_id', vendorIds)
      .ilike('notes', 'Vendor portal submission%'),
  ]);
  if (docErr) throw new Error(`Could not read vendor documents: ${docErr.message}`);
  if (portalErr) throw new Error(`Could not read vendor portal submissions: ${portalErr.message}`);
  const today = now.toISOString().slice(0, 10);
  for (const r of requests) out.set(r.id, decideVendorDoc(r, (docs ?? []) as DocRow[], (portal ?? []) as PortalDocRow[], today));
  return out;
};

export const DEFAULT_RESOLVERS: ResolverRegistry = {
  w9: vendorDocResolver,
  coi: vendorDocResolver,
  // Wave 2B: a receipt request closes when its card charge has a receipt (or is marked not required).
  receipt: receiptResolver,
  // Wave 2E: a dunning reminder closes once its invoice is paid / disputed / promised.
  // Lazy import — dunning-requests imports the request service, which imports this file.
  dunning: async (db, orgId, requests, now) =>
    (await import('@/lib/collections/dunning-requests')).dunningResolver(db, orgId, requests, now),
};
