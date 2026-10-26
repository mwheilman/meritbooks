/**
 * Logo colours → brand palettes (FPB-branding §4.6, AC-2…AC-4). Pure.
 *
 * Six roles, each with one job, so every surface can use them without guessing:
 *   primary     buttons, links, the PDF band — must read as TEXT on white (AA 4.5:1)
 *   on_primary  text on primary (white or Midnight, whichever contrasts more)
 *   secondary   a second brand colour (headings, secondary bands) — AA on white
 *   accent      highlights: rules, chips, focus of attention — 3:1 on white (UI contrast)
 *   ink         body text — AA on `surface` and on white
 *   surface     a faint brand tint for panels / table heads
 */

import {
  AA_TEXT,
  AA_UI,
  WHITE,
  contrastRatio,
  ensureContrast,
  hexToOklch,
  hueDistance,
  isHex,
  oklchToHex,
  onColorFor,
  rotateHue,
  shade,
  tint,
} from './color';
import { pickPrimary, type ExtractedColor, type Extraction } from './extract';

export const PALETTE_ROLES = ['primary', 'secondary', 'accent', 'ink', 'surface', 'on_primary'] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export type BrandPalette = Record<PaletteRole, string>;

/** Merit's own palette — the platform default when a tenant has no brand. */
export const MERIT_PALETTE: BrandPalette = {
  primary: '#2563EB',
  secondary: '#0A1628',
  accent: '#3B82F6',
  ink: '#0A1628',
  surface: '#EBF2FE',
  on_primary: '#FFFFFF',
};

export interface ContrastCheck {
  id: string;
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  min: number;
  pass: boolean;
  /** A required check blocks saving; an advisory one only warns. */
  required: boolean;
}

export interface ContrastReport {
  ok: boolean;
  checks: ContrastCheck[];
}

export function contrastReport(p: BrandPalette): ContrastReport {
  const mk = (id: string, label: string, fg: string, bg: string, min: number, required: boolean): ContrastCheck => {
    const ratio = contrastRatio(fg, bg);
    return { id, label, fg, bg, ratio: Math.round(ratio * 100) / 100, min, pass: ratio >= min, required };
  };
  const checks = [
    mk('primary_on_white', 'Brand colour as text on white', p.primary, WHITE, AA_TEXT, true),
    mk('on_primary', 'Button text on the brand colour', p.on_primary, p.primary, AA_TEXT, true),
    mk('ink_on_surface', 'Body text on the tinted surface', p.ink, p.surface, AA_TEXT, true),
    mk('ink_on_white', 'Body text on white', p.ink, WHITE, AA_TEXT, true),
    mk('secondary_on_white', 'Secondary colour on white', p.secondary, WHITE, AA_TEXT, false),
    mk('accent_on_white', 'Accent against white', p.accent, WHITE, AA_UI, false),
  ];
  return { ok: checks.every((c) => !c.required || c.pass), checks };
}

/**
 * Plain-English verdict for one check. WCAG AA: 4.5:1 for body text; 3:1 is enough only for
 * large text (≥ 24px, or ≥ 18.66px bold) and UI parts (icons, borders, focus rings) — so a
 * colour that clears 3:1 but not 4.5:1 "passes for large text and UI only", never just "passes".
 */
export function contrastVerdict(c: Pick<ContrastCheck, 'ratio' | 'min' | 'pass' | 'required'>): string {
  if (!c.pass) return c.required ? `needs ${c.min}:1` : 'low';
  if (c.ratio < AA_TEXT) return 'passes for large text and UI only (body text needs 4.5:1)';
  return 'passes';
}

/** Make a palette pass every required check (and the advisory ones), hues kept. */
export function fixPalette(p: BrandPalette): BrandPalette {
  const primary = ensureContrast(p.primary, WHITE, AA_TEXT);
  const surface = isHex(p.surface) ? p.surface : tint(primary);
  const ink = ensureContrast(ensureContrast(p.ink, surface, AA_TEXT), WHITE, AA_TEXT);
  return {
    primary,
    on_primary: onColorFor(primary),
    secondary: ensureContrast(p.secondary, WHITE, AA_TEXT),
    accent: ensureContrast(p.accent, WHITE, AA_UI),
    ink,
    surface,
  };
}

export interface SuggestedPalette {
  id: 'logo' | 'complementary' | 'analogous' | 'quiet';
  name: string;
  description: string;
  palette: BrandPalette;
}

/** A vivid version of a hue at a lightness that reads (used when the logo has no partner colour). */
function derived(h: number, L: number, C: number): string {
  return oklchToHex({ L, C, h });
}

/** The next logo colour whose hue is clearly different from `from` (≥ 30°) and not grey. */
function distinctFrom(colors: ExtractedColor[], from: ExtractedColor | null, exclude: string[] = []): ExtractedColor | null {
  return (
    colors.find(
      (c) =>
        c.chroma >= 0.04 &&
        !exclude.includes(c.hex) &&
        (!from || hueDistance(c.hue, from.hue) >= 30),
    ) ?? null
  );
}

function build(primaryRaw: string, secondaryRaw: string, accentRaw: string, inkBase: string | null): BrandPalette {
  const primary = ensureContrast(primaryRaw, WHITE, AA_TEXT);
  const surface = tint(primary, 0.97, 0.022);
  const inkSeed = inkBase && hexToOklch(inkBase).L < 0.35 ? inkBase : shade(primary, 0.24, 0.045);
  const ink = ensureContrast(ensureContrast(inkSeed, surface, AA_TEXT), WHITE, AA_TEXT);
  return fixPalette({
    primary,
    on_primary: onColorFor(primary),
    secondary: ensureContrast(secondaryRaw, WHITE, AA_TEXT),
    accent: ensureContrast(accentRaw, WHITE, AA_UI),
    ink,
    surface,
  });
}

const same = (a: BrandPalette, b: BrandPalette) =>
  a.primary === b.primary && a.secondary === b.secondary && a.accent === b.accent;

/**
 * 2–3 palettes for the owner to pick from:
 *   logo           primary = the logo's most saturated dominant colour; secondary / accent =
 *                  the logo's next distinct hues (derived analogous / complementary if none)
 *   complementary  primary + a complementary accent (or analogous when the logo is monochrome)
 *   quiet          a deeper, calmer primary with a neutral secondary — for conservative tenants
 */
export function suggestPalettes(ex: Extraction): SuggestedPalette[] {
  const prim = pickPrimary(ex);
  const out: SuggestedPalette[] = [];

  // Monochrome / grey / empty logo: build on the logo's dark ink (or its grey), and derive
  // the accent from Merit Electric's hue so the brand still has a colour to act with.
  if (!prim || ex.monochrome) {
    const base = ex.darkInk ?? prim?.hex ?? '#1F2937';
    const b = hexToOklch(base);
    const neutralHue = b.C > 0.01 ? b.h : 264;
    const primary = oklchToHex({ L: Math.min(b.L, 0.32), C: Math.min(b.C, 0.03), h: neutralHue });
    out.push({
      id: 'logo',
      name: 'From your logo',
      description: 'Your logo is one colour, so the brand is built on it with a blue accent.',
      palette: build(primary, shade(primary, 0.36, 0.02), derived(264, 0.55, 0.2), base),
    });
    out.push({
      id: 'complementary',
      name: 'Warm accent',
      description: 'The same base with a warm accent for buttons and highlights.',
      palette: build(primary, shade(primary, 0.4, 0.02), derived(45, 0.62, 0.16), base),
    });
    out.push({
      id: 'quiet',
      name: 'Classic',
      description: 'Deep blue on neutral — conservative and easy to read.',
      palette: build(derived(258, 0.42, 0.14), primary, derived(258, 0.6, 0.12), base),
    });
    return dedupe(out);
  }

  const second = distinctFrom(ex.colors, prim, [prim.hex]);
  const third = second ? distinctFrom(ex.colors, prim, [prim.hex, second.hex]) : null;
  const third2 = third && hueDistance(third.hue, second?.hue ?? 0) >= 30 ? third : null;

  const pL = Math.min(prim.lightness, 0.55);
  const secondaryRaw = second?.hex ?? derived(rotateHue(prim.hue, 30), Math.min(pL, 0.45), Math.min(prim.chroma, 0.14));
  const accentRaw = third2?.hex ?? (second ? second.hex : derived(rotateHue(prim.hue, 180), 0.6, Math.min(Math.max(prim.chroma, 0.1), 0.17)));

  out.push({
    id: 'logo',
    name: 'From your logo',
    description: second ? 'Your logo’s main colour, with its second colour as the accent.' : 'Your logo’s colour, with a matching accent.',
    palette: build(prim.hex, secondaryRaw, accentRaw, ex.darkInk),
  });

  out.push({
    id: 'complementary',
    name: 'Complementary',
    description: 'Your colour with its opposite on the colour wheel for highlights.',
    palette: build(
      prim.hex,
      derived(rotateHue(prim.hue, -30), Math.min(pL, 0.42), Math.min(prim.chroma, 0.12)),
      derived(rotateHue(prim.hue, 180), 0.62, Math.min(Math.max(prim.chroma, 0.1), 0.16)),
      ex.darkInk,
    ),
  });

  out.push({
    id: 'quiet',
    name: 'Quiet',
    description: 'A deeper shade of your colour with neutral partners — calm and formal.',
    palette: build(
      oklchToHex({ L: Math.min(prim.lightness, 0.4), C: Math.min(prim.chroma, 0.11), h: prim.hue }),
      oklchToHex({ L: 0.36, C: 0.02, h: prim.hue }),
      prim.hex,
      ex.darkInk,
    ),
  });

  return dedupe(out);
}

function dedupe(list: SuggestedPalette[]): SuggestedPalette[] {
  const out: SuggestedPalette[] = [];
  for (const s of list) if (!out.some((o) => same(o.palette, s.palette))) out.push(s);
  return out.slice(0, 3);
}
