import type { Config } from 'tailwindcss';

// G0': mirrors the MeritBooks design system (docs/DESIGN-SYSTEM.md). A later
// gate should extract a shared @meritbooks/tailwind-preset so this never drifts.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399',
          500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b', 950: '#022c22',
        },
        surface: {
          0: '#ffffff', 50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1',
          800: '#1e293b', 850: '#172033', 900: '#0f172a', 950: '#020617',
        },
        success: { DEFAULT: '#10b981', fg: '#34d399' },
        danger: { DEFAULT: '#ef4444', fg: '#f87171' },
        warning: { DEFAULT: '#f59e0b', fg: '#fbbf24' },
        info: { DEFAULT: '#3b82f6', fg: '#60a5fa' },
        ai: { DEFAULT: '#6366f1', fg: '#818cf8' },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.625rem', { lineHeight: '0.875rem' }],
        display: ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em', fontWeight: '700' }],
        title: ['1.5rem', { lineHeight: '1.9rem', letterSpacing: '-0.015em', fontWeight: '600' }],
        heading: ['1.125rem', { lineHeight: '1.6rem', letterSpacing: '-0.01em', fontWeight: '600' }],
      },
    },
  },
  plugins: [],
};
export default config;
