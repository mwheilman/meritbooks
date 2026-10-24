/**
 * What a photo upload really is, from its first bytes — never from the client's MIME type or file
 * name. JPEG, PNG, WebP and HEIC/HEIF only. Pure (unit-tested).
 */

export type PhotoType = { mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic'; ext: 'jpg' | 'png' | 'webp' | 'heic' };

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'heif']);

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export function sniffPhoto(bytes: ArrayBuffer | Uint8Array): PhotoType | null {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v)) return { mime: 'image/png', ext: 'png' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  // ISO-BMFF: [size:4]['ftyp'][major brand:4][minor:4][compatible brands…]
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const size = Math.min(b.length, Math.max(16, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0), 64);
    const brands = [ascii(b, 8, 12)];
    for (let i = 16; i + 4 <= size; i += 4) brands.push(ascii(b, i, i + 4));
    if (brands.some((x) => HEIF_BRANDS.has(x))) return { mime: 'image/heic', ext: 'heic' };
  }
  return null;
}

/** Largest photo the server takes, and the multipart body allowance on top of it (meta + boundaries). */
export const PHOTO_MAX_BYTES = 12 * 1024 * 1024;
export const PHOTO_BODY_MAX_BYTES = PHOTO_MAX_BYTES + 64 * 1024;

export class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

/**
 * Read a request body, stopping as soon as it passes `max` bytes (so a body without a
 * Content-Length, or with a false one, never gets buffered past the cap).
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) return new Uint8Array(new ArrayBuffer(0));
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
