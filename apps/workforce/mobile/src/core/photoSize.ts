/**
 * Photo size before queueing: longest edge at most 2048 px, JPEG, quality stepping down until the
 * file is at most 3.5 MB — so an upload (photo + form overhead) stays under Vercel's 4.5 MB
 * request-body limit. If even the lowest quality is too big, the image is scaled down further.
 * Pure: the encoder is injected (expo-image-manipulator on the phone, a fake in tests).
 */

export const MAX_EDGE_PX = 2048;
export const MAX_PHOTO_BYTES = 3.5 * 1024 * 1024;
export const QUALITY_STEPS: ReadonlyArray<number> = [0.85, 0.75, 0.65, 0.55, 0.45, 0.35];
const MIN_EDGE_PX = 640;

/** The size to resize to so the longest edge is ≤ max, or null when it already fits. */
export function fitWithin(width: number, height: number, max = MAX_EDGE_PX): { width: number; height: number } | null {
  const longest = Math.max(width, height);
  if (longest <= max || longest <= 0) return null;
  const k = max / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

export interface Encoded {
  uri: string;
  bytes: number;
}

/** Encode at (longest edge, quality); returns the file it wrote and its size. */
export type Encoder = (maxEdge: number, quality: number) => Promise<Encoded>;

export interface ShrinkResult extends Encoded {
  quality: number;
  maxEdge: number;
  /** Every intermediate file that was written and not kept (the caller deletes them). */
  discarded: string[];
}

export class PhotoTooLargeError extends Error {
  constructor() {
    super('This photo could not be made small enough to send. Take it again.');
    this.name = 'PhotoTooLargeError';
  }
}

/** Step quality down at 2048 px; if still over, shrink the edge by a quarter and repeat. */
export async function shrinkToLimit(encode: Encoder, limit = MAX_PHOTO_BYTES, startEdge = MAX_EDGE_PX): Promise<ShrinkResult> {
  const discarded: string[] = [];
  for (let edge = startEdge; edge >= MIN_EDGE_PX; edge = Math.floor(edge * 0.75)) {
    for (const q of QUALITY_STEPS) {
      const out = await encode(edge, q);
      if (out.bytes > 0 && out.bytes <= limit) return { ...out, quality: q, maxEdge: edge, discarded };
      discarded.push(out.uri);
    }
  }
  throw new PhotoTooLargeError();
}
