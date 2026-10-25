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

describe('the public field-service database helper uses the anon key only', () => {
  it('lib/fieldservice/public-db never reaches for the service role', () => {
    const src = readFileSync(join(__dirname, '..', 'lib', 'fieldservice', 'public-db.ts'), 'utf8');
    expect(src.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY')).toBe(true);
    expect(/createAdminSupabase|SERVICE_ROLE/.test(src)).toBe(false);
  });
});

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
    const webhook = _rel.startsWith('webhooks/');
    const publicSign = _rel.startsWith('sign/public/') || _rel.startsWith('sign\\public\\');
    const publicWidget = _rel === 'fieldservice/widget/route.ts' || _rel === 'fieldservice\\widget\\route.ts';
    const publicPortal = /^portal[\\/](?!staff[\\/])/.test(_rel);
    const fsPublic = /^fieldservice[\\/]public[\\/]/.test(_rel);
    const publicBook = /^residential[\\/]public-book[\\/]/.test(_rel);
    if (fsPublic) {
      // /api/fieldservice/public/* (1123): provider webhooks, the reminder cron and the client hub.
      // No Clerk session: each file must verify its caller (provider signature / cron secret /
      // portal session) and reach the database only through lib/fieldservice/public-db (anon key:
      // server-key-gated public.fs_* or session-scoped portal.fs_*). No route(), never the service role.
      expect(wrapped).toBe(0);
      expect(/requireCronSecret\(|verifyTwilioSignature\(|verifyRingCentral\(|verifyDialpadJwt\(|portalHandler\(/.test(src)).toBe(true);
      expect(/fsPublicRpc|fsPortalRpc/.test(src)).toBe(true);
      expect(/createAdminSupabase|SERVICE_ROLE|createClient\(/.test(src)).toBe(false);
    } else if (publicBook) {
      // /api/residential/public-book/[token] (1124, RES-10): homeowner self-booking. The path token
      // is the credential (shape-checked here, sha-256 matched and rate-limited by public.wc_* on
      // the anon key). No route(), never the service role.
      expect(wrapped).toBe(0);
      expect(src.includes('isTokenShape(')).toBe(true);
      expect(src.includes("rpc('wc_")).toBe(true);
      expect(src.includes('NEXT_PUBLIC_SUPABASE_ANON_KEY')).toBe(true);
      expect(/createAdminSupabase|SERVICE_ROLE/.test(src)).toBe(false);
    } else if (publicPortal) {
      // /api/portal/* (1118, except /api/portal/staff/*) has no Clerk session: the portal session
      // cookie is the credential, checked by portal.* on the anon key. portalHandler() (same-origin
      // writes, Zod), never route(), never the service role.
      expect(wrapped).toBe(0);
      expect(src.includes('portalHandler(')).toBe(true);
      expect(/createAdminSupabase|SERVICE_ROLE/.test(src)).toBe(false);
    } else if (publicWidget) {
      // /api/fieldservice/widget (1117) is the public online-booking widget: the token is the
      // credential, checked by public.fs_widget_* on the anon key. No route(), never the service role.
      expect(wrapped).toBe(0);
      expect(src.includes("rpc('fs_widget_")).toBe(true);
      expect(/createAdminSupabase|SERVICE_ROLE/.test(src)).toBe(false);
    } else if (publicSign) {
      // /api/sign/public/* (1115) has no session: the path token is the credential, checked by the
      // database (esign.* on the anon key). It must not use route() and never the service role.
      expect(wrapped).toBe(0);
      expect(src.includes('isTokenShape(')).toBe(true);
      expect(/createAdminSupabase|SERVICE_ROLE/.test(src)).toBe(false);
    } else if (webhook) {
      // /api/webhooks/* has no Clerk session (public in middleware): every file must verify its caller
      // (cron secret or the provider's signature) before doing anything, and must not use route().
      expect(wrapped).toBe(0);
      expect(/requireCronSecret\(|verifyTwilioSignature\(/.test(src)).toBe(true);
    } else if (onboarding) {
      // /api/onboarding/* uses its own wrapper: each handler must call denyUnless(settings:configure).
      expect([...src.matchAll(/denyUnless\('projects\.settings', 'configure'/g)].length).toBe(handlers);
    } else {
      expect(wrapped).toBe(handlers);
    }
  });
});
