import 'server-only';
/**
 * The one wrapper for PUBLIC portal API routes (no Clerk): same-origin check on writes (CSRF),
 * Zod body, the session cookie as the credential (the database checks it on every call), plain
 * JSON errors, never cached. Never the service role.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { ZodTypeAny, z } from 'zod';
import type { RequestMeta } from '@/lib/esign/public';
import { trustedClientIp } from './ip';
import { PortalError } from './errors';
import { requireSessionToken } from './session';

export const NO_STORE = { 'Cache-Control': 'no-store, private, max-age=0', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' };

export function portalJson(status: number, body: unknown, init: { headers?: Record<string, string> } = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...(init.headers ?? {}) } });
}

/** Writes must come from this origin (Origin, else Referer). Pure on headers. */
export function sameOrigin(req: Pick<NextRequest, 'headers' | 'nextUrl'>): boolean {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? req.nextUrl.host;
  const src = req.headers.get('origin') ?? req.headers.get('referer');
  if (!src) return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

export interface PortalCtx<B> { req: NextRequest; body: B; session: string; meta: RequestMeta }

export function portalHandler<S extends ZodTypeAny | undefined>(
  opts: { body?: S; auth?: boolean },
  fn: (ctx: PortalCtx<S extends ZodTypeAny ? z.infer<S> : undefined>) => Promise<NextResponse | unknown>,
) {
  return async (req: NextRequest): Promise<NextResponse> => {
    try {
      if (req.method !== 'GET' && !sameOrigin(req)) return portalJson(403, { error: 'Open the portal page and try again.', code: 'forbidden' });
      let body: unknown = undefined;
      if (opts.body) {
        let raw: unknown = {};
        try {
          const text = await req.text();
          if (text.length > 200_000) return portalJson(413, { error: 'That is too large.', code: 'invalid' });
          raw = text ? JSON.parse(text) : {};
        } catch {
          return portalJson(400, { error: 'The request is not valid.', code: 'invalid' });
        }
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) return portalJson(422, { error: 'Check the highlighted fields.', code: 'invalid', fields: parsed.error.issues.map((i) => i.path.join('.')) });
        body = parsed.data;
      }
      const session = opts.auth === false ? '' : requireSessionToken();
      const out = await fn({ req, body: body as S extends ZodTypeAny ? z.infer<S> : undefined, session, meta: { ip: trustedClientIp(req), userAgent: (req.headers.get('user-agent') ?? '').slice(0, 500) || null } });
      return out instanceof NextResponse ? out : portalJson(200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof PortalError) return portalJson(e.status, { error: e.message, code: e.code });
      console.error('[portal api]', e);
      return portalJson(500, { error: 'Something failed on our side. Try again.', code: 'unavailable' });
    }
  };
}
