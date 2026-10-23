import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { encodeQr, qrSvgPath, type QrMatrix } from './qr-code';

/**
 * Fixtures were produced by two independent reference encoders (python `qrcode` 8.x with
 * forced masks, and Project Nayuki's `qrcodegen` with automatic masks) and matched this
 * encoder bit-for-bit across 104 matrices: ECC L/M/Q/H, versions 1–39, masks 0–7 and auto,
 * ASCII URLs, UTF-8 text.
 */
const HELLO_M = [
  '111111100110001111111',
  '100000101100001000001',
  '101110100101101011101',
  '101110100011001011101',
  '101110101100101011101',
  '100000100000101000001',
  '111111101010101111111',
  '000000000011100000000',
  '101010100101000010010',
  '001011000010001000011',
  '010100101110100011111',
  '110010000000001000010',
  '011010110010101010000',
  '000000001111010100111',
  '111111100011011100111',
  '100000100011110110000',
  '101110101011011100011',
  '101110100100001100110',
  '101110101110100010101',
  '100000100100001010010',
  '111111101110101100011',
];

const PAY_URL = 'https://meritbooks-web.vercel.app/pay/3f1c2b9e-8d4a-4c1e-9b7f-2a6d5e0c1b3a';
/** sha256 of the concatenated row strings for PAY_URL at ECC M (version 5, mask 2). */
const PAY_URL_M_SHA = '145963e7fcb0d73e6f44f744f7976cf88c4a397d227c65266c0afb24ea5fcf62';

const rows = (m: QrMatrix) => m.modules.map((r) => r.map((c) => (c ? '1' : '0')).join(''));

/** Read the 15 format bits around the top-left finder and undo the 0x5412 mask. */
function readFormat(m: QrMatrix): { eccBits: number; mask: number } {
  const g = (x: number, y: number) => (m.modules[y][x] ? 1 : 0);
  const bits: number[] = [];
  for (let i = 0; i <= 5; i++) bits[i] = g(8, i);
  bits[6] = g(8, 7);
  bits[7] = g(8, 8);
  bits[8] = g(7, 8);
  for (let i = 9; i < 15; i++) bits[i] = g(14 - i, 8);
  const word = bits.reduce((acc, b, i) => acc | (b << i), 0) ^ 0x5412;
  return { eccBits: (word >>> 13) & 3, mask: (word >>> 10) & 7 };
}

function finderAt(m: QrMatrix, x0: number, y0: number): boolean {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      if (m.modules[y0 + dy][x0 + dx] !== (ring !== 2)) return false;
    }
  }
  return true;
}

describe('encodeQr', () => {
  it("'hello' at ECC M is the reference matrix (version 1, auto mask)", () => {
    const m = encodeQr('hello', { ecc: 'M' });
    expect(m.size).toBe(21);
    expect(rows(m)).toEqual(HELLO_M);
  });

  it('a pay URL encodes to the reference matrix with valid structure', () => {
    const m = encodeQr(PAY_URL, { ecc: 'M' });
    expect(m.size).toBe(37); // version 5
    expect(crypto.createHash('sha256').update(rows(m).join('')).digest('hex')).toBe(PAY_URL_M_SHA);
    expect(finderAt(m, 0, 0)).toBe(true);
    expect(finderAt(m, m.size - 7, 0)).toBe(true);
    expect(finderAt(m, 0, m.size - 7)).toBe(true);
    expect(m.modules[m.size - 8][8]).toBe(true); // the dark module
    for (let i = 8; i < m.size - 8; i++) expect(m.modules[6][i]).toBe(i % 2 === 0); // timing
    expect(readFormat(m)).toEqual({ eccBits: 0, mask: 2 }); // M = 00
  });

  it('honours a forced mask and ECC level in the format bits', () => {
    const m = encodeQr(PAY_URL, { ecc: 'H', mask: 6 });
    expect(readFormat(m)).toEqual({ eccBits: 2, mask: 6 }); // H = 10
  });

  it('is deterministic', () => {
    expect(rows(encodeQr(PAY_URL))).toEqual(rows(encodeQr(PAY_URL)));
  });

  it('picks the smallest version and respects minVersion', () => {
    expect(encodeQr('hi').size).toBe(21);
    expect(encodeQr('hi', { minVersion: 7 }).size).toBe(45);
  });

  it('throws a clear error when the text is too long', () => {
    expect(() => encodeQr('x'.repeat(3000), { ecc: 'H' })).toThrow(/too long/);
    expect(() => encodeQr(PAY_URL, { maxVersion: 2 })).toThrow(/too long/);
    expect(() => encodeQr('hi', { mask: 9 })).toThrow(/mask/);
  });
});

describe('qrSvgPath', () => {
  it('draws every dark module inside a quiet-zoned viewBox', () => {
    const m = encodeQr(PAY_URL);
    const { viewBox, d } = qrSvgPath(m);
    expect(viewBox).toBe(m.size + 8);
    expect(d.startsWith('M4,4h7v1h-7z')).toBe(true); // top-left finder row, offset by the quiet zone
    const runs = [...d.matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0);
    const dark = m.modules.flat().filter(Boolean).length;
    expect(runs).toBe(dark);
    expect(qrSvgPath(m, { quiet: 0 }).viewBox).toBe(m.size);
  });
});
