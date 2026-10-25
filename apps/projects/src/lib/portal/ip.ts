/**
 * The client IP the platform vouches for (per-IP limits). On Vercel: x-vercel-forwarded-for (set by
 * the edge, not forgeable by the client), then the request's own ip, then x-real-ip. Never the
 * leftmost x-forwarded-for, which a client can write. Pure on headers.
 */
export function trustedClientIp(req: { headers: Headers; ip?: string | null }): string | null {
  const v = req.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() || req.ip || req.headers.get('x-real-ip')?.trim() || null;
  return v ? v.slice(0, 64) : null;
}
