/**
 * LEGACY BRIDGE RATCHET (Redesign R1).
 *
 * Every page under src/app is either rebuilt on merit-ui (PORTED_ROUTES) or still on
 * the temporary legacy bridge (LEGACY_ROUTES). This guard keeps that ledger honest:
 *
 *   1. every page file is listed in exactly one list, and every listed route exists;
 *   2. the legacy count equals LEGACY_BASELINE and the baseline only goes DOWN —
 *      port a page → move it to PORTED_ROUTES and lower the baseline;
 *      add a page → build it on the kit (a new legacy page fails here);
 *   3. ported pages and the shared kit components contain none of the old
 *      vocabulary (slate/emerald/surface colours, rounded-*, font-mono, lucide);
 *   4. the bridge itself is wired: scoped config, @config entry, registry matcher.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LEGACY_BASELINE,
  LEGACY_ROUTES,
  LEGACY_SCOPE_CLASS,
  PORTED_ROUTES,
  isPortedPath,
  routePatternToRegExp,
} from '@/lib/design/legacy-bridge';
import legacyConfig from '../../tailwind.legacy.config';

const SRC = path.resolve(__dirname, '..');
const APP = path.join(SRC, 'app');

/** route pattern → directory, for every page.tsx outside app/api. */
function pageRoutes(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (p === path.join(APP, 'api')) continue;
        walk(p);
      } else if (e.name === 'page.tsx') {
        const rel = path.relative(APP, dir).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s));
        out.set(`/${rel.join('/')}`, dir);
      }
    }
  };
  walk(APP);
  return out;
}

/** Source files that belong to a route folder (not to a nested route with its own page). */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, top: boolean) => {
    if (!top && fs.existsSync(path.join(d, 'page.tsx'))) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, false);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
  };
  walk(dir, true);
  return out;
}

// The old theme's vocabulary. A ported file must contain none of it.
const LEGACY_VOCAB =
  /\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|placeholder|accent|outline)-(?:slate|gray|zinc|neutral|stone|surface|emerald|brand|em|indigo|violet|purple|fuchsia|amber|yellow|orange|red|rose|pink|green|teal|lime|sky|cyan|blue|white|black)\b|\brounded-(?:sm|md|lg|xl|2xl|3xl|full)\b|\bfont-mono\b|lucide-react|\btext-(?:2xs|xs|sm|base|lg|[2-6]?xl)\b|\bbtn-(?:primary|secondary|ghost|danger|sm)\b/;

/** Shared components rebuilt on the kit in R1 — they render on every page. */
const KIT_ONLY_SHARED = [
  'components/ui/page-header.tsx',
  'components/ui/active-company-indicator.tsx',
  'components/ui/metric-card.tsx',
  'components/ui/data-table.tsx',
  'components/ui/status-badge.tsx',
  'components/ui/confidence-bar.tsx',
  'components/ui/empty-state.tsx',
  'components/ui/currency-tag.tsx',
  'components/ui/skeleton.tsx',
  'components/ui/toast.tsx',
  'components/ui/list-pager.tsx',
  'components/layout/books-shell.tsx',
  'components/layout/legacy-scope.tsx',
  'components/layout/shell-context.tsx',
  'components/help/help-button.tsx',
  'components/detail-drawer.tsx',
  'components/company-scope-guard.tsx',
  'components/error-boundary.tsx',
  'app/(app)/_components/hub-tabs.tsx',
  'app/(app)/_components/section-tabs.tsx',
  'app/(app)/error.tsx',
  'app/global-error.tsx',
];

describe('legacy bridge — page ledger', () => {
  const pages = pageRoutes();

  it('every page is either ported or listed on the bridge (no page is unaccounted for)', () => {
    const listed = new Set([...PORTED_ROUTES, ...LEGACY_ROUTES]);
    const missing = [...pages.keys()].filter((r) => !listed.has(r)).sort();
    expect(missing, `new page(s) not in the ledger — build them on merit-ui and add to PORTED_ROUTES: ${missing.join(', ')}`).toEqual([]);
  });

  it('no route is in both lists, and every listed route still exists', () => {
    const both = PORTED_ROUTES.filter((r) => LEGACY_ROUTES.includes(r));
    expect(both).toEqual([]);
    const stale = [...PORTED_ROUTES, ...LEGACY_ROUTES].filter((r) => !pages.has(r));
    expect(stale, `listed routes with no page file: ${stale.join(', ')}`).toEqual([]);
  });

  it('LEGACY_ROUTES is sorted and unique', () => {
    expect([...LEGACY_ROUTES]).toEqual([...new Set(LEGACY_ROUTES)].sort());
  });

  it('the ratchet: the legacy count equals the baseline, and the baseline only goes down', () => {
    expect(LEGACY_ROUTES.length, 'more pages on the bridge than the baseline allows').toBeLessThanOrEqual(LEGACY_BASELINE);
    expect(LEGACY_BASELINE, 'you ported a page — lower LEGACY_BASELINE to the new count').toBe(LEGACY_ROUTES.length);
    // R1 shipped with 134 bridged pages; the number may never rise above that.
    expect(LEGACY_BASELINE).toBeLessThanOrEqual(134);
  });
});

describe('legacy bridge — ported code carries no legacy vocabulary', () => {
  const pages = pageRoutes();

  for (const route of PORTED_ROUTES) {
    it(`ported page ${route} is pure merit-ui`, () => {
      const dir = pages.get(route);
      expect(dir, `${route} has no page file`).toBeTruthy();
      for (const f of routeFiles(dir as string)) {
        const hit = fs.readFileSync(f, 'utf8').match(LEGACY_VOCAB);
        expect(hit?.[0] ?? null, `${path.relative(SRC, f)} uses legacy vocabulary`).toBeNull();
      }
    });
  }

  it('shared components rebuilt on the kit stay on the kit', () => {
    for (const rel of KIT_ONLY_SHARED) {
      const hit = fs.readFileSync(path.join(SRC, rel), 'utf8').match(LEGACY_VOCAB);
      expect(hit?.[0] ?? null, `${rel} uses legacy vocabulary`).toBeNull();
    }
  });
});

describe('legacy bridge — wiring', () => {
  it('the legacy Tailwind build is scoped to .legacy-page and has no preflight', () => {
    expect(legacyConfig.important).toBe(`.${LEGACY_SCOPE_CLASS}`);
    expect((legacyConfig.corePlugins as Record<string, boolean>).preflight).toBe(false);
  });

  it('legacy-bridge.css picks the legacy config and is the last stylesheet the root layout loads', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles/legacy-bridge.css'), 'utf8');
    expect(css).toMatch(/@config\s+"\.\.\/\.\.\/tailwind\.legacy\.config\.ts";/);
    const layout = fs.readFileSync(path.join(APP, 'layout.tsx'), 'utf8');
    const order = ['@/styles/globals.css', '@/styles/books.css', '@/styles/legacy-bridge.css'].map((s) => layout.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('globals.css is exactly the kit cascade (README §3)', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles/globals.css'), 'utf8');
    const imports = [...css.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports).toEqual([
      'tailwindcss/base',
      '@meritbooks/merit-ui/styles/system.css',
      '@meritbooks/merit-ui/styles/marks.css',
      '@meritbooks/merit-ui/styles/next-adapter.css',
      'tailwindcss/components',
      'tailwindcss/utilities',
    ]);
  });

  it('route matcher: ported paths skip the bridge, everything else (incl. unknown) gets it', () => {
    expect(isPortedPath('/dashboard')).toBe(true);
    expect(isPortedPath('/dashboard/')).toBe(true);
    expect(isPortedPath('/inbox?tab=exceptions')).toBe(true);
    expect(isPortedPath('/sign-in')).toBe(true);
    expect(isPortedPath('/sign-in/factor-one')).toBe(true);
    expect(isPortedPath('/bills')).toBe(false);
    expect(isPortedPath('/dashboard-old')).toBe(false);
    expect(isPortedPath('/')).toBe(false);
    expect(isPortedPath('/some/unknown/route')).toBe(false);
    expect(routePatternToRegExp('/jobs/[id]').test('/jobs/123')).toBe(true);
    expect(routePatternToRegExp('/jobs/[id]').test('/jobs/123/budget')).toBe(false);
  });
});
