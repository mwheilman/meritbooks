import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const API = join(__dirname, '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? routeFiles(p) : n === 'route.ts' ? [p] : [];
  });
}

const files = routeFiles(API);

describe('every API route declares access (spec §4)', () => {
  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(files.map((f) => [relative(API, f), f]))('%s', (_rel, f) => {
    const src = readFileSync(f, 'utf8');
    const handlers = [...src.matchAll(/export (?:const|async function) (GET|POST|PATCH|PUT|DELETE)\b/g)].length;
    expect(handlers).toBeGreaterThan(0);
    const wrapped = [...src.matchAll(/= route\(\s*\{\s*access:/g)].length;
    const onboarding = src.includes('withOnboarding(');
    if (onboarding) {
      // /api/onboarding/* uses its own wrapper: each handler must call denyUnless(settings:configure).
      expect([...src.matchAll(/denyUnless\('projects\.settings', 'configure'/g)].length).toBe(handlers);
    } else {
      expect(wrapped).toBe(handlers);
    }
  });
});
