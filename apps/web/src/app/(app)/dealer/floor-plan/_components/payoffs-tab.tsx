'use client';

/**
 * Payoff queue — propose ≠ release (FPB §3.4, canon money movement). Two lists:
 *  1. Awaiting release: PROPOSED payoffs. Release asks for the paid date and is
 *     refused by the server when the releaser proposed it; the button says so first.
 *  2. Payoffs to propose: sold units whose note has no proposed payoff yet.
 * Nothing is ever released automatically.
 */

import { useMemo, useState } from 'react';
import { Banknote, CheckCircle2 } from 'lucide-react';
import { dateLabel, money, todayLocal } from '@/lib/dealer/ui/format';
import { nameOf, useDealerList, useDealerQuery, useNames, type ListPage } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, type DealerColumn } from '../../_components/dealer-table';
import { Money, Notice, Section } from '../../_components/ui';
import { actorLabel, invalidateNoteRefs, useMe, useNoteRefs } from '../_lib/hooks';
import { payoffsToPropose } from '../_lib/queues';
import type { FpNote, FpTxn } from '../_lib/types';
import { DueDate, NoteLink, UnitLink } from './bits';
import { ProposePayoffDialog, ReleasePayoffDialog, type NoteLabel } from './money-dialogs';

export function PayoffsTab({ onChanged }: { onChanged: () => void }) {
  const { settings, locationId } = useDealerPack();
  const me = useMe();
  const today = todayLocal();
  const enabled = settings?.enabled === true;

  const queue = useDealerList<FpTxn>('/api/dealer/transactions', { sort: 'txn_date', dir: 'asc', filters: { txn_type: 'PAYOFF', status: 'PROPOSED' } });
  const allProposed = useDealerQuery<ListPage<FpTxn>>('/api/dealer/transactions', { txn_type: 'PAYOFF', status: 'PROPOSED', per_page: 100 });
  const sold = useDealerQuery<ListPage<FpNote>>('/api/dealer/notes', { status: 'SOLD_UNPAID', per_page: 100, sort: 'payoff_due_date', dir: 'asc' });

  const [refVersion, setRefVersion] = useState(0);
  const queueRows = queue.data?.rows ?? [];
  const { refs } = useNoteRefs(queueRows.map((t) => t.note_id), refVersion);
  const toPropose = useMemo(() => payoffsToPropose(sold.data?.rows ?? [], allProposed.data?.rows ?? []), [sold.data, allProposed.data]);
  const units = useNames('units', toPropose.map((n) => n.unit_id));
  const lines = useNames('lines', [...queueRows.map((t) => t.line_id), ...toPropose.map((n) => n.line_id)]);

  const [release, setRelease] = useState<FpTxn | null>(null);
  const [propose, setPropose] = useState<NoteLabel | null>(null);

  function done() {
    invalidateNoteRefs();
    setRefVersion((v) => v + 1);
    void queue.refetch();
    void allProposed.refetch();
    void sold.refetch();
    onChanged();
  }

  const queueCents = queueRows.reduce((s, t) => s + (refs.get(t.note_id ?? '')?.principal_balance_cents ?? t.principal_cents), 0);
  const overdueToPropose = toPropose.filter((n) => n.payoff_due_date && n.payoff_due_date < today);

  const releaseCols: DealerColumn<FpTxn>[] = [
    { key: 'date', header: 'Planned', sortKey: 'txn_date', render: (t) => <span className="font-mono tabular-nums text-slate-300">{dateLabel(t.txn_date)}</span> },
    { key: 'note', header: 'Note', render: (t) => <NoteLink noteId={t.note_id} invoice={refs.get(t.note_id ?? '')?.lender_invoice_number} /> },
    { key: 'unit', header: 'Unit', render: (t) => <UnitLink unitId={refs.get(t.note_id ?? '')?.unit_id} serial={refs.get(t.note_id ?? '')?.serial_number} /> },
    { key: 'line', header: 'Line', render: (t) => <span className="text-slate-300">{nameOf(lines, t.line_id)}</span> },
    {
      key: 'due',
      header: 'Payoff due',
      render: (t) => <DueDate date={refs.get(t.note_id ?? '')?.payoff_due_date} today={today} />,
    },
    {
      key: 'amt',
      header: 'Amount',
      align: 'right',
      render: (t) => {
        const bal = refs.get(t.note_id ?? '')?.principal_balance_cents;
        return (
          <div className="text-right">
            <Money cents={bal ?? t.principal_cents} />
            {bal !== undefined && bal !== t.principal_cents && <div className="text-2xs text-slate-500">proposed at {money(t.principal_cents)}; pays current balance</div>}
          </div>
        );
      },
    },
    { key: 'by', header: 'Proposed by', render: (t) => <span className="text-xs text-slate-400">{actorLabel(t.proposed_by, me)}</span> },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (t) => {
        const mine = !!me && t.proposed_by === me;
        return (
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={!enabled}
            title={!enabled ? 'Switch the dealer pack on to release payoffs' : mine ? 'You proposed this — a different person must release it' : undefined}
            onClick={(e) => {
              e.stopPropagation();
              setRelease(t);
            }}
          >
            Release
          </button>
        );
      },
    },
  ];

  const proposeCols: DealerColumn<FpNote & { id: string }>[] = [
    { key: 'inv', header: 'Note', render: (n) => <NoteLink noteId={n.id} invoice={n.lender_invoice_number} /> },
    { key: 'unit', header: 'Unit', render: (n) => <UnitLink unitId={n.unit_id} serial={units.get(n.unit_id ?? '')?.label} /> },
    { key: 'line', header: 'Line', render: (n) => <span className="text-slate-300">{nameOf(lines, n.line_id)}</span> },
    { key: 'sold', header: 'Sold', render: (n) => <span className="font-mono tabular-nums text-slate-400">{dateLabel(n.sold_date)}</span> },
    { key: 'due', header: 'Payoff due', render: (n) => <DueDate date={n.payoff_due_date} today={today} /> },
    { key: 'bal', header: 'Balance', align: 'right', render: (n) => <Money cents={n.principal_balance_cents} /> },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (n) => (
        <button
          type="button"
          className="btn-secondary btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            setPropose({ noteId: n.id, invoice: n.lender_invoice_number, serial: units.get(n.unit_id ?? '')?.label ?? null, balanceCents: n.principal_balance_cents });
          }}
        >
          Propose payoff
        </button>
      ),
    },
  ];

  const releaseNote: NoteLabel | null = release
    ? {
        noteId: release.note_id ?? '',
        invoice: refs.get(release.note_id ?? '')?.lender_invoice_number ?? null,
        serial: refs.get(release.note_id ?? '')?.serial_number ?? null,
        balanceCents: refs.get(release.note_id ?? '')?.principal_balance_cents ?? release.principal_cents,
      }
    : null;

  return (
    <div>
      <Notice tone="info">
        Proposing a payoff and releasing it are two people’s jobs. Releasing posts the payment (debit floor-plan payable, credit operating bank) and closes the note. Nothing is released
        automatically.
      </Notice>
      <Section
        title="Awaiting release"
        description={
          queueRows.length > 0 ? (
            <>
              <span className="font-mono tabular-nums text-slate-300">{money(queueCents)}</span> proposed across {queue.data?.total ?? queueRows.length} payoff
              {(queue.data?.total ?? queueRows.length) === 1 ? '' : 's'}.
            </>
          ) : (
            'Proposed payoffs appear here for a second person to release.'
          )
        }
      >
        <DealerTable<FpTxn>
          caption="Payoffs awaiting release"
          columns={releaseCols}
          rows={queueRows}
          isLoading={queue.isLoading}
          error={queue.error}
          onRetry={queue.refetch}
          sort={queue.state.sort}
          dir={queue.state.dir}
          onSort={queue.setSort}
          keyboard={false}
          page={queue.data?.page}
          perPage={queue.data?.perPage}
          total={queue.data?.total}
          noun="payoffs"
          onPageChange={queue.setPage}
          empty={{ icon: CheckCircle2, title: 'No payoffs waiting', description: 'When a unit sells, its payoff is proposed automatically and lands here for release.' }}
        />
      </Section>

      <Section
        title="Payoffs to propose"
        description={
          overdueToPropose.length > 0 ? (
            <span className="text-red-300">
              {overdueToPropose.length} sold unit{overdueToPropose.length === 1 ? ' is' : 's are'} past the payoff date with no payoff proposed.
            </span>
          ) : (
            'Sold units whose note has no payoff proposed yet.'
          )
        }
      >
        <DealerTable<FpNote & { id: string }>
          caption="Sold units needing a payoff proposal"
          columns={proposeCols}
          rows={toPropose}
          isLoading={sold.isLoading || allProposed.isLoading}
          error={sold.error ?? allProposed.error}
          onRetry={() => {
            void sold.refetch();
            void allProposed.refetch();
          }}
          keyboard={false}
          rowClassName={(n) => (n.payoff_due_date && n.payoff_due_date < today ? 'bg-red-500/[0.04]' : undefined)}
          empty={{ icon: Banknote, title: 'Every sold unit has a payoff proposed', description: 'Nothing sold is waiting on a payoff proposal.' }}
        />
        {(sold.data?.total ?? 0) > 100 && <p className="px-5 pb-4 text-xs text-slate-500">Showing the 100 earliest payoff dates. Work these down to see the rest.</p>}
      </Section>

      {locationId && (
        <>
          <ReleasePayoffDialog
            open={!!release}
            onClose={() => setRelease(null)}
            locationId={locationId}
            txnId={release?.id ?? null}
            note={releaseNote}
            proposedByMe={!!me && release?.proposed_by === me}
            onDone={done}
          />
          <ProposePayoffDialog open={!!propose} onClose={() => setPropose(null)} locationId={locationId} note={propose} onDone={done} />
        </>
      )}
    </div>
  );
}
