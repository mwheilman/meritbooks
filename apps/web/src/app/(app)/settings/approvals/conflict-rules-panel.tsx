'use client';

/**
 * ConflictRulesPanel — 05 §6.10 A10 "Conflict rules" (the UI name for separation of duties).
 *
 *   1. Always-on safeguards   platform-locked transaction rules (preparer ≠ approver ≠
 *                             releaser, …) — shown, never editable.
 *   2. Access combinations    platform rules (warn or block) + the tenant's own rules.
 *                             Platform rules can be made to BLOCK, never turned off;
 *                             tenant rules can be added, turned off/on, and deleted-by-off.
 *   3. Allowed conflicts      open exceptions with reason, safeguard and expiry; removable.
 *   4. Settings               who can release an approved payment (Q1 + mig 174: off / any
 *                             amount / up to a limit) + journal-entry self-post amount (Q4).
 *
 * Plain English only — rule codes never appear. All writes go through
 * /api/approvals/conflict-rules* (apiHandler + settings_system:edit); destructive actions
 * confirm first.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { formatMoney } from '@meritbooks/shared';
import { addToast } from '@/hooks/use-toast';
import { EmptyState, Skeleton } from '@/components/ui';
import { CAPABILITIES } from '@/lib/rbac/capabilities';
import { capabilityPhrase } from '@/lib/approvals/step-label';
import type { ConflictRulesView, ConflictRuleView, AllowedConflictView } from '@/lib/rbac/sod-admin';
import type { ApproverReleasePolicy } from '@/lib/rbac/sod';
import { approverReleaseConfirmation } from '@/lib/approvals/approver-release-form';
import { ApproverReleaseSetting } from './approver-release-setting';
import { JE_SELF_POST_RULE_KEY, jeSelfPostCopy } from '@/lib/rbac/je-post-sod-copy';

type Pending =
  | { kind: 'disable'; rule: ConflictRuleView }
  | { kind: 'revoke'; item: AllowedConflictView }
  | { kind: 'release'; next: ApproverReleasePolicy }
  | null;

/** Every grantable books/core permission, as "approve bills"-style options. */
const PERMISSION_OPTIONS: Array<{ value: string; label: string }> = CAPABILITIES.filter(
  (c) => c.status === 'active' && c.module !== 'platform',
)
  .flatMap((c) => c.actions.filter((a) => a !== 'view').map((a) => `${c.key}:${a}`))
  .map((ref) => ({ value: ref, label: capabilityPhrase(ref) }))
  .sort((a, b) => a.label.localeCompare(b.label));

const JE_STATUS_CLS: Record<'pos' | 'warn' | 'default', string> = {
  pos: 'bg-emerald-500/10 text-emerald-300',
  warn: 'bg-amber-500/10 text-amber-300',
  default: 'bg-white/5 text-slate-400',
};

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function daysLeft(iso: string): number {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

async function send(url: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown): Promise<void> {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
    throw new Error(j.error ?? `HTTP ${res.status}`);
  }
}

export function ConflictRulesPanel() {
  const [view, setView] = useState<ConflictRulesView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending>(null);

  // New-rule form
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [blocks, setBlocks] = useState(false);
  // Settings form
  const [threshold, setThreshold] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/approvals/conflict-rules');
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      const json = (await res.json()) as ConflictRulesView;
      setView(json);
      setThreshold(String(json.settings.jeSelfPostThresholdCents / 100));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load conflict rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      addToast('success', ok);
      await load();
    } catch (e) {
      addToast('error', e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const locked = useMemo(() => (view?.rules ?? []).filter((r) => r.kind === 'always'), [view]);
  const combos = useMemo(() => (view?.rules ?? []).filter((r) => r.kind !== 'always'), [view]);

  if (loading && !view) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading conflict rules">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (error && !view) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-4 text-xs text-red-300">
        {error}{' '}
        <button type="button" onClick={() => void load()} className="ml-2 underline hover:text-red-200">
          Try again
        </button>
      </div>
    );
  }
  if (!view) return null;

  const thresholdCents = Math.round(Number(threshold) * 100);
  const thresholdValid = threshold.trim() !== '' && Number.isFinite(Number(threshold)) && Number(threshold) >= 0;
  // One accurate description of the JE self-post rule for both places it appears (1G-6).
  const jeCopy = jeSelfPostCopy(view.settings.accessMode ?? null, formatMoney(view.settings.jeSelfPostThresholdCents));
  const thresholdChanged = thresholdValid && thresholdCents !== view.settings.jeSelfPostThresholdCents;
  const canAdd = first !== '' && second !== '' && first !== second;

  return (
    <div className="space-y-6">
      {/* 1. Always-on safeguards */}
      <section className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <div className="flex items-center gap-2">
          <Lock className="h-4 w-4 text-emerald-400" aria-hidden />
          <h2 className="text-sm font-semibold text-white">Always-on safeguards</h2>
        </div>
        <p className="mt-1 text-xs text-slate-400">Checked on every item. These can’t be turned off.</p>
        <ul className="mt-3 space-y-2">
          {locked.map((r) => (
            <li key={r.id} className="rounded-lg border border-white/5 bg-surface-950 px-3 py-2">
              <div className="text-xs font-medium text-white">
                {r.description}
                {r.key === JE_SELF_POST_RULE_KEY && (
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-2xs ${JE_STATUS_CLS[jeCopy.tone]}`}>{jeCopy.status}</span>
                )}
              </div>
              {r.key === JE_SELF_POST_RULE_KEY && <div className="mt-0.5 text-2xs text-slate-400">{jeCopy.detail}</div>}
              {r.suggestedFix && <div className="mt-0.5 text-2xs text-slate-500">{r.suggestedFix}</div>}
            </li>
          ))}
        </ul>
      </section>

      {/* 2. Access combinations */}
      <section className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden />
          <h2 className="text-sm font-semibold text-white">Risky access combinations</h2>
        </div>
        <p className="mt-1 text-xs text-slate-400">
          Checked whenever someone is given access. <span className="text-amber-300">Needs a reason</span> means the
          person can still get it, with a written reason that shows up in every access review.{' '}
          <span className="text-red-300">Blocks</span> means nobody can hold both.
        </p>
        <ul className="mt-3 divide-y divide-white/5">
          {combos.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className={r.status === 'disabled' ? 'opacity-50' : ''}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-white">{r.description}</span>
                  {r.kind === 'per_item' ? (
                    <span className="rounded bg-blue-500/10 px-1.5 py-0.5 text-2xs text-blue-300">Checked per item</span>
                  ) : r.enforcement === 'hard' ? (
                    <span className="rounded bg-red-500/10 px-1.5 py-0.5 text-2xs text-red-300">Blocks</span>
                  ) : (
                    <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-2xs text-amber-300">Needs a reason</span>
                  )}
                  {r.owner === 'tenant' && (
                    <span className="rounded bg-white/5 px-1.5 py-0.5 text-2xs text-slate-400">Your rule</span>
                  )}
                  {r.status === 'disabled' && <span className="text-2xs text-slate-500">Off</span>}
                </div>
                {r.suggestedFix && <div className="mt-0.5 text-2xs text-slate-500">Fix: {r.suggestedFix}</div>}
              </div>
              <div className="flex shrink-0 gap-2">
                {(r.canPromote || r.owner === 'tenant') && r.kind === 'access' && r.status === 'active' && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      run(
                        () => send('/api/approvals/conflict-rules', 'PATCH', { ruleId: r.id, blocks: r.enforcement !== 'hard' }),
                        r.enforcement === 'hard' ? 'Rule now needs a reason.' : 'Rule now blocks.',
                      )
                    }
                    className="rounded-lg border border-white/10 px-2.5 py-1 text-2xs text-slate-300 hover:border-emerald-500/40 hover:text-white disabled:opacity-40"
                  >
                    {r.enforcement === 'hard' ? 'Allow with a reason' : 'Make it block'}
                  </button>
                )}
                {r.canDisable &&
                  (r.status === 'active' ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPending({ kind: 'disable', rule: r })}
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-2xs text-slate-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
                    >
                      Turn off
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        run(() => send('/api/approvals/conflict-rules', 'PATCH', { ruleId: r.id, status: 'active' }), 'Rule turned on.')
                      }
                      className="rounded-lg border border-white/10 px-2.5 py-1 text-2xs text-slate-300 hover:border-emerald-500/40 hover:text-white disabled:opacity-40"
                    >
                      Turn on
                    </button>
                  ))}
                {r.owner === 'platform' && r.kind === 'access' && !r.canPromote && r.enforcement === 'hard' && (
                  <span className="self-center text-2xs text-slate-500">Set by MeritBooks</span>
                )}
              </div>
            </li>
          ))}
        </ul>

        {/* Add a tenant rule */}
        <form
          className="mt-4 rounded-lg border border-white/5 bg-surface-950 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAdd) return;
            void run(async () => {
              await send('/api/approvals/conflict-rules', 'POST', {
                first,
                second,
                enforcement: blocks ? 'hard' : 'soft',
              });
              setFirst('');
              setSecond('');
              setBlocks(false);
            }, 'Rule added.');
          }}
        >
          <div className="text-xs font-medium text-white">Add your own rule</div>
          <div className="mt-2 grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
            <label className="block">
              <span className="text-2xs text-slate-500">Nobody should be able to</span>
              <select
                value={first}
                onChange={(e) => setFirst(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Choose…</option>
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <span className="pb-2 text-center text-2xs text-slate-500">and also</span>
            <label className="block">
              <span className="sr-only">Second permission</span>
              <select
                value={second}
                onChange={(e) => setSecond(e.target.value)}
                className="mt-1 w-full rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="">Choose…</option>
                {PERMISSION_OPTIONS.filter((o) => o.value !== first).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-2xs text-slate-400">
              <input
                type="checkbox"
                checked={blocks}
                onChange={(e) => setBlocks(e.target.checked)}
                className="h-4 w-4 rounded border-white/20 bg-surface-900 text-emerald-500"
              />
              Block it outright (otherwise it needs a reason)
            </label>
            <button
              type="submit"
              disabled={busy || !canAdd}
              className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-surface-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add rule
            </button>
            {first && second && first === second && <span className="text-2xs text-amber-400">Pick two different permissions.</span>}
          </div>
        </form>
      </section>

      {/* 3. Allowed conflicts */}
      <section className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-300" aria-hidden />
          <h2 className="text-sm font-semibold text-white">Allowed conflicts</h2>
        </div>
        <p className="mt-1 text-xs text-slate-400">People who hold a risky combination on purpose, and why.</p>
        {view.allowedConflicts.length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No allowed conflicts"
            description="Nobody currently holds a risky combination with a written reason."
            className="mt-3"
          />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-2xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Person</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Can</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Reason and safeguard</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Ends</th>
                  <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {view.allowedConflicts.map((a) => {
                  const left = daysLeft(a.expiresAt);
                  return (
                    <tr key={a.id} className="align-top text-slate-300">
                      <td className="py-2 pr-3">
                        <div className="font-medium text-white">{a.personName}</div>
                        <div className="text-2xs text-slate-500">{a.clientName ?? 'Every client'}</div>
                      </td>
                      <td className="py-2 pr-3">{a.description}</td>
                      <td className="py-2 pr-3">
                        <div>{a.justification}</div>
                        {a.compensatingControl && <div className="mt-0.5 text-2xs text-slate-500">Safeguard: {a.compensatingControl}</div>}
                        <div className="mt-0.5 text-2xs text-slate-500">Allowed by {a.approvedByName}</div>
                      </td>
                      <td className="whitespace-nowrap py-2 pr-3">
                        <div className="font-mono">{fmtDate(a.expiresAt)}</div>
                        <div className={`text-2xs ${left <= 30 ? 'text-amber-400' : 'text-slate-500'}`}>
                          {left <= 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`}
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setPending({ kind: 'revoke', item: a })}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-2xs text-slate-300 hover:border-red-500/40 hover:text-red-300 disabled:opacity-40"
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. Settings */}
      <section className="rounded-xl border border-white/5 bg-surface-900 p-5">
        <h2 className="text-sm font-semibold text-white">Settings</h2>
        <div className="mt-3 space-y-4">
          <ApproverReleaseSetting
            value={view.settings.approverRelease}
            tenantType={view.settings.tenantType}
            busy={busy}
            onRequestSave={(next) => setPending({ kind: 'release', next })}
          />
          <div className="border-t border-white/5" />
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"
            onSubmit={(e) => {
              e.preventDefault();
              if (!thresholdChanged) return;
              void run(
                () => send('/api/approvals/conflict-rules/settings', 'PATCH', { jeSelfPostThresholdCents: thresholdCents }),
                'Journal entry limit saved.',
              );
            }}
          >
            <label className="block">
              <span className="text-xs font-medium text-white">Journal entries that need a second person to post</span>
              <span className="block text-2xs text-slate-500">
                Currently {formatMoney(view.settings.jeSelfPostThresholdCents)} ·{' '}
                <span className={`rounded px-1 text-2xs ${JE_STATUS_CLS[jeCopy.tone]}`}>{jeCopy.status}</span>. {jeCopy.detail}
              </span>
              <span className="mt-1 flex items-center gap-1">
                <span className="text-xs text-slate-500">$</span>
                <input
                  inputMode="decimal"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  aria-invalid={!thresholdValid}
                  className="w-40 rounded-md border border-white/10 bg-surface-950 px-2 py-1.5 font-mono text-sm text-white focus:border-emerald-500 focus:outline-none"
                />
              </span>
            </label>
            <div className="flex items-center gap-2">
              {!thresholdValid && <span className="text-2xs text-amber-400">Enter an amount of $0 or more.</span>}
              <button
                type="submit"
                disabled={busy || !thresholdChanged}
                className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-surface-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save
              </button>
            </div>
          </form>
        </div>
      </section>

      {pending && (
        <ConfirmDialog
          title={
            pending.kind === 'disable'
              ? 'Turn off this rule?'
              : pending.kind === 'revoke'
                ? 'Remove this allowed conflict?'
                : approverReleaseConfirmation(pending.next, formatMoney).title
          }
          body={
            pending.kind === 'disable'
              ? `People will no longer be warned when they get access to both: ${pending.rule.description}`
              : pending.kind === 'revoke'
                ? `${pending.item.personName} will show as an open conflict in access review until one of the two permissions is removed.`
                : approverReleaseConfirmation(pending.next, formatMoney).body
          }
          confirmLabel={
            pending.kind === 'release'
              ? approverReleaseConfirmation(pending.next, formatMoney).confirmLabel
              : pending.kind === 'revoke'
                ? 'Remove'
                : 'Turn off'
          }
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            if (pending.kind === 'disable') {
              void run(() => send('/api/approvals/conflict-rules', 'PATCH', { ruleId: pending.rule.id, status: 'disabled' }), 'Rule turned off.');
            } else if (pending.kind === 'revoke') {
              void run(() => send('/api/approvals/conflict-rules/allowed', 'DELETE', { exceptionId: pending.item.id }), 'Allowed conflict removed.');
            } else {
              const next = pending.next;
              void run(
                () =>
                  send('/api/approvals/conflict-rules/settings', 'PATCH', {
                    approverRelease: next.choice === 'up_to' ? { choice: 'up_to', maxCents: next.maxCents } : { choice: next.choice },
                  }),
                next.choice === 'off'
                  ? 'A second person now releases every payment.'
                  : next.choice === 'any'
                    ? 'Approvers may now release their own payments.'
                    : `Approvers may now release payments up to ${formatMoney(next.maxCents ?? 0)}.`,
              );
            }
          }}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sod-confirm-title"
        aria-describedby="sod-confirm-body"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-xl border border-white/10 bg-surface-900 p-5 shadow-xl"
      >
        <h3 id="sod-confirm-title" className="text-sm font-semibold text-white">{title}</h3>
        <p id="sod-confirm-body" className="mt-2 text-xs text-slate-300">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-400 disabled:opacity-40"
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
