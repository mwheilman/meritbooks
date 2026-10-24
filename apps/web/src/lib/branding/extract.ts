/**
 * Dominant colours of a logo (FPB-branding AC-1). Pure: takes RGBA pixels (what a canvas
 * `getImageData` returns), returns swatches ordered by how much of the logo they cover.
 *
 * Method: sample up to `maxSamples` pixels on a stride, drop the background — transparent
 * (α < 128), near-white and near-black pixels (OKLab L outside [darkL, lightL]) — then
 * weighted k-means in OKLab over a 5-bit-per-channel histogram (fast, deterministic: the
 * seeds are picked farthest-first from the heaviest bin, no randomness). Clusters closer
 * than `mergeDeltaE` are merged. The near-black share is reported separately so a black
 * wordmark with a coloured icon still knows it had "ink".
 */

import { oklabToOklch, oklabToRgb, rgbToOklab, toHex, type Oklab } from './color';

export interface PixelSource {
  /** RGBA, 4 bytes per pixel (Uint8ClampedArray from canvas, or a plain array in tests). */
  data: ArrayLike<number>;
  width: number;
  height: number;
}

export interface ExtractedColor {
  hex: string;
  /** Share of the kept (non-background) pixels, 0–1. */
  share: number;
  /** OKLCH chroma — how saturated it looks (0 = grey; ~0.25+ = vivid). */
  chroma: number;
  hue: number;
  lightness: number;
}

export interface Extraction {
  colors: ExtractedColor[];
  /** Pixels kept after dropping the background. */
  kept: number;
  sampled: number;
  ignored: { transparent: number; light: number; dark: number };
  /** The logo's own dark ink (e.g. a black wordmark), when it has a meaningful amount. */
  darkInk: string | null;
  /** True when no kept colour is saturated (greyscale / single neutral logo). */
  monochrome: boolean;
}

export interface ExtractOptions {
  k?: number;
  maxSamples?: number;
  lightL?: number;
  darkL?: number;
  mergeDeltaE?: number;
  /** Chroma under which a colour counts as grey. */
  greyChroma?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  k: 6,
  maxSamples: 40_000,
  lightL: 0.96,
  darkL: 0.25,
  mergeDeltaE: 0.06,
  greyChroma: 0.035,
};

interface Bin { lab: Oklab; w: number }

const dist2 = (x: Oklab, y: Oklab) => (x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2;

function describe(lab: Oklab, share: number): ExtractedColor {
  const lch = oklabToOklch(lab);
  return { hex: toHex(oklabToRgb(lab)), share, chroma: lch.C, hue: lch.h, lightness: lch.L };
}

export function extractPalette(src: PixelSource, opts: ExtractOptions = {}): Extraction {
  const o = { ...DEFAULTS, ...opts };
  const total = Math.max(0, Math.floor(src.width) * Math.floor(src.height));
  const n = Math.min(total, Math.floor(src.data.length / 4));
  const stride = Math.max(1, Math.floor(n / o.maxSamples));

  const ignored = { transparent: 0, light: 0, dark: 0 };
  const bins = new Map<number, { r: number; g: number; b: number; w: number }>();
  const darkBins = { r: 0, g: 0, b: 0, w: 0 };
  let sampled = 0;
  let kept = 0;

  for (let p = 0; p < n; p += stride) {
    const i = p * 4;
    sampled++;
    const a = src.data[i + 3];
    if (a < 128) { ignored.transparent++; continue; }
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2];
    const L = rgbToOklab({ r, g, b }).L;
    if (L > o.lightL) { ignored.light++; continue; }
    if (L < o.darkL) {
      ignored.dark++;
      darkBins.r += r; darkBins.g += g; darkBins.b += b; darkBins.w++;
      continue;
    }
    kept++;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const bin = bins.get(key);
    if (bin) { bin.r += r; bin.g += g; bin.b += b; bin.w++; }
    else bins.set(key, { r, g, b, w: 1 });
  }

  const opaque = sampled - ignored.transparent;
  const darkInk = darkBins.w > 0 && opaque > 0 && darkBins.w / opaque >= 0.02
    ? toHex({ r: darkBins.r / darkBins.w, g: darkBins.g / darkBins.w, b: darkBins.b / darkBins.w })
    : null;

  if (kept === 0) {
    return { colors: [], kept, sampled, ignored, darkInk, monochrome: true };
  }

  const points: Bin[] = Array.from(bins.values()).map((v) => ({
    lab: rgbToOklab({ r: v.r / v.w, g: v.g / v.w, b: v.b / v.w }),
    w: v.w,
  }));

  // Farthest-first seeds, starting from the heaviest bin (deterministic).
  points.sort((x, y) => y.w - x.w);
  const k = Math.min(o.k, points.length);
  const centers: Oklab[] = [points[0].lab];
  while (centers.length < k) {
    let best = -1;
    let bestScore = -1;
    for (let i = 0; i < points.length; i++) {
      const d = Math.min(...centers.map((c) => dist2(c, points[i].lab)));
      const score = d * Math.sqrt(points[i].w);
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0 || bestScore <= 0) break;
    centers.push(points[best].lab);
  }

  // Weighted k-means.
  const assign = new Array<number>(points.length).fill(0);
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < points.length; i++) {
      let bi = 0;
      let bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(points[i].lab, centers[c]);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; moved = true; }
    }
    const acc = centers.map(() => ({ L: 0, a: 0, b: 0, w: 0 }));
    for (let i = 0; i < points.length; i++) {
      const s = acc[assign[i]];
      const p = points[i];
      s.L += p.lab.L * p.w; s.a += p.lab.a * p.w; s.b += p.lab.b * p.w; s.w += p.w;
    }
    for (let c = 0; c < centers.length; c++) {
      if (acc[c].w > 0) centers[c] = { L: acc[c].L / acc[c].w, a: acc[c].a / acc[c].w, b: acc[c].b / acc[c].w };
    }
    if (!moved && iter > 0) break;
  }

  let clusters = centers.map((lab, c) => ({
    lab,
    w: points.reduce((s, p, i) => (assign[i] === c ? s + p.w : s), 0),
  })).filter((c) => c.w > 0);

  // Merge near-duplicates (heaviest absorbs lighter).
  clusters.sort((x, y) => y.w - x.w);
  const merged: typeof clusters = [];
  for (const c of clusters) {
    const into = merged.find((m) => Math.sqrt(dist2(m.lab, c.lab)) < o.mergeDeltaE);
    if (into) {
      const w = into.w + c.w;
      into.lab = {
        L: (into.lab.L * into.w + c.lab.L * c.w) / w,
        a: (into.lab.a * into.w + c.lab.a * c.w) / w,
        b: (into.lab.b * into.w + c.lab.b * c.w) / w,
      };
      into.w = w;
    } else merged.push({ ...c });
  }
  clusters = merged.sort((x, y) => y.w - x.w);

  const colors = clusters.map((c) => describe(c.lab, c.w / kept)).filter((c) => c.share >= 0.005);
  const monochrome = !colors.some((c) => c.chroma >= o.greyChroma && c.share >= 0.03);
  return { colors, kept, sampled, ignored, darkInk, monochrome };
}

/**
 * The colour to build the brand on: the most saturated DOMINANT colour — chroma weighted by
 * how much of the logo's coloured area it covers (chroma × √share among the non-grey
 * colours), so a big teal mark beats a small orange dot, while a vivid colour still beats a
 * larger dull one. Greys only when the logo has no colour at all.
 */
export function pickPrimary(ex: Extraction, minShare = 0.08, greyChroma = DEFAULTS.greyChroma): ExtractedColor | null {
  if (ex.colors.length === 0) return null;
  const chromatic = ex.colors.filter((c) => c.chroma >= greyChroma);
  if (chromatic.length === 0) return ex.colors.slice().sort((a, b) => b.share - a.share)[0];
  const total = chromatic.reduce((s, c) => s + c.share, 0) || 1;
  const pool = chromatic.filter((c) => c.share / total >= minShare);
  const score = (c: ExtractedColor) => c.chroma * Math.sqrt(c.share / total);
  return (pool.length ? pool : chromatic).slice().sort((a, b) => score(b) - score(a) || b.share - a.share)[0];
}
