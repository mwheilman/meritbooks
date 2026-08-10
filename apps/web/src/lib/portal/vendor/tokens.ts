/**
 * Vendor self-service upload portal — token model + upload guards.
 *
 * A VENDOR (not a Clerk user) opens /portal/vendor/[token] and uploads their
 * W-9, COI, and/or banking/remittance details. The magic-link token is the ONLY
 * credential; there is no tenant session. The public API validates the token
 * server-side with the service-role client, resolves org_id + vendor_id from the
 * ROW (never from anything the client sends), and narrows every write to that
 * vendor. Uploads land in the `documents` bucket as PENDING-review artifacts and
 * do NOT touch vendor_compliance_docs — so a public upload can never flip a
 * vendor to compliant or lift a payment hold. A human accepts them later.
 *
 * This module is split so the DECISIONS stay pure/unit-testable (token state,
 * doc-kind narrowing, file-safety guard) while the I/O (validate against the DB,
 * mint, revoke) is a thin wrapper on top.
 */

import { randomBytes } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ── Requested-document vocabulary ────────────────────────────────────────────
// The kinds a vendor can be asked to provide. Stored in
// vendor_portal_tokens.requested_docs (text[]); the default is {W9,COI}.
export const PORTAL_DOC_KINDS = ['W9', 'COI', 'BANKING'] as const;
export type PortalDocKind = (typeof PORTAL_DOC_KINDS)[number];

export const PORTAL_DOC_LABEL: Record<PortalDocKind, string> = {
  W9: 'Form W-9',
  COI: 'Certificate of Insurance (COI)',
  BANKING: 'Banking / remittance details',
};

export function isPortalDocKind(v: unknown): v is PortalDocKind {
  return typeof v === 'string' && (PORTAL_DOC_KINDS as readonly string[]).includes(v);
}

/**
 * Map a requested doc-kind to the retention docType used by the `documents`
 * store. W-9 and COI have first-class doc types; banking details are retained as
 * OTHER (there is no compliance-doc type for banking, and the portal deliberately
 * does not write to vendor_compliance_docs — see the file header).
 */
export function docKindToDocType(kind: PortalDocKind): 'W9' | 'COI' | 'OTHER' {
  if (kind === 'W9') return 'W9';
  if (kind === 'COI') return 'COI';
  return 'OTHER';
}

// ── File-safety guard (pure) ─────────────────────────────────────────────────
// A public upload endpoint is a hostile surface: restrict to safe document types
// and cap the size. Both mime AND extension must be acceptable.
export const PORTAL_ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const PORTAL_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png'] as const;
export const PORTAL_MAX_BYTES = 15 * 1024 * 1024; // 15 MB

export interface UploadCandidate {
  fileName: string;
  mimeType: string | null;
  size: number;
}

export type FileGuardResult = { ok: true } | { ok: false; error: string };

function extOf(name: string): string {
  const clean = (name || '').split(/[\\/]/).pop() || '';
  const dot = clean.lastIndexOf('.');
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : '';
}

/**
 * Reject anything that isn't a small PDF/JPG/PNG. Deterministic (no AI): the
 * portal only retains the file for a human to read, so we do not need to sniff
 * bytes — but we require BOTH a safe mime and a safe extension, and a size under
 * the cap, and a non-empty file.
 */
export function assertSafeUpload(c: UploadCandidate): FileGuardResult {
  if (!c || !c.fileName || !c.fileName.trim()) return { ok: false, error: 'A file is required.' };
  if (!Number.isFinite(c.size) || c.size <= 0) return { ok: false, error: 'The file is empty.' };
  if (c.size > PORTAL_MAX_BYTES) {
    return { ok: false, error: `File is too large. Maximum ${Math.round(PORTAL_MAX_BYTES / (1024 * 1024))} MB.` };
  }
  const mime = (c.mimeType || '').toLowerCase();
  const ext = extOf(c.fileName);
  const mimeOk = (PORTAL_ALLOWED_MIME as readonly string[]).includes(mime);
  const extOk = (PORTAL_ALLOWED_EXT as readonly string[]).includes(ext);
  if (!mimeOk && !extOk) {
    return { ok: false, error: 'Unsupported file type. Upload a PDF, JPG, or PNG.' };
  }
  // Require the extension to be safe even when the mime looks fine (defence in
  // depth against a spoofed content-type on a disguised file).
  if (!extOk) {
    return { ok: false, error: 'Unsupported file type. Upload a PDF, JPG, or PNG.' };
  }
  return { ok: true };
}

// ── Token state (pure) ───────────────────────────────────────────────────────
export type TokenState = 'not_found' | 'active' | 'revoked' | 'expired';

export interface TokenRowLike {
  status: string;
  expires_at: string | null;
}

/**
 * Decide a token's usable state as of `now`, purely from the row. A REVOKED
 * status stays revoked; an ACTIVE token whose expiry has passed is 'expired'
 * (even if the stored status hasn't been swept yet). Fails closed: an unknown
 * status is treated as not usable ('revoked').
 */
export function evaluateTokenState(row: TokenRowLike | null | undefined, now: Date = new Date()): TokenState {
  if (!row) return 'not_found';
  const status = (row.status || '').toUpperCase();
  if (status === 'REVOKED') return 'revoked';
  if (status === 'EXPIRED') return 'expired';
  if (status !== 'ACTIVE') return 'revoked'; // unknown → fail closed
  if (row.expires_at) {
    const exp = new Date(row.expires_at);
    if (!Number.isNaN(exp.getTime()) && exp.getTime() <= now.getTime()) return 'expired';
  }
  return 'active';
}

/** A high-entropy, URL-safe opaque token (32 random bytes → base64url ≈ 43 chars). */
export function generatePortalToken(): string {
  return randomBytes(32).toString('base64url');
}

// ── I/O ──────────────────────────────────────────────────────────────────────
export interface ValidatedToken {
  tokenId: string;
  orgId: string;
  vendorId: string;
  requestedDocs: PortalDocKind[];
  label: string | null;
}

export type ValidateResult =
  | { ok: true; token: ValidatedToken }
  | { ok: false; state: Exclude<TokenState, 'active'> };

/**
 * Validate a magic-link token against vendor_portal_tokens using the SERVICE-ROLE
 * client (there is no tenant session). Returns the resolved org_id + vendor_id
 * FROM THE ROW so callers never trust client-supplied ids. Rejects
 * revoked/expired/unknown tokens. Only doc-kinds we understand are returned.
 */
export async function validatePortalToken(
  admin: SupabaseClient,
  token: string,
): Promise<ValidateResult> {
  if (!token || token.length < 16) return { ok: false, state: 'not_found' };

  const { data, error } = await admin
    .from('vendor_portal_tokens')
    .select('id, org_id, vendor_id, status, requested_docs, expires_at, label')
    .eq('token', token)
    .maybeSingle();

  if (error || !data) return { ok: false, state: 'not_found' };

  const state = evaluateTokenState(
    { status: data.status as string, expires_at: (data.expires_at as string) ?? null },
    new Date(),
  );
  if (state !== 'active') return { ok: false, state };

  const requested = Array.isArray(data.requested_docs)
    ? (data.requested_docs as string[]).filter(isPortalDocKind)
    : [];
  // Never surface an empty requested set — fall back to the canonical default.
  const requestedDocs = requested.length > 0 ? requested : (['W9', 'COI'] as PortalDocKind[]);

  return {
    ok: true,
    token: {
      tokenId: data.id as string,
      orgId: data.org_id as string,
      vendorId: data.vendor_id as string,
      requestedDocs,
      label: (data.label as string) ?? null,
    },
  };
}

/** Best-effort stamp of last_used_at after a successful upload (never throws). */
export async function touchTokenUsage(admin: SupabaseClient, tokenId: string): Promise<void> {
  try {
    await admin
      .from('vendor_portal_tokens')
      .update({ last_used_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', tokenId);
  } catch (e) {
    console.warn('[vendor-portal] touchTokenUsage failed (non-fatal):', e);
  }
}
