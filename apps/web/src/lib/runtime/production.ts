/**
 * isProductionRuntime — the ONE "are we in production?" rule for every
 * "never fake it" gate (FPB-onboarding principle 7 / blocker B3).
 *
 * The STRICTER rule wins: a Vercel PREVIEW counts as production, because preview
 * deployments can point at the production database. So:
 *   • VERCEL_ENV=production or VERCEL_ENV=preview  → production
 *   • otherwise NODE_ENV=production (any `next start` build) → production
 *   • everything else (next dev, vitest, `vercel dev`)        → not production
 *
 * Pure and dependency-free — safe in route handlers, libraries, tests and client
 * bundles (in the browser only NODE_ENV is inlined, which is 'production' on every
 * deployed build, so the client is never more lenient than the server).
 */

type EnvLike = Record<string, string | undefined>;

export function isProductionRuntime(env: EnvLike = process.env as EnvLike): boolean {
  const vercel = env.VERCEL_ENV;
  if (vercel === 'production' || vercel === 'preview') return true;
  return env.NODE_ENV === 'production';
}
