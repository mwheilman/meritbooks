/**
 * The first-login tour "seen" flag — shared key + reader (FPB B4).
 *
 * Written server-side by `markTourSeenAction` (./actions.ts) to the Clerk user's
 * publicMetadata. Read it anywhere you have the Clerk user:
 *   client:  hasSeenTour(useUser().user?.publicMetadata)
 *   server:  hasSeenTour((await (await clerkClient()).users.getUser(id)).publicMetadata)
 * The root router uses it to send a first-login teammate to `/onboarding?tour=1`.
 */

export const TOUR_SEEN_METADATA_KEY = 'tourSeenAt' as const;

export function hasSeenTour(publicMetadata: Record<string, unknown> | null | undefined): boolean {
  const v = publicMetadata?.[TOUR_SEEN_METADATA_KEY];
  return typeof v === 'string' && v.length > 0;
}
