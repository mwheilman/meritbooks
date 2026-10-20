/**
 * The caller's IP address, from headers the PLATFORM sets (wave 2G, security review L-6a).
 *
 * `x-forwarded-for` is a client-controlled chain: its FIRST hop is whatever the client
 * claimed, so it must never decide an IP allowlist. On Vercel the real client address is
 * `x-vercel-forwarded-for` (set by the edge, overwritten if a client sends it); `x-real-ip`
 * is the fallback the platform also sets. Nothing else is trusted — no header → null, and
 * an enforced allowlist then fails closed.
 *
 * SERVER ONLY (`requestClientIp` reads next/headers). `clientIpFrom` is pure.
 */
import { headers } from 'next/headers';

/** Platform-set headers, most trusted first. */
export const TRUSTED_IP_HEADERS = ['x-vercel-forwarded-for', 'x-real-ip'] as const;

/** Pure: pick the client IP from a header getter. */
export function clientIpFrom(get: (name: string) => string | null | undefined): string | null {
  for (const name of TRUSTED_IP_HEADERS) {
    const v = get(name)?.split(',')[0]?.trim();
    if (v) return v;
  }
  return null;
}

/** The current request's client IP, or null outside a request / without a trusted header. */
export function requestClientIp(): string | null {
  try {
    const h = headers();
    return clientIpFrom((n) => h.get(n));
  } catch {
    return null;
  }
}
