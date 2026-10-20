'use client';

import { useRouter } from 'next/navigation';
import { Bands } from '@meritbooks/merit-ui';

export type ReviewKind = 'change-orders' | 'commitments' | 'billing' | 'deposits';

export interface ReviewKindItem { value: ReviewKind; label: string; count: string; caption: string }

/** To review: one band per kind of approval; one live queue at a time (one hotkey set per page). */
export function ReviewKinds({ value, items }: { value: ReviewKind; items: ReadonlyArray<ReviewKindItem> }) {
  const router = useRouter();
  return (
    <div style={{ maxWidth: 1040, marginBottom: 24 }}>
      <Bands<ReviewKind> aria-label="What is waiting" value={value} onChange={(k) => router.push(k === 'change-orders' ? '/review' : `/review?kind=${k}`, { scroll: false })} items={items} />
    </div>
  );
}
