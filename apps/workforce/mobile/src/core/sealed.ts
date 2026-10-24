/**
 * Encryption at rest for what the phone stores (the command queue's payloads and the cached work):
 * a text is sealed as "v1:<base64 of iv+ciphertext+tag>" with AES-256-GCM. The cipher itself is
 * injected (expo-crypto on the phone, a fake in tests); this module owns the format, UTF-8 and
 * the rule that anything that does not open (tampered, wrong key, old format) reads as missing —
 * never as plaintext. Pure (unit-tested).
 */

export interface Cipher {
  /** AES-GCM encrypt; returns base64 of iv + ciphertext + tag. */
  encrypt(plain: Uint8Array): Promise<string>;
  /** Inverse of encrypt; throws if the tag does not verify. */
  decrypt(combinedBase64: string): Promise<Uint8Array>;
}

const PREFIX = 'v1:';

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 1) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i += 1;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

export function utf8Decode(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    let c: number;
    if (x < 0x80) { c = x; i += 1; }
    else if (x < 0xe0) { c = ((x & 31) << 6) | (b[i + 1]! & 63); i += 2; }
    else if (x < 0xf0) { c = ((x & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63); i += 3; }
    else { c = ((x & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63); i += 4; }
    if (c >= 0x10000) {
      c -= 0x10000;
      s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023));
    } else s += String.fromCharCode(c);
  }
  return s;
}

export interface Sealer {
  seal(plain: string): Promise<string>;
  /** The plaintext, or null when the value is not sealed with this key (or was tampered with). */
  open(sealed: string | null): Promise<string | null>;
}

export function createSealer(cipher: Cipher): Sealer {
  return {
    async seal(plain) {
      return PREFIX + (await cipher.encrypt(utf8Encode(plain)));
    },
    async open(sealed) {
      if (!sealed || !sealed.startsWith(PREFIX)) return null;
      try {
        return utf8Decode(await cipher.decrypt(sealed.slice(PREFIX.length)));
      } catch {
        return null;
      }
    },
  };
}
