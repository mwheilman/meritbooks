'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Check, Download, Loader2, Lock, Scissors, UserCheck, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { AccessDialog } from '@/components/access/dialog';
import { toCsv } from '@/lib/access-governance/csv';
import type { AccessReview, AccessReviewItem, ReviewDecision, ReviewSummaryCounts } from '@/lib/access-governance/types';

type View = 'todo' | 'all' | 'decided';

const DECISION_STYLE: Record<ReviewDecision, string> = {
  keep: 'badge-success',
  reduce: 'badge-warning',
  revoke: 'badge-danger',
  delegate: 'badge-info',
};
const DECISION_LABEL: Record<ReviewDecision, string> = { keep: 'Kept', reduce: 'Reduce', revoke: 'Revoked', delegate: 'Delegated' };

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
}

export function ReviewDetail({
  review,
  canClose,
  onBack,
  onChanged,
}: {
  review: AccessReview;
  canClose: boolean;
  onBack: () => void;
  onChanged: () => Promise<void>;
}) {
  const [items, setItems] = useState<AccessReviewItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('todo');
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<AccessReviewItem | null>(null);
  const [noteTarget, setNoteTarget] = useState<AccessReviewItem | null>(null);
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState(false);
  const [summary, setSummary] = useState<ReviewSummaryCounts | null>(review.summary);
  const listRef = useRef<HTMLOListElement>(null);
  const open = review.status === 'open';

  const load = useCallback(async () => {
    setError(null);
    const res = await api.get<{ data: { items: AccessReviewItem[] } }>('/api/access/reviews/items', { reviewId: review.id });
    if (res.error) {
      setError(res.error.error || 'Could not load this review');
      setItems([]);
      return;
    }
    setItems(res.data!.data.items);
  }, [review.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const all = items ?? [];
    if (view === 'todo') return all.filter((i) => i.decision === null && (i.isMine || !all.some((x) => x.isMine)));
    if (view === 'decided') return all.filter((i) => i.decision !== null);
    return all;
  }, [items, view]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(visible.length - 1, 0)));
  }, [visible.length]);

  const decide = useCallback(
    async (item: AccessReviewItem, decision: ReviewDecision, noteText?: string) => {
      setBusy(item.id);
      const res = await api.post<{ data: { applied: boolean } }>('/api/access/reviews/decide', {
        itemId: item.id,
        decision,
        note: noteText || undefined,
      });
      setBusy(null);
      if (res.error) {
        addToast('error', res.error.error || 'Could not save the decision');
        return false;
      }
      addToast('success', decision === 'revoke' ? `${item.personName} no longer has ${item.title}.` : 'Saved.');
      setItems((prev) =>
        (prev ?? []).map((i) =>
          i.id === item.id ? { ...i, decision, decisionNote: noteText ?? null, decidedAt: new Date().toISOString(), decidedByName: 'You' } : i,
        ),
      );
      void onChanged();
      return true;
    },
    [onChanged],
  );

  // Keyboard: j/k move · a keep · r reduce · x revoke (05 §6.8).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (revokeTarget || noteTarget || closing || e.metaKey || e.ctrlKey || e.altKey) return;
      const item = visible[cursor];
      if (e.key === 'j') setCursor((c) => Math.min(c + 1, visible.length - 1));
      else if (e.key === 'k') setCursor((c) => Math.max(c - 1, 0));
      else if (!item || item.decision === 'revoke') return;
      else if (e.key === 'a') void decide(item, 'keep');
      else if (e.key === 'r') {
        setNote('');
        setNoteTarget(item);
      } else if (e.key === 'x') setRevokeTarget(item);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, visible, cursor, decide, revokeTarget, noteTarget, closing]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const closeReview = async () => {
    setBusy('close');
    const res = await api.post<{ data: { summary: ReviewSummaryCounts } }>('/api/access/reviews/close', { reviewId: review.id });
    setBusy(null);
    setClosing(false);
    if (res.error) {
      addToast('error', res.error.error || 'Could not close the review');
      return;
    }
    setSummary(res.data!.data.summary);
    addToast('success', 'Review closed.');
    await onChanged();
    await load();
  };

  const exportCsv = () => {
    const csv = toCsv(
      ['Person', 'Email', 'Access', 'Where', 'Granted', 'Granted by', 'Ends', 'Reviewer', 'Decision', 'Note', 'Decided by', 'Decided'],
      (items ?? []).map((i) => [
        i.personName,
        i.personEmail,
        i.sourceName,
        i.scopeLabel,
        fmtDate(i.grantedAt),
        i.grantedByName,
        i.endsAt ? fmtDate(i.endsAt) : 'No end date',
        i.reviewerName,
        i.decision ? DECISION_LABEL[i.decision] : 'Not reviewed',
        i.decisionNote,
        i.decidedByName,
        i.decidedAt ? fmtDate(i.decidedAt) : '',
      ]),
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${review.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-report.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const total = items?.length ?? review.progress.total;
  const decided = items ? items.filter((i) => i.decision !== null).length : review.progress.decided;
  const pct = total ? Math.round((decided / total) * 100) : 0;
  const counts = (d: ReviewDecision) => (items ?? []).filter((i) => i.decision === d).length;
  const overdue = open && new Date(review.dueAt).getTime() < Date.now();

  return (
    <div className="space-y-4">
      <button type="button" className="btn-ghost btn-sm -ml-2" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All reviews
      </button>

      <div className="card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-white">{review.name}</h2>
            <p className="mt-0.5 text-sm text-slate-400">
              {review.scopeLabel} · {open ? `Due ${fmtDate(review.dueAt)}` : `Closed ${fmtDate(review.closedAt)}`}
              {overdue && <span className="ml-2 text-red-400">Overdue</span>}
              {review.autoRevokeUnreviewed && open && <span className="ml-2 text-amber-400">Unreviewed access is revoked at close</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary btn-sm" onClick={exportCsv} disabled={!items?.length}>
              <Download className="h-3.5 w-3.5" aria-hidden /> Report (CSV)
            </button>
            {open && canClose && (
              <button type="button" className="btn-primary btn-sm" onClick={() => setClosing(true)}>
                <Lock className="h-3.5 w-3.5" aria-hidden /> Close review
              </button>
            )}
          </div>
        </div>
        <div className="mt-4 confidence-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Review progress">
          <div className="confidence-fill bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-slate-400">
          <span className="text-slate-200">
            {decided} of {total} decided
          </span>
          <span>{counts('keep')} kept</span>
          <span>{counts('reduce')} to reduce</span>
          <span>{counts('revoke')} revoked</span>
        </div>
        {summary && !open && (
          <div className="mt-4 rounded-lg border border-slate-800 bg-surface-950 p-3 text-sm text-slate-300">
            <div className="mb-1 font-medium text-white">Completion summary</div>
            {summary.items} items · {summary.kept} kept · {summary.reduced} to reduce · {summary.revoked} revoked
            {summary.auto_revoked ? ` (${summary.auto_revoked} automatically, not reviewed)` : ''} · {summary.undecided} not reviewed ·{' '}
            {summary.reviewers} reviewer{summary.reviewers === 1 ? '' : 's'}
            {summary.closed_late ? ' · closed after the due date' : ''}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter items">
        {(
          [
            ['todo', 'To decide'],
            ['decided', 'Decided'],
            ['all', 'All'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={view === k}
            onClick={() => {
              setView(k);
              setCursor(0);
            }}
            className={clsx('rounded-full px-3 py-1 text-xs font-medium', view === k ? 'bg-emerald-500/15 text-emerald-300' : 'text-slate-400 hover:text-slate-200')}
          >
            {l}
          </button>
        ))}
        {open && <span className="ml-auto hidden text-2xs text-slate-500 sm:inline">j / k move · a keep · r reduce · x revoke</span>}
      </div>

      {items === null ? (
        <TableSkeleton rows={6} />
      ) : error ? (
        <div className="card flex items-center gap-3 p-4 text-sm text-red-400" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
          <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={UserCheck}
            title={view === 'todo' ? 'Nothing left for you to decide' : 'Nothing here'}
            description={view === 'todo' ? 'Every item assigned to you has a decision. Thank you.' : 'No items match this filter.'}
          />
        </div>
      ) : (
        <ol ref={listRef} className="space-y-2">
          {visible.map((i, idx) => (
            <li
              key={i.id}
              data-idx={idx}
              onClick={() => setCursor(idx)}
              className={clsx('card p-4 transition-colors', idx === cursor && open ? 'border-emerald-500/50' : '')}
            >
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-white">{i.personName}</span>
                    <span className="text-sm text-slate-400">· {i.title}</span>
                    {i.legacy && <span className="badge-warning">Carried over from the old roles</span>}
                    {i.decision && <span className={DECISION_STYLE[i.decision]}>{DECISION_LABEL[i.decision]}</span>}
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="text-slate-500">Granted</dt>
                      <dd className="text-slate-300">
                        {fmtDate(i.grantedAt)}
                        {i.grantedByName ? ` · ${i.grantedByName}` : ''}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Ends</dt>
                      <dd className="text-slate-300">{i.endsAt ? fmtDate(i.endsAt) : 'No end date'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Reviewer</dt>
                      <dd className="text-slate-300">{i.isMine ? 'You' : i.reviewerName ?? 'Any access admin'}</dd>
                    </div>
                    <div>
                      <dt className="text-slate-500">Why they have it</dt>
                      <dd className="truncate text-slate-300" title={i.reason ?? undefined}>
                        {i.reason ?? '—'}
                      </dd>
                    </div>
                  </dl>
                  {i.decisionNote && <p className="mt-2 text-xs text-slate-400">“{i.decisionNote}”</p>}
                </div>
                {open && i.decision !== 'revoke' && (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      className={clsx('btn-sm', i.decision === 'keep' ? 'btn-primary' : 'btn-secondary')}
                      disabled={busy === i.id}
                      onClick={() => void decide(i, 'keep')}
                    >
                      {busy === i.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />}
                      Keep
                    </button>
                    <button
                      type="button"
                      className="btn-secondary btn-sm"
                      disabled={busy === i.id}
                      onClick={() => {
                        setNote('');
                        setNoteTarget(i);
                      }}
                    >
                      <Scissors className="h-3.5 w-3.5" aria-hidden /> Reduce
                    </button>
                    <button type="button" className="btn-danger btn-sm" disabled={busy === i.id} onClick={() => setRevokeTarget(i)}>
                      <XCircle className="h-3.5 w-3.5" aria-hidden /> Revoke
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      <AccessDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        title="Revoke this access?"
        description={revokeTarget ? `${revokeTarget.personName} loses ${revokeTarget.title} immediately. This is recorded in the access log.` : undefined}
        footer={
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setRevokeTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger btn-sm"
              disabled={busy !== null}
              onClick={async () => {
                if (!revokeTarget) return;
                const ok = await decide(revokeTarget, 'revoke', note.trim() || undefined);
                if (ok) {
                  setRevokeTarget(null);
                  setNote('');
                }
              }}
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Revoke now
            </button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1 block text-sm text-slate-300">Note (optional)</span>
          <input className="input" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Moved to another team" />
        </label>
      </AccessDialog>

      <AccessDialog
        open={!!noteTarget}
        onClose={() => setNoteTarget(null)}
        title="What should be reduced?"
        description="The access stays as it is for now; your note tells the access admin exactly what to cut back."
        footer={
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setNoteTarget(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={!note.trim() || busy !== null}
              onClick={async () => {
                if (!noteTarget) return;
                const ok = await decide(noteTarget, 'reduce', note.trim());
                if (ok) setNoteTarget(null);
              }}
            >
              Save
            </button>
          </>
        }
      >
        <label className="block">
          <span className="mb-1 block text-sm text-slate-300">Note</span>
          <textarea
            className="input"
            rows={3}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Keep on Clive Power, remove from Swan Creek"
          />
        </label>
      </AccessDialog>

      <AccessDialog
        open={closing}
        onClose={() => setClosing(false)}
        title="Close this review?"
        description={
          review.autoRevokeUnreviewed
            ? `${total - decided} item(s) have no decision and will be revoked now. Nobody can decide items after closing.`
            : `${total - decided} item(s) have no decision; they stay as they are. Nobody can decide items after closing.`
        }
        footer={
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setClosing(false)}>
              Cancel
            </button>
            <button type="button" className={review.autoRevokeUnreviewed ? 'btn-danger btn-sm' : 'btn-primary btn-sm'} disabled={busy === 'close'} onClick={closeReview}>
              {busy === 'close' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Close review
            </button>
          </>
        }
      >
        <p className="text-sm text-slate-400">A completion report (CSV) stays available here for auditors.</p>
      </AccessDialog>
    </div>
  );
}
