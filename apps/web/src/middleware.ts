import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  // NOTE the trailing slash: '/pay(.*)' also matched '/payroll' and '/payments'
  // (and '/api/pay(.*)' matched '/api/payroll/*', '/api/payments/*'), silently
  // making those surfaces skip Clerk at the middleware layer.
  '/pay/(.*)',         // hosted customer invoice view — tokenized, no login
  // The APIs the hosted page calls must be public too. `/pay/(.*)` covers the
  // PAGE but not `/api/pay/...`, so auth.protect() ran on the payment-intent
  // call and returned 404 to every customer — who by definition never has a
  // Clerk session. The page rendered, the Pay button failed, and the UI
  // reported "online payment isn't available yet", hiding an auth rejection
  // behind a business-sounding message. The token in the URL is the
  // credential here, exactly as it is for the page itself.
  '/api/pay/(.*)',
  // Customer self-service portal — magic-link, no login. The PAGE and the
  // token-validated statement PDF API are the credential-in-URL twins of /pay:
  // the visitor has no Clerk session, and the token itself is validated
  // server-side (resolvePortalToken) against migration 141. NOTE: the tenant-side
  // mint/revoke control plane lives under /api/customers/[id]/portal, which stays
  // OUTSIDE this matcher and remains Clerk-protected + RBAC-gated.
  '/portal/customer/(.*)',
  '/api/portal/customer/(.*)',
  // Vendor self-service upload portal — magic-link, no login. Same credential-in-
  // URL model: the PAGE (/portal/vendor/[token]) and the token-validated upload API
  // (/api/portal/vendor/[token]/upload) validate the token server-side against
  // vendor_portal_tokens (migration 142) and narrow every write to that vendor.
  // The tenant-side mint/revoke control plane lives under /api/vendor-portal/...,
  // which stays OUTSIDE this matcher and remains Clerk-protected + RBAC-gated.
  '/portal/vendor/(.*)',
  '/api/portal/vendor/(.*)',
  // Request magic links (migration 178, FPB-request-engine-notifications) — the link in a
  // chase email (/r/[token]) and its unsubscribe POST. The token is resolved server-side by
  // its sha256 (service role); bad / expired / closed links reveal nothing. NOTE the
  // trailing slash: '/r/(.*)' does not match '/reports' or '/requests' (staff surfaces).
  '/r/(.*)',
  '/api/r/(.*)',
  // Scheduler dispatcher (Vercel Cron). A cron request has no Clerk session, so
  // auth.protect() would reject it before the route runs. The route itself is the
  // credential check: Bearer CRON_SECRET, constant-time, FAILS CLOSED (401) when the
  // secret is unset or wrong, and never accepts a user session
  // (lib/scheduler/cron-auth.ts). Nothing else lives under /api/cron.
  '/api/cron/(.*)',
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
