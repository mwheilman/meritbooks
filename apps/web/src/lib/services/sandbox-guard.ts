/**
 * Sandbox environment gate (security HIGH).
 *
 * The sandbox seed/reset/verify actions run on the ADMIN client and CLEAR a
 * tenant's transactional + master data (gl_entries, invoices, events, jobs,
 * customers, vendors, employees…) and post test entries. Run against the
 * production Merit org that is an unrecoverable loss of the book of record.
 *
 * core.organizations has no `is_sandbox` flag (checked through migration 152),
 * so the gate is environmental and requires BOTH:
 *   • ALLOW_SANDBOX=1 — an explicit, per-deployment opt-in, AND
 *   • VERCEL_ENV !== 'production' — never on the production deployment, even
 *     if someone sets ALLOW_SANDBOX there by mistake.
 * Fails CLOSED: absent/any other value → refused.
 *
 * Pure and dependency-free so it is unit-testable and can be asserted inside the
 * service (defense in depth) as well as at the route.
 */

type EnvLike = Record<string, string | undefined>;

export function sandboxAllowed(env: EnvLike = process.env as EnvLike): boolean {
  return env.ALLOW_SANDBOX === '1' && env.VERCEL_ENV !== 'production';
}

export const SANDBOX_REFUSED_MESSAGE =
  'Sandbox actions are disabled in this environment. They require ALLOW_SANDBOX=1 on a non-production deployment.';

/** Throws when the sandbox is not allowed — call at the top of every destructive sandbox path. */
export function assertSandboxAllowed(env: EnvLike = process.env as EnvLike): void {
  if (!sandboxAllowed(env)) throw new Error(SANDBOX_REFUSED_MESSAGE);
}
