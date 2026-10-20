import { createServerClient } from '@supabase/ssr';

/**
 * Admin client with service role key — bypasses RLS.
 * Use ONLY in server-side operations where RLS bypass is intentional.
 *
 * Lives in its own module (no `next/headers` import) so shared libraries can reach it
 * without dragging `cookies()` into a client component's bundle. The service-role key
 * is a non-public env var, so it is never present in a browser bundle.
 */
export function createAdminSupabase() {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll: () => [],
        setAll: () => {},
      },
    }
  );
}
