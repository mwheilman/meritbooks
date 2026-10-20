'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { api } from '@/lib/api-client';
import { addToast } from '@/hooks';
import { CAPABILITY_BY_KEY, type Action } from '@/lib/rbac/capabilities';
import { actionVerb, capabilityLabel } from '@/lib/access-governance/describe';
import { AccessDialog } from './dialog';

/**
 * <RequestAccess /> — "Request access" button + form (05-RBAC-SPEC §6.11). Reusable anywhere a
 * feature is hidden or refused: pass the capability (and actions) the screen needs and the
 * client in context, and the form arrives pre-filled. With no capability it asks for a
 * client, a role or a permission set instead.
 *
 * The request is routed to everyone who could grant it (tenant admins + the delegation
 * ceiling); the requester follows it under Settings → Access → Requests.
 */

export interface RequestAccessProps {
  /** Capability key, e.g. 'ap.bills'. */
  capability?: string;
  /** Actions needed; default view. */
  actions?: Action[];
  /** Client (location) in context. */
  clientId?: string | null;
  /** Ask for a specific role instead of a capability. */
  roleId?: string;
  label?: string;
  variant?: 'primary' | 'secondary' | 'link';
  className?: string;
  onRequested?: (requestId: string) => void;
}

type Kind = 'capability' | 'role' | 'permission_set' | 'client';

interface Directory {
  clients: Array<{ id: string; name: string }>;
  roles: Array<{ id: string; name: string; description: string | null; locationId: string | null }>;
  permissionSets: Array<{ id: string; name: string; description: string | null }>;
}

const DURATIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'No end date' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

export function RequestAccess({
  capability,
  actions,
  clientId = null,
  roleId,
  label = 'Request access',
  variant = 'primary',
  className,
  onRequested,
}: RequestAccessProps) {
  const fixedKind: Kind | null = capability ? 'capability' : roleId ? 'role' : null;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>(fixedKind ?? 'client');
  const [dir, setDir] = useState<Directory | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Action[]>(actions?.length ? actions : ['view']);
  const [client, setClient] = useState<string>(clientId ?? '');
  const [role, setRole] = useState<string>(roleId ?? '');
  const [set, setSet] = useState<string>('');
  const [duration, setDuration] = useState<string>('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<{ id: string; routedCount: number } | null>(null);

  const capDef = capability ? CAPABILITY_BY_KEY.get(capability) : undefined;
  const capActions = useMemo<Action[]>(() => (capDef ? [...capDef.actions] : []), [capDef]);

  const reset = useCallback(() => {
    setKind(fixedKind ?? 'client');
    setPicked(actions?.length ? actions : ['view']);
    setClient(clientId ?? '');
    setRole(roleId ?? '');
    setSet('');
    setDuration('');
    setReason('');
    setErrors({});
    setSent(null);
  }, [fixedKind, actions, clientId, roleId]);

  useEffect(() => {
    if (!open || dir) return;
    let cancelled = false;
    api.get<{ data: Directory }>('/api/access/directory').then((res) => {
      if (cancelled) return;
      if (res.error) setDirError(res.error.error);
      else setDir(res.data!.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, dir]);

  const submit = async () => {
    const e: Record<string, string> = {};
    if (reason.trim().length < 3) e.reason = 'Tell the approver why (a few words).';
    if (kind === 'capability' && picked.length === 0) e.actions = 'Pick at least one thing you need to do.';
    if (kind === 'client' && !client) e.client = 'Pick a client.';
    if (kind === 'role' && !role) e.role = 'Pick a role.';
    if (kind === 'permission_set' && !set) e.set = 'Pick a permission set.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setBusy(true);
    const res = await api.post<{ data: { id: string; routedCount: number } }>('/api/access/requests', {
      kind,
      capability: kind === 'capability' ? capability : undefined,
      actions: kind === 'capability' ? picked : undefined,
      roleId: kind === 'role' ? role : undefined,
      permissionSetId: kind === 'permission_set' ? set : undefined,
      locationId: client || undefined,
      durationDays: duration ? Number(duration) : null,
      reason: reason.trim(),
    });
    setBusy(false);
    if (res.error) {
      const details = res.error.details ?? {};
      const fieldErrors: Record<string, string> = {};
      for (const [k, v] of Object.entries(details)) fieldErrors[k === 'locationId' ? 'client' : k] = v[0];
      setErrors(fieldErrors);
      addToast('error', res.error.error || 'Could not send the request');
      return;
    }
    setSent(res.data!.data);
    onRequested?.(res.data!.data.id);
  };

  const buttonClass =
    variant === 'link'
      ? 'inline-flex items-center gap-1.5 text-sm font-medium text-emerald-400 hover:text-emerald-300 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 rounded'
      : clsx(variant === 'primary' ? 'btn-primary' : 'btn-secondary', 'btn-sm');

  return (
    <>
      <button
        type="button"
        className={clsx(buttonClass, className)}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden />
        {label}
      </button>

      <AccessDialog
        open={open}
        onClose={() => setOpen(false)}
        title={sent ? 'Request sent' : 'Request access'}
        description={
          sent ? undefined : 'Your request goes to the people who can grant it. Nothing changes until one of them approves.'
        }
        footer={
          sent ? (
            <>
              <Link href="/settings/access/requests" className="btn-secondary btn-sm">
                See my requests
              </Link>
              <button type="button" className="btn-primary btn-sm" onClick={() => setOpen(false)}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={submit}>
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                Send request
              </button>
            </>
          )
        }
      >
        {sent ? (
          <div className="flex items-start gap-3">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" aria-hidden />
            <p className="text-sm text-slate-300">
              {sent.routedCount > 0
                ? `${sent.routedCount} ${sent.routedCount === 1 ? 'person' : 'people'} who can grant this will see your request. You'll find its status under Access requests.`
                : 'Your workspace admins will see your request. You’ll find its status under Access requests.'}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {dirError && <p className="text-sm text-red-400">{dirError}</p>}

            {!fixedKind && (
              <fieldset>
                <legend className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">What do you need?</legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(
                    [
                      ['client', 'Access to a client'],
                      ['role', 'A role'],
                      ['permission_set', 'Extra permission'],
                    ] as const
                  ).map(([k, l]) => (
                    <label
                      key={k}
                      className={clsx(
                        'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
                        kind === k ? 'border-emerald-500/60 bg-emerald-500/10 text-white' : 'border-slate-700 text-slate-300 hover:border-slate-600',
                      )}
                    >
                      <input type="radio" name="request-kind" className="accent-emerald-500" checked={kind === k} onChange={() => setKind(k)} />
                      {l}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {kind === 'capability' && capability && (
              <fieldset>
                <legend className="mb-2 text-sm text-slate-300">
                  <span className="font-medium text-white">{capabilityLabel(capability)}</span>
                  {capDef?.description ? <span className="text-slate-500"> — {capDef.description}</span> : null}
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {capActions.map((a) => (
                    <label key={a} className="inline-flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        className="accent-emerald-500"
                        checked={picked.includes(a)}
                        onChange={(ev) => setPicked((p) => (ev.target.checked ? [...p, a] : p.filter((x) => x !== a)))}
                      />
                      {actionVerb(a)}
                    </label>
                  ))}
                </div>
                {errors.actions && <p className="mt-1 text-xs text-red-400">{errors.actions}</p>}
              </fieldset>
            )}

            {kind === 'role' && (
              <label className="block">
                <span className="mb-1 block text-sm text-slate-300">Role</span>
                <select className={errors.role ? 'input-error' : 'input'} value={role} onChange={(e) => setRole(e.target.value)} disabled={!!roleId}>
                  <option value="">Pick a role…</option>
                  {(dir?.roles ?? []).filter((r) => !r.locationId || r.locationId === client).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                {errors.role && <span className="mt-1 block text-xs text-red-400">{errors.role}</span>}
              </label>
            )}

            {kind === 'permission_set' && (
              <label className="block">
                <span className="mb-1 block text-sm text-slate-300">Permission</span>
                <select className={errors.set ? 'input-error' : 'input'} value={set} onChange={(e) => setSet(e.target.value)}>
                  <option value="">Pick one…</option>
                  {(dir?.permissionSets ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {errors.set && <span className="mt-1 block text-xs text-red-400">{errors.set}</span>}
              </label>
            )}

            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">{kind === 'client' ? 'Client' : 'Where'}</span>
              <select className={errors.client ? 'input-error' : 'input'} value={client} onChange={(e) => setClient(e.target.value)}>
                {kind !== 'client' && <option value="">Every client</option>}
                {kind === 'client' && <option value="">Pick a client…</option>}
                {(dir?.clients ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {!dir && clientId && <option value={clientId}>This client</option>}
              </select>
              {errors.client && <span className="mt-1 block text-xs text-red-400">{errors.client}</span>}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">For how long</span>
              <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
                {DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </select>
              <span className="mt-1 block text-xs text-slate-500">Short, time-boxed access is approved faster and ends on its own.</span>
            </label>

            <label className="block">
              <span className="mb-1 block text-sm text-slate-300">Why do you need it?</span>
              <textarea
                className={errors.reason ? 'input-error' : 'input'}
                rows={3}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Covering Dana's clients while she's out this week"
              />
              {errors.reason && <span className="mt-1 block text-xs text-red-400">{errors.reason}</span>}
            </label>
          </div>
        )}
      </AccessDialog>
    </>
  );
}
