import type { Config } from 'tailwindcss';
import meritPreset from '@meritbooks/merit-ui/preset';

// Strict Merit Suite preset (Style Guide v2.3, packages/merit-ui): palette, 8-pt
// spacing, type sizes, square radius and shadows are REPLACED, so off-palette
// utilities (bg-emerald-500, rounded-lg, font-mono, text-sm) do not exist here.
//
// Pages not yet rebuilt on the kit still use the old dark/emerald utilities. They
// are served by the TEMPORARY legacy bridge — a second Tailwind build
// (tailwind.legacy.config.ts, loaded by src/styles/legacy-bridge.css) scoped to
// `.legacy-page` — so this file stays strict. See src/lib/design/legacy-bridge.ts.
export default {
  presets: [meritPreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/merit-ui/src/**/*.{ts,tsx}'],
} satisfies Config;
