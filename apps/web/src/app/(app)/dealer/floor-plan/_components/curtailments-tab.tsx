'use client';

/**
 * Curtailments (DL-2): scheduled principal pay-downs by due date. Due within the
 * client's warning window is amber, missed / past due is red. Pay one, pay several
 * at once, or waive (approver, with a reason). Paying reduces the loan only — the
 * unit's cost doesn't change.
 */

import { useMemo, useState } from 'react';
import { CalendarCheck, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import { CURTAILMENT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { money, todayLocal } from '@/lib/dealer/ui/format';
import { addToast } from '@/hooks/use-toast';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import { dealerSend, nameOf, useDealerList, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { ConfirmDialog } from '../../_components/forms';
import { Money, Notice, Pill, Section } from '../../_components/ui';
import { curtailmentUrgency } from '../_lib/queues';
import { invalidateNoteRefs, useNoteRefs } from '../_lib/hooks';
import type { FpCurtailment } from '../_lib/types';
import { DueDate, NoteLink, UnitLink } from './bits';
import { PayCurtailmentDialog, WaiveCurtailmentDialog, type NoteLabel } from './money-dialogs';

type Seg = 'DUE' | 'MISSED' | 'PAID' | 'WAIVED' | '';
const SEGS: Array<{ value: Seg; label: string }> = [
  { value: 'DUE', label: 'Due' },
  { value: 'MISSED', label: 'Missed' },
  { value: 'PAID', label: 'Paid' },
  { value: 'WAIVED', label: 'Waived' },
  { value: '', label: 'All' },
];

export function CurtailmentsTab({ initialStatus, onChanged }: { initialStatus: string | null; onChanged: () => void }) {
  const { settings, locationId } = useDealerPack();
  const initial = (SEGS.find((s) => s.value === initialStatus)?.value ?? 'DUE') as Seg;
  const list = useDealerList<FpCurtailment>('/api/dealer/curtailments', { sort: 'due_date', dir: 'asc', filters: initial ? { status: initial } : {} });
  const rows = list.data?.rows ?? [];
  const [refVersion, setRefVersion] = useState(0);
  const { refs } = useNoteRefs(rows.map((r) => r.note_id), refVersion);
  const lines = useNames('lines', [...refs.values()].map((n) => n.line_id));
  const today = todayLocal();
  const warn = settings?.curtailment_warn_days ?? 7;
  const enabled = settings?.enabled === true;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pay, setPay] = useState<FpCurtailment | null>(null);
  const [waive, setWaive] = useState<FpCurtailment | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

  const payable = rows.filter((r) => r.status === 'DUE' || r.status === 'MISSED');
  const chosen = payable.filter((r) => selected.has(r.id));
  const chosenCents = chosen.reduce((s, r) => s + r.amount_cents, 0);
  const soon = payable.filter((r) => curtailmentUrgency(r, today, warn) === 'soon');
  const late = payable.filter((r) => ['missed', 'overdue'].includes(curtailmentUrgency(r, today, warn)));

  function done() {
    setSelected(new Set());
    invalidateNoteRefs();
    setRefVersion((v) => v + 1);
    void list.refetch();
    onChanged();
  }

  function labelFor(c: FpCurtailment | null): NoteLabel | null {
    if (!c) return null;
    const n = refs.get(c.note_id);
    return { noteId: c.note_id, invoice: n?.lender_invoice_number ?? null, serial: n?.serial_number ?? null, balanceCents: n?.principal_balance_cents ?? null };
  }

  async function payBatch(paidDate: string) {
    if (!locationId) return;
    setBatchBusy(true);
    let ok = 0;
    const failures: string[] = [];
    for (const c of chosen) {
      const res = await dealerSend('post', '/api/dealer/curtailments/pay', locationId, { curtailmentId: c.id, paidDate });
      if (res.error) failures.push(`${refs.get(c.note_id)?.lender_invoice_number ?? 'A note'}: ${explainDealerError(res.error).message}`);
      else ok += 1;
    }
    setBatchBusy(false);
    setBatchOpen(false);
    if (ok) addToast('success', `${ok} curtailment${ok === 1 ? '' : 's'} paid and posted`);
    if (failures.length) addToast('error', `${failures.length} not paid. ${failures.slice(0, 3).join(' · ')}`);
    done();
  }

  const allChosen = payable.length > 0 && payable.every((r) => selected.has(r.id));
  const columns: DealerColumn<FpCurtailment>[] = [
    {
      key: 'sel',
      header: '',
      className: 'w-8',
      render: (r) =>
        r.status === 'DUE' || r.status === 'MISSED' ? (
          <input
            type="checkbox"
            aria-label={`Select curtailment due ${r.due_date}`}
            checked={selected.has(r.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) =>
              setSelected((s) => {
                const n = new Set(s);
                if (e.target.checked) n.add(r.id);
                else n.delete(r.id);
                return n;
              })
            }
            className="h-3.5 w-3.5 rounded border-slate-600 bg-slate-800 accent-emerald-500"
          />
        ) : null,
    },
    {
      key: 'due',
      header: 'Due',
      sortKey: 'due_date',
      render: (r) => <DueDate date={r.due_date} today={today} warnDays={warn} pastIsBad={r.status === 'DUE' || r.status === 'MISSED'} muted={r.status === 'PAID' || r.status === 'WAIVED'} />,
    },
    { key: 'note', header: 'Note', render: (r) => <NoteLink noteId={r.note_id} invoice={refs.get(r.note_id)?.lender_invoice_number} /> },
    { key: 'unit', header: 'Unit', render: (r) => <UnitLink unitId={refs.get(r.note_id)?.unit_id} serial={refs.get(r.note_id)?.serial_number} /> },
    { key: 'line', header: 'Line', render: (r) => <span className="text-slate-300">{nameOf(lines, refs.get(r.note_id)?.line_id)}</span> },
    { key: 'seq', header: 'Step', align: 'right', render: (r) => <span className="font-mono tabular-nums text-slate-400">#{r.sequence}</span> },
    { key: 'amt', header: 'Amount', sortKey: 'amount_cents', align: 'right', render: (r) => <Money cents={r.amount_cents} /> },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (r) => {
        const u = curtailmentUrgency(r, today, warn);
        if (r.status === 'DUE' && u === 'overdue') return <Pill label="Past due" tone="danger" />;
        return <Pill label={labelOf(CURTAILMENT_STATUS, r.status)} tone={toneOf(CURTAILMENT_STATUS, r.status)} title={r.waived_reason ?? undefined} />;
      },
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (r) =>
        r.status === 'DUE' || r.status === 'MISSED' ? (
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={!enabled}
              title={enabled ? undefined : 'Switch the dealer pack on to record payments'}
              onClick={(e) => {
                e.stopPropagation();
                setPay(r);
              }}
            >
              Pay
            </button>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={(e) => {
                e.stopPropagation();
                setWaive(r);
              }}
            >
              Waive
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      {late.length > 0 && (
        <Notice tone="danger">
          {late.length} curtailment{late.length === 1 ? ' is' : 's are'} past due — <span className="font-mono tabular-nums">{money(late.reduce((s, r) => s + r.amount_cents, 0))}</span>. Lenders
          treat a missed curtailment like a missed payment.
        </Notice>
      )}
      {soon.length > 0 && (
        <Notice tone="warning">
          {soon.length} due in the next {warn} day{warn === 1 ? '' : 's'} — <span className="font-mono tabular-nums">{money(soon.reduce((s, r) => s + r.amount_cents, 0))}</span>.
        </Notice>
      )}
      <Section
        title="Curtailments"
        description="Scheduled pay-downs the lender requires as a unit ages. Paying one reduces the loan; the unit’s cost doesn’t change."
        actions={
          chosen.length > 0 ? (
            <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!enabled || batchBusy} onClick={() => setBatchOpen(true)}>
              {batchBusy && <Loader2 size={13} className="animate-spin" />}
              Pay {chosen.length} selected · <span className="font-mono tabular-nums">{money(chosenCents)}</span>
            </button>
          ) : undefined
        }
      >
        <TableToolbar>
          <Segments<Seg>
            label="Curtailment status"
            value={(list.state.filters.status ?? '') as Seg}
            onChange={(v) => {
              setSelected(new Set());
              list.setFilter('status', v || null);
            }}
            options={SEGS}
          />
          {payable.length > 0 && (
            <button
              type="button"
              className={clsx('btn-ghost btn-sm', allChosen && 'text-emerald-400')}
              onClick={() => setSelected(allChosen ? new Set() : new Set(payable.map((r) => r.id)))}
            >
              {allChosen ? 'Clear selection' : `Select all ${payable.length} on this page`}
            </button>
          )}
        </TableToolbar>
        <DealerTable<FpCurtailment>
          caption="Curtailments"
          columns={columns}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          sort={list.state.sort}
          dir={list.state.dir}
          onSort={list.setSort}
          keyboard={false}
          rowClassName={(r) => {
            const u = curtailmentUrgency(r, today, warn);
            return u === 'missed' || u === 'overdue' ? 'bg-red-500/[0.05]' : u === 'soon' ? 'bg-amber-500/[0.04]' : undefined;
          }}
          page={list.data?.page}
          perPage={list.data?.perPage}
          total={list.data?.total}
          noun="curtailments"
          onPageChange={list.setPage}
          empty={{
            icon: CalendarCheck,
            title: list.state.filters.status === 'DUE' ? 'No curtailments due' : 'No curtailments here',
            description: 'Curtailments are created when a unit is floored on a program with a curtailment schedule.',
          }}
        />
      </Section>

      {locationId && (
        <>
          <PayCurtailmentDialog
            open={!!pay}
            onClose={() => setPay(null)}
            locationId={locationId}
            curtailmentId={pay?.id ?? null}
            amountCents={pay?.amount_cents ?? null}
            note={labelFor(pay)}
            onDone={done}
          />
          <WaiveCurtailmentDialog open={!!waive} onClose={() => setWaive(null)} locationId={locationId} curtailmentId={waive?.id ?? null} amountCents={waive?.amount_cents ?? null} onDone={done} />
          <ConfirmDialog
            open={batchOpen}
            onClose={() => setBatchOpen(false)}
            title={`Pay ${chosen.length} curtailment${chosen.length === 1 ? '' : 's'}`}
            confirmLabel="Record payments"
            busy={batchBusy}
            date={{ label: 'Date paid', initial: today }}
            body={
              <>
                <p>
                  Records <span className="font-mono tabular-nums text-white">{money(chosenCents)}</span> of curtailment payments — one entry per note: debit the floor-plan payable, credit the
                  operating bank.
                </p>
                <p className="mt-2 text-slate-400">This reduces the loans; unit costs don’t change.</p>
              </>
            }
            onConfirm={({ date }) => payBatch(date)}
          />
        </>
      )}
    </div>
  );
}

