import { describe, expect, it } from 'vitest';
import { createSealer, utf8Decode, utf8Encode, type Cipher } from './sealed';

/** Fake AES-GCM: XOR with a key byte + a checksum "tag", base64 like the real one. */
function fakeCipher(key: number): Cipher {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return {
    async encrypt(plain) {
      const body = plain.map((x) => x ^ key);
      const tag = body.reduce((s, x) => (s + x) & 255, key);
      return b64(new Uint8Array([...body, tag]));
    },
    async decrypt(combined) {
      const all = new Uint8Array(Buffer.from(combined, 'base64'));
      const body = all.subarray(0, all.length - 1);
      if (body.reduce((s, x) => (s + x) & 255, key) !== all[all.length - 1]) throw new Error('tag');
      return body.map((x) => x ^ key);
    },
  };
}

describe('sealing what the phone stores', () => {
  it('UTF-8 round-trips English, Spanish and emoji', () => {
    for (const s of ['Clocked 7:02 AM', 'Señor Núñez — baño', '🔧 crew ✓', '']) expect(utf8Decode(utf8Encode(s))).toBe(s);
    expect([...utf8Encode('ñ')]).toEqual([0xc3, 0xb1]);
  });

  it('seals as v1:… without the plaintext, and opens with the same key', async () => {
    const s = createSealer(fakeCipher(42));
    const text = JSON.stringify({ kind: 'log.submit', body: 'Inspector Tuesday', geo: { lat: 41.6, lng: -93.6 } });
    const sealed = await s.seal(text);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(sealed).not.toContain('Inspector');
    expect(await s.open(sealed)).toBe(text);
  });

  it('a wrong key, a tampered value or plaintext never opens (reads as missing)', async () => {
    const sealed = await createSealer(fakeCipher(42)).seal('secret');
    expect(await createSealer(fakeCipher(7)).open(sealed)).toBeNull();
    const tampered = `v1:${Buffer.from('garbage!').toString('base64')}`;
    expect(await createSealer(fakeCipher(42)).open(tampered)).toBeNull();
    expect(await createSealer(fakeCipher(42)).open('{"kind":"log.submit"}')).toBeNull();
    expect(await createSealer(fakeCipher(42)).open(null)).toBeNull();
  });
});
