/**
 * INBOUND email-to-bill orchestration (the "monitored mailbox" AP path).
 *
 * A tenant forwards vendor invoices to its per-tenant inbound address
 * (`core.organizations.inbound_ap_address`, migration 135). A provider webhook
 * delivers the message here; this module:
 *   1. resolves the RECIPIENT address to a tenant (org),
 *   2. retains each attachment in the private `documents` bucket (never dropped),
 *   3. lands a PROPOSED draft in the EXISTING AP intake queue — PARSED when AI can
 *      read it, PENDING_PARSE (degrade-safe) when it can't.
 *
 * SAFETY: nothing here posts to the GL or creates a payable. It is machine DATA
 * ENTRY that produces a reviewable draft, exactly like an uploaded invoice. Runs
 * session-less on the admin client (there is no Clerk user), but every write is
 * org_id-stamped and feature-tagged, so a draft can only ever belong to the tenant
 * the recipient address resolved to.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { storeSourceDocument } from '@/lib/documents/store-source';
import {
  createInboundIntakeDraft,
  AP_DOC_INTAKE_FEATURE,
  type DocProviderDeps,
} from '@/lib/ap/doc-intelligence';

/** The bytes the provider-agnostic webhook hands us for one attachment. */
export interface InboundAttachment {
  fileName: string;
  mediaType: string;
  base64: string;
}

/** File types the AP reader accepts (mirrors /api/bills/intake-queue). */
const ACCEPTED_MEDIA = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // generous; email invoices can be larger scans

/** Normalize an email address for comparison (trim + lowercase, strip display name). */
export function normalizeEmailAddress(raw: string): string {
  const s = (raw ?? '').trim();
  // Handle "Display Name <local@domain>" forms.
  const angle = s.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : s).trim().toLowerCase();
  return addr;
}

/** Extract the `<slug>` from an `ap-<slug>@…` or `ap+<slug>@…` inbound localpart. */
export function slugFromInboundAddress(address: string): string | null {
  const addr = normalizeEmailAddress(address);
  const local = addr.split('@')[0] ?? '';
  const m = local.match(/^ap[-+](.+)$/);
  return m ? m[1] : null;
}

export interface ResolvedTenant {
  orgId: string;
  matchedAddress: string;
}

/**
 * Resolve a set of candidate recipient addresses to a single tenant.
 * Primary: exact (case-insensitive) match on `inbound_ap_address`.
 * Fallback: derive `<slug>` from an `ap-<slug>@…` recipient and match org slug —
 * so the feature works even before a tenant customizes its address.
 * Returns null when nothing resolves (the caller drops the message, logged).
 */
export async function resolveTenantByRecipients(
  admin: SupabaseClient,
  recipients: string[],
): Promise<ResolvedTenant | null> {
  const addrs = Array.from(
    new Set(recipients.map(normalizeEmailAddress).filter((a) => a.includes('@'))),
  );
  if (addrs.length === 0) return null;

  // Primary — explicit per-tenant address.
  const { data: byAddr } = await admin
    .schema('core')
    .from('organizations')
    .select('id, inbound_ap_address')
    .in('inbound_ap_address', addrs)
    .limit(1);
  const addrRow = (byAddr as Array<{ id: string; inbound_ap_address: string }> | null)?.[0];
  if (addrRow) return { orgId: addrRow.id, matchedAddress: addrRow.inbound_ap_address };

  // Fallback — slug derived from an ap-<slug>@… recipient.
  for (const addr of addrs) {
    const slug = slugFromInboundAddress(addr);
    if (!slug) continue;
    const { data: bySlug } = await admin
      .schema('core')
      .from('organizations')
      .select('id, inbound_ap_address')
      .eq('slug', slug)
      .limit(1);
    const slugRow = (bySlug as Array<{ id: string; inbound_ap_address: string | null }> | null)?.[0];
    if (slugRow) return { orgId: slugRow.id, matchedAddress: slugRow.inbound_ap_address ?? addr };
  }

  return null;
}

/**
 * Pick a default company (location) to file inbound bills under. The reviewer can
 * change it before approving. Prefers a real operating entity over the management
 * company; returns '' when the org has no active location (the reviewer picks).
 */
export async function resolveDefaultLocationId(admin: SupabaseClient, orgId: string): Promise<string> {
  const base = admin
    .schema('core')
    .from('locations')
    .select('id, is_management_company')
    .eq('org_id', orgId)
    .eq('is_active', true);

  // Prefer a non-management operating company.
  const { data: op } = await base.eq('is_management_company', false).order('name').limit(1);
  const opRow = (op as Array<{ id: string }> | null)?.[0];
  if (opRow) return opRow.id;

  const { data: any } = await admin
    .schema('core')
    .from('locations')
    .select('id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name')
    .limit(1);
  return (any as Array<{ id: string }> | null)?.[0]?.id ?? '';
}

/**
 * Idempotency (best-effort): has this provider message already produced a draft for
 * this org? Matches the inbound messageId stashed in proposed_output. A failed
 * query returns false (proceed) — we never block ingestion on the dedup check.
 */
export async function inboundMessageAlreadySeen(
  admin: SupabaseClient,
  orgId: string,
  messageId: string | null,
): Promise<boolean> {
  if (!messageId) return false;
  try {
    const { data } = await admin
      .from('ai_decisions')
      .select('id')
      .eq('org_id', orgId)
      .eq('feature', AP_DOC_INTAKE_FEATURE)
      .contains('proposed_output', { inbound: { messageId } })
      .limit(1);
    return Boolean((data as unknown[] | null)?.length);
  } catch {
    return false;
  }
}

export type IngestAttachmentOutcome =
  | { fileName: string; ok: true; draftId: string; parseState: 'PARSED' | 'PENDING_PARSE'; sourceDocumentId: string | null }
  | { fileName: string; ok: false; skipped: true; reason: string }
  | { fileName: string; ok: false; skipped: false; error: string };

export interface IngestInboundArgs {
  orgId: string;
  locationId: string;
  from: string;
  subject: string | null;
  messageId: string | null;
  receivedAt: string;
  attachment: InboundAttachment;
  /** AI dependencies; null when no Anthropic key is available (→ PENDING_PARSE). */
  deps: DocProviderDeps | null;
}

/**
 * Ingest ONE inbound attachment: validate → retain the source doc → land a draft.
 * Retention happens BEFORE the read (store-source guarantee) so the document is
 * never lost, even if the parse fails. Unsupported/oversized attachments are
 * SKIPPED (reported), not dropped silently.
 */
export async function ingestInboundAttachment(
  admin: SupabaseClient,
  args: IngestInboundArgs,
): Promise<IngestAttachmentOutcome> {
  const { attachment } = args;
  const fileName = attachment.fileName || 'attachment';

  if (!ACCEPTED_MEDIA.has(attachment.mediaType)) {
    return { fileName, ok: false, skipped: true, reason: `Unsupported type: ${attachment.mediaType || 'unknown'}` };
  }
  const approxBytes = Math.floor((attachment.base64.length * 3) / 4);
  if (approxBytes > MAX_ATTACHMENT_BYTES) {
    return { fileName, ok: false, skipped: true, reason: 'Attachment too large' };
  }

  // 1) Retain the source document up front (never lose it) — unfiled 'bill' doc.
  const stored = await storeSourceDocument({
    supabase: admin,
    orgId: args.orgId,
    userId: null,
    base64: attachment.base64,
    fileName,
    mimeType: attachment.mediaType,
    docType: 'BILL',
    entityType: 'bill',
    notes: `Received by email from ${args.from}${args.subject ? ` — “${args.subject}”` : ''}`,
  });

  // 2) Land a draft (PARSED if AI can read it, PENDING_PARSE otherwise).
  const result = await createInboundIntakeDraft(admin, args.deps, {
    orgId: args.orgId,
    userId: null,
    base64: attachment.base64,
    mediaType: attachment.mediaType,
    fileName,
    locationId: args.locationId,
    sourceDocumentId: stored?.documentId ?? null,
    inbound: {
      from: args.from,
      subject: args.subject,
      receivedAt: args.receivedAt,
      messageId: args.messageId,
    },
  });

  if (!result.ok) {
    return { fileName, ok: false, skipped: false, error: result.error };
  }
  return {
    fileName,
    ok: true,
    draftId: result.draftId,
    parseState: result.parseState,
    sourceDocumentId: stored?.documentId ?? null,
  };
}
