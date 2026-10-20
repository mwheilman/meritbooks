import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The identity bridge. Resolves a Clerk user id to the internal core.users uuid
 * used for attribution — auto-provisioning the row on first use (the
 * `self_provision` RLS policy in migration 062 lets a signed-in user materialize
 * their OWN row). This is why attribution can finally be real: before this,
 * created_by/approved_by/actor were written null because there was no
 * Clerk-text -> uuid mapping.
 *
 * Reads on the request-scoped (RLS) client. The insert-if-absent runs as the service
 * role: migration 154 removed the member self_provision/self_update policies on
 * core.users (self_update let a signed-in user flip their own is_platform_staff).
 * The service write is constrained to `{ clerk_user_id }` only — the caller's own
 * verified Clerk id; it never sets is_platform_staff or any other column, and
 * ignoreDuplicates makes it a pure insert-if-absent (no UPDATE of an existing row).
 * Never throws — attribution must not break the underlying action.
 */
export async function resolveActor(
  supabase: SupabaseClient,
  clerkUserId: string,
): Promise<{ coreUserId: string | null; isPlatformStaff: boolean }> {
  try {
    // Ensure the row exists (insert-if-absent; conflict => no-op, no UPDATE needed).
    const { createAdminSupabase } = await import('@/lib/supabase/admin');
    await createAdminSupabase()
      .schema('core').from('users')
      .upsert({ clerk_user_id: clerkUserId }, { onConflict: 'clerk_user_id', ignoreDuplicates: true });

    const { data } = await supabase
      .schema('core').from('users')
      .select('id, is_platform_staff')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();

    return { coreUserId: data?.id ?? null, isPlatformStaff: data?.is_platform_staff ?? false };
  } catch (e) {
    console.error('[resolveActor] failed:', e instanceof Error ? e.message : e);
    return { coreUserId: null, isPlatformStaff: false };
  }
}
