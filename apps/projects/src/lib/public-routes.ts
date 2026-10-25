/**
 * Routes Clerk lets through without a session (apps/projects/src/middleware.ts). Each is scoped by
 * its own credential instead (see the middleware comment). Patterns are path-to-regexp, as
 * createRouteMatcher takes them: a bare prefix with `(.*)` also matches sibling paths that merely
 * start with the same letters, so every public prefix ends in `/` before the wildcard, or is exact.
 */
export const PUBLIC_ROUTES = [
  '/sign-in',
  '/sign-in/(.*)',
  '/api/webhooks/(.*)',
  '/sign/(.*)',
  '/api/sign/public/(.*)',
  '/api/fieldservice/widget',
  '/portal',
  '/portal/(.*)',
  '/api/portal/(.*)',
  '/api/fieldservice/public/(.*)',
  '/api/residential/public-book/(.*)',
] as const;

/** Staff-only routes inside a public prefix: always protected. */
export const PORTAL_STAFF_ROUTES = ['/api/portal/staff(.*)'] as const;
