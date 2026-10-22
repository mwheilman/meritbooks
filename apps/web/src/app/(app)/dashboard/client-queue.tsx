'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Conf, QueueTable, Tag, type QueueColumn } from '@meritbooks/merit-ui';
import type { ClientQueueItem } from './actions';
import { cents, shortLabel } from './home-format';

/**
 * The client home's Decide list: the open bank/card lines that need a person —
 * flagged first, then unscored, then lowest AI confidence. J/K move, ↵ opens the
 * bank feed (where the line is approved, edited or flagged). Read-only here.
 */
export function ClientDecideQueue({ items }: { items: ClientQueueItem[] }) {
  const router = useRouter();
  const [cursor, setCursor] = useState<string | null>(items[0]?.id ?? null);
  const columns = useMemo<QueueColumn<ClientQueueItem>[]>(
    () => [
      {
        id: 'payee',
        header: 'Line',
        cell: (r) => (
          <>
            <span className="l1">{r.description}</span>
            <span className="l2">{shortLabel(r.date)}</span>
          </>
        ),
      },
      {
        id: 'why',
        header: 'Why it’s here',
        width: 200,
        cell: (r) =>
          r.status === 'FLAGGED' ? (
            <Tag tone="neg">Flagged</Tag>
          ) : r.confidence === null ? (
            <Tag tone="warn">Not scored yet</Tag>
          ) : (
            <span className="ink-2">Under 70 · one look</span>
          ),
      },
      {
        id: 'conf',
        header: 'Confidence',
        width: 112,
        cell: (r) => (r.confidence === null ? <span className="ink-3">—</span> : <Conf score={r.confidence} />),
      },
      { id: 'amount', header: 'Amount', numeric: true, width: 120, cell: (r) => cents(r.amountCents) },
    ],
    [],
  );
  return (
    <QueueTable
      aria-label="Decide band, lowest confidence first"
      columns={columns}
      rows={items}
      getRowId={(r) => r.id}
      rowState={(r) => ({ attn: r.status === 'FLAGGED' })}
      cursorId={cursor}
      onCursorChange={(id) => setCursor(id)}
      onOpen={() => router.push('/bank-feed')}
      flush
    />
  );
}
