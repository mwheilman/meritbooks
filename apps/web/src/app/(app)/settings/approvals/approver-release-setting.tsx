'use client';

/**
 * "Who can release an approved payment" — owner decision (mig 174). Three choices:
 * Off (default) / On, any amount / On, up to an amount the tenant sets. Presentational:
 * the Conflict rules panel owns loading / error, the confirmation dialog and the save
 * call; this component owns the draft choice + amount and its validation.
 */

import { useEffect, useId, useState } from 'react';
import { formatMoney } from '@meritbooks/shared';
import type { ApproverReleasePolicy, TenantType } from '@/lib/rbac/sod';
import {
  APPROVER_RELEASE_OPTIONS,
  centsToInput,
  samePolicy,
  validateApproverReleaseForm,
} from '@/lib/approvals/approver-release-form';

export function currentReleaseSummary(p: ApproverReleasePolicy): string {
  if (p.choice === 'off') return 'Off — a second person releases every payment.';
  if (p.choice === 'any') return 'On — approvers may release payments of any amount.';
  return `On — approvers may release payments up to ${formatMoney(p.maxCents ?? 0)}.`;
}

export function ApproverReleaseSetting({
  value,
  tenantType,
  busy,
  onRequestSave,
}: {
  value: ApproverReleasePolicy;
  tenantType: TenantType;
  busy: boolean;
  /** Called with a validated, changed policy; the parent confirms and saves. */
  onRequestSave: (next: ApproverReleasePolicy) => void;
}) {
  const groupId = useId();
  const [choice, setChoice] = useState(value.choice);
  const [amount, setAmount] = useState(centsToInput(value.maxCents));
  const [touched, setTouched] = useState(false);

  // Re-sync when the saved value changes (after a save / reload).
  useEffect(() => {
    setChoice(value.choice);
    setAmount(centsToInput(value.maxCents));
    setTouched(false);
  }, [value.choice, value.maxCents]);

  const firm = tenantType === 'firm';
  const result = validateApproverReleaseForm(choice, amount);
  const changed = result.ok && !samePolicy(result.policy, value);
  const showError = !result.ok && (touched || amount.trim() !== '');

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (result.ok && changed) onRequestSave(result.policy);
      }}
    >
      <div>
        <div id={`${groupId}-label`} className="text-xs font-medium text-white">Who can release an approved payment</div>
        <div className="text-2xs text-slate-500">
          Currently: {currentReleaseSummary(value)} Whoever prepared a payment can never release it, and payroll always
          needs a second person, whatever you choose here.
          {firm && ' Approvers releasing their own payments isn’t available for firms.'}
        </div>
      </div>

      <div role="radiogroup" aria-labelledby={`${groupId}-label`} className="space-y-2">
        {APPROVER_RELEASE_OPTIONS.map((opt) => {
          const disabled = busy || (firm && opt.value !== 'off');
          const checked = choice === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors ${
                checked ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-white/5 bg-surface-950 hover:border-white/10'
              } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
            >
              <input
                type="radio"
                name={`${groupId}-choice`}
                value={opt.value}
                checked={checked}
                disabled={disabled}
                onChange={() => setChoice(opt.value)}
                className="mt-0.5 h-4 w-4 accent-emerald-500"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs font-medium text-white">{opt.label}</span>
                <span className="block text-2xs text-slate-500">{opt.help}</span>
                {opt.value === 'up_to' && checked && (
                  <span className="mt-2 flex items-center gap-1">
                    <span className="text-xs text-slate-500">$</span>
                    <input
                      inputMode="decimal"
                      aria-label="Most an approver may also release, in dollars"
                      aria-invalid={showError}
                      aria-describedby={showError ? `${groupId}-error` : undefined}
                      placeholder="5,000"
                      value={amount}
                      disabled={busy}
                      onChange={(e) => setAmount(e.target.value)}
                      onBlur={() => setTouched(true)}
                      className="w-40 rounded-md border border-white/10 bg-surface-900 px-2 py-1.5 font-mono text-sm text-white focus:border-emerald-500 focus:outline-none"
                    />
                  </span>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <div className="flex items-center justify-end gap-2">
        {showError && !result.ok && (
          <span id={`${groupId}-error`} role="alert" className="text-2xs text-amber-400">
            {result.error}
          </span>
        )}
        <span className="text-2xs text-slate-500">Allowing more may ask you to verify it’s you first.</span>
        <button
          type="submit"
          disabled={busy || !changed}
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-surface-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
