'use client';

import { useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { isSpecificCompany } from '@/lib/company-scope';
import { DEALER_REPORTS } from '@/lib/dealer/reports/catalog';
import { ReportViewer } from '../report-viewer';
import { findEngineReport, type LibraryReport } from './catalog';
import { ReportLibrary } from './report-library';
import { StatementViewer } from './statement-viewer';

/**
 * /reports — the report library, the engine statement viewer, and (for reports not yet on
 * the engine) the classic viewer. Old links keep working: `?report=pnl` etc. open the
 * engine viewer with that report's defaults; `?report=ar_aging` etc. open the classic viewer.
 */
export function ReportsScreen({ initialReport, initialToday, initialDealer }: {
  initialReport: string | null;
  initialToday: string;
  initialDealer: { locationId: string | null; enabled: boolean };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const key = params?.get('report') ?? initialReport;
  const { activeCompanyId } = useActiveCompany();
  const active = isSpecificCompany(activeCompanyId) ? activeCompanyId : null;
  const dealer: LibraryReport[] = useMemo(
    () => (initialDealer.enabled ? DEALER_REPORTS.map((r) => ({ key: r.key, label: r.label, desc: r.desc, shelf: 'other' as const, legacy: true, keywords: 'dealer' })) : []),
    [initialDealer.enabled],
  );
  const open = (k: string) => router.push(`/reports?report=${encodeURIComponent(k)}`);
  const back = () => router.push('/reports');

  if (!key) return <ReportLibrary onOpen={open} onOpenQuery={(q) => router.push(`/reports?${q}`)} dealerReports={dealer} />;
  if (findEngineReport(key)) {
    return <StatementViewer key={key} reportKey={key} today={initialToday} activeCompanyId={active} onBack={back} />;
  }
  // classic viewer (aging, customers / vendors, jobs, dealer, direct cash flow …)
  return (
    <div>
      <button type="button" className="btn btn--quiet" onClick={back} style={{ marginBottom: 8 }}>← Report library</button>
      <ReportViewer initialReport={key} initialToday={initialToday} initialDealer={initialDealer} />
    </div>
  );
}
