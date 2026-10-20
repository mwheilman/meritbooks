'use client';

/**
 * Money-event timeline for one warranty or incentive claim
 * (GET /api/dealer/claim-events) — every event with its date, amount, note and a
 * link to the journal entry it posted.
 */

import { useEffect } from 'react';
import Link from 'next/link';
import { clsx } from 'clsx';
import { FileText, History } from 'lucide-react';
import { CLAIM_EVENT, labelOf } from '@/lib/dealer/ui/labels';
import { dateLabel } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import type { ClaimEventRow } from '@/lib/dealer/ui/claims';
import type { ClaimKind } from '@/lib/dealer/types';
import { useDealerQuery, type ListPage } from '../../_lib/use-dealer';
import { ErrorPanel, Money } from '../ui';

const DOT: Partial<Record<ClaimEventRow['event_type'], string>> = {
  RECOGNIZED: 'bg-blue-400',
  ACCRUED: 'bg-blue-400',
  SUBMITTED: 'bg-slate-400',
  RESUBMITTED: 'bg-slate-400',
  CREDIT_APPLIED: 'bg-emerald-400',
  CASH_RECEIVED: 'bg-emerald-400',
  SHORT_PAY_ACCEPTED: 'bg-amber-400',
  REJECTED: 'bg-red-400',
  WRITTEN_OFF: 'bg-amber-400',
  DEBITED: 'bg-red-400',
};

export function ClaimTimeline({ kind, claimId, refreshKey }: { kind: ClaimKind; claimId: string; refreshKey: number }) {
  const q = useDealerQuery<ListPage<ClaimEventRow>>('/api/dealer/claim-events', {
    [kind === 'WARRANTY' ? 'warranty_claim_id' : 'incentive_claim_id']: claimId,
    sort: 'created_at',
    dir: 'asc',
    per_page: 100,
  });
  const { refetch } = q;

  useEffect(() => {
    if (refreshKey > 0) void refetch();
  }, [refreshKey, refetch]);

  return (
    <section aria-labelledby={`tl-${claimId}`}>
      <h3 id={`tl-${claimId}`} className="mb-3 flex items-center gap-1.5 text-caption uppercase tracking-caps text-slate-500">
        <History size={12} /> History
      </h3>
      {q.error ? (
        <ErrorPanel error={q.error} onRetry={() => void q.refetch()} compact />
      ) : q.isLoading && !q.data ? (
        <div className="space-y-3" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-slate-800/60" />
          ))}
        </div>
      ) : (q.data?.rows.length ?? 0) === 0 ? (
        <p className="text-sm text-slate-500">Nothing has happened on this claim yet. Events appear here as it is submitted, paid or resolved.</p>
      ) : (
        <ol className="relative space-y-4 border-l border-slate-800 pl-5">
          {q.data!.rows.map((e) => (
            <li key={e.id} className="relative">
              <span aria-hidden className={clsx('absolute -left-[25px] top-1.5 h-2 w-2 rounded-full ring-4 ring-surface-900', DOT[e.event_type] ?? 'bg-slate-500')} />
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <span className="text-sm text-slate-200">{labelOf(CLAIM_EVENT, e.event_type)}</span>
                {e.amount_cents > 0 && <Money cents={e.amount_cents} className="text-sm" />}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                <span className="font-mono tabular-nums">{dateLabel(e.event_date)}</span>
                {e.oem_statement_line_id && <span>from a manufacturer statement</span>}
                {e.gl_entry_id && (
                  <Link href={dealerLinks.journalEntry(e.gl_entry_id)} className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300">
                    <FileText size={11} /> Journal entry
                  </Link>
                )}
              </div>
              {e.note && <p className="mt-1 text-xs text-slate-400">{e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
