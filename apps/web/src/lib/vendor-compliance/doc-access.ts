/**
 * Who may open a vendor's submitted document (security review M8).
 *
 * A W-9 image carries the vendor's FULL taxpayer ID, so a signed URL to one is a TIN
 * reveal: it is handed out only to a caller whose `tin` field level allows a reveal
 * (reveal_logged / visible — lib/rbac/field-masks), only on an explicit request with a
 * reason, and only after the reveal is written to core.field_reveals + the action log
 * (no log → no URL). Certificates of insurance and banking letters are not TIN-bearing.
 *
 * Every link is short-lived. Inline view is allowed only for the three types the portal
 * accepts after its magic-byte check (PDF / JPEG / PNG); anything else is forced to
 * download (Content-Disposition: attachment).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { canReveal, fieldLevel, logFieldReveal, resolveFieldPolicy, type FieldLevel } from '@/lib/rbac/field-masks';
import { getSignedUrl } from '@/lib/documents/store';

export const SAFE_INLINE_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export function isTinBearingDoc(docType: string | null | undefined): boolean {
  return (docType ?? '').toUpperCase() === 'W9';
}

/** Pure: may this TIN level open a W-9 image (with a logged reveal)? */
export function mayOpenW9(level: FieldLevel): boolean {
  return canReveal(level);
}

/** Pure: inline only for a known-safe type; otherwise force a download. */
export function inlineAllowed(mimeType: string | null | undefined): boolean {
  return (SAFE_INLINE_MIME as readonly string[]).includes((mimeType ?? '').toLowerCase());
}

export class DocAccessError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'DocAccessError';
  }
}

export interface DocLink {
  url: string;
  fileName: string;
  mimeType: string | null;
}

export interface RevealDeps {
  resolveLevel?: (admin: SupabaseClient, orgId: string, userId: string) => Promise<FieldLevel>;
  logReveal?: typeof logFieldReveal;
  sign?: typeof getSignedUrl;
}

/**
 * Open a TIN-bearing document: check the caller's TIN level, log the reveal (subject =
 * the submission / document row), then sign a 5-minute URL. Throws DocAccessError.
 * `member` is the caller's RLS client (the document row must be visible to them).
 */
export async function revealTinDocument(
  admin: SupabaseClient,
  member: SupabaseClient,
  input: { orgId: string; userId: string; documentId: string; mimeType: string | null; subjectTable: string; subjectId: string; reason: string },
  deps: RevealDeps = {},
): Promise<DocLink> {
  const reason = input.reason.trim();
  if (reason.length < 3) throw new DocAccessError('Say why you are opening this W-9 (it is logged).', 400, 'REASON_REQUIRED');
  const level = await (deps.resolveLevel ?? (async (a, o, u) => fieldLevel(await resolveFieldPolicy(a, o, u), 'tin')))(admin, input.orgId, input.userId);
  if (!mayOpenW9(level)) {
    throw new DocAccessError('Your role can’t view taxpayer IDs, so it can’t open W-9 images. Ask someone who can reveal TINs.', 403, 'TIN_REVEAL_DENIED');
  }
  const logged = await (deps.logReveal ?? logFieldReveal)(admin, {
    orgId: input.orgId,
    clerkUserId: input.userId,
    fieldClass: 'tin',
    subjectTable: input.subjectTable,
    subjectIds: [input.subjectId],
    reason: reason.slice(0, 500),
  });
  if (!logged) throw new DocAccessError('We couldn’t log the reveal, so the W-9 stays closed. Try again.', 503, 'REVEAL_LOG_FAILED');
  const signed = await (deps.sign ?? getSignedUrl)(member, input.documentId, 300, { download: !inlineAllowed(input.mimeType) });
  if (!signed) throw new DocAccessError('File not found', 404, 'NOT_FOUND');
  return { url: signed.url, fileName: signed.fileName, mimeType: input.mimeType };
}
