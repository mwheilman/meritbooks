import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { ZodSchema, ZodError } from 'zod';
import { createAdminSupabase } from '@/lib/supabase/server';

export interface ApiContext {
  userId: string;
  orgId: string | null;
  supabase: ReturnType<typeof createAdminSupabase>;
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
    // Auth — fall back to dev user if Clerk session not available
    const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
    const userId = authResult.userId ?? 'dev-user';
    const orgId = authResult.orgId ?? null;

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

      // Create Supabase client
      // TODO: Switch back to createServerSupabase() once Clerk JWT template is configured in Supabase
      const supabase = createAdminSupabase();

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
    // Auth — fall back to dev user if Clerk session not available
    const authResult = await auth().catch(() => ({ userId: null as string | null, orgId: null as string | null }));
    const userId = authResult.userId ?? 'dev-user';
    const orgId = authResult.orgId ?? null;

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

      // TODO: Switch back to createServerSupabase() once Clerk JWT template is configured in Supabase
      const supabase = createAdminSupabase();
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
