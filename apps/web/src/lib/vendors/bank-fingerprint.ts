/**
 * Full-number bank fingerprint (security review M2). Bank details are stored as last-4
 * masks only, so a NEW account that happens to share the old last four looks unchanged.
 * The profile upsert (which briefly holds the raw numbers) stores this keyed HMAC-SHA256
 * of routing|account in vendor_payment_profiles.account_fingerprint; the mig-180 trigger
 * opens a bank-change call-back when it changes. Keyed (not a bare hash): a bare SHA-256
 * of a routing + account number is brute-forceable. Key: BANK_FINGERPRINT_KEY, else
 * derived from TIN_ENCRYPTION_KEY. No key → null (the trigger then compares masks).
 */

import { createHmac } from 'crypto';

function fingerprintKey(): Buffer | null {
  const own = process.env.BANK_FINGERPRINT_KEY?.trim();
  if (own && own.length >= 32) return Buffer.from(own, 'utf8');
  const tin = process.env.TIN_ENCRYPTION_KEY?.trim();
  if (!tin) return null;
  return createHmac('sha256', tin).update('meritbooks:bank-fingerprint:v1').digest();
}

export function bankAccountFingerprint(routingNumber: string | null | undefined, accountNumber: string | null | undefined): string | null {
  const r = (routingNumber ?? '').replace(/\D/g, '');
  const a = (accountNumber ?? '').replace(/[^0-9A-Za-z]/g, '');
  if (!a) return null;
  const k = fingerprintKey();
  if (!k) return null;
  return `f1:${createHmac('sha256', k).update(`${r}|${a}`).digest('base64url')}`;
}
