'use client';

/**
 * Incentive claim drawer (`?claim=<id>` on the Claims tab): the open amount as the
 * hero, the program's treatment in plain English, unit / sale links, the claim
 * deadline flag (DL-7), the money-event timeline and the actions the status allows
 * (submit, record payment, rejected, write off — write-off needs an approver).
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { FileText, Loader2 } from 'lucide-react';
import { DetailDrawer } from '@/components/detail-drawer';
import { INCENTIVE_STATUS, PROGRAM_TYPE, TREATMENT, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import {
  incentiveActions,
  incentiveAging,
  incentiveOpenCents,
  incentiveWriteOffEffect,
  type IncentiveAction,
  type IncentiveClaimRow,
  type OemProgramRecord,
} from '@/lib/dealer/ui/claims';
import { dealerMutate, nameOf, useDealerQuery, useNames, type DealerApiError } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { ConfirmDialog, DateInput, Field, Modal, MoneyInput, TextInput } from '../../_components/forms';
import { DefList, ErrorPanel, Mono, Notice, Pill } from '../../_components/ui';
import { ClaimTimeline } from '../../_components/claims/claim-timeline';
import { SettleDialog } from '../../_components/claims/settle-dialog';

const ACTION_LABEL: Record<IncentiveAction, string> = {
  SUBMIT: 'Submit claim',
  SETTLE: 'Record payment',
  REJECTED_BY_OEM: 'Rejected by manufacturer',
  WRITE_OFF: 'Write off',
};

export function IncentiveDrawer({ claimId, onClose, onChanged }: { claimId: string | null; onClose: () => void; onChanged: () => void }) {
  const { settings, locationId } = useDealerPack();
  const q = useDealerQuery<IncentiveClaimRow>(claimId ? '/api/dealer/record' : null, { kind: 'incentive', id: claimId });
  const c = q.data;
  const prog = useDealerQuery<OemProgramRecord>(c ? '/api/dealer/record' : null, { kind: 'oem_program', id: c?.program_id });
  const p = prog.data;
  const vendors = useNames('vendors', [p?.oem_vendor_id]);
  const units = useNames('units', [c?.unit_id]);
  const [action, setAction] = useState<IncentiveAction | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const manufacturer = p ? vendors.get(p.oem_vendor_id)?.label ?? null : null;

  useEffect(() => {
    setError(null);
    setBusy(false);
  }, [action]);

  function changed() {
    void q.refetch();
    setRefreshKey((k) => k + 1);
    onChanged();
  }

  const open = c ? incentiveOpenCents(c) : 0;
  const actions = c ? incentiveActions(c) : [];
  const aging = c && settings ? incentiveAging(c, settings, todayLocal()) : null;
  const unitStatus = c?.unit_id ? (units.get(c.unit_id)?.meta?.status as string | undefined) : undefined;
  const unitInStock = !!unitStatus && unitStatus !== 'SOLD' && unitStatus !== 'DELIVERED';
  const label = c ? (c.claim_reference ? `Claim ${c.claim_reference}` : p?.name ?? 'Incentive claim') : 'Incentive claim';

  async function resolve(resolution: Record<string, unknown>, ok: string) {
    if (!c || !locationId) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/incentives/resolve', locationId, { claimId: c.id, resolution }, ok);
    setBusy(false);
    if (res.error) return setError(res.error);
    changed();
    setAction(null);
  }

  return (
    <DetailDrawer
      open={!!claimId}
      onClose={() => {
        if (action) return;
        onClose();
      }}
      width="lg"
      title={label}
      subtitle={[p?.name && c?.claim_reference ? p.name : null, manufacturer].filter(Boolean).join(' · ') || null}
      isLoading={q.isLoading && !c}
      error={q.error ? `${explainDealerError(q.error).title}. ${explainDealerError(q.error).message}` : null}
      headerRight={c ? <Pill label={labelOf(INCENTIVE_STATUS, c.status)} tone={toneOf(INCENTIVE_STATUS, c.status)} /> : null}
    >
      {c && locationId && (
        <div className="space-y-6">
          <div>
            <p className="text-caption uppercase tracking-caps text-slate-500">Still owed by the manufacturer</p>
            <p className="mt-1 font-mono text-display tabular-nums text-white">{money(open)}</p>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-400">
              <span>
                Earned <Mono className="text-slate-200">{money(c.accrued_cents)}</Mono>
              </span>
              <span>
                Claimed <Mono className="text-slate-200">{money(c.claimed_cents)}</Mono>
              </span>
              <span>
                Paid <Mono className="text-slate-200">{money(c.settled_cents)}</Mono>
              </span>
              {c.written_off_cents > 0 && (
                <span>
                  Written off <Mono className="text-amber-300">{money(c.written_off_cents)}</Mono>
                </span>
              )}
            </div>
          </div>

          {aging?.flag && <Notice tone={aging.flag.tone === 'danger' ? 'danger' : 'warning'}>{aging.flag.label}.</Notice>}

          {actions.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Claim actions">
              {actions.map((a, i) => (
                <button key={a} type="button" onClick={() => setAction(a)} className={`btn-sm ${i === 0 ? 'btn-primary' : a === 'WRITE_OFF' ? 'btn-danger' : 'btn-secondary'}`} title={a === 'WRITE_OFF' ? 'Needs an approver' : undefined}>
                  {ACTION_LABEL[a]}
                </button>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-surface-950 px-4 py-3 text-xs text-slate-400">
            <p className="text-slate-200">{labelOf(TREATMENT, c.treatment)}</p>
            <p className="mt-0.5">{hintOf(TREATMENT, c.treatment)}</p>
          </div>

          <DefList
            items={[
              { label: 'Program', value: p ? p.name : prog.isLoading ? '…' : '—' },
              { label: 'Program type', value: p ? labelOf(PROGRAM_TYPE, p.program_type) : '—' },
              { label: 'Manufacturer', value: manufacturer ?? '—' },
              { label: 'Claim reference', value: c.claim_reference ?? '—', mono: true },
              {
                label: 'Unit',
                value: c.unit_id ? (
                  <Link href={dealerLinks.unit(c.unit_id)} className="font-mono text-emerald-400 hover:text-emerald-300">
                    {nameOf(units, c.unit_id)}
                  </Link>
                ) : (
                  '—'
                ),
              },
              {
                label: 'Sale',
                value: c.sale_id ? (
                  <Link href={dealerLinks.deal(c.sale_id)} className="text-emerald-400 hover:text-emerald-300">
                    Open the deal
                  </Link>
                ) : (
                  '—'
                ),
              },
              { label: 'Earned', value: dateLabel(c.earned_date), mono: true },
              { label: 'Claim deadline', value: dateLabel(c.claim_deadline), mono: true },
              { label: 'Submitted', value: c.submitted_date ? `${dateLabel(c.submitted_date)}${aging?.daysOutstanding != null ? ` · ${aging.daysOutstanding}d` : ''}` : '—', mono: true },
            ]}
          />

          {c.gl_entry_id && (
            <Link href={dealerLinks.journalEntry(c.gl_entry_id)} className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300">
              <FileText size={12} /> Accrual journal entry
            </Link>
          )}

          <ClaimTimeline kind="INCENTIVE" claimId={c.id} refreshKey={refreshKey} />

          <SubmitIncentiveDialog open={action === 'SUBMIT'} onClose={() => setAction(null)} claim={c} locationId={locationId} onDone={changed} />
          <SettleDialog
            open={action === 'SETTLE'}
            onClose={() => setAction(null)}
            kind="incentive"
            claimId={c.id}
            claimLabel={label}
            openCents={open}
            defaultMethod={settings?.oem_settlement_default ?? 'STATEMENT_CREDIT'}
            manufacturer={manufacturer}
            locationId={locationId}
            onDone={changed}
          />
          <ConfirmDialog
            open={action === 'REJECTED_BY_OEM'}
            onClose={() => setAction(null)}
            title="Record a manufacturer rejection"
            confirmLabel="Mark rejected"
            busy={busy}
            date={{ label: 'Rejected on', initial: todayLocal() }}
            reason={{ label: 'Rejection reason', required: true, placeholder: 'As the manufacturer stated it' }}
            body={<p>Marks the claim rejected. Nothing posts — the {money(open)} stays in the incentive receivable until you resubmit it or write it off.</p>}
            error={error ? <ErrorPanel error={error} compact /> : null}
            onConfirm={({ date, reason }) => resolve({ action: 'REJECTED_BY_OEM', date, reason }, 'Rejection recorded')}
          />
          <ConfirmDialog
            open={action === 'WRITE_OFF'}
            onClose={() => setAction(null)}
            title={`Write off ${money(open)}?`}
            confirmLabel="Write off"
            danger
            busy={busy}
            date={{ label: 'Date', initial: todayLocal() }}
            reason={{ label: 'Why (optional)', placeholder: 'e.g. program closed before we claimed' }}
            body={
              <div className="space-y-2">
                <p className="text-slate-200">{incentiveWriteOffEffect({ targetRole: c.accrual_target_role, openCents: open, unitInStock })}</p>
                <p className="text-xs text-slate-500">This needs an approver. If you don’t have approval rights you’ll be told before anything posts.</p>
              </div>
            }
            error={error ? <ErrorPanel error={error} compact /> : null}
            onConfirm={({ date, reason }) => resolve({ action: 'WRITE_OFF', date, note: reason || null }, 'Incentive written off')}
          />
        </div>
      )}
    </DetailDrawer>
  );
}

function SubmitIncentiveDialog({ open, onClose, claim, locationId, onDone }: { open: boolean; onClose: () => void; claim: IncentiveClaimRow; locationId: string; onDone: () => void }) {
  const [date, setDate] = useState(todayLocal());
  const [amount, setAmount] = useState<number | null>(claim.accrued_cents);
  const [ref, setRef] = useState(claim.claim_reference ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setDate(todayLocal());
    setAmount(claim.claimed_cents > 0 ? claim.claimed_cents : claim.accrued_cents);
    setRef(claim.claim_reference ?? '');
    setError(null);
  }, [open, claim.accrued_cents, claim.claimed_cents, claim.claim_reference]);

  const late = claim.claim_deadline && date > claim.claim_deadline;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && amount !== null && amount > 0;

  async function submit() {
    if (!valid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/incentives/submit', locationId, { claimId: claim.id, submittedDate: date, claimedCents: amount, claimReference: ref.trim() || null }, claim.status === 'REJECTED' ? 'Claim resubmitted' : 'Claim submitted');
    setBusy(false);
    if (res.error) return setError(res.error);
    onDone();
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      width="sm"
      title={claim.status === 'REJECTED' ? 'Resubmit the claim' : 'Submit the claim'}
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm" disabled={!valid || busy} onClick={() => void submit()}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            Submit {amount ? money(amount) : ''}
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm text-slate-300">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Submitted on" htmlFor={`${id}-d`} required error={late ? 'After the claim deadline — the manufacturer may refuse it.' : null}>
            <DateInput id={`${id}-d`} value={date} onChange={setDate} />
          </Field>
          <Field label="Amount claimed" htmlFor={`${id}-a`} required hint={`Earned ${money(claim.accrued_cents)}`}>
            <MoneyInput id={`${id}-a`} cents={amount} onChange={setAmount} />
          </Field>
        </div>
        <Field label="Claim reference" htmlFor={`${id}-r`} hint="The manufacturer’s number — statement credits are matched by it">
          <TextInput id={`${id}-r`} value={ref} onChange={setRef} maxLength={100} className="font-mono" />
        </Field>
        <p className="rounded-lg border border-slate-800 bg-surface-950 px-3 py-2 text-xs">
          <span className="font-medium text-slate-200">What this posts: </span>
          Nothing — the receivable was booked when the incentive was earned. This records the claim and starts the unpaid-aging clock.
        </p>
        {error && <ErrorPanel error={error} compact />}
      </div>
    </Modal>
  );
}
