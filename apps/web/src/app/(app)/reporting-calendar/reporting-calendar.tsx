'use client';

import { useMemo, useState } from 'react';
import { Button, InlineNotice, Seg, Tabs, useQuery } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { CalendarGrid } from './calendar-grid';
import { PeriodPanel } from './period-panel';
import { FreshnessTab } from './freshness-tab';
import { RestatementsTab } from './restatements-tab';
import { SettingsTab } from './settings-tab';
import { monthName, type CalendarCell, type CalendarResponse, type CalendarRow } from './types';
import s from './reporting-calendar.module.css';

type Tab = 'calendar' | 'freshness' | 'restatements' | 'settings';
const PANEL = 'reporting-calendar-panel';

function ruleSentence(r: CalendarResponse['tenantSettings']): string {
  if (!r.autoReleaseEnabled) return 'Months are released by hand. Partners see nothing until someone releases it.';
  return `Months release automatically ${r.autoReleaseDays} days after month end once ${r.autoReleaseMinStatus === 'HARD_CLOSE' ? 'closed' : 'soft-closed'}. You can release earlier or take a month back.`;
}

/**
 * /reporting-calendar — FPB §18.4. One row per company, the last N months as columns; each
 * month says whether partners can see it. Click a month to release it, take it back, or see
 * what was reported.
 */
export function ReportingCalendar() {
  const [tab, setTab] = useState<Tab>('calendar');
  const [months, setMonths] = useState<'6' | '12' | '24'>('12');
  const [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<{ row: CalendarRow; cell: CalendarCell } | null>(null);
  const { data, error, isLoading, refetch } = useQuery<CalendarResponse>(
    '/api/report-governance/calendar',
    { months },
    { key: String(refresh), scope: false },
  );
  const changed = () => setRefresh((n) => n + 1);

  const counts = useMemo(() => {
    if (!data) return { ready: 0, restated: 0, attention: 0 };
    let ready = 0;
    for (const r of data.calendar.rows) for (const c of r.cells) if (c.state === 'ready') ready++;
    return {
      ready,
      restated: data.restatements.filter((x) => !x.acknowledgedAt).length,
      attention: data.freshness.filter((f) => f.status === 'attention' || f.status === 'behind').length,
    };
  }, [data]);

  // Keep the open panel in sync with fresh data after a change.
  const live = useMemo(() => {
    if (!selected || !data) return selected;
    const row = data.calendar.rows.find((r) => r.locationId === selected.row.locationId);
    const cell = row?.cells.find((c) => c.key === selected.cell.key);
    return row && cell ? { row, cell } : null;
  }, [selected, data]);

  return (
    <div>
      <PageHeader
        eyebrow={['Close', 'Reporting calendar']}
        title="Reporting calendar"
        description="Which months partners, lenders and department heads can see, company by company. Finance always sees the latest numbers, marked as a preview until they're released."
        actions={
          <Seg<'6' | '12' | '24'>
            aria-label="Months shown"
            value={months}
            onChange={setMonths}
            items={[
              { value: '6', label: '6M' },
              { value: '12', label: '12M' },
              { value: '24', label: '24M' },
            ]}
          />
        }
      />

      {isLoading && !data ? (
        <div className="wg-loading" style={{ height: 320 }} aria-busy="true">
          <span className="bar-l" style={{ width: '60%' }} />
        </div>
      ) : error ? (
        <InlineNotice tone="neg" title="Couldn't load the reporting calendar.">
          {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
        </InlineNotice>
      ) : !data ? null : (
        <>
          <div className={s.strip} role="list" aria-label="Summary">
            <div className={s.cell} role="listitem">
              <span className={s.cellL}>Books closed through</span>
              <span className={s.cellV}>{monthName(data.calendar.closedThrough)}</span>
              <span className={s.cellS}>Every company, from the period locks</span>
            </div>
            <div className={s.cell} role="listitem">
              <span className={s.cellL}>Partners see through</span>
              <span className={s.cellV}>{monthName(data.calendar.releasedThrough)}</span>
              <span className={s.cellS}>The earliest company's latest release</span>
            </div>
            <div className={s.cell} role="listitem">
              <span className={s.cellL}>Ready to release</span>
              <span className={s.cellV}>{counts.ready}</span>
              <span className={s.cellS}>Closed months not yet released</span>
            </div>
            <div className={s.cell} role="listitem">
              <span className={s.cellL}>Restatements to explain</span>
              <span className={`${s.cellV} ${counts.restated ? s.neg : ''}`}>{counts.restated}</span>
              <span className={s.cellS}>Released months whose numbers changed</span>
            </div>
          </div>

          <p className={s.sentence}>{ruleSentence(data.tenantSettings)}</p>
          {!data.canRelease && (
            <InlineNotice className={s.notice} tone="info" title="You can see the calendar but not release months.">
              Releasing needs close-management authority (controller or CFO).
            </InlineNotice>
          )}
          {data.maintenance.warnings.map((w) => (
            <InlineNotice key={w} className={s.notice} tone="warn" title="Part of the check didn't run.">{w}</InlineNotice>
          ))}
          {data.maintenance.restated > 0 && (
            <InlineNotice className={s.notice} tone="warn" title={`${data.maintenance.restated} released month(s) changed since they were reported.`}>
              They are listed under Restatements with what changed and why. <Button variant="quiet" onClick={() => setTab('restatements')}>Review</Button>
            </InlineNotice>
          )}

          <Tabs<Tab>
            className={s.tabs}
            aria-label="Reporting calendar"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'calendar', label: 'Calendar', count: counts.ready || undefined, panelId: PANEL },
              { value: 'freshness', label: 'Freshness & deadlines', count: counts.attention || undefined, panelId: PANEL },
              { value: 'restatements', label: 'Restatements', count: counts.restated || undefined, panelId: PANEL },
              { value: 'settings', label: 'Release rule', panelId: PANEL },
            ]}
          />

          <div id={PANEL} role="tabpanel">
            {tab === 'calendar' ? (
              data.calendar.rows.length === 0 ? (
                <div className={`${s.surface} ${s.state}`}>
                  <h2 className="t-section">No companies yet</h2>
                  <p>Add a company and generate its fiscal periods; its months appear here as they close.</p>
                </div>
              ) : (
                <CalendarGrid
                  calendar={data.calendar}
                  selected={live ? { locationId: live.row.locationId, key: live.cell.key } : null}
                  onSelect={(row, cell) => setSelected({ row, cell })}
                />
              )
            ) : tab === 'freshness' ? (
              <FreshnessTab data={data} />
            ) : tab === 'restatements' ? (
              <RestatementsTab data={data} onChanged={changed} />
            ) : (
              <SettingsTab data={data} onChanged={changed} />
            )}
          </div>

          <PeriodPanel
            open={!!live}
            row={live?.row ?? null}
            cell={live?.cell ?? null}
            canRelease={data.canRelease}
            restatements={live ? data.restatements.filter((r) => r.locationId === live.row.locationId && r.periodKey === live.cell.key) : []}
            onClose={() => setSelected(null)}
            onChanged={changed}
          />
        </>
      )}
    </div>
  );
}
