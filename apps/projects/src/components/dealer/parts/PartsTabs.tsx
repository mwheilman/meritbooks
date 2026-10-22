'use client';

import { useRouter } from 'next/navigation';
import { Tabs } from '@meritbooks/merit-ui';

export type PartsTab = 'counter' | 'catalog' | 'special' | 'orders' | 'counts';

export const PARTS_TABS: ReadonlyArray<{ value: PartsTab; label: string }> = [
  { value: 'counter', label: 'Counter' },
  { value: 'catalog', label: 'Catalog and on hand' },
  { value: 'special', label: 'Special orders' },
  { value: 'orders', label: 'Stock orders' },
  { value: 'counts', label: 'Counts' },
];

/** The parts department's views; each tab is its own URL so the browser back button works. */
export function PartsTabs({ value, counts }: { value: PartsTab; counts: Partial<Record<PartsTab, number>> }) {
  const router = useRouter();
  return (
    <Tabs<PartsTab>
      aria-label="Parts"
      value={value}
      onChange={(t) => router.push(`/parts?tab=${t}`)}
      items={PARTS_TABS.map((t) => ({ value: t.value, label: t.label, count: counts[t.value] || undefined }))}
    />
  );
}
