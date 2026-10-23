'use client';

import { useState } from 'react';
import { ButtonLink, InlineNotice } from '@meritbooks/merit-ui';
import { useQuery } from '@/hooks';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import type { WipScheduleView } from '@/lib/rev-rec/wip-view';
import { PeriodPicker, lastClosedPeriod, periodLabel } from '@/components/rev-rec/period-picker';
import { WipProposalPanel, WipRunHistory } from '@/components/rev-rec/wip-proposal-panel';

/**
 * Revenue recognition → Month-end: the month's proposed recognition entry (the canonical WIP
 * run), approve / dismiss, run history and the next scheduled run. The full per-job schedule
 * with the GL tie-out lives on /jobs/wip.
 */
export function RevRecMonthEnd() {
  const { activeCompanyId } = useActiveCompany();
  const [period, setPeriod] = useState(lastClosedPeriod());
  const [refresh, setRefresh] = useState(0);
  const { data, isLoading, error, refetch } = useQuery<WipScheduleView>(
    '/api/rev-rec/wip',
    { location_id: activeCompanyId, period },
    { key: `${activeCompanyId}:${period}:${refresh}` },
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="row row--between" style={{ flexWrap: 'wrap', gap: 12 }}>
        <PeriodPicker value={period} onChange={setPeriod} />
        <ButtonLink href="/jobs/wip" variant="default" iconAfter="right">Open the WIP schedule</ButtonLink>
      </div>
      {isLoading && !data ? (
        <div className="surface wg-loading mb-state-block" aria-busy="true">
          <span className="bar-l" style={{ width: '64%' }} aria-hidden="true" />
          <span className="bar-l" style={{ width: '48%' }} aria-hidden="true" />
          <span className="t-cap" role="status">Computing {periodLabel(period)}…</span>
        </div>
      ) : error || !data ? (
        <div className="surface wg-state mb-state-block" role="alert">
          <span className="tag tag--neg">Not loaded</span>
          <span className="t-head">The month-end entry didn’t load</span>
          <span className="t-cap ink-2">{error ?? 'Unknown error'}</span>
          <button type="button" className="btn" onClick={() => void refetch()}>Try again</button>
        </div>
      ) : (
        <>
          {data.tieOut && !data.tieOut.tied && data.currentRun?.status === 'POSTED' && (
            <InlineNotice tone="warn" title="Books and schedule differ">
              Unbilled AR differs by {(data.tieOut.unbilled.differenceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} and
              deferred revenue by {(data.tieOut.deferred.differenceCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} — propose a true-up.
            </InlineNotice>
          )}
          <WipProposalPanel view={data} onChanged={async () => { setRefresh((n) => n + 1); }} />
          <section aria-labelledby="rr-hist-h" className="stack">
            <h2 id="rr-hist-h" className="t-section">Run history</h2>
            <WipRunHistory runs={data.history} />
          </section>
        </>
      )}
    </div>
  );
}
