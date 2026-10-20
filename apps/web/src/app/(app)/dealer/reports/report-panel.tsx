'use client';

/**
 * Embeddable dealer report for the main Reports screen (report-viewer.tsx). Runs
 * for exactly one client; shows a calm message when the selection is consolidated
 * or the dealer pack is off for that client. The viewer's own Export menu exports
 * the same report (lib/reports/export/build-model.ts → /api/dealer/reports).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Building2, BarChart3, Settings2 } from 'lucide-react';
import { dealerReportDef, isDealerReportKey, type DealerReport } from '@/lib/dealer/reports/catalog';
import { dealerReportParams, singleClient } from '@/lib/dealer/reports/export-spec';
import type { DealerSettings } from '@/lib/dealer/types';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dealerGet, type DealerApiError } from '../_lib/use-dealer';
import { Empty, ErrorPanel, Spinner } from '../_components/ui';
import { DealerReportTable } from './_components/report-table';

type State =
  | { phase: 'loading' }
  | { phase: 'off' }
  | { phase: 'error'; error: DealerApiError }
  | { phase: 'ready'; report: DealerReport };

export function DealerReportPanel({ reportKey, sd, ed, locIds }: { reportKey: string; sd: string; ed: string; locIds: string }) {
  const locationId = singleClient(locIds);
  const [state, setState] = useState<State>({ phase: 'loading' });
  const valid = isDealerReportKey(reportKey);

  const load = useCallback(async () => {
    if (!locationId || !isDealerReportKey(reportKey)) return;
    setState({ phase: 'loading' });
    const s = await dealerGet<{ settings: DealerSettings }>('/api/dealer/settings', locationId);
    if (s.error) return setState({ phase: 'error', error: s.error });
    if (!s.data?.settings.enabled) return setState({ phase: 'off' });
    const p = dealerReportParams(reportKey, { locationId, sd, ed });
    const r = await dealerGet<{ report: DealerReport }>('/api/dealer/reports', locationId, p);
    if (r.error || !r.data) return setState({ phase: 'error', error: r.error ?? { error: 'The report did not load.', code: 'ERROR' } });
    setState({ phase: 'ready', report: r.data.report });
  }, [locationId, reportKey, sd, ed]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!valid) return <div className="card p-8 text-center text-sm text-slate-500">Report not yet implemented.</div>;
  if (!locationId) {
    return (
      <div className="card">
        <Empty
          icon={Building2}
          title="Choose one dealer client"
          description="Dealer reports run for one client at a time. Pick a single company in the Companies filter (or switch to it at the top of the app) to see this report."
        />
      </div>
    );
  }
  if (state.phase === 'loading') return <div className="card"><Spinner label="Running the report…" /></div>;
  if (state.phase === 'off') {
    return (
      <div className="card">
        <Empty
          icon={Settings2}
          title="The dealer pack is off for this client"
          description="Switch the dealer pack on for this client to see floor plan, unit and manufacturer reports."
          action={<Link href={dealerLinks.settings('enable')} className="btn-secondary btn-sm">Open dealer settings</Link>}
        />
      </div>
    );
  }
  if (state.phase === 'error') return <div className="card"><ErrorPanel error={state.error} onRetry={() => void load()} /></div>;
  const report = state.report;
  const hasRows = report.rows.some((r) => r.kind === 'account' || r.kind === 'subtotal' || r.kind === 'total');
  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-5 py-3 text-xs text-slate-500">
        <span>
          {report.entityLabel} · {report.periodLabel}
          {dealerReportDef(report.key).mode === 'asOf' ? ' (point in time)' : ''}
        </span>
        <Link href={dealerLinks.reports(report.key)} className="text-emerald-400 hover:text-emerald-300">Open in dealer reports →</Link>
      </div>
      {hasRows ? (
        <DealerReportTable report={report} />
      ) : (
        <Empty icon={BarChart3} title="Nothing to report for these dates" description="No dealer activity matches the selected dates for this client." />
      )}
    </div>
  );
}
