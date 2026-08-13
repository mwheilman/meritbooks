export const dynamic = 'force-dynamic';

import SectionHost from './section-host';

export const metadata = {
  title: 'Set up · MeritBooks',
};

/**
 * Generic onboarding SECTION host (design spec §6 — "the shell owns the per-section
 * UI; the board card deep-links here"). The Setup Home board's Wave-1 domain cards
 * (Customers & A/R, Vendors & A/P, Jobs & WIP, Debt, Leases, Fixed assets) deep-link to
 * `/onboarding/sections/<slug>`; this route mounts the matching ReviewComponent by slug.
 * Equity keeps its own dedicated page (`/onboarding/sections/equity`), which the static
 * segment resolves before this dynamic one.
 */
export default function OnboardingSectionPage({ params }: { params: { section: string } }) {
  return (
    <div className="px-6 py-6">
      <SectionHost section={params.section} />
    </div>
  );
}
