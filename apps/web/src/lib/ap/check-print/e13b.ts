/**
 * E-13B MICR glyphs as vector shapes — PURE, authored in this repo (no third-party font).
 *
 * WHY: there is no OFL / permissively-licensed E-13B TrueType font; the free ones are GPL
 * Type-1 (GnuMICR) or commercial. Typeface DESIGNS are not copyrightable in the US (font
 * SOFTWARE is), so drawing the standard's shapes ourselves carries no licence.
 *
 * GEOMETRY: E-13B is drawn on a 0.013" grid ("13"): every character is 9 units
 * (0.117") tall and sits in a 0.125" pitch cell. Each glyph below is a set of filled
 * rectangles [x, y, w, h] in grid units, y measured DOWN from the top of the character.
 *
 * CAUTION — these outlines APPROXIMATE the ISO 1004-1 / ANSI X9.27 reference shapes. They
 * read correctly to the eye and to most OCR readers, but they are NOT certified for
 * magnetic (waveform) recognition. Production use needs MICR toner AND either the bank's
 * MICR quality test passing with these shapes, or a licensed E-13B TTF dropped at
 * lib/ap/check-print/fonts/micr-e13b.ttf (check-pdf.tsx uses it automatically).
 */

import type { MicrChar } from '@/lib/ap/checks/micr';

export const E13B_UNIT_IN = 0.013;
export const E13B_HEIGHT_UNITS = 9;

export interface Glyph {
  /** Advance width of the inked shape, in grid units. */
  width: number;
  rects: ReadonlyArray<readonly [number, number, number, number]>;
}

export const E13B_GLYPHS: Readonly<Record<MicrChar, Glyph>> = {
  '0': { width: 7, rects: [[1, 0, 5, 1], [1, 8, 5, 1], [0, 1, 2, 7], [5, 1, 2, 7]] },
  '1': { width: 4, rects: [[0.5, 0, 2.5, 1], [1.5, 1, 1.5, 4], [1.5, 5, 2.5, 4], [0, 7, 1.5, 2]] },
  '2': { width: 5, rects: [[0, 0, 5, 1], [3.5, 1, 1.5, 3], [0, 4, 5, 1], [0, 5, 2, 2], [0, 7, 5, 2]] },
  '3': { width: 6, rects: [[0, 0, 4.5, 1], [3, 1, 1.5, 3], [1, 4, 5, 1], [3.5, 5, 2.5, 3], [0, 8, 6, 1]] },
  '4': { width: 7, rects: [[0, 0, 1.5, 5], [0, 5, 7, 1.5], [4.5, 3, 2.5, 6]] },
  '5': { width: 6, rects: [[0, 0, 6, 1], [0, 1, 1.5, 3], [0, 4, 6, 1], [3.5, 5, 2.5, 3], [0, 8, 6, 1]] },
  '6': { width: 6, rects: [[0, 0, 4.5, 1], [0, 1, 2, 8], [2, 4, 4, 1], [3.5, 5, 2.5, 3], [2, 8, 4, 1]] },
  '7': { width: 6, rects: [[0, 0, 6, 1.5], [3.5, 1.5, 2.5, 7.5]] },
  '8': { width: 6, rects: [[0.5, 0, 5, 1], [0.5, 1, 1.5, 3], [4, 1, 1.5, 3], [0.5, 4, 5, 1], [0, 5, 2.5, 3], [3.5, 5, 2.5, 3], [0, 8, 6, 1]] },
  '9': { width: 6, rects: [[0, 0, 6, 1], [0, 1, 2, 3], [0, 4, 4, 1], [4, 1, 2, 8]] },
  // ⑆ transit: a bar with two squares to its right.
  T: { width: 7, rects: [[0, 0, 1.5, 9], [3.5, 0, 3.5, 3.5], [3.5, 5.5, 3.5, 3.5]] },
  // ⑈ on-us: two short bars over the left half, a block lower right.
  U: { width: 7, rects: [[0, 0, 1.5, 6], [2.5, 0, 1.5, 6], [4.5, 5.5, 2.5, 3.5]] },
  // ⑇ amount: a short bar, a tall bar, a short bar (bank use; never printed by the issuer).
  A: { width: 7, rects: [[0, 2.5, 1.5, 4], [2.75, 0, 1.5, 9], [5.5, 2.5, 1.5, 4]] },
  // ⑉ dash: three blocks.
  D: { width: 7, rects: [[0, 3, 2, 3], [2.5, 3, 2, 3], [5, 3, 2, 3]] },
};

/**
 * Rectangles (in POINTS, PDF user space, y down) for one glyph whose character cell's
 * left edge is at `cellLeftPt` and whose baseline is at `baselinePt`. The glyph is centred
 * in its 0.125" cell.
 */
export function glyphRectsPt(char: MicrChar, cellLeftPt: number, baselinePt: number): Array<{ x: number; y: number; w: number; h: number }> {
  const g = E13B_GLYPHS[char];
  const u = E13B_UNIT_IN * 72;
  const cellW = 0.125 * 72;
  const left = cellLeftPt + (cellW - g.width * u) / 2;
  const top = baselinePt - E13B_HEIGHT_UNITS * u;
  return g.rects.map(([x, y, w, h]) => ({ x: left + x * u, y: top + y * u, w: w * u, h: h * u }));
}
