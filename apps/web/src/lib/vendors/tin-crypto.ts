/**
 * TIN encryption for the fill-here W-9 (FPB-vendor-compliance-chase §19 A6).
 *
 * AES-256-GCM with a server-only key (`TIN_ENCRYPTION_KEY`: 32 bytes as 64 hex chars or
 * base64). Output (v2): `v2:<key id>:<iv b64url>:<tag b64url>:<ciphertext b64url>`. The key
 * id names the key that sealed the value so keys can rotate: put the retired key in
 * `TIN_ENCRYPTION_KEY_PREVIOUS` (comma-separated for several) and old values still open.
 * The key id is `TIN_ENCRYPTION_KEY_ID` when set, else the first 8 hex of SHA-256(key) — it
 * identifies, never reveals, the key. Legacy `v1:<iv>:<tag>:<ct>` values (no key id) are
 * still decrypted, trying the current key then the previous ones.
 *
 * With no key configured `encryptTin` returns null and the caller keeps the last four
 * digits only — the TIN is then simply not stored (never stored in clear). Never log or
 * return the input.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

interface TinKey {
  id: string;
  key: Buffer;
}

function parseKey(raw: string | undefined): Buffer | null {
  const v = raw?.trim();
  if (!v) return null;
  const buf = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  return buf.length === 32 ? buf : null;
}

/** The key's identifier: first 8 hex of SHA-256(key). Not reversible. */
export function tinKeyId(k: Buffer): string {
  return createHash('sha256').update(k).digest('hex').slice(0, 8);
}

function currentKey(): TinKey | null {
  const k = parseKey(process.env.TIN_ENCRYPTION_KEY);
  if (!k) return null;
  const configured = process.env.TIN_ENCRYPTION_KEY_ID?.trim();
  return { id: configured && /^[A-Za-z0-9_-]{1,32}$/.test(configured) ? configured : tinKeyId(k), key: k };
}

function previousKeys(): TinKey[] {
  return (process.env.TIN_ENCRYPTION_KEY_PREVIOUS ?? '')
    .split(',')
    .map((r) => parseKey(r))
    .filter((k): k is Buffer => k !== null)
    .map((k) => ({ id: tinKeyId(k), key: k }));
}

export function tinEncryptionConfigured(): boolean {
  return currentKey() !== null;
}

/** Digits only, 9 of them, or null. */
export function normaliseTin(raw: string): string | null {
  const d = (raw ?? '').replace(/\D/g, '');
  return d.length === 9 ? d : null;
}

/**
 * Plausibility (not an IRS match): 9 digits, not all the same digit, no SSN with area 000 /
 * 666 / 9xx or group 00 or serial 0000, no EIN with a 00 / 07 / 08 / 09 / 17 / 18 / 19 / 28
 * / 29 / 49 / 69 / 70 / 78 / 79 / 89 / 96 / 97 prefix (never issued).
 */
export function tinLooksValid(digits: string, type: 'SSN' | 'EIN'): boolean {
  if (!/^\d{9}$/.test(digits)) return false;
  if (/^(\d)\1{8}$/.test(digits)) return false;
  if (digits === '123456789') return false;
  if (type === 'SSN') {
    const area = digits.slice(0, 3);
    if (area === '000' || area === '666' || area.startsWith('9')) return false;
    if (digits.slice(3, 5) === '00' || digits.slice(5) === '0000') return false;
    return true;
  }
  const prefix = digits.slice(0, 2);
  return !['00', '07', '08', '09', '17', '18', '19', '28', '29', '49', '69', '70', '78', '79', '89', '96', '97'].includes(prefix);
}

export function encryptTin(digits: string): string | null {
  const k = currentKey();
  if (!k) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.key, iv);
  const ct = Buffer.concat([c.update(digits, 'utf8'), c.final()]);
  return `v2:${k.id}:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

function open(key: Buffer, iv: string, tag: string, ct: string): string | null {
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** The key id a sealed value names (v2), or null (v1 / malformed). Never decrypts. */
export function sealedKeyId(sealed: string | null | undefined): string | null {
  const parts = (sealed ?? '').split(':');
  return parts[0] === 'v2' && parts.length === 5 && parts[1] ? parts[1] : null;
}

/**
 * Server-only (1099 / TIN match). Returns null on a missing key, an unknown key id or a
 * tampered value. v2 opens with the key its id names (current or previous); v1 tries the
 * current key, then each previous key.
 */
export function decryptTin(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const cur = currentKey();
  const ring = [...(cur ? [cur] : []), ...previousKeys()];
  if (ring.length === 0) return null;
  const parts = sealed.split(':');
  if (parts[0] === 'v2') {
    const [, kid, iv, tag, ct] = parts;
    if (parts.length !== 5 || !kid || !iv || !tag || !ct) return null;
    const k = ring.find((r) => r.id === kid) ?? (cur && kid === tinKeyId(cur.key) ? cur : undefined);
    return k ? open(k.key, iv, tag, ct) : null;
  }
  if (parts[0] === 'v1') {
    const [, iv, tag, ct] = parts;
    if (parts.length !== 4 || !iv || !tag || !ct) return null;
    for (const k of ring) {
      const out = open(k.key, iv, tag, ct);
      if (out !== null) return out;
    }
  }
  return null;
}

/** "•••-••-1234" (SSN) / "••-•••1234" (EIN). */
export function maskTinDigits(digits: string, type: 'SSN' | 'EIN'): string {
  const last4 = digits.slice(-4);
  return type === 'SSN' ? `•••-••-${last4}` : `••-•••${last4}`;
}
