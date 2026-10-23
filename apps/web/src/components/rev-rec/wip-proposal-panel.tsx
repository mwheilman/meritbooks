'use client';

import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Eyebrow,
  InlineNotice,
  KV,
  Status,
  Tag,
  money,
  toast,
  type StatusKind,
} from '@meritbooks/merit-ui';
import type { WipEntryView, WipScheduleView } from '@/lib/rev-rec/wip-view';
import type { WipRunRow } from '@/lib/rev-rec/wip-run-service';
import { periodLabel } from './period-picker';

/**
 * The month-end WIP proposal — status, the entries it will post (with the reversal on the
 * 1st), and the verbs: Propose · Approve & post · Dismiss (reason) · Post reversal. Shared by
 * /jobs/wip and /rev-rec. Every number comes from the API (the canonical engine).
 */

const usd = (c: number) => money(c, { symbol: '$' });

const RUN_STATUS: Record<WipRunRow['status'], { kind: StatusKind; label: string }> = {
  PROPOSED: { kind: 'risk', label: 'Awaiting approval' },
  POSTING: { kind: 'track', label: 'Posting…' },
  POSTED: { kind: 'ready', label: 'Posted' },
  NO_CHANGE: { kind: 'ready', label: 'Nothing to book' },
  DISMISSED: { kind: 'track', label: 'Dismissed' },
  SUPERSEDED: { kind: 'track', label: 'Replaced' },
  FAILED: { kind: 'blocked', label: 'Posting failed' },
};

const ENTRY_TITLE: Record<WipEntryView['kind'], string> = {
  RECLASS: 'Billings reclass (permanent)',
  ADJUSTMENT: 'WIP adjustment',
  REVERSAL: 'Automatic reversal',
};

const fmtWhen = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const who = (v: string | null) => (!v ? 'the scheduler' : v.startsWith('system:') ? 'the scheduler' : 'a team member');

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

export function EntryTable({ entry }: { entry: WipEntryView }) {
  return (
    <div className="stack">
      <div className="row row--between">
        <span className="t-head">{ENTRY_TITLE[entry.kind]}</span>
        <span className="t-cap ink-3">Dated {entry.date}</span>
      </div>
      <div className="mb-scroll-x surface">
        <table className="tbl tbl-q tbl-q--compact" aria-label={ENTRY_TITLE[entry.kind]}>
          <thead>
            <tr>
              <th style={{ width: '38%' }}>Account</th>
              <th style={{ width: '22%' }}>Job</th>
              <th className="n">Debit</th>
              <th className="n">Credit</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l, i) => (
              <tr key={i} className="q-row">
                <td><span className="code">{l.accountNumber}</span>{l.accountName}</td>
                <td>{l.jobNumber ?? '—'}</td>
                <td className="n tnum">{l.debitCents ? money(l.debitCents) : ''}</td>
                <td className="n tnum">{l.creditCents ? money(l.creditCents) : ''}</td>
              </tr>
            ))}
            <tr className="q-group">
              <td colSpan={2}><b>Total</b></td>
              <td className="n tnum"><b>{money(entry.totalCents)}</b></td>
              <td className="n tnum"><b>{money(entry.totalCents)}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function WipProposalPanel({ view, onChanged }: { view: WipScheduleView; onChanged: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'approve' | 'dismiss' | null>(null);
  const run = view.currentRun;
  const somethingToPost = view.entries.length > 0;
  const t = view.totals;

  const propose = async () => {
    setBusy(true);
    try {
      const r = await post('/api/rev-rec/wip', { location_id: view.locationId, period: view.periodKey });
      if (!r.ok) { toast.error(String(r.json.error ?? 'Could not propose the entry')); return; }
      const outcome = String(r.json.outcome);
      toast(outcome === 'proposed' ? `Proposed the ${periodLabel(view.periodKey)} WIP entry` : outcome === 'up_to_date' ? 'Already posted — nothing new to book' : 'Nothing to book this month');
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const act = async (action: 'approve' | 'dismiss' | 'retry_reversal', reason?: string) => {
    if (!run) return;
    setBusy(true);
    try {
      const r = await post(`/api/rev-rec/wip/${run.id}`, reason ? { action, reason } : { action });
      if (!r.ok) {
        toast.error(String(r.json.error ?? 'That did not work'));
        if (r.status === 409) await onChanged();
        return;
      }
      if (action === 'approve') {
        const nums = (r.json.entryNumbers ?? {}) as Record<string, string | undefined>;
        toast(`Posted ${[nums.reclass, nums.adjustment, nums.reversal].filter(Boolean).join(' · ') || 'the WIP entry'}${r.json.reversalPending ? ' — reversal still pending' : ''}`);
      } else if (action === 'dismiss') {
        toast('Dismissed — the close task is cleared with your reason');
      } else {
        toast('Reversal posted');
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const status = run ? RUN_STATUS[run.status] : null;
  const periodBlocked = view.period.status === 'HARD_CLOSE' || view.period.status === 'MISSING';
  const nextBlocked = view.nextPeriod.status === 'HARD_CLOSE' || view.nextPeriod.status === 'MISSING';
  const hasAdjustment = view.entries.some((e) => e.kind === 'ADJUSTMENT');
  const canApprove = run?.status === 'PROPOSED' && !periodBlocked && !(hasAdjustment && nextBlocked) && view.issues.length === 0 && view.setupIssues.length === 0;

  return (
    <section className="surface" style={{ padding: 16 }} aria-labelledby="wip-proposal-h">
      <div className="row row--between" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <Eyebrow>{['Month-end entry', periodLabel(view.periodKey)]}</Eyebrow>
          <h2 id="wip-proposal-h" className="t-section" style={{ marginTop: 4 }}>
            {t.jobs} job{t.jobs === 1 ? '' : 's'} · underbilled {usd(t.targetUnderCents)} · overbilled {usd(t.targetOverCents)}
            {t.targetLossCents > 0 ? ` · loss provision ${usd(t.targetLossCents)}` : ''}
          </h2>
          <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
            {status ? <Status kind={status.kind}>{status.label}</Status> : <Status kind="overdue">Not proposed yet</Status>}
            {run && <span className="t-cap ink-3">Revision {run.revision} · proposed {fmtWhen(run.proposed_at)} by {who(run.requested_by)}</span>}
            {run?.status === 'POSTED' && <span className="t-cap ink-3">Approved {fmtWhen(run.posted_at)} by {who(run.approved_by)}</span>}
            {run?.status === 'DISMISSED' && <span className="t-cap ink-3">Reason: {run.dismiss_reason}</span>}
          </div>
        </div>
        <div className="btn-row">
          {run?.status === 'PROPOSED' ? (
            <>
              <Button variant="quiet" disabled={busy} onClick={() => setConfirm('dismiss')}>Dismiss</Button>
              <Button variant="primary" disabled={busy || !canApprove} onClick={() => setConfirm('approve')}>Approve &amp; post</Button>
            </>
          ) : run?.status === 'POSTED' && run.reversal_pending ? (
            <Button variant="primary" disabled={busy || nextBlocked} onClick={() => act('retry_reversal')}>Post reversal</Button>
          ) : (
            <Button variant="primary" disabled={busy || view.setupIssues.length > 0 || view.lines.length === 0} onClick={propose}>
              {run?.status === 'POSTED' && somethingToPost ? 'Propose true-up' : 'Propose entry'}
            </Button>
          )}
        </div>
      </div>

      <div className="stack" style={{ marginTop: 16 }}>
        {view.setupIssues.map((m) => <InlineNotice key={m} tone="neg" title="Set up needed">{m}</InlineNotice>)}
        {periodBlocked && (
          <InlineNotice tone="warn" title={view.period.status === 'MISSING' ? 'No fiscal period' : 'Month is hard-closed'}>
            {view.period.status === 'MISSING' ? `There is no fiscal period for ${periodLabel(view.periodKey)}.` : `Reopen ${periodLabel(view.periodKey)} to post a WIP entry into it.`}
          </InlineNotice>
        )}
        {hasAdjustment && nextBlocked && (
          <InlineNotice tone="warn" title="Next month is not open">
            The WIP entry reverses on {view.reversalDate}. Open that month before approving.
          </InlineNotice>
        )}
        {view.issues.map((i) => (
          <InlineNotice key={i.jobId + i.reason} tone="warn" title={i.jobNumber ?? 'Job'}>{i.reason}</InlineNotice>
        ))}
        {run?.status === 'FAILED' && run.error && <InlineNotice tone="neg" title="Posting failed">{run.error}</InlineNotice>}
        {run?.status === 'POSTED' && run.reversal_pending && <InlineNotice tone="warn" title="Reversal pending">{run.error ?? 'Post the reversal once next month is open.'}</InlineNotice>}

        {somethingToPost ? (
          <>
            <p className="t-body ink-2">
              {run?.status === 'POSTED'
                ? 'Something changed after the entry was posted. This true-up brings the books back to the schedule:'
                : 'Approving posts these entries. The WIP adjustment reverses automatically on the 1st, so next month starts from billings again.'}
            </p>
            {view.entries.map((e) => <EntryTable key={e.kind} entry={e} />)}
          </>
        ) : (
          <p className="t-body ink-2">
            {view.lines.length === 0
              ? 'No jobs on the WIP schedule for this company.'
              : 'The books already match the schedule for this month — nothing to post.'}
          </p>
        )}

        <KV
          items={[
            { term: 'Posts to', value: `${view.accounts.unbilled ?? '—'} Unbilled receivable · ${view.accounts.deferred ?? '—'} Deferred revenue${view.policy.lossProvision ? ` · ${view.accounts.lossProvision ?? 'not mapped'} Loss provision` : ''}` },
            { term: 'Posting', value: view.policy.postingMode === 'AUTO_POST' ? 'Posts automatically within your autonomy limit' : 'Proposed — a person approves' },
            { term: 'Next scheduled run', value: view.nextScheduledRun ? fmtWhen(view.nextScheduledRun) : 'On demand only' },
          ]}
        />
      </div>

      <ConfirmDialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        title={`Post the ${periodLabel(view.periodKey)} WIP entry?`}
        confirmLabel="Approve & post"
        onConfirm={async () => { setConfirm(null); await act('approve'); }}
        footNote={`Reverses automatically on ${view.reversalDate}.`}
      >
        <p className="t-body">
          Books {usd(t.targetUnderCents)} of underbillings to Unbilled AR and {usd(t.targetOverCents)} of overbillings to Deferred revenue
          {t.targetLossCents > 0 ? `, plus a ${usd(t.targetLossCents)} anticipated-loss provision` : ''}, across {t.jobs} job{t.jobs === 1 ? '' : 's'}.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'dismiss'}
        onClose={() => setConfirm(null)}
        title="Dismiss this month’s WIP entry?"
        confirmLabel="Dismiss entry"
        tone="danger"
        reason={{ label: 'Why are you not booking it?', minLength: 4, placeholder: 'e.g. Estimates are being re-forecast; booking next month' }}
        onConfirm={async (reason) => { setConfirm(null); await act('dismiss', reason); }}
      >
        <p className="t-body">Nothing posts. The close checklist accepts the dismissal and keeps your reason on the record.</p>
      </ConfirmDialog>
    </section>
  );
}

/** Run history list (newest first). */
export function WipRunHistory({ runs }: { runs: WipRunRow[] }) {
  if (runs.length === 0) return <p className="t-body ink-3">No month-end runs yet. The first one appears after you propose an entry (or on the 1st, if scheduled).</p>;
  return (
    <div className="mb-scroll-x surface">
      <table className="tbl tbl-q tbl-q--compact" aria-label="WIP run history">
        <thead>
          <tr>
            <th>Month</th>
            <th>Status</th>
            <th className="n">Jobs</th>
            <th className="n">Underbilled</th>
            <th className="n">Overbilled</th>
            <th className="n">Loss</th>
            <th>When</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="q-row">
              <td>{periodLabel(r.period_key)}{r.revision > 1 ? <Tag style={{ marginLeft: 6 }}>rev {r.revision}</Tag> : null}</td>
              <td><Status kind={RUN_STATUS[r.status].kind}>{RUN_STATUS[r.status].label}</Status></td>
              <td className="n tnum">{r.job_count}</td>
              <td className="n tnum">{money(Number(r.underbilled_cents))}</td>
              <td className="n tnum">{money(Number(r.overbilled_cents))}</td>
              <td className="n tnum">{money(Number(r.loss_provision_cents))}</td>
              <td>{fmtWhen(r.posted_at ?? r.dismissed_at ?? r.proposed_at)}</td>
              <td className="ink-2">{r.dismiss_reason ?? (r.source === 'SCHEDULER' ? 'Scheduled' : '')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
