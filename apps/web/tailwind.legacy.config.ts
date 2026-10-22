/**
 * LEGACY BRIDGE — Tailwind config (TEMPORARY; delete when the ratchet reaches 0).
 *
 * Books is porting page by page from the old dark/emerald theme onto the Merit
 * Suite design system (packages/merit-ui, Style Guide v2.3). Most pages still use
 * the old utility vocabulary (bg-surface-900, text-slate-400, border-slate-800,
 * emerald-*, rounded-xl, font-mono …). Rather than leave them black-and-green, this
 * second Tailwind build keeps that vocabulary but RE-POINTS every value at the Merit
 * tokens, and scopes every rule under `.legacy-page`:
 *
 *   - `important: '.legacy-page'` → every utility is emitted as `.legacy-page .x`
 *     (specificity 0,2,0), so inside a bridged page the legacy meaning wins over the
 *     strict kit build (0,1,0) — e.g. `p-4` is 16px here, 32px in the kit scale —
 *     and outside a bridged page nothing here applies at all.
 *   - Spacing, sizing and layout are Tailwind defaults (unchanged geometry).
 *   - Colours: the dark ramps invert onto the light Merit canvas (cards → white,
 *     wells → Canvas, hairlines → --line, body text → Midnight ink, secondary →
 *     Steel, captions → ink-3). Emerald/brand/indigo/blue accents → Electric;
 *     green/teal → spruce (pos); red/rose → brick (neg); amber/yellow/orange →
 *     ochre (warn). Text and background are mapped separately (textColor /
 *     backgroundColor) because the inversion differs for each.
 *   - Square geometry (radius 0), no shadows except floating overlays (--float),
 *     no blur/glass, no gradients, no monospace (DM Sans tabular instead).
 *
 * Loaded ONLY by src/styles/legacy-bridge.css via `@config`. The page registry and
 * the shrinking ratchet live in src/lib/design/legacy-bridge.ts (+ its test).
 */
import type { Config } from 'tailwindcss';

// ── Merit tokens (exact hexes from packages/merit-ui/styles/system.css) ─────────
const M = {
  electric: '#2563EB',
  signal: '#3B82F6',
  midnight: '#0A1628',
  steel: '#3D4F65',
  slate: '#8494A7',
  warm: '#FDFCFA',
  canvas: '#F5F3EF',
  sky: '#EBF2FE',
  white: '#FFFFFF',
  ink: '#0A1628',
  ink2: '#3D4F65',
  ink3: '#536A82',
  line: '#E1E5EA',
  line2: '#CCD3DB',
  blue100: '#DCEBFF',
  blue200: '#A9CCFF',
  blue300: '#6AA8FF',
  grey100: '#F2F3F5',
  grey200: '#E1E5EA',
  grey300: '#CCD3DB',
  grey400: '#B5BEC8',
  night500: '#5A738D',
  night600: '#3F566F',
  night700: '#2A3E57',
  night800: '#1A2A3F',
  pos: '#1F6E50',
  posWash: '#E6F1EC',
  neg: '#B42318',
  negWash: '#FBEAE8',
  warn: '#8A5A00',
  warnWash: '#F7EFDF',
} as const;

type Ramp = Record<string, string>;
const SHADES = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'] as const;

/** Every shade → one value. */
function flat(v: string): Ramp {
  return Object.fromEntries(SHADES.map((s) => [s, v]));
}

/** Background ramp for a hue: light (50–200) and dark (800–950) ends become the wash; the middle is the solid. */
function bgHue(solid: string, wash: string): Ramp {
  return Object.fromEntries(SHADES.map((s) => [s, ['50', '100', '200', '800', '900', '950'].includes(s) ? wash : solid]));
}

// Hue families → the kit colour each one now means.
const ACCENT_HUES = ['emerald', 'brand', 'blue', 'sky', 'cyan', 'indigo', 'violet', 'purple', 'fuchsia'] as const; // → Electric
const POS_HUES = ['green', 'teal', 'lime'] as const; // → spruce
const NEG_HUES = ['red', 'rose', 'pink'] as const; // → brick
const WARN_HUES = ['amber', 'yellow', 'orange'] as const; // → ochre
const NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone'] as const;

function hueMap(make: (solid: string, wash: string) => Ramp): Record<string, Ramp> {
  const out: Record<string, Ramp> = {};
  for (const h of ACCENT_HUES) out[h] = make(M.electric, M.sky);
  for (const h of POS_HUES) out[h] = make(M.pos, M.posWash);
  for (const h of NEG_HUES) out[h] = make(M.neg, M.negWash);
  for (const h of WARN_HUES) out[h] = make(M.warn, M.warnWash);
  return out;
}

function neutrals(r: Ramp): Record<string, Ramp> {
  return Object.fromEntries(NEUTRALS.map((n) => [n, r]));
}

/** Semantic role tokens from the old config (success/danger/warning/info/ai + fg tints). */
function semantic(kind: 'text' | 'bg' | 'border'): Record<string, Ramp | string> {
  const s = (solid: string, wash: string) => ({ DEFAULT: kind === 'bg' ? solid : solid, fg: solid, wash });
  return {
    success: s(M.pos, M.posWash),
    danger: s(M.neg, M.negWash),
    warning: s(M.warn, M.warnWash),
    info: s(M.electric, M.sky),
    ai: s(M.electric, M.sky),
    'red-fig': M.neg,
    pos: M.pos,
    'ink-on-em': M.white,
    em: { DEFAULT: M.electric, bright: M.electric, deep: M.electric },
  };
}

// Neutral ramps, inverted for the light canvas.
const TEXT_NEUTRAL: Ramp = {
  50: M.ink, 100: M.ink, 200: M.ink, 300: M.ink, 400: M.ink2, 500: M.ink3,
  600: M.ink3, 700: M.ink3, 800: M.ink, 900: M.ink, 950: M.ink,
};
const BG_NEUTRAL: Ramp = {
  50: M.warm, 100: M.grey100, 200: M.grey200, 300: M.grey300, 400: M.night500, 500: M.steel,
  600: M.grey300, 700: M.grey200, 800: M.grey100, 900: M.white, 950: M.warm,
};
const BORDER_NEUTRAL: Ramp = {
  50: M.line, 100: M.line, 200: M.line, 300: M.line2, 400: M.grey400, 500: M.grey400,
  600: M.grey400, 700: M.line2, 800: M.line, 900: M.line, 950: M.line,
};
const GENERIC_NEUTRAL: Ramp = {
  50: M.ink, 100: M.ink, 200: M.ink, 300: M.ink2, 400: M.ink2, 500: M.ink3,
  600: M.ink3, 700: M.line2, 800: M.line, 900: M.white, 950: M.warm,
};
const SURFACE_BG: Ramp = { 0: M.white, 50: M.warm, 100: M.grey100, 200: M.grey200, 300: M.grey300, 800: M.grey100, 850: M.canvas, 900: M.white, 950: M.warm };
const SURFACE_TEXT: Ramp = { 0: M.ink, 50: M.ink, 100: M.ink, 200: M.ink, 300: M.ink2, 800: M.ink, 850: M.ink, 900: M.ink, 950: M.ink };
const SURFACE_BORDER: Ramp = { 0: M.line, 50: M.line, 100: M.line, 200: M.line, 300: M.line2, 800: M.line, 850: M.line, 900: M.line, 950: M.line };

const base = { transparent: 'transparent', current: 'currentColor', inherit: 'inherit' };
const inkTokens = { ink: { DEFAULT: M.ink, hi: M.ink, mid: M.ink2, dim: M.ink3, 'on-em': M.white }, hairline: { DEFAULT: M.line, strong: M.line2 } };

/** Generic palette: rings, placeholders, fills/strokes, accent, outline, caret, ring offsets. */
const colors = {
  ...base,
  white: M.white,
  black: M.midnight,
  ...neutrals(GENERIC_NEUTRAL),
  surface: SURFACE_BG,
  ...hueMap((solid) => flat(solid)),
  ...semantic('text'),
  ...inkTokens,
};

const ZERO = '0px';

const legacyConfig: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  important: '.legacy-page',
  // The .dark class is never set any more; dark: variants simply never match.
  darkMode: 'class',
  corePlugins: { preflight: false },
  theme: {
    colors,
    textColor: {
      ...base,
      white: M.ink,
      black: M.ink,
      ...neutrals(TEXT_NEUTRAL),
      surface: SURFACE_TEXT,
      ...hueMap((solid) => flat(solid)),
      ...semantic('text'),
      ...inkTokens,
    },
    backgroundColor: {
      ...base,
      // white/[0.04] hover overlays were light-on-dark; on the light canvas they
      // become a faint Midnight tint. A SOLID `bg-white` is restored to white in
      // legacy-bridge.css (exact class only).
      white: M.midnight,
      black: M.midnight,
      ...neutrals(BG_NEUTRAL),
      surface: SURFACE_BG,
      ...hueMap(bgHue),
      ...semantic('bg'),
      ...inkTokens,
    },
    borderColor: {
      ...base,
      DEFAULT: M.line,
      white: M.midnight,
      black: M.midnight,
      ...neutrals(BORDER_NEUTRAL),
      surface: SURFACE_BORDER,
      ...hueMap((solid) => flat(solid)),
      ...semantic('border'),
      ...inkTokens,
    },
    ringColor: {
      ...base,
      DEFAULT: M.electric,
      white: M.white,
      black: M.midnight,
      ...neutrals(BORDER_NEUTRAL),
      surface: SURFACE_BORDER,
      ...hueMap((solid) => flat(solid)),
      ...semantic('border'),
      ...inkTokens,
    },
    fontFamily: {
      sans: ['var(--font-dm-sans, "DM Sans")', 'system-ui', 'sans-serif'],
      display: ['var(--font-syne, "Syne")', 'var(--font-dm-sans, "DM Sans")', 'system-ui', 'sans-serif'],
      // No monospace in the suite: figures are DM Sans tabular (legacy-bridge.css adds tnum).
      mono: ['var(--font-dm-sans, "DM Sans")', 'system-ui', 'sans-serif'],
    },
    // The kit's five sizes (12 · 13 · 15 · 20 · 28, 40 once). Nothing below 12.
    fontSize: {
      '2xs': ['12px', { lineHeight: '16px' }],
      xs: ['12px', { lineHeight: '16px' }],
      sm: ['13px', { lineHeight: '20px' }],
      base: ['15px', { lineHeight: '24px' }],
      lg: ['15px', { lineHeight: '24px' }],
      xl: ['20px', { lineHeight: '28px' }],
      '2xl': ['20px', { lineHeight: '28px' }],
      '3xl': ['28px', { lineHeight: '32px' }],
      '4xl': ['28px', { lineHeight: '32px' }],
      '5xl': ['40px', { lineHeight: '48px' }],
      '6xl': ['40px', { lineHeight: '48px' }],
      display: ['28px', { lineHeight: '32px', fontWeight: '600' }],
      title: ['20px', { lineHeight: '28px', fontWeight: '600' }],
      heading: ['15px', { lineHeight: '24px', fontWeight: '600' }],
      subheading: ['15px', { lineHeight: '24px', fontWeight: '600' }],
      body: ['13px', { lineHeight: '20px' }],
      'body-sm': ['13px', { lineHeight: '20px' }],
      label: ['12px', { lineHeight: '16px', fontWeight: '500' }],
      caption: ['12px', { lineHeight: '16px', letterSpacing: '0.08em' }],
    },
    letterSpacing: {
      tighter: '-0.02em',
      tight: '-0.01em',
      normal: '0',
      wide: '0.02em',
      wider: '0.08em',
      widest: '0.14em',
      caps: '0.08em',
    },
    // Square everywhere (the kit's one exception, the keycap, is a kit class).
    borderRadius: {
      none: ZERO, sm: ZERO, DEFAULT: ZERO, md: ZERO, lg: ZERO, xl: ZERO, '2xl': ZERO, '3xl': ZERO, '4xl': ZERO,
      full: ZERO, 'brand-sm': ZERO, brand: ZERO, 'brand-lg': ZERO,
    },
    // Hairlines first; only floating things (menus, popovers, modals) get --float.
    boxShadow: {
      none: 'none', sm: 'none', DEFAULT: 'none', md: 'none', inner: 'none',
      lg: '0 1px 0 #0A1628, 0 24px 48px -16px rgba(10,22,40,.40)',
      xl: '0 1px 0 #0A1628, 0 24px 48px -16px rgba(10,22,40,.40)',
      '2xl': '0 1px 0 #0A1628, 0 24px 48px -16px rgba(10,22,40,.40)',
    },
    dropShadow: { none: '0 0 #0000', sm: '0 0 #0000', DEFAULT: '0 0 #0000', md: '0 0 #0000', lg: '0 0 #0000', xl: '0 0 #0000', '2xl': '0 0 #0000' },
    // No glass, no glow, no gradients.
    backdropBlur: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0' },
    blur: { none: '0', sm: '0', DEFAULT: '0', md: '0', lg: '0', xl: '0', '2xl': '0', '3xl': '0' },
    backgroundImage: { none: 'none' },
    extend: {
      keyframes: {
        'slide-up': { '0%': { transform: 'translateY(10px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        'fade-in': { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        'slide-in-right': { '0%': { transform: 'translateX(100%)', opacity: '0' }, '100%': { transform: 'translateX(0)', opacity: '1' } },
      },
      animation: {
        'slide-up': 'slide-up 0.2s cubic-bezier(.2,.7,.2,1)',
        'fade-in': 'fade-in 0.2s cubic-bezier(.2,.7,.2,1)',
        'slide-in-right': 'slide-in-right 0.2s cubic-bezier(.2,.7,.2,1)',
      },
      transitionDuration: { fast: '120ms', base: '200ms', slow: '500ms' },
      transitionTimingFunction: { standard: 'cubic-bezier(.2,.7,.2,1)' },
    },
  },
  plugins: [],
};

export default legacyConfig;
