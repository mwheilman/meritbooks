'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Button, InlineNotice, Pip, Widget, api, count, toast } from '@meritbooks/merit-ui';
import type { SeamHealthRow } from '@/lib/pm/money/types';
import { SEAM_EVENT_LABELS, ageWords, seamSentence, worstAlarm } from '@/lib/pm/money/status';

interface SeamGet { rows: SeamHealthRow[]; booksPresent: boolean }
interface SeamPost { rows: SeamHealthRow[]; reconcile: { billing_issued: number; billing_rejected: number; deposits_issued: number; deposits_rejected: number }; costs: { status: 'ok' | 'busy'; applied?: number } }

/** Outbound: what Merit Projects sent that Merit Books has not picked up yet. Inbound (JOB_COST) is shown apart. */
export function seamSummary(rows: ReadonlyArray<SeamHealthRow>) {
  const out = rows.filter((r) => r.event_type !== 'JOB_COST');
  const inbound = rows.find((r) => r.event_type === 'JOB_COST') ?? null;
  const pending = out.reduce((s, r) => s + r.pending_count, 0);
  const ages = out.filter((r) => r.pending_count > 0).map((r) => r.oldest_pending_age_minutes ?? 0);
  const oldest = ages.length ? Math.max(...ages) : null;
  const rejected = out.reduce((s, r) => s + r.rejected_count, 0);
  const worst = worstAlarm([...out.map((r) => r.alarm), ...(inbound ? [inbound.alarm] : [])]);
  return { out, inbound, pending, oldest, rejected, worst };
}

export function SeamHealthWidget({ x = 1, y = 7, w = 4, h = 2 }: { x?: number; y?: number; w?: number; h?: number }) {
  const [data, setData] = useState<SeamGet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const r = await api.get<SeamGet>('/api/seam');
    if (r.error) setError(r.error.error);
    else setData(r.data);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const check = async () => {
    setBusy(true);
    const r = await api.post<SeamPost>('/api/seam', {});
    setBusy(false);
    if (r.error || !r.data) return void toast.error(r.error?.error ?? 'Merit Books did not answer. Try again.');
    setData((d) => ({ booksPresent: d?.booksPresent ?? true, rows: r.data!.rows }));
    const c = r.data.reconcile;
    const issued = c.billing_issued + c.deposits_issued;
    const rejected = c.billing_rejected + c.deposits_rejected;
    const applied = r.data.costs.status === 'ok' ? r.data.costs.applied ?? 0 : null;
    toast([issued || rejected ? `${count(issued)} issued, ${count(rejected)} rejected by Merit Books` : 'Nothing new from Merit Books', applied ? `${count(applied)} costs applied` : null].filter(Boolean).join(' · '));
  };

  const s = data ? seamSummary(data.rows) : null;
  return (
    <Widget
      w={w}
      h={h}
      x={x}
      y={y}
      title="Waiting on Merit Books"
      count={s?.pending || undefined}
      meta={s && s.pending > 0 ? `oldest ${ageWords(s.oldest)}` : undefined}
      actions={data?.booksPresent ? <Button variant="quiet" disabled={busy} aria-busy={busy || undefined} onClick={() => void check()}>Check now</Button> : undefined}
      pad
      state={
        error ? { kind: 'error', title: 'Seam health did not load', body: error, onRetry: () => void load(), retryLabel: 'Try again' }
          : !data ? { kind: 'loading', label: 'Checking Merit Books…', lines: 3 }
            : !data.booksPresent ? { kind: 'empty', title: 'Merit Books is not on', body: 'Nothing is sent from Merit Projects, so nothing can wait. Turn on Merit Books to invoice and post from here.' }
              : s!.pending === 0 && s!.worst === 'OK' && !s!.rejected ? { kind: 'done', title: 'Nothing is waiting on Merit Books', body: s!.inbound?.last_drain_at ? 'Costs from Merit Books are up to date.' : 'Bills, contracts and commitments reach Merit Books within minutes.' }
                : undefined
      }
      foot={s && (s.pending > 0 || s.rejected > 0) ? <Link className="link" href="/billing">Open billing</Link> : undefined}
    >
      {s && (
        <div className="stack" style={{ gap: 12 }}>
          {s.worst !== 'OK' && (
            <InlineNotice tone={s.worst === 'ALARM' ? 'neg' : 'warn'} title={s.worst === 'ALARM' ? 'Merit Books is behind.' : 'Slower than usual.'} role={s.worst === 'ALARM' ? 'alert' : 'status'}>
              {seamSentence(s.worst, s.pending, s.oldest)}
            </InlineNotice>
          )}
          <ul className="agenda" aria-label="By kind">
            {s.out.filter((r) => r.pending_count > 0 || r.rejected_count > 0).map((r) => (
              <li key={r.event_type}>
                <span className="d tnum">{count(r.pending_count)}</span>
                <span className="txt">
                  <span className="l1">{SEAM_EVENT_LABELS[r.event_type] ?? r.event_type}</span>
                  <span className="l2">{r.pending_count ? `oldest ${ageWords(r.oldest_pending_age_minutes)}` : 'none waiting'}{r.rejected_count ? ` · ${count(r.rejected_count)} rejected` : ''}</span>
                </span>
                <Pip kind={r.alarm === 'ALARM' ? 'overdue' : r.alarm === 'WARN' ? 'risk' : r.pending_count ? 'open' : 'ready'} />
              </li>
            ))}
            {s.inbound && s.inbound.pending_count > 0 && (
              <li>
                <span className="d tnum">{count(s.inbound.pending_count)}</span>
                <span className="txt"><span className="l1">Costs from Merit Books</span><span className="l2">not applied yet · oldest {ageWords(s.inbound.oldest_pending_age_minutes)}</span></span>
                <Pip kind={s.inbound.alarm === 'ALARM' ? 'overdue' : s.inbound.alarm === 'WARN' ? 'risk' : 'open'} />
              </li>
            )}
          </ul>
        </div>
      )}
    </Widget>
  );
}
