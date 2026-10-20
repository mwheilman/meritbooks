'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Inbox, KeyRound, Loader2, ShieldAlert, XCircle } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { AccessDialog } from '@/components/access/dialog';
import { RequestAccess } from '@/components/access/request-access';
import type { AccessRequestView, RequestStatus } from '@/lib/access-governance/types';

interface Payload {
  mine: AccessRequestView[];
  inbox: AccessRequestView[];
  recent: AccessRequestView[];
}
interface Directory {
  roles: Array<{ id: string; name: string; locationId: string | null }>;
}

const STATUS: Record<RequestStatus, { label: string; cls: string }> = {
  pending: { label: 'Waiting', cls: 'badge-info' },
  approved: { label: 'Approved', cls: 'badge-success' },
  denied: { label: 'Declined', cls: 'badge-danger' },
  expired: { label: 'Expired', cls: 'badge-neutral' },
  cancelled: { label: 'Withdrawn', cls: 'badge-neutral' },
};

function ago(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${Math.max(mins, 1)} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

type Decision = 'approve' | 'deny' | 'confirm';

export function AccessRequestsClient() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roles, setRoles] = useState<Directory['roles']>([]);
  const [target, setTarget] = useState<{ req: AccessRequestView; decision: Decision } | null>(null);
  const [note, setNote] = useState('');
  const [roleId, setRoleId] = useState('');
  const [duration, setDuration] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await api.get<{ data: Payload }>('/api/access/requests');
    if (res.error) {
      setError(res.error.error || 'Could not load access requests');
      setData({ mine: [], inbox: [], recent: [] });
      return;
    }
    setData(res.data!.data);
  }, []);

  useEffect(() => {
    void load();
    api.get<{ data: Directory }>('/api/access/directory').then((res) => {
      if (res.data) setRoles(res.data.data.roles);
    });
  }, [load]);

  const openDecision = (req: AccessRequestView, decision: Decision) => {
    setNote('');
    setRoleId(req.roleId ?? '');
    setDuration(req.durationDays ? String(req.durationDays) : '');
    setTarget({ req, decision });
  };

  const submit = async () => {
    if (!target) return;
    if (target.decision === 'deny' && !note.trim()) {
      addToast('error', 'Tell them why.');
      return;
    }
    if (target.decision === 'approve' && target.req.kind === 'client' && !roleId) {
      addToast('error', 'Pick the role to grant on this client.');
      return;
    }
    setBusy(true);
    const res = await api.post<{ data: { status?: string; needs_second_approval?: boolean } }>('/api/access/requests/decide', {
      requestId: target.req.id,
      decision: target.decision,
      note: note.trim() || undefined,
      roleId: target.decision === 'approve' && target.req.kind === 'client' ? roleId : undefined,
      durationDays: target.decision === 'approve' && duration ? Number(duration) : undefined,
    });
    setBusy(false);
    if (res.error) {
      addToast('error', res.error.error || 'Could not save the decision');
      return;
    }
    const d = res.data!.data;
    addToast(
      'success',
      target.decision === 'deny'
        ? 'Declined.'
        : d.needs_second_approval
          ? 'Approved. Because this access is high-risk, a second person who can grant it must confirm before it starts.'
          : target.decision === 'confirm'
            ? 'Confirmed. The access is active now.'
            : 'Approved. The access is active now.',
    );
    setTarget(null);
    await load();
  };

  const withdraw = async (req: AccessRequestView) => {
    if (!confirm('Withdraw this request?')) return;
    const res = await api.post('/api/access/requests/cancel', { requestId: req.id });
    if (res.error) {
      addToast('error', res.error.error || 'Could not withdraw');
      return;
    }
    addToast('success', 'Request withdrawn.');
    await load();
  };

  if (data === null) return <TableSkeleton rows={6} />;

  return (
    <div className="space-y-8">
      {error && (
        <div className="card flex items-center gap-3 p-4 text-sm text-red-400" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden /> {error}
          <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => void load()}>
            Try again
          </button>
        </div>
      )}

      <section aria-labelledby="inbox-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="inbox-h" className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            To decide {data.inbox.length > 0 && <span className="ml-1 font-mono text-emerald-400">{data.inbox.length}</span>}
          </h2>
        </div>
        {data.inbox.length === 0 ? (
          <div className="card">
            <EmptyState icon={Inbox} title="No requests waiting for you" description="When someone asks for access you're able to grant, it shows up here." />
          </div>
        ) : (
          <ul className="space-y-2">
            {data.inbox.map((r) => (
              <li key={r.id} className="card flex flex-col gap-3 p-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <div className="text-sm text-white">
                    <span className="font-semibold">{r.requesterName}</span> <span className="text-slate-400">asks for</span> {r.what}
                  </div>
                  <p className="mt-1 text-sm text-slate-400">“{r.reason}”</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {ago(r.createdAt)}
                    {r.awaitingSecondApproval && (
                      <span className="ml-2 inline-flex items-center gap-1 text-amber-400">
                        <ShieldAlert className="h-3 w-3" aria-hidden /> Approved by {r.decidedByName ?? 'someone'} — needs a second approver
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {r.awaitingSecondApproval ? (
                    <button type="button" className="btn-primary btn-sm" onClick={() => openDecision(r, 'confirm')}>
                      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Confirm
                    </button>
                  ) : (
                    <>
                      <button type="button" className="btn-primary btn-sm" onClick={() => openDecision(r, 'approve')}>
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Approve
                      </button>
                      <button type="button" className="btn-danger btn-sm" onClick={() => openDecision(r, 'deny')}>
                        <XCircle className="h-3.5 w-3.5" aria-hidden /> Decline
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="mine-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="mine-h" className="text-sm font-semibold uppercase tracking-wide text-slate-400">
            My requests
          </h2>
          <RequestAccess label="New request" variant="secondary" onRequested={() => void load()} />
        </div>
        {data.mine.length === 0 ? (
          <div className="card">
            <EmptyState icon={KeyRound} title="You haven't asked for any access" description="Need to see or do something you can't? Request it here and the right person will be asked." />
          </div>
        ) : (
          <ul className="card divide-y divide-slate-800">
            {data.mine.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm text-white">{r.what}</div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    Asked {ago(r.createdAt)}
                    {r.decidedByName ? ` · ${STATUS[r.status].label.toLowerCase()} by ${r.decidedByName}` : ''}
                    {r.decisionNote ? ` · “${r.decisionNote}”` : ''}
                    {r.status === 'pending' ? ` · ${r.routedCount} ${r.routedCount === 1 ? 'person' : 'people'} can decide` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className={clsx(r.awaitingSecondApproval ? 'badge-warning' : STATUS[r.status].cls)}>
                    {r.awaitingSecondApproval ? 'Waiting for a second approver' : STATUS[r.status].label}
                  </span>
                  {r.status === 'pending' && (
                    <button type="button" className="btn-ghost btn-sm" onClick={() => void withdraw(r)}>
                      Withdraw
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.recent.length > 0 && (
        <section aria-labelledby="recent-h">
          <h2 id="recent-h" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
            Recently decided
          </h2>
          <ul className="card divide-y divide-slate-800">
            {data.recent.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <span className="min-w-0 truncate text-slate-300">
                  <span className="text-white">{r.requesterName}</span> · {r.what}
                </span>
                <span className={STATUS[r.status].cls}>{STATUS[r.status].label}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <AccessDialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target?.decision === 'deny' ? 'Decline this request?' : target?.decision === 'confirm' ? 'Confirm as second approver?' : 'Approve this request?'}
        description={target ? `${target.req.requesterName} · ${target.req.what}` : undefined}
        footer={
          <>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setTarget(null)}>
              Cancel
            </button>
            <button type="button" className={target?.decision === 'deny' ? 'btn-danger btn-sm' : 'btn-primary btn-sm'} disabled={busy} onClick={submit}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {target?.decision === 'deny' ? 'Decline' : target?.decision === 'confirm' ? 'Confirm' : 'Approve'}
            </button>
          </>
        }
      >
        <div className="space-y-4">
          {target?.decision === 'approve' && target.req.kind === 'client' && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Role on {target.req.locationName ?? 'this client'}</span>
              <select className="input" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                <option value="">Pick a role…</option>
                {roles
                  .filter((r) => !r.locationId || r.locationId === target.req.locationId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </label>
          )}
          {target?.decision === 'approve' && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Ends after</span>
              <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
                <option value="">{target.req.durationDays ? `${target.req.durationDays} days (as asked)` : 'No end date'}</option>
                {[1, 7, 30, 90].map((d) => (
                  <option key={d} value={String(d)}>
                    {d} day{d === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
          )}
          {target?.decision !== 'confirm' && (
            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">{target?.decision === 'deny' ? 'Why (they will see this)' : 'Note (optional)'}</span>
              <textarea className="input" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          )}
          <p className="text-xs text-slate-500">
            You can only grant what you hold yourself, on clients you can access. Approvals and declines are recorded in the access log.
          </p>
        </div>
      </AccessDialog>
    </div>
  );
}
