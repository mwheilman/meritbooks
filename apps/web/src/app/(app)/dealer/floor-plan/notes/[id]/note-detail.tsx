'use client';

/**
 * Floor-plan note page: header (lender invoice #, unit, line, program, status,
 * original vs balance, floored / free-floor / maturity / payoff dates, how the sale
 * was detected), the money-event timeline with journal-entry links, the curtailment
 * schedule with Pay / Waive, and the note's actions (propose payoff, pay down).
 */

import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, CalendarCheck, History } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import type { CurtailmentStatus, FloorTxnType, RowStatus } from '@/lib/dealer/types';
import { COLLATERAL, CURTAILMENT_STATUS, NOTE_STATUS, ROW_STATUS, SOLD_DETECTED_BY, TXN_TYPE, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, daysBetween, money, todayLocal } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { nameOf, useDealerQuery, useNames } from '../../../_lib/use-dealer';
import { useDealerPack } from '../../../_components/dealer-shell';
import { DealerTable, type DealerColumn } from '../../../_components/dealer-table';
import { DefList, ErrorPanel, Money, Notice, Pill, Section } from '../../../_components/ui';
import { actorLabel, useMe } from '../../_lib/hooks';
import { curtailmentUrgency } from '../../_lib/queues';
import type { FpNote, FpTxn } from '../../_lib/types';
import { DueDate, JeLink, UnitLink } from '../../_components/bits';
import { AdHocCurtailmentDialog, PayCurtailmentDialog, ProposePayoffDialog, ReleasePayoffDialog, WaiveCurtailmentDialog, type NoteLabel } from '../../_components/money-dialogs';

interface Curt {
  id: string;
  sequence: number;
  due_date: string;
  amount_cents: number;
  status: CurtailmentStatus;
  paid_txn_id: string | null;
}

interface Detail {
  note: FpNote;
  transactions: FpTxn[];
  curtailments: Curt[];
}

const LIVE = new Set(['OPEN', 'SOLD_UNPAID', 'IN_DEFAULT']);

export function NoteDetailView({ id }: { id: string }) {
  const { settings, locationId } = useDealerPack();
  const me = useMe();
  const q = useDealerQuery<Detail>('/api/dealer/notes/detail', { id });
  const note = q.data?.note ?? null;
  const units = useNames('units', [note?.unit_id]);
  const lines = useNames('lines', [note?.line_id]);
  const programs = useNames('programs', [note?.program_id]);
  const today = todayLocal();
  const warn = settings?.curtailment_warn_days ?? 7;
  const enabled = settings?.enabled === true;

  const [pay, setPay] = useState<Curt | null>(null);
  const [waive, setWaive] = useState<Curt | null>(null);
  const [propose, setPropose] = useState(false);
  const [release, setRelease] = useState<FpTxn | null>(null);
  const [adhoc, setAdhoc] = useState(false);

  if (q.error) {
    return (
      <div>
        <BackLink />
        <div className="card">
          <ErrorPanel error={q.error} onRetry={q.refetch} />
        </div>
      </div>
    );
  }

  if (!note) {
    return (
      <div>
        <BackLink />
        <div className="mb-6 h-8 w-64 animate-pulse rounded bg-slate-800" />
        <div className="card mb-6 grid grid-cols-2 gap-6 p-6 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <div className="h-2.5 w-16 animate-pulse rounded bg-slate-800" />
              <div className="h-4 w-24 animate-pulse rounded bg-slate-800" />
            </div>
          ))}
        </div>
        <div className="card h-48 animate-pulse" />
      </div>
    );
  }

  const serial = note.unit_id ? units.get(note.unit_id)?.label ?? null : null;
  const label: NoteLabel = { noteId: note.id, invoice: note.lender_invoice_number, serial, balanceCents: note.principal_balance_cents };
  const txns = q.data?.transactions ?? [];
  const curts = q.data?.curtailments ?? [];
  const proposedPayoff = txns.find((t) => t.txn_type === 'PAYOFF' && t.status === 'PROPOSED') ?? null;
  const live = LIVE.has(note.status);
  const matDays = daysBetween(today, note.maturity_date);
  const paidDown = note.original_principal_cents - note.principal_balance_cents;
  const refresh = () => void q.refetch();

  const txnCols: DealerColumn<FpTxn>[] = [
    { key: 'date', header: 'Date', render: (t) => <span className="font-mono tabular-nums text-slate-300">{dateLabel(t.txn_date)}</span> },
    { key: 'type', header: 'What happened', render: (t) => <span className="text-slate-200">{labelOf(TXN_TYPE, t.txn_type as FloorTxnType)}</span> },
    { key: 'p', header: 'Principal', align: 'right', render: (t) => (t.principal_cents ? <Money cents={t.principal_cents} /> : <span className="text-slate-500">—</span>) },
    { key: 'i', header: 'Interest', align: 'right', render: (t) => (t.interest_cents ? <Money cents={t.interest_cents} /> : <span className="text-slate-500">—</span>) },
    { key: 'f', header: 'Fee', align: 'right', render: (t) => (t.fee_cents ? <Money cents={t.fee_cents} /> : <span className="text-slate-500">—</span>) },
    { key: 's', header: 'Status', render: (t) => <Pill label={labelOf(ROW_STATUS, t.status as RowStatus)} tone={toneOf(ROW_STATUS, t.status as RowStatus)} /> },
    {
      key: 'who',
      header: 'By',
      render: (t) => (
        <span className="text-xs text-slate-400">
          {t.txn_type === 'PAYOFF' && t.released_by ? `Proposed: ${actorLabel(t.proposed_by, me)} · Released: ${actorLabel(t.released_by, me)}` : actorLabel(t.proposed_by, me)}
        </span>
      ),
    },
    { key: 'memo', header: 'Memo', render: (t) => <span className="block max-w-[260px] truncate text-xs text-slate-400" title={t.memo ?? undefined}>{t.memo ?? '—'}</span> },
    { key: 'je', header: '', align: 'right', render: (t) => <JeLink glEntryId={t.gl_entry_id} /> },
  ];

  const curtCols: DealerColumn<Curt>[] = [
    { key: 'seq', header: 'Step', render: (c) => <span className="font-mono tabular-nums text-slate-400">#{c.sequence}</span> },
    { key: 'due', header: 'Due', render: (c) => <DueDate date={c.due_date} today={today} warnDays={warn} pastIsBad={c.status === 'DUE' || c.status === 'MISSED'} muted={c.status === 'PAID' || c.status === 'WAIVED'} /> },
    { key: 'amt', header: 'Amount', align: 'right', render: (c) => <Money cents={c.amount_cents} /> },
    {
      key: 'st',
      header: 'Status',
      render: (c) =>
        c.status === 'DUE' && curtailmentUrgency(c, today, warn) === 'overdue' ? <Pill label="Past due" tone="danger" /> : <Pill label={labelOf(CURTAILMENT_STATUS, c.status)} tone={toneOf(CURTAILMENT_STATUS, c.status)} />,
    },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (c) =>
        c.status === 'DUE' || c.status === 'MISSED' ? (
          <div className="flex justify-end gap-1.5">
            <button type="button" className="btn-secondary btn-sm" disabled={!enabled} onClick={() => setPay(c)}>
              Pay
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setWaive(c)}>
              Waive
            </button>
          </div>
        ) : null,
    },
  ];

  return (
    <div>
      <BackLink />
      <PageHeader
        title={`Note ${note.lender_invoice_number}`}
        description={`${labelOf(COLLATERAL, note.collateral_type)} on ${nameOf(lines, note.line_id)}${note.is_opening ? ' · loaded as an opening balance' : ''}`}
        breadcrumbs={[{ label: 'Dealer', href: '/dealer' }, { label: 'Floor plan', href: dealerLinks.floorPlan('notes') }, { label: note.lender_invoice_number }]}
        actions={
          live ? (
            <div className="flex gap-2">
              {note.principal_balance_cents > 0 && (
                <button type="button" className="btn-secondary btn-sm" disabled={!enabled} onClick={() => setAdhoc(true)}>
                  Pay down
                </button>
              )}
              {proposedPayoff ? (
                <button type="button" className="btn-primary btn-sm" disabled={!enabled} onClick={() => setRelease(proposedPayoff)}>
                  Release payoff
                </button>
              ) : (
                <button type="button" className="btn-primary btn-sm" disabled={!enabled || note.principal_balance_cents <= 0} onClick={() => setPropose(true)}>
                  Propose payoff
                </button>
              )}
            </div>
          ) : undefined
        }
      />

      {note.status === 'SOLD_UNPAID' && note.payoff_due_date && note.payoff_due_date < today && (
        <Notice tone="danger">
          Sold {dateLabel(note.sold_date)} and the payoff was due {dateLabel(note.payoff_due_date)} — this unit is out of trust until the lender is paid.
          {proposedPayoff ? ' A payoff is proposed and waiting for release.' : ' Propose the payoff now.'}
        </Notice>
      )}
      {note.status === 'OPEN' && matDays !== null && matDays <= (settings?.term_warning_days ?? 60) && (
        <Notice tone={matDays < 0 ? 'danger' : 'warning'}>
          {matDays < 0 ? `This note matured ${-matDays} days ago` : `This note matures in ${matDays} days`} ({dateLabel(note.maturity_date)}). Agree a repayment plan with the lender, or sell,
          demo or return the unit.
        </Notice>
      )}

      <section className="card mb-6 p-6" aria-label="Note summary">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-caption uppercase tracking-caps text-slate-500">Owed to the lender</div>
            <div className="mt-1 font-mono text-display tabular-nums text-white">{money(note.principal_balance_cents)}</div>
            <div className="mt-1 text-xs text-slate-400">
              of <span className="font-mono tabular-nums">{money(note.original_principal_cents)}</span> floored
              {paidDown > 0 && (
                <>
                  {' '}· <span className="font-mono tabular-nums">{money(paidDown)}</span> paid down
                </>
              )}
            </div>
          </div>
          <Pill label={labelOf(NOTE_STATUS, note.status)} tone={toneOf(NOTE_STATUS, note.status)} title={hintOf(NOTE_STATUS, note.status)} />
        </div>
        <DefList
          items={[
            { label: 'Lender invoice #', value: note.lender_invoice_number, mono: true },
            { label: 'Unit', value: note.unit_id ? <UnitLink unitId={note.unit_id} serial={serial} /> : labelOf(COLLATERAL, note.collateral_type) },
            { label: 'Line', value: nameOf(lines, note.line_id) },
            { label: 'Program', value: note.program_id ? nameOf(programs, note.program_id) : 'No program' },
            { label: 'Floored', value: dateLabel(note.floored_date), mono: true },
            { label: 'Free floor ends', value: dateLabel(note.free_floor_end_date), mono: true },
            { label: 'Maturity', value: <DueDate date={note.maturity_date} today={today} warnDays={settings?.term_warning_days ?? 60} pastIsBad={note.status === 'OPEN'} /> },
            { label: 'Interest accrued through', value: dateLabel(note.interest_accrued_through), mono: true },
            { label: 'Sold', value: note.sold_date ? `${dateLabel(note.sold_date)}${note.sold_detected_by ? ` · ${SOLD_DETECTED_BY[note.sold_detected_by]}` : ''}` : '—' },
            { label: 'Payoff due', value: note.status === 'SOLD_UNPAID' ? <DueDate date={note.payoff_due_date} today={today} /> : dateLabel(note.payoff_due_date) },
            { label: 'Paid off', value: dateLabel(note.paid_off_date), mono: true },
            { label: 'Scheduled due', value: dateLabel(note.scheduled_due_date), mono: true },
          ]}
        />
        {note.description && <p className="mt-4 text-sm text-slate-400">{note.description}</p>}
      </section>

      <Section title="Curtailment schedule" description="Created from the program when the note was floored. Paying reduces the loan; the unit’s cost doesn’t change.">
        <DealerTable<Curt>
          caption="Curtailment schedule"
          columns={curtCols}
          rows={curts}
          isLoading={q.isLoading}
          keyboard={false}
          rowClassName={(c) => {
            const u = curtailmentUrgency(c, today, warn);
            return u === 'missed' || u === 'overdue' ? 'bg-red-500/[0.05]' : u === 'soon' ? 'bg-amber-500/[0.04]' : undefined;
          }}
          empty={{ icon: CalendarCheck, title: 'No curtailments on this note', description: 'Its program has no curtailment schedule (or it was floored without a program).' }}
        />
      </Section>

      <Section title="History" description="Every money event on this note, oldest first, with its journal entry.">
        <DealerTable<FpTxn>
          caption="Note history"
          columns={txnCols}
          rows={txns}
          isLoading={q.isLoading}
          keyboard={false}
          empty={{ icon: History, title: 'No activity yet', description: 'The flooring and any payments, accruals and fees will appear here.' }}
        />
      </Section>

      {locationId && (
        <>
          <ProposePayoffDialog open={propose} onClose={() => setPropose(false)} locationId={locationId} note={label} onDone={refresh} />
          <ReleasePayoffDialog
            open={!!release}
            onClose={() => setRelease(null)}
            locationId={locationId}
            txnId={release?.id ?? null}
            note={label}
            proposedByMe={!!me && release?.proposed_by === me}
            onDone={refresh}
          />
          <PayCurtailmentDialog open={!!pay} onClose={() => setPay(null)} locationId={locationId} curtailmentId={pay?.id ?? null} amountCents={pay?.amount_cents ?? null} note={label} onDone={refresh} />
          <WaiveCurtailmentDialog open={!!waive} onClose={() => setWaive(null)} locationId={locationId} curtailmentId={waive?.id ?? null} amountCents={waive?.amount_cents ?? null} onDone={refresh} />
          <AdHocCurtailmentDialog open={adhoc} onClose={() => setAdhoc(false)} locationId={locationId} note={label} onDone={refresh} />
        </>
      )}
    </div>
  );
}

function BackLink() {
  return (
    <Link href={dealerLinks.floorPlan('notes')} className="mb-3 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
      <ArrowLeft size={12} /> All notes
    </Link>
  );
}

