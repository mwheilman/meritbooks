'use server';

import { auth, clerkClient } from '@clerk/nextjs/server';
import { TOUR_SEEN_METADATA_KEY } from './tour-seen';

/**
 * Persist "this user has seen the first-login tour" SERVER-SIDE (FPB B4).
 *
 * No Books table carries per-user UI state without a migration, so the flag lives on
 * the Clerk user's publicMetadata (server-writable only; readable in the browser via
 * `useUser().user.publicMetadata` and on the server via clerkClient). That makes it
 * survive device/browser changes, unlike the old localStorage-only flag — which the
 * tour still writes as a fast local cache.
 *
 * Best-effort: never throws; returns whether the write landed.
 */
export async function markTourSeenAction(): Promise<{ ok: boolean }> {
  try {
    const { userId } = await auth();
    if (!userId) return { ok: false };
    const client = await clerkClient();
    // updateUserMetadata deep-merges, so other publicMetadata keys are preserved.
    await client.users.updateUserMetadata(userId, {
      publicMetadata: { [TOUR_SEEN_METADATA_KEY]: new Date().toISOString() },
    });
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
