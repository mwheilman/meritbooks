'use client';

/**
 * Switch the pack on (FPB §9.3; AC 1). The readiness checklist names exactly what's
 * missing — each required account role / department role with a jump link to its
 * row — and the opening tie-out (subledger vs GL per bucket). Enable stays disabled
 * until the server says `canEnable`; the server and a DB trigger re-check anyway.
 */

import { useState } from 'react';
import { clsx } from 'clsx';
import { CheckCircle2, CircleAlert, CircleDashed, Power } from 'lucide-react';
import { invalidateIndustryPacks } from '@/lib/hooks/use-industry-packs';
import type { Readiness } from '@/lib/dealer/service/settings';
import { describeRequirement } from '@/lib/dealer/ui/errors';
import { TIEOUT_BUCKET } from '@/lib/dealer/ui/settings-form';
import { dealerMutate, nameOf, useNames, type DealerApiError } from '../../_lib/use-dealer';
import { ConfirmDialog } from '../../_components/forms';
import { ErrorPanel, Money, Pill, Section } from '../../_components/ui';

export function EnableSection({ readiness, locationId, clientName, onChanged }: { readiness: Readiness; locationId: string; clientName: string | null; onChanged: () => Promise<void> }) {
  const [confirm, setConfirm] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const accounts = useNames('accounts', readiness.tieout.rows.map((r) => r.account_id));

  const missingRoles = readiness.missing.filter((m) => m.startsWith('ROLE:'));
  const missingDepts = readiness.missing.filter((m) => m.startsWith('DEPT:'));
  const requiredRoles = readiness.roles.filter((r) => r.required);
  const tieRows = readiness.tieout.rows.filter((r) => r.subledger_cents !== 0 || r.gl_cents !== 0 || r.difference_cents !== 0);

  async function toggle(enabled: boolean) {
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/settings/enable', locationId, { enabled }, enabled ? 'Dealer pack switched on' : 'Dealer pack switched off');
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return;
    }
    setConfirm(null);
    invalidateIndustryPacks(locationId); // sidebar re-reads on next company render
    await onChanged();
  }

  return (
    <Section
      id="enable"
      className="scroll-mt-6"
      title="Switch the dealer pack on"
      description={`Once on, flooring, unit sales, payoffs and manufacturer claims post to ${clientName ?? 'this client'}’s books.`}
      actions={
        readiness.enabled ? (
          <>
            <Pill label="On" tone="success" />
            <button type="button" className="btn-secondary btn-sm" onClick={() => setConfirm(false)}>
              <Power size={13} /> Switch off
            </button>
          </>
        ) : (
          <>
            <Pill label="Off" tone="neutral" />
            <button type="button" className="btn-primary btn-sm" disabled={!readiness.canEnable} onClick={() => setConfirm(true)} title={readiness.canEnable ? undefined : 'Finish the checklist first'}>
              <Power size={13} /> Switch on
            </button>
          </>
        )
      }
    >
      <ol className="divide-y divide-slate-800/50">
        <Step
          done={missingRoles.length === 0}
          title="Accounts chosen for every required role"
          detail={
            missingRoles.length === 0
              ? `All ${requiredRoles.length} required roles resolve to an account.`
              : `${missingRoles.length} still need an account:`
          }
        >
          {missingRoles.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {missingRoles.map((m) => (
                <li key={m}>
                  <a href={`#role-${m.slice(5)}`} className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-0.5 text-xs text-amber-200 hover:border-amber-400/60">
                    {describeRequirement(m).replace(/^Account for /, '')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Step>
        <Step done={missingDepts.length === 0} title="Departments chosen for the six dealer departments" detail={missingDepts.length === 0 ? 'Every posting line will carry the right department.' : `${missingDepts.length} still need a department:`}>
          {missingDepts.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-2">
              {missingDepts.map((m) => (
                <li key={m}>
                  <a href={`#dept-${m.slice(5)}`} className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-0.5 text-xs text-amber-200 hover:border-amber-400/60">
                    {describeRequirement(m).replace(/^Department for /, '')}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Step>
        <Step
          done={readiness.tieout.ok}
          title="Opening balances tie to the general ledger"
          detail={
            readiness.tieout.ok
              ? tieRows.length
                ? 'The opening floor plan, units and claims match the trial balance to the cent.'
                : 'Nothing loaded yet — there is nothing to tie out. Load opening notes and units first if the dealer already has them.'
              : 'The opening subledgers don’t match the books yet. Post the reconciling entry (or fix the opening import) until every difference is zero.'
          }
        >
          {tieRows.length > 0 && (
            <div className="mt-3 overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-body-sm">
                <caption className="sr-only">Opening tie-out</caption>
                <thead>
                  <tr className="border-b border-slate-800 text-caption uppercase tracking-caps text-slate-500">
                    <th scope="col" className="px-3 py-2 text-left">Balance</th>
                    <th scope="col" className="px-3 py-2 text-left">Account</th>
                    <th scope="col" className="px-3 py-2 text-right">Dealer records</th>
                    <th scope="col" className="px-3 py-2 text-right">General ledger</th>
                    <th scope="col" className="px-3 py-2 text-right">Difference</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/50">
                  {tieRows.map((r) => (
                    <tr key={`${r.bucket}-${r.account_id ?? ''}`}>
                      <td className="px-3 py-2 text-slate-200">
                        {TIEOUT_BUCKET[r.bucket]?.label ?? r.bucket}
                        <span className="block text-2xs text-slate-500">{TIEOUT_BUCKET[r.bucket]?.subledger}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-400">{r.account_id ? nameOf(accounts, r.account_id) : 'Not mapped'}</td>
                      <td className="px-3 py-2 text-right"><Money cents={r.subledger_cents} /></td>
                      <td className="px-3 py-2 text-right"><Money cents={r.gl_cents} /></td>
                      <td className={clsx('px-3 py-2 text-right font-mono tabular-nums', r.difference_cents === 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {r.difference_cents === 0 ? 'Ties' : <Money cents={r.difference_cents} className="text-red-400" />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {readiness.tieout.problems.length > 0 && (
            <ul className="mt-2 space-y-1 text-xs text-red-300">
              {readiness.tieout.problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </Step>
      </ol>
      {error && (
        <div className="px-5 pb-5">
          <ErrorPanel error={error} compact />
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
          setError(null);
        }}
        title={confirm ? 'Switch the dealer pack on?' : 'Switch the dealer pack off?'}
        confirmLabel={confirm ? 'Switch on' : 'Switch off'}
        danger={confirm === false}
        busy={busy}
        body={
          confirm ? (
            <p>Money events start posting for this client: flooring, interest, unit sales and payoffs, warranty and incentive claims. The checks (sold-out-of-trust, curtailments, statement differences) start running.</p>
          ) : (
            <p>Hides the pack and stops its checks for this client; nothing is deleted. Everything already posted stays in the books, and you can switch it back on at any time.</p>
          )
        }
        error={error ? <ErrorPanel error={error} compact /> : null}
        onConfirm={() => toggle(confirm === true)}
      />
    </Section>
  );
}

function Step({ done, title, detail, children }: { done: boolean; title: string; detail: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3 px-5 py-4">
      {done ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-emerald-400" aria-label="Done" /> : children ? <CircleAlert size={16} className="mt-0.5 shrink-0 text-amber-400" aria-label="Needs attention" /> : <CircleDashed size={16} className="mt-0.5 shrink-0 text-slate-500" aria-label="Not done" />}
      <div className="min-w-0 flex-1">
        <p className={clsx('text-sm', done ? 'text-slate-300' : 'text-slate-100')}>{title}</p>
        <p className="mt-0.5 text-xs text-slate-500">{detail}</p>
        {children}
      </div>
    </li>
  );
}
