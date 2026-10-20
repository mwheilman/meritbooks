'use client';

import { usePathname, useRouter } from 'next/navigation';
import { Tabs } from '@meritbooks/merit-ui';
import type { TabDef } from '@/lib/pm/job-tabs';
import type { JobTab } from '@/lib/pm/guards';

export function JobTabsNav({ tabs, value, counts }: { tabs: ReadonlyArray<TabDef>; value: JobTab; counts: Partial<Record<JobTab, number>> }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <Tabs<JobTab>
      className="job-tabs"
      aria-label="Job sections"
      value={value}
      onChange={(t) => router.push(t === 'overview' ? pathname : `${pathname}?tab=${t}`, { scroll: false })}
      items={tabs.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] || undefined, panelId: 'job-panel' }))}
    />
  );
}
