import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ZodSchema, ZodError } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedSupabase } from '@/lib/supabase/authed';

export interface ApiContext {
  userId: string;
  /**
   * The MeritBooks organization UUID, taken from the token's `org_id` claim.
   * This is a real `core.organizations.id` (e.g. via the Clerk↔Supabase
   * integration), NOT Clerk's `org_...` string. Routes may use it directly to
   * scope inserts/queries; it also matches what get_org_id() enforces in RLS.
   */
  orgId: string | null;
  /**
   * Request-scoped Supabase client running AS THE USER (RLS enforced). Tenant
   * isolation is guaranteed by the database, not by the route remembering to
   * filter. For no-session contexts (webhook, public pay page) use
   * createAdminSupabase() directly instead of this wrapper.
   */
  supabase: SupabaseClient;
}

/**
 * Full auth context: identity, org UUID (from the `org_id` claim), and the raw
 * session token needed to build a user-scoped Supabase client. Fails CLOSED —
 * returns a 401 NextResponse the caller must return immediately.
 */
async function resolveAuthContext(): Promise<
  { userId: string; orgId: string | null; token: string } | NextResponse
> {
  const a = await auth().catch(() => null);
  if (!a?.userId) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHENTICATED' },
      { status: 401 }
    );
  }
  // Session token carries our custom claims (role=authenticated, org_id=<uuid>).
  // Without it we cannot run as the user, so fail closed rather than silently
  // falling back to an unscoped or privileged client.
  const token = await a.getToken().catch(() => null);
  if (!token) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'NO_SESSION_TOKEN' },
      { status: 401 }
    );
  }
  const claims = a.sessionClaims as Record<string, unknown> | null;
  const orgId = typeof claims?.org_id === 'string' ? claims.org_id : null;
  return { userId: a.userId, orgId, token };
}

/**
 * Resolves the Clerk auth context, failing CLOSED.
 *
 * SECURITY: if auth() throws or resolves without a userId, this returns a 401
 * response that the caller MUST return immediately. It never substitutes a
 * fallback identity. (Previously the code fell back to a privileged 'dev-user'
 * running the RLS-bypassing admin client, so any auth failure executed as a
 * trusted insider — an authentication-bypass vulnerability.)
 *
 * `orgId` is the MeritBooks org UUID from the token's `org_id` claim.
 *
 * Usage in a raw route handler:
 *   const authResult = await requireAuth();
 *   if (authResult instanceof NextResponse) return authResult;
 *   const { userId, orgId } = authResult;
 */
export async function requireAuth(): Promise<
  { userId: string; orgId: string | null } | NextResponse
> {
  const ctx = await resolveAuthContext();
  if (ctx instanceof NextResponse) return ctx;
  return { userId: ctx.userId, orgId: ctx.orgId };
}

/**
 * Auth context for RAW route handlers (those not wrapped by apiHandler) — the
 * one-call replacement for the `auth()` + `createAdminSupabase()` + first-org
 * lookup trio. Returns the identity, the org UUID from the token claim, and a
 * Supabase client scoped to the user (RLS enforced), or a 401 the caller must
 * return immediately. Converting a route to this both closes the RLS-bypass and
 * removes its `select id from organizations limit 1` (the tenant is the claim).
 *
 *   const ctx = await requireAuthedContext();
 *   if (ctx instanceof NextResponse) return ctx;
 *   // ctx.userId, ctx.orgId, ctx.supabase
 */
export async function requireAuthedContext(): Promise<ApiContext | NextResponse> {
  const ctx = await resolveAuthContext();
  if (ctx instanceof NextResponse) return ctx;
  return { userId: ctx.userId, orgId: ctx.orgId, supabase: createAuthedSupabase(ctx.token) };
}

/**
 * Wraps an API handler with auth, validation, and error handling.
 * Eliminates boilerplate from every route.
 */
export function apiHandler<T>(
  schema: ZodSchema<T> | null,
  handler: (body: T, ctx: ApiContext) => Promise<NextResponse>
) {
  return async (request: Request) => {
    // Auth — fail closed. Never substitute a privileged fallback identity.
    const authResult = await resolveAuthContext();
    if (authResult instanceof NextResponse) return authResult;
    const { userId, orgId, token } = authResult;

    try {
      // Parse + validate body
      let body: T;
      if (schema) {
        const raw = await request.json();
        const result = schema.safeParse(raw);
        if (!result.success) {
          return NextResponse.json(
            {
              error: 'Validation failed',
              code: 'VALIDATION_ERROR',
              details: formatZodErrors(result.error),
            },
            { status: 422 }
          );
        }
        body = result.data;
      } else {
        body = {} as T;
      }

      // Run AS THE USER: RLS enforces tenant isolation at the database.
      const supabase = createAuthedSupabase(token);

      // Execute handler
      return await handler(body, { userId, orgId, supabase });
    } catch (error) {
      console.error('[API Error]', error);

      if (error instanceof SyntaxError) {
        return NextResponse.json(
          { error: 'Invalid JSON body', code: 'PARSE_ERROR' },
          { status: 400 }
        );
      }

      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : 'Internal server error',
          code: 'INTERNAL_ERROR',
        },
        { status: 500 }
      );
    }
  };
}

/**
 * Same as apiHandler but for GET requests with query params.
 */
export function apiQueryHandler<T>(
  schema: ZodSchema<T> | null,
  handler: (params: T, ctx: ApiContext) => Promise<NextResponse>
) {
  return async (request: Request) => {
    // Auth — fail closed. Never substitute a privileged fallback identity.
    const authResult = await resolveAuthContext();
    if (authResult instanceof NextResponse) return authResult;
    const { userId, orgId, token } = authResult;

    try {
      let params: T;
      if (schema) {
        const { searchParams } = new URL(request.url);
        const raw = Object.fromEntries(searchParams.entries());
        const result = schema.safeParse(raw);
        if (!result.success) {
          return NextResponse.json(
            {
              error: 'Invalid query parameters',
              code: 'VALIDATION_ERROR',
              details: formatZodErrors(result.error),
            },
            { status: 422 }
          );
        }
        params = result.data;
      } else {
        params = {} as T;
      }

      // Run AS THE USER: RLS enforces tenant isolation at the database.
      const supabase = createAuthedSupabase(token);
      return await handler(params, { userId, orgId, supabase });
    } catch (error) {
      console.error('[API Error]', error);
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : 'Internal server error',
          code: 'INTERNAL_ERROR',
        },
        { status: 500 }
      );
    }
  };
}

function formatZodErrors(error: ZodError): Record<string, string[]> {
  const formatted: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    if (!formatted[path]) formatted[path] = [];
    formatted[path].push(issue.message);
  }
  return formatted;
}
