/**
 * Next.js only allows specific named exports from route.ts / page.tsx / layout.tsx.
 * `next build` enforces this during its type-check (and fails the deploy), but
 * `tsc --noEmit` and the rest of the test suite do NOT — so an extra export
 * (a constant, a helper) slips through every local check and only breaks on
 * Vercel. This guard runs the same rule locally. Put shared helpers/constants
 * in src/lib/** and import them instead of exporting them from a route file.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');

const SEGMENT_CONFIG = [
  'dynamic', 'revalidate', 'runtime', 'preferredRegion', 'maxDuration',
  'fetchCache', 'dynamicParams', 'generateStaticParams',
];
const ROUTE_OK = new Set([
  'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'config', ...SEGMENT_CONFIG,
]);
const PAGE_OK = new Set([
  'default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', ...SEGMENT_CONFIG,
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/^(route|page|layout)\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Runtime (non-type) export names declared in a file. */
export function runtimeExportNames(src: string): string[] {
  const names: string[] = [];
  const decl = /^export\s+(?:async\s+)?(const|let|var|function|class|enum)\s+([A-Za-z_$][\w$]*)/gm;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src)) !== null) names.push(m[2]);
  if (/^export\s+default\b/m.test(src)) names.push('default');
  const list = /^export\s*\{([^}]*)\}/gm;
  while ((m = list.exec(src)) !== null) {
    for (const raw of m[1].split(',')) {
      const part = raw.trim();
      if (!part || part.startsWith('type ')) continue;
      names.push(part.split(/\s+as\s+/).pop()!.trim());
    }
  }
  return names;
}

describe('Next.js route/page files export only allowed names', () => {
  it('detects a disallowed export (self-test)', () => {
    expect(runtimeExportNames("export const FOO = 1;\nexport async function GET() {}")).toEqual(['FOO', 'GET']);
    expect(runtimeExportNames('export type X = string;\nexport interface Y {}')).toEqual([]);
  });

  it('no route.ts / page.tsx / layout.tsx exports anything Next.js rejects', () => {
    const offenders: string[] = [];
    for (const file of walk(APP_ROOT)) {
      const isRoute = /route\.tsx?$/.test(file);
      const allowed = isRoute ? ROUTE_OK : PAGE_OK;
      const bad = runtimeExportNames(fs.readFileSync(file, 'utf8')).filter((n) => !allowed.has(n));
      if (bad.length) offenders.push(`${path.relative(APP_ROOT, file)}: ${bad.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
