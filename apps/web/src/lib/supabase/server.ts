export const dynamic = "force-dynamic";
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { markMemberClient } from './member-client';

export async function createServerSupabase() {
  const cookieStore = await cookies();

  // Member (RLS) client — see lib/supabase/member-client.ts (migration 171 write path).
  return markMemberClient(createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // Server component — can't set cookies, but that's fine for reads
          }
        },
      },
    }
  ));
}

export { createAdminSupabase } from './admin';
