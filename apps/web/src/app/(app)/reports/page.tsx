import { PageHeader } from '@/components/ui';
import { readInitialCompany } from '@/lib/company-scope-server';
import { isSpecificCompany } from '@/lib/company-scope';
import { readDealerPackEnabled } from '@/lib/dealer/pack-enabled-server';
import { ReportViewer } from './report-viewer';
import { utcIsoDate } from './period-presets';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Reports' };

/**
 * Everything the viewer's FIRST render depends on is read here and passed down, so the
 * server HTML and the first client render are identical (live smoke test: full loads of
 * /reports?report=… threw React #418 ×N + #423):
 *   - `?report=`  (was read from window.location during render)
 *   - today's date (was `new Date()` during render — UTC on the server, local in the browser)
 *   - whether the Dealer Pack is on for the active client (the Dealer group is hidden otherwise)
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const raw = searchParams?.report;
  const initialReport = typeof raw === 'string' && /^[a-z0-9_]{1,64}$/.test(raw) ? raw : null;
  const company = await readInitialCompany();
  const locationId = isSpecificCompany(company.id) ? company.id : null;
  const dealerEnabled = await readDealerPackEnabled(locationId);

  return (
    <>
      <PageHeader
        title="Financial Reports"
        description="Generate statements from GL data across all entities"
      />
      <ReportViewer
        initialReport={initialReport}
        initialToday={utcIsoDate()}
        initialDealer={{ locationId, enabled: dealerEnabled }}
      />
    </>
  );
}
