import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Next.js fails the production build when a route.ts exports anything but handlers and route config.
const ALLOWED = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'dynamic', 'revalidate', 'runtime',
  'fetchCache', 'preferredRegion', 'maxDuration', 'dynamicParams', 'generateStaticParams']);

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routes(p) : n === 'route.ts' ? [p] : [];
  });
}

describe('route files export only handlers and route config', () => {
  it('has no extra value exports', () => {
    const bad: string[] = [];
    for (const f of routes(join(__dirname, '..', 'app'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
        if (!ALLOWED.has(m[1])) bad.push(`${f}: ${m[1]}`);
      }
      if (/^export\s+(?:default|\{)/m.test(src)) bad.push(`${f}: default or re-export`);
    }
    expect(bad).toEqual([]);
  });
});
