import type { Config } from 'tailwindcss';
import meritPreset from '@meritbooks/merit-ui/preset';

// Strict Merit Suite preset (Style Guide v2.3): palette, 8-pt spacing, type sizes,
// square radius and shadows are REPLACED, so off-palette utilities do not exist.
export default {
  presets: [meritPreset],
  content: ['./src/**/*.{ts,tsx}', '../../packages/merit-ui/src/**/*.{ts,tsx}'],
} satisfies Config;
