/**
 * FPB-branding AC-3 — colour math and the AA guarantee.
 */
import { describe, expect, it } from 'vitest';
import {
  AA_TEXT,
  INK,
  WHITE,
  contrastRatio,
  ensureContrast,
  hexToOklch,
  hueDistance,
  normalizeHex,
  oklchToHex,
  onColorFor,
  parseHex,
  ratioLabel,
  tint,
} from './color';

/** Deterministic PRNG so the sweep is the same on every run. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('WCAG contrast', () => {
  it('matches the published ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // Merit Electric Blue on white is AA for text.
    expect(contrastRatio('#2563EB', WHITE)).toBeGreaterThan(5.1);
    expect(contrastRatio('#2563EB', WHITE)).toBeLessThan(5.3);
    // #767676 is the classic "just passes" grey (4.54:1).
    expect(contrastRatio('#767676', WHITE)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio('#777777', WHITE)).toBeLessThan(AA_TEXT);
  });

  it('is symmetric and treats bad input as failing', () => {
    expect(contrastRatio('#123456', '#ABCDEF')).toBeCloseTo(contrastRatio('#ABCDEF', '#123456'), 10);
    expect(contrastRatio('red', WHITE)).toBe(1);
  });

  it('never rounds a failing ratio up into a pass label', () => {
    expect(ratioLabel(4.499)).toBe('4.49:1');
    expect(ratioLabel(4.5)).toBe('4.50:1');
  });

  it('parses 3- and 6-digit hex, with or without #', () => {
    expect(parseHex('#fff')).toEqual({ r: 255, g: 255, b: 255 });
    expect(normalizeHex('2563eb')).toBe('#2563EB');
    expect(parseHex('#12345')).toBeNull();
  });
});

describe('onColorFor — white or Midnight ink by contrast', () => {
  it('picks the higher-contrast text colour', () => {
    expect(onColorFor('#2563EB')).toBe(WHITE);
    expect(onColorFor('#0A1628')).toBe(WHITE);
    expect(onColorFor('#FDE047')).toBe(INK);
    expect(onColorFor('#10B981')).toBe(INK); // white on emerald is only 2.5:1
  });
});

describe('OKLCH round trip', () => {
  it('round-trips sRGB colours within a step', () => {
    for (const hex of ['#2563EB', '#E11D48', '#16A34A', '#F59E0B', '#0A1628', '#808080']) {
      const back = oklchToHex(hexToOklch(hex));
      const a = parseHex(hex)!;
      const b = parseHex(back)!;
      expect(Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)).toBeLessThanOrEqual(3);
    }
  });

  it('maps out-of-gamut points into sRGB by reducing chroma, keeping lightness', () => {
    const hex = oklchToHex({ L: 0.7, C: 0.5, h: 150 });
    expect(hex).toMatch(/^#[0-9A-F]{6}$/);
    expect(hexToOklch(hex).L).toBeCloseTo(0.7, 1);
  });
});

describe('ensureContrast — AA is always reached (AC-3)', () => {
  it('leaves passing colours alone', () => {
    expect(ensureContrast('#2563EB')).toBe('#2563EB');
  });

  it('fixes the hard cases: yellow, lime, white, cyan, light pink', () => {
    for (const hex of ['#FFFF00', '#00FF00', '#FFFFFF', '#00FFFF', '#FFC0CB', '#FDE047', '#10B981', '#F59E0B']) {
      const out = ensureContrast(hex, WHITE, AA_TEXT);
      expect(contrastRatio(out, WHITE), `${hex} → ${out}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it('keeps the hue (within 15°) for chromatic colours', () => {
    for (const hex of ['#FFFF00', '#00FF00', '#FF6B6B', '#38BDF8', '#A78BFA', '#F59E0B', '#10B981']) {
      const out = ensureContrast(hex);
      const a = hexToOklch(hex);
      const b = hexToOklch(out);
      if (b.C > 0.03) expect(hueDistance(a.h, b.h), `${hex} → ${out}`).toBeLessThanOrEqual(15);
    }
  });

  it('stays as close to the original as possible (barely passes, not black)', () => {
    const out = ensureContrast('#F59E0B');
    const r = contrastRatio(out, WHITE);
    expect(r).toBeGreaterThanOrEqual(AA_TEXT);
    expect(r).toBeLessThan(5.2);
  });

  it('lightens against a dark background', () => {
    const out = ensureContrast('#1E3A8A', '#0A1628', AA_TEXT);
    expect(contrastRatio(out, '#0A1628')).toBeGreaterThanOrEqual(AA_TEXT);
    expect(hexToOklch(out).L).toBeGreaterThan(hexToOklch('#1E3A8A').L);
  });

  it('property sweep: 2,000 random colours all reach 4.5:1 on white and 3:1 for UI', () => {
    const r = rng(190);
    for (let i = 0; i < 2000; i++) {
      const hex = `#${[r(), r(), r()].map((v) => Math.floor(v * 256).toString(16).padStart(2, '0')).join('')}`;
      expect(contrastRatio(ensureContrast(hex, WHITE, 4.5), WHITE), hex).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ensureContrast(hex, WHITE, 3), WHITE), hex).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('tint', () => {
  it('is a light surface that dark ink reads on', () => {
    const t = tint('#2563EB');
    expect(hexToOklch(t).L).toBeGreaterThan(0.95);
    expect(contrastRatio(INK, t)).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
