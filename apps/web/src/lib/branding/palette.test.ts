/**
 * FPB-branding AC-1, AC-2, AC-4 — extraction from pixel arrays and palette suggestions.
 */
import { describe, expect, it } from 'vitest';
import { AA_TEXT, WHITE, contrastRatio, deltaE, hexToOklch, hueDistance, onColorFor, parseHex } from './color';
import { extractPalette, pickPrimary, type PixelSource } from './extract';
import { MERIT_PALETTE, PALETTE_ROLES, contrastReport, fixPalette, suggestPalettes } from './palette';

type Rgba = [number, number, number, number];

/** A synthetic logo: a background, then filled rectangles of colour (share = area). */
function logo(w: number, h: number, bg: Rgba, shapes: Array<{ x: number; y: number; w: number; h: number; c: Rgba }>): PixelSource {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let c = bg;
      for (const s of shapes) if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) c = s.c;
      data.set(c, (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

const rgba = (hex: string, a = 255): Rgba => {
  const c = parseHex(hex)!;
  return [c.r, c.g, c.b, a];
};

const WHITE_BG = rgba('#FFFFFF');
const CLEAR = rgba('#000000', 0);

describe('extractPalette (AC-1)', () => {
  it('finds the logo colour on a white background — never the white', () => {
    const ex = extractPalette(logo(100, 50, WHITE_BG, [{ x: 10, y: 10, w: 40, h: 30, c: rgba('#1D4ED8') }]));
    expect(ex.colors.length).toBeGreaterThan(0);
    expect(deltaE(ex.colors[0].hex, '#1D4ED8')).toBeLessThan(0.02);
    expect(ex.colors.every((c) => hexToOklch(c.hex).L < 0.96)).toBe(true);
    expect(ex.ignored.light).toBeGreaterThan(0);
    expect(ex.monochrome).toBe(false);
  });

  it('ignores transparent pixels (a PNG on no background)', () => {
    const ex = extractPalette(logo(80, 80, CLEAR, [{ x: 20, y: 20, w: 40, h: 40, c: rgba('#DC2626') }]));
    expect(ex.ignored.transparent).toBeGreaterThan(0);
    expect(ex.colors).toHaveLength(1);
    expect(deltaE(ex.colors[0].hex, '#DC2626')).toBeLessThan(0.02);
    expect(ex.colors[0].share).toBeCloseTo(1, 5);
  });

  it('orders colours by share and keeps both colours of a two-colour logo', () => {
    const ex = extractPalette(
      logo(120, 60, WHITE_BG, [
        { x: 0, y: 0, w: 70, h: 60, c: rgba('#0F766E') }, // teal, big
        { x: 80, y: 10, w: 30, h: 30, c: rgba('#F97316') }, // orange, small
      ]),
    );
    expect(deltaE(ex.colors[0].hex, '#0F766E')).toBeLessThan(0.02);
    expect(ex.colors.some((c) => deltaE(c.hex, '#F97316') < 0.02)).toBe(true);
    expect(ex.colors[0].share).toBeGreaterThan(ex.colors[1].share);
  });

  it('sets near-black aside as the logo’s ink, and still finds the coloured icon', () => {
    const ex = extractPalette(
      logo(120, 40, WHITE_BG, [
        { x: 0, y: 0, w: 30, h: 40, c: rgba('#7C3AED') }, // purple icon
        { x: 40, y: 10, w: 80, h: 20, c: rgba('#111111') }, // black wordmark
      ]),
    );
    expect(ex.darkInk).not.toBeNull();
    expect(hexToOklch(ex.darkInk!).L).toBeLessThan(0.2);
    expect(deltaE(pickPrimary(ex)!.hex, '#7C3AED')).toBeLessThan(0.02);
  });

  it('flags a greyscale logo as monochrome (AC-2)', () => {
    const ex = extractPalette(logo(80, 40, WHITE_BG, [{ x: 10, y: 10, w: 60, h: 20, c: rgba('#4B5563') }]));
    expect(ex.monochrome).toBe(true);
  });

  it('handles an empty / all-background image', () => {
    const ex = extractPalette(logo(10, 10, WHITE_BG, []));
    expect(ex.colors).toEqual([]);
    expect(ex.monochrome).toBe(true);
    expect(suggestPalettes(ex).length).toBeGreaterThanOrEqual(2);
  });

  it('is deterministic', () => {
    const src = logo(90, 60, WHITE_BG, [
      { x: 0, y: 0, w: 45, h: 60, c: rgba('#2563EB') },
      { x: 50, y: 0, w: 20, h: 60, c: rgba('#F59E0B') },
    ]);
    expect(extractPalette(src)).toEqual(extractPalette(src));
  });
});

function allPass(p: ReturnType<typeof suggestPalettes>[number]['palette']) {
  const r = contrastReport(p);
  return r.ok && r.checks.every((c) => c.pass);
}

describe('suggestPalettes (AC-2, AC-4)', () => {
  it('builds on the logo’s most saturated dominant colour, made AA', () => {
    const ex = extractPalette(
      logo(100, 60, WHITE_BG, [
        { x: 0, y: 0, w: 40, h: 60, c: rgba('#9CA3AF') }, // grey (bigger, but not saturated)
        { x: 50, y: 0, w: 30, h: 60, c: rgba('#16A34A') }, // green
      ]),
    );
    const [first] = suggestPalettes(ex);
    expect(first.id).toBe('logo');
    expect(hueDistance(hexToOklch(first.palette.primary).h, hexToOklch('#16A34A').h)).toBeLessThan(15);
    expect(contrastRatio(first.palette.primary, WHITE)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('a big brand mark beats a small vivid dot; the dot becomes the partner colour', () => {
    const ex = extractPalette(
      logo(120, 60, CLEAR, [
        { x: 0, y: 0, w: 80, h: 60, c: rgba('#0D9488') }, // teal mark (most of the logo)
        { x: 90, y: 20, w: 15, h: 15, c: rgba('#F97316') }, // small orange dot (more saturated)
        { x: 0, y: 50, w: 120, h: 10, c: rgba('#111827') }, // near-black wordmark
      ]),
    );
    expect(deltaE(pickPrimary(ex)!.hex, '#0D9488')).toBeLessThan(0.02);
    expect(ex.darkInk).not.toBeNull();
    const first = suggestPalettes(ex)[0].palette;
    expect(hueDistance(hexToOklch(first.primary).h, hexToOklch('#0D9488').h)).toBeLessThan(15);
    expect([first.secondary, first.accent].some((c) => hueDistance(hexToOklch(c).h, hexToOklch('#F97316').h) < 20)).toBe(true);
  });

  it('a bright yellow logo still yields readable palettes', () => {
    const ex = extractPalette(logo(60, 60, CLEAR, [{ x: 0, y: 0, w: 60, h: 60, c: rgba('#FACC15') }]));
    const list = suggestPalettes(ex);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.length).toBeLessThanOrEqual(3);
    for (const s of list) expect(allPass(s.palette), s.id).toBe(true);
  });

  it('derives secondary / accent distinct from primary for a single-colour logo', () => {
    const ex = extractPalette(logo(60, 60, CLEAR, [{ x: 0, y: 0, w: 60, h: 60, c: rgba('#DC2626') }]));
    for (const s of suggestPalettes(ex)) {
      expect(deltaE(s.palette.accent, s.palette.primary), s.id).toBeGreaterThan(0.03);
    }
  });

  it('monochrome logo: a neutral primary and a coloured accent (AC-2)', () => {
    const ex = extractPalette(logo(80, 40, WHITE_BG, [{ x: 0, y: 0, w: 80, h: 40, c: rgba('#111827') }]));
    const list = suggestPalettes(ex);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(hexToOklch(list[0].palette.primary).C).toBeLessThan(0.05);
    expect(hexToOklch(list[0].palette.accent).C).toBeGreaterThan(0.08);
    for (const s of list) expect(allPass(s.palette), s.id).toBe(true);
  });

  it('two-colour logo: the second logo colour becomes a partner, palettes are distinct', () => {
    const ex = extractPalette(
      logo(120, 60, WHITE_BG, [
        { x: 0, y: 0, w: 70, h: 60, c: rgba('#1E40AF') },
        { x: 80, y: 0, w: 30, h: 60, c: rgba('#EA580C') },
      ]),
    );
    const list = suggestPalettes(ex);
    const first = list[0].palette;
    // Primary = the more saturated of the two; the other logo colour is its partner.
    const roles = [first.primary, first.secondary, first.accent].map((c) => hexToOklch(c).h);
    for (const logoHex of ['#1E40AF', '#EA580C']) {
      const h = hexToOklch(logoHex).h;
      expect(roles.some((rh) => hueDistance(rh, h) < 20), logoHex).toBe(true);
    }
    const keys = new Set(list.map((s) => `${s.palette.primary}${s.palette.secondary}${s.palette.accent}`));
    expect(keys.size).toBe(list.length);
  });

  it('every role is a hex; on_primary is chosen by contrast', () => {
    const ex = extractPalette(logo(40, 40, CLEAR, [{ x: 0, y: 0, w: 40, h: 40, c: rgba('#0EA5E9') }]));
    for (const s of suggestPalettes(ex)) {
      for (const r of PALETTE_ROLES) expect(s.palette[r]).toMatch(/^#[0-9A-F]{6}$/);
      expect(s.palette.on_primary).toBe(onColorFor(s.palette.primary));
    }
  });

  it('property sweep: any single-colour logo gives 2–3 palettes that all pass (AC-3)', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 150; i++) {
      const c: Rgba = [Math.floor(r() * 256), Math.floor(r() * 256), Math.floor(r() * 256), 255];
      const ex = extractPalette(logo(30, 30, WHITE_BG, [{ x: 5, y: 5, w: 20, h: 20, c }]));
      const list = suggestPalettes(ex);
      expect(list.length).toBeGreaterThanOrEqual(2);
      expect(list.length).toBeLessThanOrEqual(3);
      for (const s of list) expect(contrastReport(s.palette).ok, `${c.join(',')} ${s.id}`).toBe(true);
    }
  });
});

describe('contrastReport / fixPalette', () => {
  it('the Merit default passes', () => {
    expect(contrastReport(MERIT_PALETTE).ok).toBe(true);
  });

  it('flags a light primary and fixes it without changing the hue', () => {
    const bad = { ...MERIT_PALETTE, primary: '#93C5FD', on_primary: '#FFFFFF' };
    const rep = contrastReport(bad);
    expect(rep.ok).toBe(false);
    expect(rep.checks.find((c) => c.id === 'primary_on_white')!.pass).toBe(false);
    const fixed = fixPalette(bad);
    expect(contrastReport(fixed).ok).toBe(true);
    expect(hueDistance(hexToOklch(fixed.primary).h, hexToOklch('#93C5FD').h)).toBeLessThan(15);
  });

  it('flags ink that does not read on the surface', () => {
    const rep = contrastReport({ ...MERIT_PALETTE, ink: '#9CA3AF' });
    expect(rep.ok).toBe(false);
    expect(contrastReport(fixPalette({ ...MERIT_PALETTE, ink: '#9CA3AF' })).ok).toBe(true);
  });
});
