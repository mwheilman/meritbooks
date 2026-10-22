import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { NextResponse, type NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z, type ZodTypeAny } from 'zod';
import { getDb, requireReadyTenant, type TenantContext } from '@/lib/tenant';
import { HttpError, PmQueryError, mapPgError, type PgErrorLike } from '@/lib/api-errors';
import { getAccess } from '@/lib/access/server';
import { can } from '@/lib/access/can';
import { forbiddenBody, requireCan } from '@/lib/access/guard';
import { maskMoney, seesAllMoney } from '@/lib/access/mask';
import type { MoneyObject } from '@/lib/access/money-keys';
import type { Access, AccessAction, ProjectCapability } from '@/lib/access/types';

export type ReadyTenant = TenantContext & { orgId: string };

export interface RouteContext<B, Q> {
  req: NextRequest;
  body: B;
  query: Q;
  params: Record<string, string>;
  db: SupabaseClient;
  tenant: ReadyTenant;
  userId: string;
  /** The caller's Projects access (preview-narrowed when an owner previews a role). */
  access: Access;
}

export interface RouteGrant {
  cap: ProjectCapability;
  action: AccessAction;
}

/**
 * Required on every route (spec §4): the grant the caller must hold, or 'none' for routes any
 * signed-in member of a ready workspace may call (context switch, health, own-access).
 */
export type RouteAccess = RouteGrant | 'none';

export interface Options<BS extends ZodTypeAny | undefined, QS extends ZodTypeAny | undefined> {
  /** Required — omitting it is a type error. Checked before the handler; 403 FORBIDDEN when missing. */
  access: RouteAccess;
  /**
   * Extra grant per `body.op` value (multi-operation POSTs), checked after the body parses —
   * e.g. `{ approve: { cap: 'projects.billing', action: 'approve' } }`.
   */
  ops?: Readonly<Record<string, RouteGrant>>;
  /**
   * Money object types in the response, for maskMoney (lib/access/money-keys.ts). Omitted → the
   * strict union of every type (fail closed). `false` only for responses with no money at all.
   */
  mask?: MoneyObject | readonly MoneyObject[] | false;
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
 * The grants the current route() call declared, keyed by the request's tenant object (a fresh
 * object per request), so assertCompany() can check them at a row's company.
 */
const REQUEST_GRANTS = new WeakMap<ReadyTenant, { access: Access; grants: RouteGrant[] }>();

function companyOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null;
  const c = (v as { companyId?: unknown }).companyId;
  return typeof c === 'string' && UUID.test(c) ? c : null;
}

function opOf(v: unknown): string | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = (v as { op?: unknown }).op;
  return typeof o === 'string' ? o : null;
}

function denied(g: RouteGrant, access: Access, companyId: string | null, tenant: ReadyTenant): NextResponse | null {
  if (can(access, g.cap, g.action, companyId)) return null;
  const name = companyId ? tenant.companies.find((c) => c.id === companyId)?.name ?? null : null;
  return json(403, forbiddenBody(g.cap, g.action, name));
}

/**
 * Response masking (spec §4, defense in depth on top of RLS). Applied to EVERY JSON response —
 * reads and writes alike — because writes echo rows too and a forgotten declaration must not
 * leak: a route that declares nothing gets the strictest key union. Owners (all money at every
 * company) skip the walk entirely.
 */
async function masked(result: unknown, access: Access, companyId: string | null, mask: Options<undefined, undefined>['mask']): Promise<NextResponse> {
  const objects = mask === false ? null : mask;
  if (result instanceof NextResponse) {
    if (objects === null || seesAllMoney(access) || !(result.headers.get('content-type') ?? '').includes('application/json')) return result;
    const body: unknown = await result.clone().json().catch(() => undefined);
    if (body === undefined) return result;
    const headers = new Headers(result.headers);
    headers.delete('content-length');
    return new NextResponse(JSON.stringify(maskMoney(body, access, companyId, objects)), { status: result.status, headers });
  }
  const out = result ?? { ok: true };
  return json(200, objects === null ? out : maskMoney(out, access, companyId, objects));
}

/**
 * The one route-handler wrapper for Merit Projects:
 * Clerk auth → ready tenant (org resolved by the DB, Projects entitled) → access (pm.my_access)
 * → declared grant (403 FORBIDDEN) → uuid route params → Zod body/query → company / op grant →
 * handler on the RLS client → money masking → PG errcodes mapped to plain responses.
 * Never a service-role client.
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
      const access = await getAccess();
      // Union check first (cheap, before parsing): the grant at ANY company.
      if (opts.access !== 'none') {
        const no = denied(opts.access, access, null, tenant);
        if (no) return no;
      }
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

      // Company check: a body/query companyId must hold the grant AT that company.
      const companyId = companyOf(body) ?? companyOf(query);
      if (opts.access !== 'none' && companyId) {
        const no = denied(opts.access, access, companyId, tenant);
        if (no) return no;
      }
      const op = opOf(body);
      const opGrant = op && opts.ops && Object.prototype.hasOwnProperty.call(opts.ops, op) ? opts.ops[op] : undefined;
      if (opGrant) {
        const no = denied(opGrant, access, companyId, tenant);
        if (no) return no;
      }

      const grants: RouteGrant[] = [...(opts.access === 'none' ? [] : [opts.access]), ...(opGrant ? [opGrant] : [])];
      const reqTenant: ReadyTenant = { ...tenant };
      REQUEST_GRANTS.set(reqTenant, { access, grants });

      const result = await handler({ req, body: body as Infer<BS>, query: query as Infer<QS>, params, db, tenant: reqTenant, userId, access });
      return await masked(result, access, companyId ?? tenant.activeCompanyId, opts.mask);
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

/**
 * 403 unless the company id is one of the tenant's operating companies — and, inside route(),
 * unless the caller holds the route's declared grant (and the op's grant) AT that company.
 * Handlers call this after loading a row's location_id, so every one of those call sites
 * enforces location scope (spec §1.5) without repeating the grant.
 */
export function assertCompany(tenant: ReadyTenant, companyId: string): void {
  const company = tenant.companies.find((c) => c.id === companyId);
  if (!company) {
    throw new HttpError(403, 'That company is not in this workspace.', 'FORBIDDEN_COMPANY');
  }
  const scope = REQUEST_GRANTS.get(tenant);
  if (!scope) return;
  for (const g of scope.grants) requireCan(scope.access, g.cap, g.action, companyId, company.name);
}
