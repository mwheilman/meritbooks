'use client';

import { useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button, Popover, PopoverGroup, PopoverItem, PopoverList, Tabs, Tag } from '@meritbooks/merit-ui';
import type { JobTabDef, JobTabValue } from '@/lib/pm/job-tabs';

export interface JobTabsNavProps {
  visible: ReadonlyArray<JobTabDef>;
  more: ReadonlyArray<JobTabDef>;
  value: JobTabValue;
  /** The tab the job opens on: its URL carries no ?tab. */
  defaultTab: JobTabValue;
  counts: Partial<Record<JobTabValue, number>>;
}

/**
 * The pack's tab row (≤ 7) plus More (UX seat §3d). Counts show as badges; the URL carries the
 * tab (the default tab is the bare job URL, so a shared link opens where the industry expects).
 * When the open tab lives behind More it shows in the row as the eighth item so you can see where
 * you are.
 */
export function JobTabsNav({ visible, more, value, defaultTab, counts }: JobTabsNavProps) {
  const router = useRouter();
  const pathname = usePathname();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const go = (t: JobTabValue) => router.push(t === defaultTab ? pathname : `${pathname}?tab=${t}`, { scroll: false });
  const inMore = more.find((t) => t.value === value);
  const row = inMore ? [...visible, inMore] : [...visible];
  const moreCount = more.reduce((n, t) => n + (counts[t.value] ?? 0), 0);

  return (
    <div className="job-tabrow">
      <Tabs<JobTabValue>
        className="job-tabs"
        aria-label="Job sections"
        value={value}
        onChange={go}
        items={row.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] || undefined, panelId: 'job-panel' }))}
      />
      {more.length > 0 && (
        <>
          <Button ref={anchor} variant="quiet" iconAfter="down" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            More{moreCount ? ` · ${moreCount}` : ''}
          </Button>
          <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} width={280} placement="bottom-end" aria-label="More job sections" role="menu">
            <PopoverList role="menu" aria-label="More sections">
              <PopoverGroup label="More" meta={String(more.length)} />
              {more.map((t) => (
                <PopoverItem
                  key={t.value}
                  active={t.value === value}
                  onClick={() => {
                    setOpen(false);
                    go(t.value);
                  }}
                  right={t.later ? <Tag>Later release</Tag> : counts[t.value] ? <span className="ink-3 tnum">{counts[t.value]}</span> : undefined}
                >
                  {t.label}
                </PopoverItem>
              ))}
            </PopoverList>
          </Popover>
        </>
      )}
    </div>
  );
}
