import { describe, expect, it } from 'vitest';
import { MAX_PHOTO_BYTES, PhotoTooLargeError, QUALITY_STEPS, fitWithin, shrinkToLimit, type Encoder } from './photoSize';

/** Fake JPEG encoder: size ∝ pixels × quality. */
function encoder(bytesAtFullQuality2048: number): { encode: Encoder; calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    encode: async (edge, q) => {
      calls.push([edge, q]);
      return { uri: `file:///tmp/${edge}-${q}.jpg`, bytes: Math.round(bytesAtFullQuality2048 * (edge / 2048) ** 2 * q) };
    },
  };
}

describe('photo size before queueing', () => {
  it('fits the longest edge into 2048 px, keeping the aspect ratio', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048 });
    expect(fitWithin(1600, 1200)).toBeNull();
    expect(fitWithin(2048, 100)).toBeNull();
  });

  it('keeps the first quality that is under 3.5 MB', async () => {
    const e = encoder(2 * 1024 * 1024);
    const r = await shrinkToLimit(e.encode);
    expect(r).toMatchObject({ quality: QUALITY_STEPS[0], maxEdge: 2048, discarded: [] });
    expect(e.calls).toEqual([[2048, 0.85]]);
  });

  it('steps quality down until the file is ≤ 3.5 MB, listing the discarded tries', async () => {
    const e = encoder(6 * 1024 * 1024); // 0.85 → 5.1 MB, 0.75 → 4.5, 0.65 → 3.9, 0.55 → 3.3 ✓
    const r = await shrinkToLimit(e.encode);
    expect(r.quality).toBe(0.55);
    expect(r.bytes).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
    expect(e.calls.map((c) => c[1])).toEqual([0.85, 0.75, 0.65, 0.55]);
    expect(r.discarded).toHaveLength(3);
  });

  it('when the lowest quality is still too big, scales the edge down and tries again', async () => {
    const e = encoder(14 * 1024 * 1024); // at 2048, 0.35 → 4.9 MB; at 1536 the steps reach ≤ 3.5 MB
    const r = await shrinkToLimit(e.encode);
    expect(r.maxEdge).toBe(1536);
    expect(r.bytes).toBeLessThanOrEqual(MAX_PHOTO_BYTES);
    expect(e.calls.slice(0, QUALITY_STEPS.length).every((c) => c[0] === 2048)).toBe(true);
  });

  it('gives up with a plain error rather than queueing a photo the server would refuse', async () => {
    await expect(shrinkToLimit(async (edge, q) => ({ uri: `f-${edge}-${q}`, bytes: 50 * 1024 * 1024 }))).rejects.toBeInstanceOf(PhotoTooLargeError);
  });

  it('the limit leaves room for the form under Vercel’s 4.5 MB body limit', () => {
    expect(MAX_PHOTO_BYTES + 64 * 1024).toBeLessThan(4.5 * 1024 * 1024);
  });
});
