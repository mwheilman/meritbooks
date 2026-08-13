import { TourClient } from './tour-client';

export const dynamic = 'force-dynamic';

/**
 * Guided TOUR — the surface a brand-new member sees on their first login into an
 * already-live company (routed here by the company-state router in
 * `/onboarding/page.tsx`, never self-selected).
 *
 * WAVE 0 = a minimal, honest placeholder: it welcomes the member by name + role +
 * company and offers a Skip → dashboard. The rich, role-aware spotlight tour
 * (3–5 stops on real nav + one genuine first action) is Wave 2 (design spec §2).
 *
 * No permission guard: the tour is for any authenticated member of a live company —
 * including read-only teammates who (correctly) cannot run setup. It is always
 * skippable, so no one is ever trapped here.
 */
export default function OnboardingTourPage() {
  return <TourClient />;
}
