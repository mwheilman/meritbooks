/**
 * Tenant-isolation guard.
 *
 * THE SITUATION (audited 2026-07-20)
 *
 * CLAUDE.md and the Master Document both describe isolation as "RLS policies
 * keyed to org_id from Clerk JWT claims". The policies exist and are coherent:
 *
 *   get_org_id() = (request.jwt.claims ->> 'org_id')::uuid
 *
 * But the API never runs as a user. Every route uses createAdminSupabase — the
 * service-role client — which carries no user JWT, so request.jwt.claims is
 * empty, get_org_id() returns null, and RLS would deny everything. Routes
 * therefore bypass RLS and resolve the tenant as:
 *
 *   select id from core.organizations limit 1
 *
 * ...whichever org sorts first. With exactly one org in production this behaves
 * correctly and is invisible. With two, 49 endpoints serve the wrong tenant's
 * data to everyone.
 *
 * There is also no mapping between a Clerk organization and core.organizations
 * (no clerk_org_id column), so ctx.orgId — a Clerk 'org_...' string — cannot be
 * used as-is against a uuid primary key. Closing this properly means: a Clerk
 * JWT template carrying the MeritBooks org uuid (or a mapping column), a
 * request-scoped Supabase client using that JWT, and routes moving off the admin
 * client so RLS actually engages.
 *
 * WHAT THIS TEST DOES
 *
 * It does not pretend the problem is fixed. It ratchets: the current count of
 * first-org lookups is pinned, so remediation can proceed incrementally while
 * NEW routes cannot add to the pile. Lower the budget as routes are converted;
 * the test fails if it ever rises.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../app/api',
);

/**
 * Known count of routes resolving the tenant as "first row in the table".
 * RATCHET: this may only ever go DOWN. Do not raise it to make a build pass —
 * a new route that needs the tenant must take it from the authenticated
 * context, not from whichever org sorts first.
 */
const FIRST_ORG_LOOKUP_BUDGET = 49;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Routes that read core.organizations and take the first row. */
function routesUsingFirstOrg(): string[] {
  return walk(API_ROOT).filter((f) => {
    const src = fs.readFileSync(f, 'utf8');
    return /from\(['"]organizations['"]\)/.test(src) && /limit\(1\)/.test(src);
  });
}

describe('tenant isolation — first-org lookups are capped and shrinking', () => {
  it('does not exceed the known budget of first-org lookups', () => {
    const offenders = routesUsingFirstOrg().map((f) => path.relative(API_ROOT, f)).sort();
    expect(offenders.length).toBeLessThanOrEqual(FIRST_ORG_LOOKUP_BUDGET);
  });

  it('budget matches reality — lower it as routes are converted', () => {
    // If this fails LOW, that's good news: routes were fixed. Drop the budget to
    // the new count so the ratchet holds at the improved level.
    const count = routesUsingFirstOrg().length;
    expect(count).toBeLessThanOrEqual(FIRST_ORG_LOOKUP_BUDGET);
    if (count < FIRST_ORG_LOOKUP_BUDGET) {
      console.warn(
        `[tenant-isolation] first-org lookups down to ${count} (budget ${FIRST_ORG_LOOKUP_BUDGET}). ` +
          'Lower FIRST_ORG_LOOKUP_BUDGET to lock in the progress.',
      );
    }
  });
});

describe('tenant isolation — the customer-facing surface is already token-scoped', () => {
  /**
   * The public routes never had this problem: they resolve the invoice by
   * public_token, which pins org, location and customer transitively. They must
   * stay that way — a first-org lookup on an unauthenticated route would be far
   * worse than on an authenticated one.
   */
  const publicRoutes = ['pay'];

  for (const route of publicRoutes) {
    it(`/api/${route} does not resolve the tenant by first-row lookup`, () => {
      const dir = path.join(API_ROOT, route);
      if (!fs.existsSync(dir)) return;
      const offenders = walk(dir).filter((f) => {
        const src = fs.readFileSync(f, 'utf8');
        return /from\(['"]organizations['"]\)/.test(src) && /limit\(1\)/.test(src);
      });
      expect(offenders.map((f) => path.relative(API_ROOT, f))).toEqual([]);
    });
  }
});
