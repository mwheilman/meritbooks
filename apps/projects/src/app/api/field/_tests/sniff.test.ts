import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readLimited, sniffPhoto } from '../_lib/sniff';

const bytes = (...parts: Array<number[] | string>) => {
  const out: number[] = [];
  for (const p of parts) typeof p === 'string' ? out.push(...[...p].map((c) => c.charCodeAt(0))) : out.push(...p);
  return new Uint8Array(out);
};

describe('photo type from magic bytes, never from the client', () => {
  it('recognises JPEG, PNG, WebP and HEIC/HEIF', () => {
    expect(sniffPhoto(bytes([0xff, 0xd8, 0xff, 0xdb]))).toEqual({ mime: 'image/jpeg', ext: 'jpg' });
    expect(sniffPhoto(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]))).toEqual({ mime: 'image/png', ext: 'png' });
    expect(sniffPhoto(bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 '))).toEqual({ mime: 'image/webp', ext: 'webp' });
    expect(sniffPhoto(bytes([0, 0, 0, 0x18], 'ftypheic', [0, 0, 0, 0], 'mif1heic'))).toEqual({ mime: 'image/heic', ext: 'heic' });
    expect(sniffPhoto(bytes([0, 0, 0, 0x1c], 'ftypmif1', [0, 0, 0, 0], 'mif1heicmiaf'))).toEqual({ mime: 'image/heic', ext: 'heic' });
  });
  it('refuses everything else: PDF, video (ftyp isom), SVG, HTML, empty, truncated', () => {
    expect(sniffPhoto(bytes('%PDF-1.7'))).toBeNull();
    expect(sniffPhoto(bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2mp41'))).toBeNull();
    expect(sniffPhoto(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
    expect(sniffPhoto(bytes('<html><script>'))).toBeNull();
    expect(sniffPhoto(new Uint8Array(0))).toBeNull();
    expect(sniffPhoto(bytes([0xff, 0xd8]))).toBeNull();
    expect(sniffPhoto(bytes('RIFF', [0, 0, 0, 0], 'WAVE'))).toBeNull();
  });
});

describe('readLimited', () => {
  const stream = (chunks: number[]) => new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n));
      c.close();
    },
  });
  it('returns the body under the limit', async () => {
    expect((await readLimited(stream([3, 4]), 10)).byteLength).toBe(7);
    expect((await readLimited(null, 10)).byteLength).toBe(0);
  });
  it('stops as soon as the body passes the limit', async () => {
    await expect(readLimited(stream([6, 6, 6]), 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});
