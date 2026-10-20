'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, RotateCcw, ShieldCheck, ShieldAlert, X } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';

// ── API shapes (GET/POST /api/settings/access/dual-run) ─────────────────────────────
type Mode = 'legacy' | 'dual' | 'v2';
interface Group {
  capability: string;
  action: string;
  route: string;
  kind: string;
  legacyAllowed: boolean | null;
  explained: boolean;
  explanation: string | null;
  total: number;
  members: number;
  lastSeen: string;
}
interface PendingModeChange {
  id: string;
  fromMode: string;
  toMode: string;
  requestedBy: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  mine: boolean;
}
type ModeOutcome =
  | { status: 'applied'; mode: Mode; previousMode: Mode; singleAdmin: boolean }
  | { status: 'pending'; mode: Mode; requestedMode: Mode; requestId: string }
  | { status: 'unchanged'; mode: Mode };
interface Status {
  mode: Mode;
  pendingModeChange: PendingModeChange | null;
  dualRunStartedAt: string | null;
  modeChangedAt: string | null;
  windowDays: number;
  eligible: boolean;
  daysElapsed: number;
  daysRemaining: number;
  unexplained: number;
  blockers: string[];
  totals: { disagreements: number; explained: number; unexplained: number; members: number };
  groups: Group[];
}

const MODE_LABEL: Record<Mode, { label: string; tone: string; blurb: string }> = {
  legacy: {
    label: 'Current permissions',
    tone: 'border-slate-700 bg-slate-800/60 text-slate-300',
    blurb: 'Access is decided by the current permissions only. The new role model is not being checked.',
  },
  dual: {
    label: 'Side-by-side check',
    tone: 'border-blue-800/60 bg-blue-950/40 text-blue-300',
    blurb:
      'Access is still decided by the current permissions, so nothing changes for your team. Every check is also run against the new role model, and any difference is listed below.',
  },
  v2: {
    label: 'New role model enforced',
    tone: 'border-emerald-800/60 bg-emerald-950/40 text-emerald-300',
    blurb: 'Access is decided by roles, permission sets and client assignments. Posting, approving and paying are re-checked by the database.',
  },
};

const KIND_LABEL: Record<string, string> = {
  tighten: 'Planned tightening',
  implied_view: 'View implied by another permission',
  unmapped_cell: 'Retired permission',
  same_capability_other_key: 'Same access, different permission',
  scope: 'Client scope now applied',
  money_kind: 'Approval now per payment type',
  disagree: 'Needs review',
  v2_error: 'Could not evaluate',
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

export function DualRunPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [modeDialog, setModeDialog] = useState<Mode | null>(null);
  const [explaining, setExplaining] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await api.get<{ data: Status }>('/api/settings/access/dual-run');
    if (res.error) {
      if (res.status === 403) setHidden(true);
      else setError(res.error.error || 'Could not load the permission check');
      setLoading(false);
      return;
    }
    setStatus(res.data!.data);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (hidden) return null;

  if (loading && !status) {
    return (
      <section aria-busy="true" className="mb-6 rounded-xl border border-slate-800 bg-surface-900 p-4">
        <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 h-3 w-full max-w-xl animate-pulse rounded bg-slate-800" />
        <div className="mt-2 h-3 w-2/3 max-w-md animate-pulse rounded bg-slate-800" />
      </section>
    );
  }

  if (error || !status) {
    return (
      <section className="mb-6 flex flex-col gap-3 rounded-xl border border-red-900/50 bg-red-950/30 p-4 text-sm text-red-300 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" /> {error ?? 'Could not load the permission check'}
        </span>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-red-800/60 px-3 py-1.5 text-xs font-medium text-red-200 hover:bg-red-900/30"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Retry
        </button>
      </section>
    );
  }

  const m = MODE_LABEL[status.mode];
  const progress = Math.min(100, Math.round((status.daysElapsed / status.windowDays) * 100));
  const groupKey = (g: Group) => `${g.capability}|${g.action}|${g.route}`;

  return (
    <section className="mb-6 rounded-xl border border-slate-800 bg-surface-900 p-4" aria-labelledby="dual-run-title">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {status.mode === 'v2' ? (
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
            ) : (
              <ShieldAlert className="h-4 w-4 text-blue-300" />
            )}
            <h2 id="dual-run-title" className="text-base font-semibold text-white">
              Permission enforcement
            </h2>
            <span className={clsx('rounded-full border px-2 py-0.5 text-xs font-medium', m.tone)}>{m.label}</span>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">{m.blurb}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {status.mode === 'dual' && (
            <button
              type="button"
              disabled={!status.eligible}
              onClick={() => setModeDialog('v2')}
              title={status.eligible ? undefined : status.blockers.join(' ')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              <ShieldCheck className="h-4 w-4" /> Enforce new role model
            </button>
          )}
          {status.mode === 'legacy' && (
            <button
              type="button"
              onClick={() => setModeDialog('dual')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600"
            >
              Start side-by-side check
            </button>
          )}
          {status.mode === 'v2' && !status.pendingModeChange && (
            <button
              type="button"
              onClick={() => setModeDialog('dual')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-surface-950"
            >
              <RotateCcw className="h-4 w-4" /> Return to side-by-side
            </button>
          )}
        </div>
      </div>

      {status.pendingModeChange && (
        <PendingModeBanner pending={status.pendingModeChange} onDone={setStatus} />
      )}

      {status.mode === 'dual' && (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-surface-950 p-3">
            <div className="text-xs text-slate-500">Check window</div>
            <div className="mt-1 font-mono text-lg text-white">
              Day {Math.min(status.daysElapsed, status.windowDays)} / {status.windowDays}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Check window progress">
              <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
            </div>
            <div className="mt-1 text-xs text-slate-500">Started {fmtDate(status.dualRunStartedAt)}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-surface-950 p-3">
            <div className="text-xs text-slate-500">Needs review</div>
            <div className={clsx('mt-1 font-mono text-lg', status.totals.unexplained > 0 ? 'text-amber-400' : 'text-white')}>
              {status.totals.unexplained.toLocaleString()}
            </div>
            <div className="mt-1 text-xs text-slate-500">
              {status.totals.explained.toLocaleString()} expected difference{status.totals.explained === 1 ? '' : 's'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-surface-950 p-3">
            <div className="text-xs text-slate-500">Ready to enforce</div>
            {status.eligible ? (
              <div className="mt-1 flex items-center gap-1.5 text-sm text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> Yes
              </div>
            ) : (
              <ul className="mt-1 space-y-0.5 text-xs text-slate-400">
                {status.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="mt-4">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Differences {status.mode === 'dual' ? 'in this check window' : 'in the last 7 days'}
        </h3>
        {status.groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 p-6 text-center text-sm text-slate-500">
            {status.mode === 'legacy'
              ? 'No comparison is running. Start the side-by-side check to see how the new role model would decide.'
              : 'No differences. Both permission models agreed on every check in this window.'}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="min-w-full divide-y divide-slate-800 text-sm">
              <thead className="bg-surface-950 text-left text-xs text-slate-500">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Permission</th>
                  <th scope="col" className="px-3 py-2 font-medium">Where</th>
                  <th scope="col" className="px-3 py-2 font-medium">Difference</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">People</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Checks</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last seen</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {status.groups.map((g) => {
                  const key = `${groupKey(g)}|${g.kind}|${String(g.legacyAllowed)}|${String(g.explained)}`;
                  return (
                    <tr key={key} className="align-top">
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs text-slate-200">{g.capability}</span>
                        <span className="font-mono text-xs text-slate-500">:{g.action}</span>
                      </td>
                      <td className="max-w-[16rem] truncate px-3 py-2 font-mono text-xs text-slate-400" title={g.route}>
                        {g.route}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {g.legacyAllowed === true ? (
                          <span className="text-amber-400">Would lose access</span>
                        ) : g.legacyAllowed === false ? (
                          <span className="text-blue-300">Would gain access</span>
                        ) : (
                          <span className="text-slate-500">Unknown</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{g.members}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs text-slate-300">{g.total.toLocaleString()}</td>
                      <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{fmtDate(g.lastSeen)}</td>
                      <td className="px-3 py-2 text-xs">
                        {g.explained ? (
                          <span className="text-slate-400" title={g.explanation ?? undefined}>
                            <CheckCircle2 className="mr-1 inline h-3.5 w-3.5 text-emerald-500" />
                            {g.explanation ? 'Explained' : KIND_LABEL[g.kind] ?? g.kind}
                          </span>
                        ) : explaining === key ? (
                          <ExplainForm
                            group={g}
                            onCancel={() => setExplaining(null)}
                            onDone={(next) => {
                              setExplaining(null);
                              setStatus(next);
                            }}
                          />
                        ) : (
                          <div className="flex flex-col items-start gap-1">
                            <span className="text-amber-400">{KIND_LABEL[g.kind] ?? g.kind}</span>
                            <button
                              type="button"
                              onClick={() => setExplaining(key)}
                              className="text-emerald-400 underline-offset-2 hover:underline"
                            >
                              Mark as expected
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modeDialog && (
        <ModeDialog
          target={modeDialog}
          onClose={() => setModeDialog(null)}
          onDone={(next) => {
            setModeDialog(null);
            setStatus(next);
          }}
        />
      )}
    </section>
  );
}

function ExplainForm({ group, onCancel, onDone }: { group: Group; onCancel: () => void; onDone: (s: Status) => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = note.trim().length >= 10;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const res = await api.post<{ data: { explained: number; status: Status } }>('/api/settings/access/dual-run', {
      op: 'explain',
      capability: group.capability,
      action: group.action,
      route: group.route,
      note: note.trim(),
    });
    setBusy(false);
    if (res.error) {
      addToast('error', res.error.error || 'Could not save the explanation');
      return;
    }
    addToast('success', `Marked ${res.data!.data.explained} difference${res.data!.data.explained === 1 ? '' : 's'} as expected`);
    onDone(res.data!.data.status);
  };

  return (
    <div className="flex w-64 flex-col gap-1.5">
      <label htmlFor={`explain-${group.capability}-${group.route}`} className="sr-only">
        Why is this difference expected?
      </label>
      <textarea
        id={`explain-${group.capability}-${group.route}`}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        maxLength={1000}
        placeholder="Why is this expected?"
        className="w-full rounded-lg border border-slate-700 bg-surface-950 px-2 py-1.5 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => void submit()}
          className="inline-flex items-center gap-1 rounded-md bg-emerald-500 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400"
        >
          {busy && <Loader2 className="h-3 w-3 animate-spin" />} Save
        </button>
        <button type="button" onClick={onCancel} className="rounded-md px-2 py-1 text-xs text-slate-400 hover:bg-surface-950">
          Cancel
        </button>
      </div>
    </div>
  );
}

const MODE_NAME: Record<string, string> = {
  legacy: 'current permissions only',
  dual: 'the side-by-side check',
  v2: 'the new role model',
};

/** A downgrade waiting for a second tenant admin (wave 2G). The requester can only cancel. */
function PendingModeBanner({ pending, onDone }: { pending: PendingModeChange; onDone: (s: Status) => void }) {
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const act = async (op: 'confirm_mode' | 'cancel_mode') => {
    setBusy(op === 'confirm_mode' ? 'confirm' : 'cancel');
    setErr(null);
    const res = await api.post<{ data: { status: Status } }>('/api/settings/access/dual-run', { op, requestId: pending.id });
    setBusy(null);
    if (res.error) {
      setErr(res.error.error || 'The request was refused');
      return;
    }
    addToast('success', op === 'confirm_mode' ? 'Change confirmed' : 'Request cancelled');
    onDone(res.data!.data.status);
  };
  return (
    <div className="mt-4 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3" role="status">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 text-sm">
          <div className="font-medium text-amber-300">
            Switch back to {MODE_NAME[pending.toMode] ?? pending.toMode} — waiting for a second tenant admin
          </div>
          <p className="mt-1 text-slate-400">
            {pending.mine ? 'You asked for this. ' : 'Another admin asked for this. '}
            Reason: <span className="text-slate-300">{pending.reason}</span>
          </p>
          <p className="mt-0.5 text-xs text-slate-500">Expires {fmtDate(pending.expiresAt)}. The person who asked can’t confirm it.</p>
          {err && <p className="mt-1 text-xs text-red-300" role="alert">{err}</p>}
        </div>
        <div className="flex shrink-0 gap-2">
          {!pending.mine && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act('confirm_mode')}
              className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400"
            >
              {busy === 'confirm' && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
            </button>
          )}
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void act('cancel_mode')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-surface-950 disabled:opacity-50"
          >
            {busy === 'cancel' && <Loader2 className="h-4 w-4 animate-spin" />} Cancel request
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeDialog({ target, onClose, onDone }: { target: Mode; onClose: () => void; onDone: (s: Status) => void }) {
  const [confirmation, setConfirmation] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const enforcing = target === 'v2';
  const valid = reason.trim().length >= 3 && (!enforcing || confirmation === 'ENFORCE');

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErr(null);
    const res = await api.post<{ data: { mode: Mode; outcome: ModeOutcome; status: Status } }>('/api/settings/access/dual-run', {
      op: 'set_mode',
      mode: target,
      confirmation: enforcing ? confirmation : 'confirmed',
      reason: reason.trim(),
    });
    setBusy(false);
    if (res.error) {
      setErr(res.error.error || 'The change was refused');
      return;
    }
    const outcome = res.data!.data.outcome;
    if (outcome?.status === 'pending') {
      addToast('info', 'Sent to another tenant admin to confirm. Nothing changes until they do.');
    } else if (outcome?.status === 'applied' && outcome.singleAdmin) {
      addToast('success', 'Side-by-side check is running. You are the only tenant admin, so your reason was recorded instead of a second confirmation.');
    } else {
      addToast('success', enforcing ? 'The new role model is now enforced' : 'Side-by-side check is running');
    }
    onDone(res.data!.data.status);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mode-dialog-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="w-full max-w-md rounded-xl border border-slate-800 bg-surface-950 p-5">
        <div className="flex items-start justify-between">
          <h3 id="mode-dialog-title" className="text-base font-semibold text-white">
            {enforcing ? 'Enforce the new role model?' : 'Run the side-by-side check?'}
          </h3>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-slate-500 hover:bg-surface-900 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          {enforcing
            ? 'From now on, access is decided by roles, permission sets and client assignments, not the current permissions. You can return to the side-by-side check at any time.'
            : 'Access goes back to the current permissions while both models are compared again. The 7-day window restarts.'}
        </p>
        <div className="mt-4 space-y-3">
          <div>
            <label htmlFor="mode-reason" className="mb-1 block text-xs text-slate-400">
              Reason (recorded in the activity log)
            </label>
            <input
              id="mode-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              autoFocus
              className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
            />
          </div>
          {enforcing && (
            <div>
              <label htmlFor="mode-confirm" className="mb-1 block text-xs text-slate-400">
                Type <span className="font-mono text-slate-200">ENFORCE</span> to confirm
              </label>
              <input
                id="mode-confirm"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value.toUpperCase())}
                autoComplete="off"
                className="w-full rounded-lg border border-slate-700 bg-surface-900 px-3 py-2 font-mono text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          )}
          {err && (
            <div className="flex items-start gap-2 rounded-lg border border-red-900/50 bg-red-950/30 p-2 text-xs text-red-300">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {err}
            </div>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-slate-300 hover:bg-surface-900">
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => void submit()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {enforcing ? 'Enforce' : 'Start check'}
          </button>
        </div>
      </div>
    </div>
  );
}
