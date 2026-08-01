/**
 * Platform-staff gate for the Operator Console.
 *
 * The Operator Console is the PLATFORM plane — a cross-tenant view the operator
 * (MeritBooks) sees, distinct from any single tenant's book of record. Reaching it
 * requires platform staff. This helper fails CLOSED: no session, no flag, or any
 * lookup error → not staff.
 *
 * Authority (canon, FPB identity §8): `core.users.is_platform_staff`, keyed to the
 * Clerk user id. That table is populated by the identity backfill (a later gate);
 * until a staff row exists, an env allowlist (`PLATFORM_STAFF_CLERK_IDS`, comma-
 * separated Clerk ids) can bootstrap access without a migration or a DB seed. Both
 * default to "deny" — an unset allowlist and an absent/false flag both mean no.
 */

import { auth } from '@clerk/nextjs/server';
import { createAdminSupabase } from '@/lib/supabase/server';

export interface PlatformStaffContext {
  clerkUserId: string | null;
  isPlatformStaff: boolean;
}

function envAllowlist(): Set<string> {
  return new Set(
    (process.env.PLATFORM_STAFF_CLERK_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Resolve whether the current request is made by platform staff. Reads Clerk for
 * the signed-in user, then the authoritative `core.users.is_platform_staff` flag
 * (with the env allowlist as a bootstrap). Never throws — degrades to not-staff.
 */
export async function resolvePlatformStaff(): Promise<PlatformStaffContext> {
  const a = await auth().catch(() => null);
  const clerkUserId = a?.userId ?? null;
  if (!clerkUserId) return { clerkUserId: null, isPlatformStaff: false };

  // Bootstrap allowlist (empty by default → no effect).
  if (envAllowlist().has(clerkUserId)) return { clerkUserId, isPlatformStaff: true };

  // Authoritative flag on the identity spine.
  try {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .schema('core')
      .from('users')
      .select('is_platform_staff')
      .eq('clerk_user_id', clerkUserId)
      .maybeSingle();
    if (error) return { clerkUserId, isPlatformStaff: false };
    const flag = (data as { is_platform_staff?: boolean } | null)?.is_platform_staff === true;
    return { clerkUserId, isPlatformStaff: flag };
  } catch {
    return { clerkUserId, isPlatformStaff: false };
  }
}
