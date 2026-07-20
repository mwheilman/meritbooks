import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
  '/pay(.*)',          // hosted customer invoice view — tokenized, no login
  // The APIs the hosted page calls must be public too. `/pay(.*)` covers the
  // PAGE but not `/api/pay/...`, so auth.protect() ran on the payment-intent
  // call and returned 404 to every customer — who by definition never has a
  // Clerk session. The page rendered, the Pay button failed, and the UI
  // reported "online payment isn't available yet", hiding an auth rejection
  // behind a business-sounding message. The token in the URL is the
  // credential here, exactly as it is for the page itself.
  '/api/pay(.*)',
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
