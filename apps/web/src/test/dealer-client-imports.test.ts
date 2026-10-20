/**
 * Dealer Pack (D2) client/server boundary guard.
 *
 * scripts/check-client-server-imports.js catches `next/headers` and
 * lib/supabase/server.ts. The dealer screens have extra server-only neighbours —
 * the service-role client (lib/supabase/admin.ts), D1's service layer (which
 * hands out that client) and the AI/XLSX import server modules — so this test
 * walks every 'use client' module under app/(app)/dealer transitively (value
 * imports only; `import type` is erased) and fails if any of them is reached.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const ROOT = path.join(SRC, 'app', '(app)', 'dealer');

const FORBIDDEN_SPECS = [/^next\/headers$/, /^server-only$/, /^@clerk\/nextjs\/server$/];
const FORBIDDEN_FILES = [
  'lib/supabase/server.ts',
  'lib/supabase/admin.ts',
  'lib/dealer/imports/ai-parse.ts',
  'lib/dealer/imports/server.ts',
  'lib/ai/gateway.ts',
].map((p) => path.join(SRC, p));
const FORBIDDEN_DIRS = [path.join(SRC, 'lib', 'dealer', 'service') + path.sep, path.join(SRC, 'lib', 'controls') + path.sep];

const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec);
  else return null;
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const e of EXTS) if (fs.existsSync(base + e)) return base + e;
  return null;
}

function valueImports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  const out: string[] = [];
  const re = /(?:import|export)\s+(type\s+)?(?:[^'"`;]*?from\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m[1]) continue; // import type / export type
    out.push(m[2] ?? m[3]);
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) acc.push(p);
  }
  return acc;
}

function isClient(file: string): boolean {
  return /^\s*['"]use client['"]/.test(fs.readFileSync(file, 'utf8').slice(0, 300));
}

function violations(): string[] {
  const bad: string[] = [];
  for (const f of walk(ROOT).filter(isClient)) {
    const seen = new Set<string>([f]);
    const stack: Array<[string, string[]]> = [[f, [f]]];
    let hit: string[] | null = null;
    while (stack.length && !hit) {
      const [cur, trail] = stack.pop()!;
      for (const spec of valueImports(cur)) {
        if (FORBIDDEN_SPECS.some((r) => r.test(spec))) {
          hit = [...trail, spec];
          break;
        }
        const r = resolveSpec(cur, spec);
        if (!r) continue;
        if (FORBIDDEN_FILES.includes(r) || FORBIDDEN_DIRS.some((d) => r.startsWith(d))) {
          hit = [...trail, r];
          break;
        }
        if (!seen.has(r)) {
          seen.add(r);
          stack.push([r, [...trail, r]]);
        }
      }
    }
    if (hit) bad.push(hit.map((x) => path.relative(SRC, x)).join(' -> '));
  }
  return bad;
}

describe('dealer client components stay off server-only code', () => {
  it('finds the dealer client modules', () => {
    expect(walk(ROOT).filter(isClient).length).toBeGreaterThan(10);
  });

  it('no client module reaches next/headers, the service-role client, D1 services, controls or AI server code', () => {
    expect(violations()).toEqual([]);
  });
});
