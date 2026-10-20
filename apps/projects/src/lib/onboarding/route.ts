import 'server-only';
/**
 * Route wrapper for /api/onboarding/*: ready tenant (tenant.ts contract) + the RLS
 * client from getDb() + Zod body + one error shape. Never returns a stack trace.
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ZodType, ZodTypeDef } from 'zod';
import { getDb, requireReadyTenant, type TenantContext } from '@/lib/tenant';

export interface OnboardingCtx {
  tenant: TenantContext & { orgId: string };
  db: SupabaseClient;
  userId: string | null;
}

export class RouteError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status });
}

interface PgErrorLike { code?: string; message?: string; details?: string | null; hint?: string | null }

/** Turn a PostgREST / Postgres error into a RouteError with plain words. */
export function dbError(err: PgErrorLike | null | undefined, what: string): RouteError {
  const msg = err?.message ?? '';
  const code = err?.code ?? '';
  if (code === 'PGRST202' || /could not find the function/i.test(msg)) {
    return new RouteError(501, 'RPC_MISSING', `${what} isn't available on this workspace yet.`, { detail: msg });
  }
  if (code === 'PGRST106' || /schema must be one of/i.test(msg)) {
    return new RouteError(503, 'SCHEMA_NOT_EXPOSED', 'Merit Projects data isn\'t reachable yet (the pm schema is not exposed to the API).', { detail: msg });
  }
  if (code === '42501' || /PM_FORBIDDEN|permission denied/i.test(msg)) {
    return new RouteError(403, 'FORBIDDEN', `You don't have access to do that for this company.`, { detail: msg });
  }
  if (/PLAN_INVALID|PM_INVALID|PM_UNKNOWN|PM_NO_|PM_SAMPLE/i.test(msg)) {
    return new RouteError(422, 'INVALID', msg.replace(/^[A-Z_]+:\s*/, ''), { detail: msg });
  }
  return new RouteError(500, 'DB_ERROR', `${what} didn't go through. Try again; if it keeps happening, tell us.`, { detail: msg });
}

export async function withOnboarding<T>(
  req: Request,
  schema: ZodType<T, ZodTypeDef, unknown> | null,
  handler: (body: T, ctx: OnboardingCtx) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const tenant = await requireReadyTenant();
    if (!tenant) return json({ error: 'Sign in to a workspace with Merit Projects turned on.', code: 'NOT_READY' }, 401);
    const db = await getDb();
    if (!db) return json({ error: 'Your session ended. Sign in again.', code: 'NO_SESSION' }, 401);
    let body = undefined as T;
    if (schema) {
      const raw = await req.json().catch(() => undefined);
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return json({ error: 'Some of that didn\'t look right.', code: 'VALIDATION_ERROR', details: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, 422);
      }
      body = parsed.data;
    }
    return await handler(body, { tenant, db, userId: tenant.clerkUserId });
  } catch (err) {
    if (err instanceof RouteError) {
      if (err.status >= 500) console.error('[onboarding]', err.code, err.extra?.detail ?? err.message);
      return json({ error: err.message, code: err.code }, err.status);
    }
    console.error('[onboarding] unexpected', err);
    return json({ error: 'Something went wrong on our side. Try again.', code: 'INTERNAL_ERROR' }, 500);
  }
}

/** The company must be one of the tenant's operating companies. */
export function requireCompany(ctx: OnboardingCtx, companyId: string) {
  const c = ctx.tenant.companies.find((x) => x.id === companyId);
  if (!c) throw new RouteError(404, 'UNKNOWN_COMPANY', "That company isn't in this workspace.");
  return c;
}
