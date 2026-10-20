'use client';

/**
 * Settings → Security (05-RBAC §3.8, R-7). Tenant authentication policy:
 *   - require two-factor authentication for all staff
 *   - step-up re-verification window for money release / bank-detail changes
 *   - session max age and idle timeout for money release
 *   - IP allowlist (CIDR ranges)
 *
 * Shows what Clerk reports about the admin's OWN session so they can see, before
 * turning a policy on, whether it can actually be verified (on a policy that can't be
 * verified, money release fails closed). Admin-only: GET needs settings_system:view,
 * PUT needs settings_system:edit (403 → read-only notice).
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2, Lock, Plus, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { isValidCidr, type SecurityPolicy } from '@/lib/auth/session-policy';

interface AllowlistDraft { name: string; cidrs: string[] }

interface SecurityResponse {
  available: boolean;
  policy: SecurityPolicy;
  policyOff: boolean;
  allowlists: Array<{ id: string; name: string; cidrs: string[] }>;
  session: { factorVerificationAge: [number, number] | null; secondFactorVerified: boolean | null; clientIp: string | null };
  bounds: {
    stepUpMinutes: { min: number; max: number };
    sessionMaxHours: { min: number; max: number };
    idleTimeoutMinutes: { min: number; max: number };
  };
}

const inputCls = 'w-full px-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white focus:outline-none focus:border-emerald-500/50 disabled:opacity-50';
const labelCls = 'block text-xs text-slate-500 mb-1.5 font-medium';

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 disabled:opacity-50',
        checked ? 'bg-emerald-600' : 'bg-slate-700',
      )}
    >
      <span className={clsx('inline-block h-4 w-4 rounded-full bg-white transition-transform', checked ? 'translate-x-4' : 'translate-x-0.5')} />
    </button>
  );
}

export function SecurityPolicyPanel() {
  const { data, isLoading, error, refetch } = useQuery<SecurityResponse>('/api/settings/security');

  const [policy, setPolicy] = useState<SecurityPolicy | null>(null);
  const [lists, setLists] = useState<AllowlistDraft[]>([]);
  const [newCidr, setNewCidr] = useState<Record<number, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [readOnly, setReadOnly] = useState(false);

  useEffect(() => {
    if (data?.available) {
      setPolicy(data.policy);
      setLists(data.allowlists.map((l) => ({ name: l.name, cidrs: [...l.cidrs] })));
    }
  }, [data]);

  if (isLoading) {
    return (
      <div className="card p-6 flex items-center gap-2 text-sm text-slate-400">
        <Loader2 size={14} className="animate-spin" /> Loading security policy…
      </div>
    );
  }
  if (error || !data) {
    const forbidden = typeof error === 'string' ? /forbidden|403/i.test(error) : false;
    return (
      <div className="card p-6">
        <div className="flex items-start gap-2 text-sm">
          {forbidden ? <Lock size={16} className="mt-0.5 text-slate-500" /> : <AlertTriangle size={16} className="mt-0.5 text-red-400" />}
          <div>
            <p className={forbidden ? 'text-slate-300' : 'text-red-400'}>
              {forbidden ? 'Only workspace administrators can view security settings.' : 'Could not load the security policy.'}
            </p>
            {!forbidden && (
              <button onClick={() => refetch()} className="mt-2 text-xs text-emerald-400 hover:text-emerald-300">Try again</button>
            )}
          </div>
        </div>
      </div>
    );
  }
  if (!data.available || !policy) {
    return (
      <div className="card p-6 text-sm text-amber-300 flex items-start gap-2">
        <AlertTriangle size={16} className="mt-0.5" /> Security policy storage isn’t available yet. Apply migration 167 and reload.
      </div>
    );
  }

  const fva = data.session.factorVerificationAge;
  const verifiable = fva != null;
  const off = !policy.mfa_all_staff && policy.default_step_up_minutes === 0 && policy.session_max_hours == null
    && policy.idle_timeout_minutes == null && !policy.ip_allowlist_enforced;
  const set = <K extends keyof SecurityPolicy>(k: K, v: SecurityPolicy[K]) => setPolicy({ ...policy, [k]: v });
  const b = data.bounds;

  async function save() {
    if (!policy) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/settings/security', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy, allowlists: lists.filter((l) => l.name.trim() || l.cidrs.length) }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; obligation?: string };
      // Relaxing a setting needs a session that meets the CURRENT policy (wave 2G): that
      // refusal carries an obligation (re-verify / sign in again) — it is not read-only.
      if (res.status === 403 && body.obligation) {
        setSaveError(`${body.error ?? 'Verify your identity again to relax this policy.'} Relaxing a security setting requires a session that meets the current policy.`);
        return;
      }
      if (res.status === 403) { setReadOnly(true); setSaveError('You can view but not change security settings.'); return; }
      if (!res.ok) { setSaveError(body.error ?? 'Could not save the security policy.'); return; }
      addToast('success', 'Security policy saved');
      refetch();
    } catch {
      setSaveError('Could not save the security policy.');
    } finally {
      setSaving(false);
    }
  }

  function addCidr(i: number) {
    const v = (newCidr[i] ?? '').trim();
    if (!v) return;
    if (!isValidCidr(v)) { setSaveError(`“${v}” is not a valid IP address or CIDR range.`); return; }
    setSaveError(null);
    setLists(lists.map((l, j) => (j === i ? { ...l, cidrs: l.cidrs.includes(v) ? l.cidrs : [...l.cidrs, v] } : l)));
    setNewCidr({ ...newCidr, [i]: '' });
  }

  return (
    <div className="space-y-4">
      {/* Status */}
      <div className={clsx('card p-4 flex items-start gap-3 border', off ? 'border-amber-500/30 bg-amber-500/5' : 'border-emerald-500/20 bg-emerald-500/5')}>
        {off ? <AlertTriangle size={18} className="mt-0.5 text-amber-400 shrink-0" /> : <ShieldCheck size={18} className="mt-0.5 text-emerald-400 shrink-0" />}
        <div className="text-sm">
          <p className={off ? 'text-amber-300 font-medium' : 'text-emerald-300 font-medium'}>
            {off ? 'No security policy is on' : 'Security policy is on'}
          </p>
          <p className="text-xs text-slate-400 mt-0.5">
            {off
              ? 'Money release, payroll release and vendor bank-detail changes only require a signed-in user with the right role. Turn on step-up verification to require a fresh sign-in check first.'
              : 'Money release, payroll release and vendor bank-detail changes are checked against this policy. If a check can’t be verified, the action is blocked.'}
          </p>
        </div>
      </div>

      {/* Your session */}
      <div className="card p-4">
        <p className="text-xs font-medium text-slate-400 mb-2">Your current session (as reported by sign-in)</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <div>
            <p className="text-slate-500">Last password / first-factor check</p>
            <p className="font-mono text-slate-200">{fva ? (fva[0] >= 0 ? `${fva[0]} min ago` : 'never') : 'not reported'}</p>
          </div>
          <div>
            <p className="text-slate-500">Two-factor</p>
            <p className={clsx('font-mono', fva && fva[1] >= 0 ? 'text-emerald-300' : 'text-slate-200')}>
              {fva ? (fva[1] >= 0 ? `verified ${fva[1]} min ago` : 'not verified this session') : 'not reported'}
            </p>
          </div>
          <div>
            <p className="text-slate-500">Network address</p>
            <p className="font-mono text-slate-200">{data.session.clientIp ?? 'not reported'}</p>
          </div>
        </div>
        {!verifiable && (
          <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-300">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            Sign-in did not report verification times for this session. Turning on two-factor or step-up would block money release until it does.
          </p>
        )}
      </div>

      {/* Policy */}
      <div className="card p-6 space-y-5">
        <h2 className="text-lg font-semibold text-white">Authentication policy</h2>

        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-white">Require two-factor authentication for all staff</p>
            <p className="text-xs text-slate-500">Staff without a verified second factor can’t release money or change bank details.</p>
          </div>
          <Toggle checked={policy.mfa_all_staff} onChange={(v) => set('mfa_all_staff', v)} label="Require two-factor authentication" disabled={readOnly} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={labelCls} htmlFor="sec-stepup">Step-up window (minutes)</label>
            <input
              id="sec-stepup" type="number" className={inputCls} disabled={readOnly}
              min={0} max={b.stepUpMinutes.max}
              value={policy.default_step_up_minutes}
              onChange={(e) => set('default_step_up_minutes', Math.max(0, Math.min(b.stepUpMinutes.max, Math.round(Number(e.target.value) || 0))))}
            />
            <span className="text-[10px] text-slate-600">0 = off. Release needs a re-check within this window.</span>
          </div>
          <div>
            <label className={labelCls} htmlFor="sec-maxh">Max session age (hours)</label>
            <input
              id="sec-maxh" type="number" className={inputCls} disabled={readOnly}
              min={b.sessionMaxHours.min} max={b.sessionMaxHours.max} placeholder="Off"
              value={policy.session_max_hours ?? ''}
              onChange={(e) => set('session_max_hours', e.target.value === '' ? null : Math.max(b.sessionMaxHours.min, Math.min(b.sessionMaxHours.max, Math.round(Number(e.target.value)))))}
            />
            <span className="text-[10px] text-slate-600">Blank = off.</span>
          </div>
          <div>
            <label className={labelCls} htmlFor="sec-idle">Idle timeout (minutes)</label>
            <input
              id="sec-idle" type="number" className={inputCls} disabled={readOnly}
              min={b.idleTimeoutMinutes.min} max={b.idleTimeoutMinutes.max} placeholder="Off"
              value={policy.idle_timeout_minutes ?? ''}
              onChange={(e) => set('idle_timeout_minutes', e.target.value === '' ? null : Math.max(b.idleTimeoutMinutes.min, Math.min(b.idleTimeoutMinutes.max, Math.round(Number(e.target.value)))))}
            />
            <span className="text-[10px] text-slate-600">Blank = off.</span>
          </div>
        </div>
      </div>

      {/* IP allowlist */}
      <div className="card p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-white">IP allowlist</h2>
            <p className="text-xs text-slate-500">When enforced, money release only works from these networks. Your current address must be included.</p>
          </div>
          <Toggle checked={policy.ip_allowlist_enforced} onChange={(v) => set('ip_allowlist_enforced', v)} label="Enforce IP allowlist" disabled={readOnly} />
        </div>

        {lists.length === 0 && <p className="text-xs text-slate-500">No networks yet.</p>}
        {lists.map((l, i) => (
          <div key={i} className="rounded-lg border border-slate-800 bg-surface-950 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <input
                aria-label="Network name" className={inputCls} placeholder="e.g. Office" disabled={readOnly}
                value={l.name} onChange={(e) => setLists(lists.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <button
                type="button" disabled={readOnly} aria-label={`Remove ${l.name || 'network'}`}
                onClick={() => setLists(lists.filter((_, j) => j !== i))}
                className="p-2 text-slate-500 hover:text-red-400 disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {l.cidrs.map((c) => (
                <span key={c} className="inline-flex items-center gap-1 rounded-md bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-200">
                  {c}
                  {!readOnly && (
                    <button type="button" aria-label={`Remove ${c}`} className="text-slate-500 hover:text-red-400"
                      onClick={() => setLists(lists.map((x, j) => (j === i ? { ...x, cidrs: x.cidrs.filter((y) => y !== c) } : x)))}>
                      <X size={11} />
                    </button>
                  )}
                </span>
              ))}
            </div>
            {!readOnly && (
              <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); addCidr(i); }}>
                <input
                  aria-label="Add IP address or CIDR" className={clsx(inputCls, 'font-mono')} placeholder="203.0.113.0/24"
                  value={newCidr[i] ?? ''} onChange={(e) => setNewCidr({ ...newCidr, [i]: e.target.value })}
                />
                <button type="submit" className="flex items-center gap-1 px-3 py-2 rounded-lg text-xs bg-slate-800 text-slate-200 hover:bg-slate-700">
                  <Plus size={12} /> Add
                </button>
              </form>
            )}
          </div>
        ))}
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => setLists([...lists, { name: '', cidrs: [] }])}
              className="flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300">
              <Plus size={12} /> Add network
            </button>
            {data.session.clientIp && (
              <button type="button"
                onClick={() => setLists([...lists, { name: 'My current network', cidrs: [data.session.clientIp as string] }])}
                className="flex items-center gap-1 text-xs text-slate-400 hover:text-white">
                <Plus size={12} /> Add my current address ({data.session.clientIp})
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        {saveError ? <p className="text-xs text-red-400" role="alert">{saveError}</p> : <div />}
        <button
          onClick={() => void save()} disabled={saving || readOnly}
          className={clsx('flex items-center gap-2 px-5 py-2 rounded-lg text-sm font-medium transition-colors',
            saving || readOnly ? 'bg-slate-700 text-slate-500' : 'bg-emerald-600 text-white hover:bg-emerald-500')}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : readOnly ? <Check size={14} /> : <Save size={14} />}
          Save security policy
        </button>
      </div>
    </div>
  );
}
