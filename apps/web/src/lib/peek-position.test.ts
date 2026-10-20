import { describe, it, expect } from 'vitest';
import { placePeekCard } from './peek-position';

const base = { viewportW: 1440, viewportH: 900, cardW: 340, cardH: 240 };

describe('placePeekCard', () => {
  it('sits beside the pointer, below the row — not pinned to the far left (L11)', () => {
    // A full-width row starting just right of a 264px sidebar.
    const p = placePeekCard({ ...base, anchorX: 700, rowTop: 300, rowBottom: 340 });
    expect(p.left).toBe(712);
    expect(p.top).toBe(344);
  });

  it('flips left of the pointer near the right edge', () => {
    const p = placePeekCard({ ...base, anchorX: 1300, rowTop: 300, rowBottom: 340 });
    expect(p.left).toBe(1300 - 12 - 340);
  });

  it('flips above the row near the bottom edge', () => {
    const p = placePeekCard({ ...base, anchorX: 700, rowTop: 800, rowBottom: 840 });
    expect(p.top).toBe(800 - 4 - 240);
  });

  it('always stays inside the viewport', () => {
    for (const anchorX of [0, 5, 720, 1435, 1440]) {
      for (const rowTop of [0, 450, 880]) {
        const p = placePeekCard({ ...base, anchorX, rowTop, rowBottom: rowTop + 40 });
        expect(p.left).toBeGreaterThanOrEqual(12);
        expect(p.left + base.cardW).toBeLessThanOrEqual(base.viewportW - 12);
        expect(p.top).toBeGreaterThanOrEqual(12);
        expect(p.top + base.cardH).toBeLessThanOrEqual(base.viewportH - 12);
      }
    }
  });

  it('degrades on a viewport smaller than the card', () => {
    const p = placePeekCard({ viewportW: 300, viewportH: 200, cardW: 340, cardH: 240, anchorX: 100, rowTop: 50, rowBottom: 90 });
    expect(p).toEqual({ left: 12, top: 12 });
  });
});
