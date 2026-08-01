import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ZodSchema, ZodError } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAuthedSupabase } from '@/lib/supabase/authed';

export interface ApiContext {
  userId: string;
  // MeritBooks org UUID from the token's org_id claim (matches get_org_id()).
  orgId: string | null;
  // RLS-scoped client running AS THE USER.
  supabase: SupabaseClient;
}

async function resolveAuthContext(): Promise<
  { userId: string; orgId: string | null; token: string } | NextResponse
> {
  const a = await auth().catch(() => null);
  if (!a?.userId) {
    return NextResponse.json({ error: 'Unauthorized', code: 'UNAUTHENTICATED' }, { status: 401 });
  }
  const token = await a.getToken().catch(() => null);
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized', code: 'NO_SESSION_TOKEN' }, { status: 401 });
  }
  const claims = a.sessionClaims as Record<string, unknown> | null;
  const orgId = typeof claims?.org_id === 'string' ? claims.org_id : null;
  return { userId: a.userId, orgId, token };
}

export async function requireAuth(): Promise<{ userId: string; orgId: string | null } | NextResponse> {
  const ctx = await resolveAuthContext();
  if (ctx instanceof NextResponse) return ctx;
  return { userId: ctx.userId, orgId: ctx.orgId };
}

function formatZodErrors(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_root';
    (out[path] ||= []).push(issue.message);
  }
  return out;
}

export function apiHandler<T>(
  schema: ZodSchema<T> | null,
  handler: (body: T, ctx: ApiContext) => Promise<NextResponse>,
) {
  return async (request: Request) => {
    const authResult = await resolveAuthContext();
    if (authResult instanceof NextResponse) return authResult;
    const { userId, orgId, token } = authResult;
    try {
      let body: T;
      if (schema) {
        const json = await request.json().catch(() => { throw new SyntaxError('Invalid JSON'); });
        const result = schema.safeParse(json);
        if (!result.success) {
          return NextResponse.json(
            { error: 'Validation failed', code: 'VALIDATION_ERROR', details: formatZodErrors(result.error) },
            { status: 422 },
          );
        }
        body = result.data;
      } else {
        body = {} as T;
      }
      const supabase = createAuthedSupabase(token);
      return await handler(body, { userId, orgId, supabase });
    } catch (error) {
      console.error('[API Error]', error);
      if (error instanceof SyntaxError) {
        return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      );
    }
  };
}

export function apiQueryHandler<T>(
  schema: ZodSchema<T> | null,
  handler: (params: T, ctx: ApiContext) => Promise<NextResponse>,
) {
  return async (request: Request) => {
    const authResult = await resolveAuthContext();
    if (authResult instanceof NextResponse) return authResult;
    const { userId, orgId, token } = authResult;
    try {
      let params: T;
      if (schema) {
        const { searchParams } = new URL(request.url);
        const result = schema.safeParse(Object.fromEntries(searchParams.entries()));
        if (!result.success) {
          return NextResponse.json(
            { error: 'Invalid query parameters', code: 'VALIDATION_ERROR', details: formatZodErrors(result.error) },
            { status: 422 },
          );
        }
        params = result.data;
      } else {
        params = {} as T;
      }
      const supabase = createAuthedSupabase(token);
      return await handler(params, { userId, orgId, supabase });
    } catch (error) {
      console.error('[API Error]', error);
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal server error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      );
    }
  };
}
