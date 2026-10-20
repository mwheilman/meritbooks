import type { CSSProperties } from 'react';

/**
 * Join class names, skipping falsy parts. Returns undefined when nothing is
 * left, so React omits an empty class="". Tiny on purpose (no clsx).
 */
export function cx(...parts: Array<string | false | null | undefined | 0>): string | undefined {
  let out = '';
  for (const p of parts) {
    if (!p) continue;
    out = out ? `${out} ${p}` : p;
  }
  return out || undefined;
}

/**
 * True outside production builds. Dev-only assertions key off this.
 * `process.env.NODE_ENV` is replaced statically by Next/webpack/Vite, so it
 * must be written out literally (no `typeof process` guard, which would read
 * 'undefined' in a production browser bundle and turn dev checks on).
 */
export function isDev(): boolean {
  try {
    return process.env.NODE_ENV !== 'production';
  } catch {
    return false;
  }
}

/** A CSS custom-property style object (`--w`, `--h` …) typed for React. */
export function cssVars(vars: Record<`--${string}`, string | number | undefined>): CSSProperties {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) out[k] = v;
  }
  return out as CSSProperties;
}
