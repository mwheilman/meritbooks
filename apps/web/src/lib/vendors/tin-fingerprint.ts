/**
 * Org-scoped TIN fingerprint (security review H2). SERVER ONLY.
 *
 * A taxpayer id (EIN / SSN) must never sit in plaintext in a staging table, a log, an AI prompt or
 * an API body. Where Books only needs to answer "is this the same tax id?" (migration staging,
 * duplicate detection) it keeps a keyed fingerprint plus the last four digits instead:
 *
 *   fingerprint = "t1:" + base64url( HMAC-SHA256( orgKey, digits ) )
 *   orgKey      = HMAC-SHA256( baseKey, "meritbooks:tin-fingerprint:v1:" + orgId )
 *   baseKey     = TIN_FINGERPRINT_KEY (≥ 32 chars), else derived from TIN_ENCRYPTION_KEY
 *
 * Keyed, not a bare hash: a 9-digit id space is trivially brute-forced from an unkeyed SHA-256.
 * Org-scoped: the same TIN in two tenants yields unrelated fingerprints, so a fingerprint can't be
 * used to link records across tenants. No key configured → null (matching then falls back to name /
 * email / phone; nothing is stored in the clear). Only 9-digit ids are fingerprinted (US EIN / SSN).
 */

import { createHmac } from 'crypto';

function baseKey(): Buffer | null {
  const own = process.env.TIN_FINGERPRINT_KEY?.trim();
  if (own && own.length >= 32) return Buffer.from(own, 'utf8');
  const tin = process.env.TIN_ENCRYPTION_KEY?.trim();
  if (!tin) return null;
  return createHmac('sha256', tin).update('meritbooks:tin-fingerprint:v1').digest();
}

/** Digits of a raw tax id (formatting stripped). */
export function tinDigits(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '');
}

/** The keyed, org-scoped fingerprint of a 9-digit tax id; null when absent / malformed / no key. */
export function tinFingerprint(orgId: string, raw: string | null | undefined): string | null {
  const digits = tinDigits(raw);
  if (digits.length !== 9 || !orgId) return null;
  const k = baseKey();
  if (!k) return null;
  const orgKey = createHmac('sha256', k).update(`meritbooks:tin-fingerprint:v1:${orgId}`).digest();
  return `t1:${createHmac('sha256', orgKey).update(digits).digest('base64url')}`;
}

/** Last four digits (display only); null when fewer than four digits. */
export function tinLastFour(raw: string | null | undefined): string | null {
  const digits = tinDigits(raw);
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Replace a parsed `taxId` with `{ taxIdHash, taxIdLast4 }`. The returned object never carries the
 * plaintext id (the `taxId` key is removed, not nulled).
 */
export function protectTaxId<T extends { taxId?: string | null }>(
  orgId: string,
  party: T,
): Omit<T, 'taxId'> & { taxIdHash: string | null; taxIdLast4: string | null } {
  const { taxId, ...rest } = party;
  return { ...rest, taxIdHash: tinFingerprint(orgId, taxId), taxIdLast4: tinLastFour(taxId) };
}
