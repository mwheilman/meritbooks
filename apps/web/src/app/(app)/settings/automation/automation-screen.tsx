'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, PageHead, Tabs, useQuery } from '@meritbooks/merit-ui';
import { JobsTab } from './jobs-tab';
import { DunningTab } from './dunning-tab';
import { LateFeesTab } from './late-fees-tab';
import type { PoliciesResponse } from './automation-types';
import s from './automation.module.css';

export type AutomationTab = 'jobs' | 'dunning' | 'late_fees';

/** Settings → Automation: what the books do on their own, when, and with what result. */
export function AutomationScreen({ initialTab }: { initialTab: AutomationTab }) {
  const router = useRouter();
  const [tab, setTab] = useState<AutomationTab>(initialTab);
  const [policyKey, setPolicyKey] = useState(0);
  const policies = useQuery<PoliciesResponse>(tab === 'jobs' ? null : '/api/automation/policies', undefined, { key: String(policyKey), scope: false });
  const reloadPolicies = useCallback(() => setPolicyKey((k) => k + 1), []);

  const change = (t: AutomationTab) => {
    setTab(t);
    router.replace(t === 'jobs' ? '/settings/automation' : `/settings/automation?tab=${t}`, { scroll: false });
  };

  return (
    <div>
      <PageHead eyebrow={['Settings', 'Automation']} title="Automation">
        <p className="t-cap">What the books do on their own, on what schedule, and what happened last time. Anything that could post or send waits for a person unless you raise its autonomy dial.</p>
      </PageHead>
      <Tabs<AutomationTab>
        aria-label="Automation"
        className={s.tabs}
        value={tab}
        onChange={change}
        items={[
          { value: 'jobs', label: 'Scheduled jobs' },
          { value: 'dunning', label: 'Payment reminders' },
          { value: 'late_fees', label: 'Late fees' },
        ]}
      />
      {tab === 'jobs' ? (
        <JobsTab />
      ) : policies.error ? (
        <div className={s.state} role="alert">
          <p className="t-head">Couldn’t load the policies.</p>
          <p className="ink-2">{policies.error}</p>
          <Button onClick={() => void policies.refetch()}>Try again</Button>
        </div>
      ) : !policies.data ? (
        <div className={s.state} role="status">
          <span className="bar-l" style={{ width: '50%' }} aria-hidden="true" />
          <p className="t-cap">Loading…</p>
        </div>
      ) : tab === 'dunning' ? (
        <DunningTab data={policies.data} onSaved={reloadPolicies} />
      ) : (
        <LateFeesTab data={policies.data} onSaved={reloadPolicies} />
      )}
    </div>
  );
}
