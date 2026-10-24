/**
 * Colour math for brand profiles (FPB-branding §4.6). Pure, dependency-free, used by the
 * browser (palette extraction + live contrast) AND the server (re-validation on save), so
 * both sides compute the very same numbers.
 *
 *  - WCAG 2.x relative luminance + contrast ratio (the AA rule we enforce).
 *  - OKLab / OKLCH (Björn Ottosson) for perceptual work: darkening a colour "keeps its
 *    hue", tints, distances between swatches, chroma as "how saturated it looks".
 *  - Gamut mapping by chroma reduction (an OKLCH point outside sRGB keeps L and h).
 */

export interface Rgb { r: number; g: number; b: number }            // 0–255
export interface Oklab { L: number; a: number; b: number }
export interface Oklch { L: number; C: number; h: number }           // h in degrees [0, 360)

export const WHITE = '#FFFFFF';
/** Merit Midnight — the "ink" text colour used when white doesn't read. */
export const INK = '#0A1628';
export const AA_TEXT = 4.5;
export const AA_UI = 3;

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
}

/** '#abc' | 'abc' | '#AABBCC' → {r,g,b}; null when not a hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function toHex({ r, g, b }: Rgb): string {
  const p = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`.toUpperCase();
}

/** Normalise any accepted hex spelling to '#RRGGBB'. */
export function normalizeHex(hex: string): string | null {
  const c = parseHex(hex);
  return c ? toHex(c) : null;
}

// ── WCAG ──────────────────────────────────────────────────────────────────────

const toLinear = (c8: number) => {
  const c = c8 / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function relativeLuminance(c: Rgb): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

/** WCAG contrast ratio, 1–21. Invalid input reads as 1 (fails every check). */
export function contrastRatio(a: string, b: string): number {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return 1;
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Round DOWN to 2 dp for display, so "4.49" never prints as "4.5" and looks like a pass. */
export function ratioLabel(r: number): string {
  return `${(Math.floor(r * 100) / 100).toFixed(2)}:1`;
}

/** White or Midnight ink — whichever has more contrast on `bg`. */
export function onColorFor(bg: string): string {
  return contrastRatio(bg, WHITE) >= contrastRatio(bg, INK) ? WHITE : INK;
}

// ── OKLab / OKLCH ─────────────────────────────────────────────────────────────

export function rgbToOklab(c: Rgb): Oklab {
  const r = toLinear(c.r), g = toLinear(c.g), b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** OKLab → linear sRGB (may be outside [0,1]). */
function oklabToLinear({ L, a, b }: Oklab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function oklabToRgb(lab: Oklab): Rgb {
  const [r, g, b] = oklabToLinear(lab);
  return { r: fromLinear(clamp(r, 0, 1)), g: fromLinear(clamp(g, 0, 1)), b: fromLinear(clamp(b, 0, 1)) };
}

export function oklabToOklch({ L, a, b }: Oklab): Oklch {
  const C = Math.sqrt(a * a + b * b);
  let h = (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L, C, h };
}

export function oklchToOklab({ L, C, h }: Oklch): Oklab {
  const rad = (h * Math.PI) / 180;
  return { L, a: C * Math.cos(rad), b: C * Math.sin(rad) };
}

export function hexToOklch(hex: string): Oklch {
  const c = parseHex(hex);
  return c ? oklabToOklch(rgbToOklab(c)) : { L: 0, C: 0, h: 0 };
}

function inGamut(lab: Oklab): boolean {
  const eps = 1e-4;
  return oklabToLinear(lab).every((v) => v >= -eps && v <= 1 + eps);
}

/** OKLCH → hex, reducing chroma (never L or h) until the colour is inside sRGB. */
export function oklchToHex(c: Oklch): string {
  const L = clamp(c.L, 0, 1);
  let lab = oklchToOklab({ L, C: Math.max(0, c.C), h: c.h });
  if (!inGamut(lab)) {
    let lo = 0;
    let hi = Math.max(0, c.C);
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchToOklab({ L, C: mid, h: c.h }))) lo = mid;
      else hi = mid;
    }
    lab = oklchToOklab({ L, C: lo, h: c.h });
  }
  return toHex(oklabToRgb(lab));
}

/** Perceptual distance (ΔE in OKLab, ~0.02 = just noticeable). */
export function deltaE(a: string, b: string): number {
  const ca = parseHex(a), cb = parseHex(b);
  if (!ca || !cb) return Infinity;
  const x = rgbToOklab(ca), y = rgbToOklab(cb);
  return Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2);
}

/** Smallest angle between two hues, 0–180. */
export function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 360;
  return d > 180 ? 360 - d : d;
}

export const rotateHue = (h: number, deg: number) => (((h + deg) % 360) + 360) % 360;

// ── Contrast adjustment ───────────────────────────────────────────────────────

/**
 * The colour, adjusted in OKLCH lightness (hue and chroma kept as far as sRGB allows) until
 * it reaches `min` contrast against `against`. Darkens against a light background, lightens
 * against a dark one. Returns the LIGHTEST passing colour when darkening (closest to the
 * original), found by binary search; black / white are the guaranteed end stops.
 */
export function ensureContrast(hex: string, against: string = WHITE, min: number = AA_TEXT): string {
  const norm = normalizeHex(hex);
  if (!norm) return against.toUpperCase() === WHITE ? INK : WHITE;
  if (contrastRatio(norm, against) >= min) return norm;
  const c = hexToOklch(norm);
  const bgLight = relativeLuminance(parseHex(against) ?? { r: 255, g: 255, b: 255 }) > 0.18;
  // Search the lightness band between the colour and the end stop.
  let lo = bgLight ? 0 : c.L;      // darkening: [0, L]   lightening: [L, 1]
  let hi = bgLight ? c.L : 1;
  let best = bgLight ? '#000000' : WHITE;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    const cand = oklchToHex({ L: mid, C: c.C, h: c.h });
    if (contrastRatio(cand, against) >= min) {
      best = cand;
      if (bgLight) lo = mid; else hi = mid;   // passing: try closer to the original
    } else if (bgLight) hi = mid; else lo = mid;
  }
  // Rounding to 8-bit can land a hair under the line: step until it truly passes.
  let guard = 0;
  while (contrastRatio(best, against) < min && guard++ < 40) {
    const b = hexToOklch(best);
    best = oklchToHex({ L: clamp(b.L + (bgLight ? -0.01 : 0.01), 0, 1), C: b.C, h: b.h });
  }
  return contrastRatio(best, against) >= min ? best : bgLight ? '#000000' : WHITE;
}

/** A light tint of the colour (for surfaces): OKLCH at lightness L with gentle chroma. */
export function tint(hex: string, L = 0.97, maxChroma = 0.025): string {
  const c = hexToOklch(hex);
  return oklchToHex({ L, C: Math.min(c.C, maxChroma), h: c.h });
}

/** A deep shade of the colour (for ink): low lightness, low chroma, same hue. */
export function shade(hex: string, L = 0.24, maxChroma = 0.05): string {
  const c = hexToOklch(hex);
  return oklchToHex({ L, C: Math.min(c.C, maxChroma), h: c.h });
}
