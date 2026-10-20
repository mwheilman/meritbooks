import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z, type ZodTypeAny } from 'zod';
import { getDb, requireReadyTenant, type TenantContext } from '@/lib/tenant';
import { HttpError, PmQueryError, mapPgError, type PgErrorLike } from '@/lib/api-errors';

export type ReadyTenant = TenantContext & { orgId: string };

export interface RouteContext<B, Q> {
  req: NextRequest;
  body: B;
  query: Q;
  params: Record<string, string>;
  db: SupabaseClient;
  tenant: ReadyTenant;
  userId: string;
}

interface Options<BS extends ZodTypeAny | undefined, QS extends ZodTypeAny | undefined> {
  body?: BS;
  query?: QS;
  /** Writes are refused in the read-only consolidated view unless this is set (the context switch itself). */
  allowReadOnly?: boolean;
}

type Infer<S> = S extends ZodTypeAny ? z.infer<S> : undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown): NextResponse {
  return NextResponse.json(body, { status });
}

function zodDetails(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const k = issue.path.join('.') || '_';
    (out[k] ??= []).push(issue.message);
  }
  return out;
}

/**
 * The one route-handler wrapper for Merit Projects:
 * Clerk auth → ready tenant (org resolved by the DB, Projects entitled) →
 * uuid route params → Zod body/query → handler on the RLS client → PG errcodes
 * mapped to plain responses. Never a service-role client.
 */
export function route<BS extends ZodTypeAny | undefined = undefined, QS extends ZodTypeAny | undefined = undefined>(
  opts: Options<BS, QS>,
  handler: (ctx: RouteContext<Infer<BS>, Infer<QS>>) => Promise<unknown>,
) {
  return async (req: NextRequest, segment: { params: Record<string, string | string[]> } = { params: {} }): Promise<NextResponse> => {
    try {
      const { userId } = await auth();
      if (!userId) return json(401, { error: 'Sign in to continue.', code: 'UNAUTHENTICATED' });
      const tenant = await requireReadyTenant();
      if (!tenant) return json(403, { error: 'Merit Projects is not set up for this workspace.', code: 'NOT_READY' });
      const db = await getDb();
      if (!db) return json(401, { error: 'Your session expired. Sign in again.', code: 'UNAUTHENTICATED' });
      if (req.method !== 'GET' && !opts.allowReadOnly && !tenant.activeCompanyId && req.cookies.get('mp_view')?.value === 'consolidated') {
        return json(403, { error: 'The consolidated view is read-only. Switch to a company to make changes.', code: 'READ_ONLY' });
      }

      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(segment.params ?? {})) {
        const s = Array.isArray(v) ? v.join('/') : v;
        if (/Id$/.test(k) && !UUID.test(s)) return json(404, { error: 'That was not found.', code: 'NOT_FOUND' });
        params[k] = s;
      }

      let body: unknown = undefined;
      if (opts.body) {
        let raw: unknown = {};
        const text = await req.text();
        if (text) {
          try {
            raw = JSON.parse(text);
          } catch {
            return json(400, { error: 'The request body is not valid JSON.', code: 'BAD_JSON' });
          }
        }
        const parsed = opts.body.safeParse(raw);
        if (!parsed.success) {
          return json(422, { error: 'Check the highlighted fields.', code: 'VALIDATION', details: zodDetails(parsed.error) });
        }
        body = parsed.data;
      }

      let query: unknown = undefined;
      if (opts.query) {
        const parsed = opts.query.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
        if (!parsed.success) {
          return json(422, { error: 'Check the filters.', code: 'VALIDATION', details: zodDetails(parsed.error) });
        }
        query = parsed.data;
      }

      const result = await handler({ req, body: body as Infer<BS>, query: query as Infer<QS>, params, db, tenant, userId });
      if (result instanceof NextResponse) return result;
      return json(200, result ?? { ok: true });
    } catch (e) {
      if (isNextControlFlow(e)) throw e;
      return errorResponse(e);
    }
  };
}

/** Next's own signals (dynamic usage, redirect, notFound) must pass through untouched. */
function isNextControlFlow(e: unknown): boolean {
  const digest = typeof e === 'object' && e !== null && 'digest' in e ? String((e as { digest: unknown }).digest) : '';
  return digest === 'DYNAMIC_SERVER_USAGE' || digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND';
}

export function errorResponse(e: unknown): NextResponse {
  if (e instanceof HttpError) return json(e.status, { error: e.message, code: e.code });
  if (e instanceof PmQueryError) {
    const m = mapPgError(e.pg);
    return json(m.status, m.body);
  }
  if (isPgError(e)) {
    const m = mapPgError(e);
    return json(m.status, m.body);
  }
  // eslint-disable-next-line no-console
  console.error('[projects api]', e);
  return json(500, { error: 'Something failed on our side. Try again; if it repeats, tell support what you were doing.', code: 'INTERNAL' });
}

function isPgError(e: unknown): e is PgErrorLike {
  return typeof e === 'object' && e !== null && 'code' in e && 'message' in e;
}

/** Throw the PG error from a supabase result, else return data. */
export function must<T>(res: { data: T | null; error: PgErrorLike | null }, what: string): T {
  if (res.error) throw new PmQueryError(what, res.error);
  return res.data as T;
}

/** 403 unless the company id is one of the tenant's operating companies. */
export function assertCompany(tenant: ReadyTenant, companyId: string): void {
  if (!tenant.companies.some((c) => c.id === companyId)) {
    throw new HttpError(403, 'That company is not in this workspace.', 'FORBIDDEN_COMPANY');
  }
}
