/**
 * Merit Enterprise Suite — Tailwind preset (design system v2.2)
 * Values mirror reference/system.css exactly. Do not add colors outside this file.
 *
 * Usage (tailwind.config.ts):
 *   import meritPreset from './merit-tailwind-preset';
 *   export default { presets: [meritPreset], content: ['./src/**\/*.{ts,tsx}'] };
 */
import type { Config } from 'tailwindcss';

const meritPreset: Partial<Config> = {
  theme: {
    // Replace (not extend) colors so off-palette utilities don't exist.
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#FFFFFF',
      // Core brand
      electric: '#2563EB', // main: titles, rules, primary buttons, links, focus, active
      signal: '#3B82F6', // accent on Midnight only
      midnight: '#0A1628', // shell, body copy, total rules
      steel: '#3D4F65', // secondary text; consolidated bar
      slate: '#8494A7', // labels on Midnight only — never text on light
      warm: '#FDFCFA', // page
      canvas: '#F5F3EF', // insets, notes column, group rows, dialog foot
      sky: '#EBF2FE', // selection, AI, info wash
      // Text roles
      ink: { DEFAULT: '#0A1628', 2: '#3D4F65', 3: '#536A82' },
      // Lines
      line: { DEFAULT: '#E1E5EA', 2: '#CCD3DB' },
      // Ramps (guide p.14)
      blue: { 100: '#DCEBFF', 200: '#A9CCFF', 300: '#6AA8FF' },
      grey: { 100: '#F2F3F5', 200: '#E1E5EA', 300: '#CCD3DB', 400: '#B5BEC8' },
      night: { 500: '#5A738D', 600: '#3F566F', 700: '#2A3E57', 800: '#1A2A3F' },
      // Status only
      pos: { DEFAULT: '#1F6E50', wash: '#E6F1EC' },
      neg: { DEFAULT: '#B42318', wash: '#FBEAE8' },
      warn: { DEFAULT: '#8A5A00', wash: '#F7EFDF' },
    },
    fontFamily: {
      display: ['Syne', 'DM Sans', 'system-ui', 'sans-serif'],
      sans: ['DM Sans', 'system-ui', 'sans-serif'],
    },
    fontSize: {
      cap: ['12px', { lineHeight: '16px' }],
      ui: ['13px', { lineHeight: '20px' }],
      body: ['15px', { lineHeight: '24px' }],
      section: ['20px', { lineHeight: '28px' }],
      title: ['28px', { lineHeight: '32px' }],
      display: ['40px', { lineHeight: '48px' }],
    },
    letterSpacing: {
      tight: '-0.02em',
      snug: '-0.01em',
      normal: '0',
      table: '0.08em',
      caps: '0.14em',
    },
    spacing: {
      0: '0',
      px: '1px',
      half: '4px',
      1: '8px',
      2: '16px',
      3: '24px',
      4: '32px',
      5: '40px',
      6: '48px',
      8: '64px',
      rail: '232px',
      'rail-mini': '64px',
      bar: '48px',
      ctxline: '32px',
      row: '136px',
    },
    // Square geometry. The only radius is the keycap.
    borderRadius: {
      none: '0',
      kbd: '2px',
      full: '9999px', // radios only
    },
    boxShadow: {
      none: 'none',
      float: '0 1px 0 #0A1628, 0 24px 48px -16px rgba(10,22,40,.40)',
      lift: '0 2px 0 #2563EB, 0 16px 32px -12px rgba(10,22,40,.35)',
      cursor: 'inset 3px 0 #2563EB, inset 0 0 0 1px #2563EB',
    },
    extend: {
      transitionDuration: { fast: '120ms', med: '200ms' },
      transitionTimingFunction: { merit: 'cubic-bezier(.2,.7,.2,1)' },
      gridTemplateColumns: { 12: 'repeat(12, minmax(0, 1fr))' },
    },
  },
};

export default meritPreset;
