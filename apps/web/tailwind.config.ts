import type { Config } from 'tailwindcss';
import twColors from 'tailwindcss/colors';

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * MeritBooks theme — Merit brand (Feb 2026 Style Guide) as the DEFAULT TENANT
 * theme. See docs/DESIGN-SYSTEM.md for the system and the token tables.
 *
 * WHITE-LABEL RULE: brand + neutral colors resolve to CSS variables declared in
 * `src/styles/globals.css :root` (channel triplets, so `/alpha` modifiers work).
 * A tenant re-skins by overriding those variables (see lib/brand/tenant-brand.ts);
 * no component names a tenant or a brand hex.
 *
 * RE-SKIN STRATEGY: the app was authored dark (≈6k `slate-*`, `surface-*`,
 * `emerald-*`, `brand-*` utilities). Rather than rewrite every file, this config
 * remaps those palettes PER UTILITY (text vs background vs border) so the same
 * class names now render the light Merit theme with correct contrast:
 *   • text-slate-50…500   → navy … steel … slate ink (dark on light)
 *   • bg-slate/surface-*  → warm-white / canvas / white surfaces
 *   • border-slate-*      → warm hairlines
 *   • status palettes      → text shades darkened to pass WCAG AA on light;
 *                            dark-tinted fills (900/950) flipped to light tints
 *   • brand / em           → Merit Electric Blue (the 5% accent)
 * Status meaning (success green, danger red, warning amber, AI indigo) is kept.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Resolve a channel-triplet CSS variable with Tailwind's alpha support. */
const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

// ── Neutral ramps (replace Tailwind slate/gray/zinc/neutral/stone) ───────────
// The dark theme used LOW numbers for text and HIGH numbers for surfaces. Each
// utility gets the ramp that keeps that intent on a light canvas.
const neutralText = {
  50: v('ink-hi'), // headings, the number            (was ≈ white)
  100: v('ink-hi'),
  200: v('ink-strong'), // strong body / input text
  300: v('ink'), // body copy — Merit Steel
  400: v('ink-soft'), // secondary
  500: v('ink-mid'), // labels, column headers — AA floor
  600: v('ink-dim'), // captions, placeholders, disabled — Merit Slate
  700: v('ink-faint'), // decorative only (separators, disabled glyphs)
  // 800–950 only ever appeared as dark text ON light fills/documents.
  800: v('ink-strong'),
  900: v('ink-hi'),
  950: v('ink-hi'),
};
const neutralBg = {
  50: v('surface'),
  100: v('surface'),
  200: v('inset-soft'),
  300: v('fill-strong'),
  400: v('ink-dim'), // neutral dots / bars
  500: v('ink-dim'),
  600: v('ink-faint'), // neutral chips / toggle knobs on dark → light grey
  700: v('fill-strong'), // hover fill for secondary controls
  800: v('fill'), // control fill: secondary buttons, chips, tracks, kbd
  900: v('surface'), // cards / panels (white)
  950: v('canvas'), // insets, wells, page-level wrappers
};
const neutralLine = {
  50: v('hairline-soft'),
  100: v('hairline-soft'),
  200: v('hairline'),
  300: v('hairline-strong'),
  400: v('ink-faint'),
  500: v('ink-dim'), // checkbox / emphasized outlines
  600: v('ink-faint'), // hover border (darker than 700)
  700: v('hairline-strong'), // inputs, interactive borders
  800: v('hairline'), // default hairline / dividers
  900: v('hairline-soft'),
  950: v('fill'),
};
const NEUTRALS = ['slate', 'gray', 'zinc', 'neutral', 'stone'] as const;
const forNeutrals = (ramp: Record<number, string>) =>
  Object.fromEntries(NEUTRALS.map((n) => [n, ramp]));

// ── Accent ramp (Merit Electric Blue) ────────────────────────────────────────
const accentBase = {
  50: v('brand-wash'),
  100: v('brand-wash-2'),
  200: v('brand-accent-deep'),
  300: v('brand-accent-strong'),
  400: v('brand-accent'),
  500: v('brand-accent'),
  600: v('brand-accent-strong'),
  700: v('brand-accent-deep'),
  800: v('brand-accent-line'),
  900: v('brand-wash-2'),
  950: v('brand-wash'),
};
const accentText = {
  ...accentBase,
  // text-brand-300 was the "brighter" hover tint on dark → darker on light.
  100: v('brand-accent-deep'),
  800: v('brand-accent-deep'),
  900: v('brand-accent-deep'),
  950: v('brand-accent-deep'),
};
const accentBg = {
  ...accentBase,
  // bg-brand-400 was a lighter hover of bg-brand-500; on light we press darker
  // so white button text stays ≥ AA.
  400: v('brand-accent-strong'),
};

// ── Status palettes ──────────────────────────────────────────────────────────
// Text "fg" shades chosen to clear 4.5:1 on white AND on the palette's own
// 500@20% soft fill (the badge background). See docs/DESIGN-SYSTEM.md §Contrast.
type Ramp = Record<string, string>;
const STATUS: Record<string, { fg: string; base: Ramp }> = {
  emerald: { fg: '#04714f', base: twColors.emerald },
  green: { fg: '#127436', base: twColors.green },
  teal: { fg: '#0e6f68', base: twColors.teal },
  lime: { fg: '#45700e', base: twColors.lime },
  red: { fg: '#b91c1c', base: twColors.red },
  rose: { fg: '#be123c', base: twColors.rose },
  pink: { fg: '#be185d', base: twColors.pink },
  amber: { fg: '#a14b08', base: twColors.amber },
  orange: { fg: '#b03a0c', base: twColors.orange },
  yellow: { fg: '#8f5807', base: twColors.yellow },
  blue: { fg: '#1d4ed8', base: twColors.blue },
  sky: { fg: '#0369a1', base: twColors.sky },
  cyan: { fg: '#0d6f8a', base: twColors.cyan },
  indigo: { fg: '#4338ca', base: twColors.indigo },
  violet: { fg: '#6d28d9', base: twColors.violet },
  purple: { fg: '#7e22ce', base: twColors.purple },
  fuchsia: { fg: '#a21caf', base: twColors.fuchsia },
};
const statusText = Object.fromEntries(
  Object.entries(STATUS).map(([name, { fg, base }]) => [
    name,
    {
      50: base[900], 100: base[800], 200: base[800], 300: base[800],
      400: fg, 500: fg, 600: fg,
      700: base[800], 800: base[900], 900: base[900], 950: base[950],
    },
  ]),
);
const statusBg = Object.fromEntries(
  Object.entries(STATUS).map(([name, { base }]) => [
    name,
    // 800–950 were dark tinted panels on the dark canvas → light tints now.
    { ...base, 800: base[100], 900: base[100], 950: base[50] },
  ]),
);
const statusBorder = Object.fromEntries(
  Object.entries(STATUS).map(([name, { base }]) => [
    name,
    { ...base, 700: base[300], 800: base[200], 900: base[200], 950: base[100] },
  ]),
);

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  // Light Merit theme only. The legacy `dark` class on <html> is no longer set;
  // there are no `dark:` variants in the codebase.
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Default (fill/stroke/ring/gradient/accent) resolution for neutrals = text ramp.
        ...forNeutrals(neutralText),
        brand: accentBase,
        // Legacy emerald-accent aliases → the tenant accent.
        em: {
          DEFAULT: v('brand-accent'),
          bright: v('brand-accent'),
          deep: v('brand-accent-strong'),
        },
        // ── Merit brand named colors (use these in new code) ────────────────
        navy: v('brand-navy'),
        accent: {
          DEFAULT: v('brand-accent'),
          bright: v('brand-accent-bright'),
          strong: v('brand-accent-strong'),
          deep: v('brand-accent-deep'),
          wash: v('brand-wash'),
          line: v('brand-accent-line'),
        },
        canvas: v('canvas'),
        page: v('bg'),
        // ── Surfaces ─────────────────────────────────────────────────────────
        surface: {
          0: '#ffffff',
          50: v('bg'),
          100: v('canvas'),
          200: v('fill'),
          300: v('fill-strong'),
          800: v('canvas'), // raised / hover surface
          850: v('inset-soft'), // nested well inside a card
          900: v('surface'), // cards, panels, dialogs (white)
          950: v('canvas'), // insets; full-page wrappers
        },
        // ── App shell (navy chrome: sidebar + top bar) ───────────────────────
        shell: {
          DEFAULT: v('brand-navy'),
          raised: v('shell-raised'),
          line: v('shell-line'),
          fg: v('shell-fg'),
          mid: v('shell-fg-mid'),
          dim: v('shell-fg-dim'),
          accent: v('brand-accent-bright'),
        },
        // ── Semantic roles (meaning-bearing; fg = AA text on light) ──────────
        success: { DEFAULT: '#059669', fg: '#04714f' }, // debits, posted, healthy
        danger: { DEFAULT: '#dc2626', fg: '#b91c1c' }, // credits, overdue, errors
        warning: { DEFAULT: '#d97706', fg: '#a14b08' }, // needs review, soft-close
        info: { DEFAULT: '#3b82f6', fg: '#1d4ed8' }, // neutral status, in-progress
        ai: { DEFAULT: '#6366f1', fg: '#4338ca' }, // AI-generated / suggested
        // ── Text tokens ──────────────────────────────────────────────────────
        ink: {
          hi: v('ink-hi'), // headings, the number — Merit Navy
          DEFAULT: v('ink'), // body — Merit Steel
          strong: v('ink-strong'),
          soft: v('ink-soft'),
          mid: v('ink-mid'), // labels — AA floor
          dim: v('ink-dim'), // captions — Merit Slate (decorative/meta only)
          faint: v('ink-faint'),
          'on-em': '#ffffff', // text/icons on an accent fill
        },
        'on-accent': '#ffffff',
        hairline: {
          DEFAULT: v('hairline'),
          strong: v('hairline-strong'),
          soft: v('hairline-soft'),
        },
        'red-fig': '#b91c1c', // negative figures (parentheses)
        pos: '#04714f', // positive figures
        'ink-on-em': '#ffffff',
      },
      // Per-utility remaps (see header). Deep-merged over `colors`.
      textColor: {
        ...forNeutrals(neutralText),
        ...statusText,
        brand: accentText,
      },
      backgroundColor: {
        ...forNeutrals(neutralBg),
        ...statusBg,
        brand: accentBg,
      },
      borderColor: {
        ...forNeutrals(neutralLine),
        ...statusBorder,
      },
      divideColor: {
        ...forNeutrals(neutralLine),
      },
      ringColor: {
        ...forNeutrals(neutralLine),
      },
      ringOffsetColor: {
        ...forNeutrals(neutralBg),
      },
      placeholderColor: {
        ...forNeutrals(neutralText),
      },
      fontFamily: {
        // Bound in app/layout.tsx via next/font (tenant-swappable).
        sans: ['var(--font-sans)', 'system-ui', 'sans-serif'], // DM Sans — body, nav, labels, buttons
        display: ['var(--font-display)', 'var(--font-sans)', 'system-ui', 'sans-serif'], // Syne — titles, big stats
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'], // JetBrains Mono — figures, codes, eyebrows
      },
      // ── Named type scale (see docs/DESIGN-SYSTEM.md §Type) ──────────────
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        // Marquee figures: the one hero number on a screen (KPI, balance due).
        display: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '700' }],
        // Page H1.
        title: ['1.5rem', { lineHeight: '1.9rem', letterSpacing: '-0.015em', fontWeight: '700' }],
        // Section / card header.
        heading: ['1.125rem', { lineHeight: '1.6rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        // Sub-section / dialog title.
        subheading: ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.006em', fontWeight: '600' }],
        // Default body / table cell.
        body: ['0.875rem', { lineHeight: '1.35rem' }],
        // Dense secondary text.
        'body-sm': ['0.8125rem', { lineHeight: '1.2rem' }],
        // Form labels, inline metadata.
        label: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
        // Overline: uppercase table headers / eyebrows (pair with tracking-caps).
        caption: ['0.6875rem', { lineHeight: '0.9rem', letterSpacing: '0.04em' }],
      },
      letterSpacing: {
        // Uppercase overlines / column headers.
        caps: '0.06em',
        // Merit eyebrow labels (JetBrains Mono, uppercase): 1.5–2.5px.
        eyebrow: '0.16em',
      },
      borderRadius: {
        // Merit digital spec: buttons/inputs 10px, cards 16px. Remapping the
        // two radii the app already uses re-shapes every control and card.
        lg: '0.625rem', // 10px (was 8px) — buttons, inputs, chips
        xl: '1rem', // 16px (was 12px) — cards, dialogs, menus
        '2xl': '1.25rem', // 20px — large modals (kept above xl)
        '4xl': '2rem',
        // ── Brand radii (Merit digital: buttons 10px, cards 16px) ───────────
        'brand-sm': '7px', // chips, small controls
        brand: '10px', // buttons, inputs
        'brand-lg': '16px', // cards, panels
      },
      boxShadow: {
        // Cards are border-defined; this is the only resting elevation allowed.
        card: '0 1px 2px 0 rgb(10 22 40 / 0.04)',
        pop: '0 12px 32px -8px rgb(10 22 40 / 0.18), 0 2px 6px -2px rgb(10 22 40 / 0.08)',
      },
      keyframes: {
        'slide-up': {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in-right': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
      },
      animation: {
        'slide-up': 'slide-up 0.3s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'slide-in-right': 'slide-in-right 0.25s ease-out',
      },
      // ── Motion (see docs/DESIGN-SYSTEM.md §Motion) ──────────────────────
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '500ms',
      },
      transitionTimingFunction: {
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
