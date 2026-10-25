import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

// /sign/<token> + /api/sign/public/<token>: the e-signature page for signers without an account
// (token-scoped by the database, migration 1115). Everything else under /api/sign needs sign-in.
// /api/fieldservice/widget: the online booking widget a company embeds on its own site (1117) —
// key-scoped by the route and the database, no Clerk session.
const isPublicRoute = createRouteMatcher(['/sign-in(.*)', '/api/webhooks(.*)', '/sign/(.*)', '/api/sign/public/(.*)', '/api/fieldservice/widget(.*)']);

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
