import { defineConfig } from 'vitest/config';

// Unit tests cover the pure core (queue, clock state, overlay, i18n) — no React Native imports.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
