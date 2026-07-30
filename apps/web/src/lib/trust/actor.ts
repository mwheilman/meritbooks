import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The identity bridge. Resolves a Clerk user id to the internal core.users uuid
 * used for attribution — auto-provisioning the row on first use (the
 * `self_provision` RLS policy in migration 062 lets a signed-in user materialize
 * their OWN row). This is why attribution can finally be real: before this,
 * created_by/approved_by/actor were written null because there was no
 * Clerk-text -> uuid mapping.
 *
 * Runs on the request-scoped (RLS) client. Never throws — attribution must not
 * break the underlying action.
 */
export async function resolveActor(
  supabase: SupabaseClient,
  clerkUserId: string,
): Promise<{ coreUserId: string | null; isPlatformStaff: boolean }> {
  try {
    // Ensure the row exists (insert-if-absent; conflict => no-op, no UPDATE needed).
    await supabase
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
