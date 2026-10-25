/**
 * Which paths Clerk lets through without a session (lib/public-routes, used by middleware.ts),
 * checked with Clerk's own createRouteMatcher so the pattern semantics are the real ones.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createRouteMatcher } from '@clerk/nextjs/server';
import { PORTAL_STAFF_ROUTES, PUBLIC_ROUTES } from '@/lib/public-routes';

const isPublic = createRouteMatcher([...PUBLIC_ROUTES]);
const isStaff = createRouteMatcher([...PORTAL_STAFF_ROUTES]);
/** The middleware's rule: public and not a staff route → no sign-in required. */
const open = (path: string) => {
  const req = new NextRequest(new URL(path, 'https://projects.example.com'));
  return isPublic(req) && !isStaff(req);
};

describe('public routes (middleware)', () => {
  it.each([
    '/api/fieldservice/widget', '/api/fieldservice/public/cron', '/api/fieldservice/public/sms', '/api/fieldservice/public/voice/twilio',
    '/api/fieldservice/public/hub', '/api/residential/public-book/abc123', '/api/sign/public/tok', '/sign/tok', '/portal', '/portal/o/x',
    '/api/portal/session', '/api/webhooks/notifications/dispatch', '/api/webhooks/notifications/sms', '/sign-in', '/sign-in/factor-one',
    '/sign-in/sso-callback',
  ])('%s is public', (p) => expect(open(p)).toBe(true));

  it.each([
    '/api/fieldservice/publicX', '/api/fieldservice/public', '/api/fieldservice/publicity/x', '/api/fieldservice/widgets',
    '/api/fieldservice/widgetX', '/api/fieldservice/widget/x', '/api/fieldservice/calls', '/api/residential/public-booking',
    '/api/residential/public-book', '/api/portal/staff/threads', '/api/sign/abc', '/jobs', '/',
    '/api/webhooksX', '/api/webhooks', '/api/webhooks-admin/x', '/sign-inX', '/sign-in-as/x',
  ])('%s needs sign-in', (p) => expect(open(p)).toBe(false));

  it('the middleware uses this list', () => {
    const mw = readFileSync(join(__dirname, '..', 'middleware.ts'), 'utf8');
    expect(mw).toContain('createRouteMatcher([...PUBLIC_ROUTES])');
    expect(mw).toContain('createRouteMatcher([...PORTAL_STAFF_ROUTES])');
  });

  it('every API route under a public prefix exists as a route file (no stale public prefixes)', () => {
    const api = join(__dirname, '..', 'app', 'api');
    for (const f of ['fieldservice/widget/route.ts', 'fieldservice/public/cron/route.ts', 'residential/public-book/[token]/route.ts',
      'webhooks/notifications/dispatch/route.ts', 'webhooks/notifications/sms/route.ts']) {
      expect(() => readFileSync(join(api, f))).not.toThrow();
    }
  });
});
