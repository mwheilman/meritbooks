/**
 * Optional licensed E-13B font. Server-only.
 *
 * By default checks draw the MICR line with the in-repo vector glyphs (e13b.ts). If the
 * tenant / operator licenses an E-13B TrueType font, point CHECK_MICR_FONT_PATH at it (or
 * drop it at apps/web/src/lib/ap/check-print/fonts/micr-e13b.ttf) and it is used instead.
 * Licensed MICR fonts almost all map the four symbols to letters:
 *   A = ⑆ transit   B = ⑇ amount   C = ⑈ on-us   D = ⑉ dash
 * Override with CHECK_MICR_FONT_SYMBOLS="ABCD" (transit, amount, on-us, dash) when a font differs.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MicrChar } from '@/lib/ap/checks/micr';

export interface MicrFont {
  path: string;
  /** Map one composed MICR char to the font's code point. */
  toFontText: (text: string) => string;
}

function candidatePaths(): string[] {
  const out: string[] = [];
  if (process.env.CHECK_MICR_FONT_PATH) out.push(process.env.CHECK_MICR_FONT_PATH);
  out.push(path.join(process.cwd(), 'src/lib/ap/check-print/fonts/micr-e13b.ttf'));
  out.push(path.join(process.cwd(), 'apps/web/src/lib/ap/check-print/fonts/micr-e13b.ttf'));
  return out;
}

export function loadMicrFont(): MicrFont | null {
  const found = candidatePaths().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!found) return null;
  const sym = (process.env.CHECK_MICR_FONT_SYMBOLS ?? 'ABCD').padEnd(4, 'D').slice(0, 4);
  const map: Partial<Record<MicrChar, string>> = { T: sym[0], A: sym[1], U: sym[2], D: sym[3] };
  return {
    path: found,
    toFontText: (text) => text.replace(/[TUAD]/g, (c) => map[c as MicrChar] ?? c),
  };
}
