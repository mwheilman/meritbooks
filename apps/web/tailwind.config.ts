import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#ecfdf5',
          100: '#d1fae5',
          200: '#a7f3d0',
          300: '#6ee7b7',
          400: '#34d399', // = --em-bright
          500: '#10b981', // primary emerald (= --em)
          600: '#059669', // = --em-deep
          700: '#047857',
          800: '#065f46',
          900: '#064e3b',
          950: '#022c22',
        },
        // ── Brand emerald aliases (MeritBooks-Brand-Tokens.md §Brand) ───────
        // Semantic emerald names so markup can read intent: `bg-em`, `text-em-bright`.
        em: {
          DEFAULT: '#10b981', // --em: primary. Buttons, links, active, ledger accent.
          bright: '#34d399', // --em-bright: positive figures, hover, grand-total double-rule.
          deep: '#059669', // --em-deep: subtotal rule, pressed, emerald-context dividers.
        },
        // ── Surfaces (MeritBooks brand — green-tinted near-black) ────────────
        // The app's existing dark steps are REMAPPED onto the brand surface
        // tokens so every screen re-skins without a per-file rewrite. Light
        // steps (0–300) are retained for print/document surfaces.
        surface: {
          0: '#ffffff',
          50: '#f8fafc',
          100: '#f1f5f9',
          200: '#e2e8f0',
          300: '#cbd5e1',
          // Dark surfaces → brand near-black ramp
          800: '#18211C', // --elevated  (raised / hover surfaces)
          850: '#0E1512', // --surface-2 (insets, wells, code blocks)
          900: '#121A16', // --surface   (cards, panels)
          950: '#0A0F0D', // --bg        (page / app background)
        },
        // ── Neutrals: green-tinted ramp (REMAPS Tailwind slate) ─────────────
        // Components reference `slate-*` ~6.7k times for text and hairlines.
        // Remapping the palette re-skins them all to the brand's warm-green
        // greys and hairline borders while every existing class name still
        // resolves. Luminance ordering is preserved so contrast is unchanged.
        slate: {
          50: '#EDF2EF', // ≈ --text-hi
          100: '#E0E6E2',
          200: '#CBD3CE',
          300: '#AEB8B2', // = --text (body)
          400: '#97A19B',
          500: '#7E8983', // = --text-mid (secondary/labels — reading floor)
          600: '#4A544E',
          700: '#2C362F', // = --hairline-2 (stronger borders, inputs, secondary btn hover)
          800: '#232C27', // = --hairline (default borders/dividers)
          900: '#121A16', // = --surface
          950: '#0A0F0D', // = --bg
        },
        // ── Semantic roles (see docs/DESIGN-SYSTEM.md §Color) ──────────────
        // Meaning-bearing colors. Prefer these over raw palette utilities so
        // intent is legible in the markup: `text-danger-fg`, `bg-danger/10`.
        // DEFAULT = solid/on-color; `fg` = the bright on-dark text tint;
        // soft fills come from the alpha modifier (e.g. bg-success/10).
        success: { DEFAULT: '#10b981', fg: '#34d399' }, // debits, posted, healthy
        danger: { DEFAULT: '#ef4444', fg: '#f87171' }, // credits, overdue, errors
        warning: { DEFAULT: '#f59e0b', fg: '#fbbf24' }, // needs review, soft-close
        info: { DEFAULT: '#3b82f6', fg: '#60a5fa' }, // neutral status, in-progress
        ai: { DEFAULT: '#6366f1', fg: '#818cf8' }, // AI-generated / suggested
        // ── Brand text tokens (MeritBooks-Brand-Tokens.md §Text) ────────────
        // Warm-green text ramp. `text-ink` = body; `text-ink-hi` = headings;
        // `text-ink-mid` = labels; `text-ink-dim` = captions; `ink-on-em` =
        // text/icons ON an emerald fill (never pure white on emerald).
        ink: {
          hi: '#EDF2EF', // --text-hi   (headings, high-emphasis)
          DEFAULT: '#AEB8B2', // --text      (body)
          mid: '#7E8983', // --text-mid  (secondary / labels)
          dim: '#7C877F', // --text-dim  (captions / footnotes)
          'on-em': '#05221A', // --ink-on-em (on emerald fills)
        },
        // Structural hairlines (borders/dividers) as named tokens.
        hairline: {
          DEFAULT: '#232C27', // --hairline
          strong: '#2C362F', // --hairline-2
        },
        // Functional-accent figure tints (meaning only, never decoration).
        'red-fig': '#f87171', // negative figures (parentheses)
        pos: '#34d399', // positive figures (= --em-bright)
        'ink-on-em': '#05221A', // flat alias of ink.on-em
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      // ── Named type scale (see docs/DESIGN-SYSTEM.md §Type) ──────────────
      // A closed set of roles. Reach for these instead of ad-hoc text-2xl so
      // hierarchy is consistent across every screen. Raw Tailwind sizes
      // (text-sm, text-xl…) remain available for backward compatibility.
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        // Marquee figures: the one hero number on a screen (KPI, balance due).
        'display': ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '700' }],
        // Page H1.
        'title': ['1.5rem', { lineHeight: '1.9rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        // Section / card header.
        'heading': ['1.125rem', { lineHeight: '1.6rem', letterSpacing: '-0.01em', fontWeight: '600' }],
        // Sub-section / dialog title.
        'subheading': ['1rem', { lineHeight: '1.5rem', letterSpacing: '-0.006em', fontWeight: '600' }],
        // Default body / table cell.
        'body': ['0.875rem', { lineHeight: '1.35rem' }],
        // Dense secondary text.
        'body-sm': ['0.8125rem', { lineHeight: '1.2rem' }],
        // Form labels, inline metadata.
        'label': ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
        // Overline: uppercase table headers / eyebrows (pair with tracking-caps).
        'caption': ['0.6875rem', { lineHeight: '0.9rem', letterSpacing: '0.04em' }],
      },
      letterSpacing: {
        // Uppercase overlines / column headers.
        caps: '0.06em',
      },
      borderRadius: {
        '4xl': '2rem',
        // ── Brand radii (MeritBooks-Brand-Tokens.md §Shape) ─────────────────
        'brand-sm': '7px', // --radius-sm: chips, small controls
        brand: '10px', // --radius:    buttons, inputs
        'brand-lg': '14px', // --radius-lg: cards, panels
      },
      boxShadow: {
        'glow-sm': '0 0 10px -3px rgba(16, 185, 129, 0.3)',
        'glow': '0 0 20px -5px rgba(16, 185, 129, 0.4)',
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
      // Three speeds, nothing bespoke. fast = state feedback (hover/press),
      // base = entrances (drawer, toast), slow = data transitions (bars).
      transitionDuration: {
        fast: '120ms',
        base: '200ms',
        slow: '500ms',
      },
      transitionTimingFunction: {
        // Standard ease for UI motion — quick out, settled in.
        standard: 'cubic-bezier(0.2, 0, 0, 1)',
      },
    },
  },
  plugins: [],
};

export default config;
