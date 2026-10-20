/**
 * Fonts — Syne 700 and DM Sans 400–700 with optical sizing. Nothing else
 * (no mono family; figures are DM Sans tabular).
 *
 * Import from "@meritbooks/merit-ui/fonts" in the ROOT LAYOUT only, and put
 * `fontVariables` on <html> (the kit tokens are defined on :root, so the
 * variables must live on the same element):
 *
 *   import { fontVariables } from '@meritbooks/merit-ui/fonts';
 *   <html lang="en" className={fontVariables}>
 *
 * next/font runs at build time through Next's SWC font loader. It works from
 * this package because the app lists '@meritbooks/merit-ui' in
 * `transpilePackages`. If a future Next version stops resolving font loaders
 * inside transpiled packages, copy the two calls below into the app's own
 * `src/app/fonts.ts` verbatim (next/font needs literal options at the call
 * site, so they can't be passed in as a config object) — see README.
 *
 * Not re-exported from the package root: next/font only runs inside Next.
 */
import { DM_Sans, Syne } from 'next/font/google';

/** Syne 700 — titles, section titles, a statement's bottom line, note numerals. */
export const syne = Syne({
  subsets: ['latin'],
  weight: '700',
  display: 'swap',
  variable: '--font-syne',
});

/** DM Sans — variable weight (covers 400/500/600/700) with the opsz axis. */
export const dmSans = DM_Sans({
  subsets: ['latin'],
  axes: ['opsz'],
  display: 'swap',
  variable: '--font-dm-sans',
});

/** className for <html>: defines --font-syne and --font-dm-sans. */
export const fontVariables = `${syne.variable} ${dmSans.variable}`;
