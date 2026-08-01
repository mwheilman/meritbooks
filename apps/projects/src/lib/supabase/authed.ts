import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { auth } from '@clerk/nextjs/server';

// Request-scoped Supabase client running AS THE USER: forwards the Clerk session
// token so get_org_id() resolves the caller's org and org_isolation RLS enforces
// tenant isolation AT THE DATABASE. Identical contract to Books.
export function createAuthedSupabase(accessToken: string): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
}

export async function createAuthedServerSupabase(): Promise<SupabaseClient | null> {
  const { getToken } = await auth();
  const token = await getToken().catch(() => null);
  return token ? createAuthedSupabase(token) : null;
}
