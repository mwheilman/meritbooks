'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, CalendarClock, ClipboardCheck, Loader2, Plus } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { EmptyState, TableSkeleton } from '@/components/ui';
import { AccessDialog } from '@/components/access/dialog';
import type { AccessReview } from '@/lib/access-governance/types';
import { ReviewDetail } from './review-detail';

interface Directory {
  me: { membershipId: string; isTenantAdmin: boolean; canStartReviews: boolean };
  clients: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string; locationId: string | null }>;
  people: Array<{ membershipId: string; name: string }>;
}

function dueLabel(r: AccessReview): { text: string; overdue: boolean } {
  if (r.status === 'closed') return { text: `Closed ${new Date(r.closedAt ?? r.dueAt).toLocaleDateString()}`, overdue: false };
  const days = Math.ceil((new Date(r.dueAt).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { text: `Overdue by ${-days} day${days === -1 ? '' : 's'}`, overdue: true };
  if (days === 0) return { text: 'Due today', overdue: false };
  return { text: `Due ${new Date(r.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${days} day${days === 1 ? '' : 's'}`, overdue: false };
}

function defaultName(): string {
  const d = new Date();
  return `Q${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()} access review`;
}

function isoDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function AccessReviewsClient() {
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get('review');

  const [reviews, setReviews] = useState<AccessReview[] | null>(null);
  const [dir, setDir] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showStart, setShowStart] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    const res = await api.get<{ data: { reviews: AccessReview[] } }>('/api/access/reviews');
    if (res.error) {
      setError(res.error.error || 'Could not load access reviews');
      setReviews([]);
      return;
    }
    setReviews(res.data!.data.reviews);
  }, []);

  useEffect(() => {
    void load();
    api.get<{ data: Directory }>('/api/access/directory').then((res) => {
      if (res.data) setDir(res.data.data);
    });
  }, [load]);

  const select = (id: string | null) => router.push(id ? `/settings/access/reviews?review=${id}` : '/settings/access/reviews');

  const current = reviews?.find((r) => r.id === selected) ?? null;
  if (selected && reviews && current) {
    return (
      <ReviewDetail
        review={current}
        canClose={!!dir?.me.canStartReviews}
        onBack={() => select(null)}
        onChanged={load}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-400">
          Reviewers see only the access they're asked to confirm. Nobody reviews their own access.
        </p>
        {dir?.me.canStartReviews && (
          <button type="button" className="btn-primary btn-sm" onClick={() => setShowStart(true)}>
            <Plus className="h-3.5 w-3.5" aria-hidden /> Start a review
          </button>
        )}
      </div>

      {reviews === null ? (
        <TableSkeleton rows={4} />
      ) : error ? (
        <div className="card flex items-center gap-3 p-4 text-sm text-red-400" role="alert">
          <AlertCircle className="h-4 w-4" aria-hidden />
          {error}
          <button type="button" className="btn-secondary btn-sm ml-auto" onClick={() => void load()}>
            Try again
          </button>
        </div>
      ) : reviews.length === 0 ? (
        <div className="card">
          <EmptyState
            icon={ClipboardCheck}
            title="No access reviews yet"
            description={
              dir?.me.canStartReviews
                ? 'A quarterly review is how auditors expect you to prove access is still right. Start one for everyone, one client or one role.'
                : 'When someone asks you to confirm access, it shows up here.'
            }
            action={dir?.me.canStartReviews ? { label: 'Start a review', onClick: () => setShowStart(true) } : undefined}
          />
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {reviews.map((r) => {
            const due = dueLabel(r);
            const pct = r.progress.total ? Math.round((r.progress.decided / r.progress.total) * 100) : 0;
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => select(r.id)}
                  className="card-hover w-full p-4 text-left focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white">{r.name}</div>
                      <div className="mt-0.5 text-xs text-slate-500">{r.scopeLabel}</div>
                    </div>
                    <span className={clsx(r.status === 'closed' ? 'badge-neutral' : due.overdue ? 'badge-danger' : 'badge-info')}>
                      {r.status === 'closed' ? 'Closed' : 'Open'}
                    </span>
                  </div>
                  <div className="mt-3 confidence-bar" aria-hidden>
                    <div className="confidence-fill bg-emerald-500" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="font-mono text-slate-300">
                      {r.progress.decided} of {r.progress.total} decided
                    </span>
                    {r.progress.mineUndecided > 0 && <span className="text-amber-400">{r.progress.mineUndecided} waiting for you</span>}
                    <span className={clsx('ml-auto inline-flex items-center gap-1', due.overdue ? 'text-red-400' : 'text-slate-500')}>
                      <CalendarClock className="h-3 w-3" aria-hidden /> {due.text}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {showStart && dir && (
        <StartReviewDialog
          dir={dir}
          onClose={() => setShowStart(false)}
          onStarted={async (id) => {
            setShowStart(false);
            await load();
            select(id);
          }}
        />
      )}
    </div>
  );
}

function StartReviewDialog({ dir, onClose, onStarted }: { dir: Directory; onClose: () => void; onStarted: (id: string) => void }) {
  const [name, setName] = useState(defaultName());
  const [scopeKind, setScopeKind] = useState<'all' | 'client' | 'role'>('all');
  const [locationId, setLocationId] = useState('');
  const [roleId, setRoleId] = useState('');
  const [due, setDue] = useState(isoDay(14));
  const [reviewer, setReviewer] = useState('');
  const [autoRevoke, setAutoRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const e: Record<string, string> = {};
    if (!name.trim()) e.name = 'Name the review.';
    if (scopeKind === 'client' && !locationId) e.locationId = 'Pick a client.';
    if (scopeKind === 'role' && !roleId) e.roleId = 'Pick a role.';
    if (!due || new Date(`${due}T23:59:59`).getTime() <= Date.now()) e.dueAt = 'Pick a due date in the future.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await api.post<{ data: { id: string } }>('/api/access/reviews', {
      name: name.trim(),
      scopeKind,
      locationId: scopeKind === 'client' ? locationId : undefined,
      roleId: scopeKind === 'role' ? roleId : undefined,
      dueAt: new Date(`${due}T23:59:59`).toISOString(),
      reviewerMembershipId: reviewer || undefined,
      autoRevokeUnreviewed: autoRevoke,
    });
    setBusy(false);
    if (res.error) {
      const d = res.error.details ?? {};
      setErrors(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v[0]])));
      addToast('error', res.error.error || 'Could not start the review');
      return;
    }
    addToast('success', 'Review started. Reviewers can begin now.');
    onStarted(res.data!.data.id);
  };

  return (
    <AccessDialog
      open
      onClose={onClose}
      title="Start an access review"
      description="Everyone's current access in scope becomes a list for reviewers to keep, reduce or revoke."
      footer={
        <>
          <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={submit}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Start review
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-sm text-slate-300">Name</span>
          <input className={errors.name ? 'input-error' : 'input'} value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          {errors.name && <span className="mt-1 block text-xs text-red-400">{errors.name}</span>}
        </label>
        <fieldset>
          <legend className="mb-2 text-sm text-slate-300">Who's in scope</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ['all', 'Everyone'],
                ['client', 'One client'],
                ['role', 'One role'],
              ] as const
            ).map(([k, l]) => (
              <label
                key={k}
                className={clsx(
                  'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                  scopeKind === k ? 'border-emerald-500/60 bg-emerald-500/10 text-white' : 'border-slate-700 text-slate-300',
                )}
              >
                <input type="radio" name="scope" className="accent-emerald-500" checked={scopeKind === k} onChange={() => setScopeKind(k)} />
                {l}
              </label>
            ))}
          </div>
        </fieldset>
        {scopeKind === 'client' && (
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Client</span>
            <select className={errors.locationId ? 'input-error' : 'input'} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Pick a client…</option>
              {dir.clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">Includes people with all-clients access, since it covers this client.</span>
            {errors.locationId && <span className="mt-1 block text-xs text-red-400">{errors.locationId}</span>}
          </label>
        )}
        {scopeKind === 'role' && (
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Role</span>
            <select className={errors.roleId ? 'input-error' : 'input'} value={roleId} onChange={(e) => setRoleId(e.target.value)}>
              <option value="">Pick a role…</option>
              {dir.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
            {errors.roleId && <span className="mt-1 block text-xs text-red-400">{errors.roleId}</span>}
          </label>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Due</span>
            <input type="date" className={errors.dueAt ? 'input-error' : 'input'} value={due} min={isoDay(1)} onChange={(e) => setDue(e.target.value)} />
            {errors.dueAt && <span className="mt-1 block text-xs text-red-400">{errors.dueAt}</span>}
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-slate-300">Reviewer</span>
            <select className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">Whoever granted it (default)</option>
              {dir.people.map((p) => (
                <option key={p.membershipId} value={p.membershipId}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-300">
          <input type="checkbox" className="mt-0.5 accent-emerald-500" checked={autoRevoke} onChange={(e) => setAutoRevoke(e.target.checked)} />
          <span>
            Revoke anything nobody reviewed when the review is closed
            <span className="block text-xs text-slate-500">Off by default. Turn on for strict audits.</span>
          </span>
        </label>
      </div>
    </AccessDialog>
  );
}
