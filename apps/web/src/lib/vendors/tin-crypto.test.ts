/** TIN ciphertext carries a key id (rotation) and still opens legacy v1 values. */
import { describe, it, expect, afterEach } from 'vitest';
import { createCipheriv, randomBytes } from 'crypto';
import { decryptTin, encryptTin, sealedKeyId, tinKeyId } from './tin-crypto';
import { bankAccountFingerprint } from './bank-fingerprint';

const K1 = 'a'.repeat(64);
const K2 = 'c'.repeat(64);
const saved = { ...process.env };
afterEach(() => {
  for (const k of ['TIN_ENCRYPTION_KEY', 'TIN_ENCRYPTION_KEY_PREVIOUS', 'TIN_ENCRYPTION_KEY_ID', 'BANK_FINGERPRINT_KEY']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function legacyV1(digits: string, hexKey: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const ct = Buffer.concat([c.update(digits, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

describe('tin-crypto key id', () => {
  it('seals as v2:<key id>:… and round-trips', () => {
    process.env.TIN_ENCRYPTION_KEY = K1;
    const sealed = encryptTin('421234567')!;
    expect(sealed).toMatch(/^v2:[0-9a-f]{8}:/);
    expect(sealedKeyId(sealed)).toBe(tinKeyId(Buffer.from(K1, 'hex')));
    expect(sealed).not.toContain('421234567');
    expect(decryptTin(sealed)).toBe('421234567');
  });
  it('opens a legacy v1 value (backward compatible)', () => {
    process.env.TIN_ENCRYPTION_KEY = K1;
    expect(decryptTin(legacyV1('421234567', K1))).toBe('421234567');
  });
  it('after rotation: v2 and v1 values sealed with the previous key still open', () => {
    process.env.TIN_ENCRYPTION_KEY = K1;
    const oldV2 = encryptTin('421234567')!;
    const oldV1 = legacyV1('987654321', K1);
    process.env.TIN_ENCRYPTION_KEY = K2;
    expect(decryptTin(oldV2)).toBeNull(); // previous key not configured
    process.env.TIN_ENCRYPTION_KEY_PREVIOUS = K1;
    expect(decryptTin(oldV2)).toBe('421234567');
    expect(decryptTin(oldV1)).toBe('987654321');
    expect(sealedKeyId(encryptTin('421234567'))).toBe(tinKeyId(Buffer.from(K2, 'hex')));
  });
  it('tampering, an unknown key id or no key → null', () => {
    process.env.TIN_ENCRYPTION_KEY = K1;
    const sealed = encryptTin('421234567')!;
    const parts = sealed.split(':');
    expect(decryptTin([parts[0], 'deadbeef', ...parts.slice(2)].join(':'))).toBeNull();
    expect(decryptTin(sealed.replace(/.$/, sealed.endsWith('A') ? 'B' : 'A'))).toBeNull();
    delete process.env.TIN_ENCRYPTION_KEY;
    expect(encryptTin('421234567')).toBeNull();
    expect(decryptTin(sealed)).toBeNull();
  });
});

describe('bankAccountFingerprint', () => {
  it('is keyed, stable, and differs for a different account with the same last four', () => {
    process.env.TIN_ENCRYPTION_KEY = K1;
    const a = bankAccountFingerprint('071000013', '000123451234');
    expect(a).toMatch(/^f1:/);
    expect(a).toBe(bankAccountFingerprint('071000013', '0001-2345-1234'));
    expect(a).not.toBe(bankAccountFingerprint('071000013', '999999991234'));
    expect(a).not.toContain('1234');
    delete process.env.TIN_ENCRYPTION_KEY;
    expect(bankAccountFingerprint('071000013', '000123451234')).toBeNull();
  });
});
