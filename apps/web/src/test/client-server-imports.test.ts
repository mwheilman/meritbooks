/**
 * `next build` fails when a 'use client' module (transitively, including dynamic
 * import()) reaches server-only code (next/headers, lib/supabase/server.ts). tsc and the
 * rest of the suite don't catch it, so it only broke on Vercel. This runs the same graph
 * walk locally. See scripts/check-client-server-imports.js.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/check-client-server-imports.js');

describe('client components never import server-only code', () => {
  it('no use-client module reaches next/headers or lib/supabase/server', () => {
    let out = '';
    let failed = false;
    try {
      out = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    } catch (e) {
      failed = true;
      out = String((e as { stdout?: string }).stdout ?? e);
    }
    expect(failed, out).toBe(false);
  });
});
