export const dynamic = 'force-dynamic';

import EquityClient from './equity-client';

export const metadata = {
  title: 'Equity & Cap Table',
};

/**
 * Equity / Cap-table onboarding section (design spec §3 — an optional Setup Home
 * domain). Recommended for multi-owner / holding entities, skippable, and N/A for a
 * single-member company. This is equity's home surface (it has no page otherwise).
 */
export default function EquitySectionPage() {
  return (
    <div className="px-6 py-6">
      <EquityClient />
    </div>
  );
}
