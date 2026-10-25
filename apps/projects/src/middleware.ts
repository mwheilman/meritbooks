import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import { PORTAL_STAFF_ROUTES, PUBLIC_ROUTES } from '@/lib/public-routes';

// /sign/<token> + /api/sign/public/<token>: the e-signature page for signers without an account
// (token-scoped by the database, migration 1115). Everything else under /api/sign needs sign-in.
// /api/fieldservice/widget: the online booking widget a company embeds on its own site (1117) —
// key-scoped by the route and the database, no Clerk session.
// /portal + /api/portal: customer / sub / lender portals (1118) — no Clerk account; the portal
// session cookie is checked by the database on every call. /api/portal/staff/* is staff-only.
// /api/fieldservice/public/*: phone-provider webhooks (signature-verified), the automations cron
// (CRON_SECRET) and the client hub (portal session) — 1123; anon key + server key only.
// /api/residential/public-book/<token>: homeowner self-booking (1124) — token-scoped by the database.
// The list lives in lib/public-routes (tested): '/api/fieldservice/widget' is exact (it has no
// sub-routes; '/api/fieldservice/widgets' is the staff settings route) and '/api/fieldservice/public/'
// keeps its slash so a sibling such as '/api/fieldservice/publicX' is never public.
const isPublicRoute = createRouteMatcher([...PUBLIC_ROUTES]);
const isPortalStaff = createRouteMatcher([...PORTAL_STAFF_ROUTES]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req) || isPortalStaff(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
