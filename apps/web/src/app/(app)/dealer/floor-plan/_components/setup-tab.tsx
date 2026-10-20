'use client';

/**
 * Lenders & programs: floorings waiting for review (post / void), the client's
 * floor-plan lines and programs (add / edit), and "Floor a unit" by hand.
 */

import { useState } from 'react';
import { Building2, ClipboardCheck, Layers, Plus } from 'lucide-react';
import { LINE_STATUS, PAYOFF_TERMS, PROGRAM_STATUS, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, money } from '@/lib/dealer/ui/format';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate, nameOf, useDealerList, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { ConfirmDialog } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { Money, Pill, Section } from '../../_components/ui';
import { actorLabel, invalidateNoteRefs, useMe, useNoteRefs } from '../_lib/hooks';
import { describeSchedule } from '../_lib/schedule';
import type { FpLine, FpProgram, FpTxn } from '../_lib/types';
import { NoteLink, UnitLink } from './bits';
import { FloorFormModal } from './floor-form';
import { LineFormModal } from './line-form';
import { ProgramFormModal } from './program-form';

export function SetupTab({ onChanged }: { onChanged: () => void }) {
  const { locationId, settings } = useDealerPack();
  const enabled = settings?.enabled === true;
  const [floorOpen, setFloorOpen] = useState(false);
  const [queueVersion, setQueueVersion] = useState(0);

  return (
    <div>
      <ProposedFloorings
        key={queueVersion}
        onChanged={onChanged}
        onFloor={() => setFloorOpen(true)}
        enabled={enabled}
      />
      <LinesSection onChanged={onChanged} />
      <ProgramsSection />
      {locationId && (
        <FloorFormModal
          open={floorOpen}
          onClose={() => setFloorOpen(false)}
          locationId={locationId}
          canPost={enabled}
          onSaved={() => {
            setQueueVersion((v) => v + 1);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function ProposedFloorings({ onChanged, onFloor, enabled }: { onChanged: () => void; onFloor: () => void; enabled: boolean }) {
  const { locationId } = useDealerPack();
  const me = useMe();
  const list = useDealerList<FpTxn>('/api/dealer/transactions', { sort: 'txn_date', dir: 'asc', filters: { txn_type: 'FLOOR', status: 'PROPOSED' } });
  const rows = list.data?.rows ?? [];
  const [refV, setRefV] = useState(0);
  const { refs } = useNoteRefs(rows.map((t) => t.note_id), refV);
  const lines = useNames('lines', rows.map((t) => t.line_id));
  const [post, setPost] = useState<FpTxn | null>(null);
  const [voidT, setVoidT] = useState<FpTxn | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);

  async function act(path: string, body: Record<string, unknown>, ok: string) {
    if (!locationId) return false;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', path, locationId, body, ok);
    setBusy(false);
    if (res.error) {
      setError(res.error);
      return false;
    }
    invalidateNoteRefs();
    setRefV((v) => v + 1);
    void list.refetch();
    onChanged();
    return true;
  }

  const cols: DealerColumn<FpTxn>[] = [
    { key: 'date', header: 'Floored', sortKey: 'txn_date', render: (t) => <span className="font-mono tabular-nums text-slate-300">{dateLabel(t.txn_date)}</span> },
    { key: 'note', header: 'Lender invoice #', render: (t) => <NoteLink noteId={t.note_id} invoice={refs.get(t.note_id ?? '')?.lender_invoice_number} /> },
    { key: 'unit', header: 'Unit', render: (t) => <UnitLink unitId={refs.get(t.note_id ?? '')?.unit_id} serial={refs.get(t.note_id ?? '')?.serial_number} /> },
    { key: 'line', header: 'Line', render: (t) => <span className="text-slate-300">{nameOf(lines, t.line_id)}</span> },
    { key: 'amt', header: 'Principal', sortKey: 'principal_cents', align: 'right', render: (t) => <Money cents={t.principal_cents} /> },
    { key: 'by', header: 'Entered by', render: (t) => <span className="text-xs text-slate-400">{actorLabel(t.proposed_by, me)}</span> },
    {
      key: 'act',
      header: '',
      align: 'right',
      render: (t) => (
        <div className="flex justify-end gap-1.5">
          <button type="button" className="btn-secondary btn-sm" disabled={!enabled} onClick={(e) => { e.stopPropagation(); setPost(t); }}>
            Post
          </button>
          <button type="button" className="btn-ghost btn-sm" onClick={(e) => { e.stopPropagation(); setVoidT(t); }}>
            Void
          </button>
        </div>
      ),
    },
  ];

  return (
    <Section
      title="Floorings waiting for review"
      description="Floorings from imports or entered by hand that haven’t posted yet. Posting books debit unit inventory / credit floor-plan payable."
      actions={
        <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" onClick={onFloor}>
          <Plus size={13} /> Floor a unit
        </button>
      }
    >
      <DealerTable<FpTxn>
        caption="Floorings waiting for review"
        columns={cols}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        sort={list.state.sort}
        dir={list.state.dir}
        onSort={list.setSort}
        keyboard={false}
        page={list.data?.page}
        perPage={list.data?.perPage}
        total={list.data?.total}
        noun="floorings"
        onPageChange={list.setPage}
        empty={{ icon: ClipboardCheck, title: 'Nothing waiting for review', description: 'New floorings from a lender import or “Floor a unit” land here until someone posts them.' }}
      />
      <ConfirmDialog
        open={!!post}
        onClose={() => setPost(null)}
        title="Post flooring"
        confirmLabel="Post"
        busy={busy}
        body={
          <p>
            Books <span className="font-mono tabular-nums text-white">{money(post?.principal_cents ?? 0)}</span> for lender invoice{' '}
            <span className="font-mono">{refs.get(post?.note_id ?? '')?.lender_invoice_number ?? ''}</span>: debit unit inventory, credit floor-plan payable. The unit’s cost goes up by the same amount.
          </p>
        }
        error={error ? <p className="text-xs text-red-300">{explainDealerError(error).message}</p> : null}
        onConfirm={async () => {
          if (post && (await act('/api/dealer/floor/post', { txnId: post.id }, 'Flooring posted'))) setPost(null);
        }}
      />
      <ConfirmDialog
        open={!!voidT}
        onClose={() => setVoidT(null)}
        title="Void flooring"
        confirmLabel="Void"
        danger
        busy={busy}
        reason={{ label: 'Why void it?', required: true, placeholder: 'For example: duplicate of another import' }}
        body={<p>Removes this proposed flooring. Nothing was posted, so no entry is reversed.</p>}
        error={error ? <p className="text-xs text-red-300">{explainDealerError(error).message}</p> : null}
        onConfirm={async ({ reason }) => {
          if (voidT && (await act('/api/dealer/floor/void', { txnId: voidT.id, reason }, 'Flooring voided'))) setVoidT(null);
        }}
      />
    </Section>
  );
}

function LinesSection({ onChanged }: { onChanged: () => void }) {
  const { locationId } = useDealerPack();
  const list = useDealerList<FpLine>('/api/dealer/lines', { sort: 'name', dir: 'asc' });
  const rows = list.data?.rows ?? [];
  const lenders = useNames('vendors', rows.map((r) => r.lender_vendor_id));
  const accounts = useNames('accounts', rows.map((r) => r.liability_account_id));
  const [edit, setEdit] = useState<FpLine | null>(null);
  const [adding, setAdding] = useState(false);

  const cols: DealerColumn<FpLine>[] = [
    {
      key: 'name',
      header: 'Line',
      sortKey: 'name',
      render: (r) => (
        <div>
          <div className="font-medium text-white">{r.name}</div>
          <div className="text-xs text-slate-400">{nameOf(lenders, r.lender_vendor_id)}</div>
        </div>
      ),
    },
    { key: 'limit', header: 'Credit limit', sortKey: 'credit_limit_cents', align: 'right', render: (r) => <Money cents={r.credit_limit_cents} /> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <Pill label={labelOf(LINE_STATUS, r.status)} tone={toneOf(LINE_STATUS, r.status)} title={hintOf(LINE_STATUS, r.status)} /> },
    {
      key: 'acct',
      header: 'Payable account',
      render: (r) => (r.liability_account_id ? <span className="text-xs text-slate-300">{nameOf(accounts, r.liability_account_id)}</span> : <span className="text-xs text-slate-500">Client default</span>),
    },
    {
      key: 'days',
      header: 'Interest / payments / statement',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-slate-400">
          {r.interest_due_day ?? '—'} / {r.scheduled_payment_day ?? '—'} / {r.statement_day ?? '—'}
        </span>
      ),
    },
    {
      key: 'codes',
      header: 'Sold-unpaid codes',
      render: (r) =>
        r.sau_codes.length ? (
          <span className="flex flex-wrap gap-1">
            {r.sau_codes.map((c) => (
              <span key={c} className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-2xs text-slate-300">
                {c}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-xs text-amber-400" title="Without these, lender floor checks can’t flag sold-and-unpaid units">None set</span>
        ),
    },
  ];

  return (
    <Section
      title="Floor-plan lines"
      description="Each lender credit facility for this client."
      actions={
        <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add line
        </button>
      }
    >
      <DealerTable<FpLine>
        caption="Floor-plan lines"
        columns={cols}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        sort={list.state.sort}
        dir={list.state.dir}
        onSort={list.setSort}
        onRowClick={(r) => setEdit(r)}
        keyboard={false}
        page={list.data?.page}
        perPage={list.data?.perPage}
        total={list.data?.total}
        noun="lines"
        onPageChange={list.setPage}
        empty={{
          icon: Building2,
          title: 'No lender lines yet',
          description: 'Add the lender (as a vendor), the credit limit and its payment days. This works before the pack is switched on.',
          action: (
            <button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)}>
              Add the first line
            </button>
          ),
        }}
      />
      {locationId && (
        <LineFormModal
          open={adding || !!edit}
          onClose={() => {
            setAdding(false);
            setEdit(null);
          }}
          line={edit}
          locationId={locationId}
          onSaved={() => {
            void list.refetch();
            onChanged();
          }}
        />
      )}
    </Section>
  );
}

function rateText(p: FpProgram): string {
  if (p.rate_type === 'INDEX_PLUS') {
    const spread = p.spread_bps ?? 0;
    return `${p.index_name ?? 'Index'} ${bpsToPct(p.index_rate_bps)} ${spread < 0 ? '−' : '+'} ${bpsToPct(Math.abs(spread))}`;
  }
  return bpsToPct(p.rate_bps);
}

function ProgramsSection() {
  const { locationId } = useDealerPack();
  const list = useDealerList<FpProgram>('/api/dealer/programs', { sort: 'name', dir: 'asc' });
  const rows = list.data?.rows ?? [];
  const lines = useNames('lines', rows.map((r) => r.line_id));
  const oems = useNames('vendors', rows.map((r) => r.oem_vendor_id));
  const [edit, setEdit] = useState<FpProgram | null>(null);
  const [adding, setAdding] = useState(false);

  const cols: DealerColumn<FpProgram>[] = [
    {
      key: 'name',
      header: 'Program',
      sortKey: 'name',
      render: (r) => (
        <div>
          <div className="font-medium text-white">{r.name}</div>
          <div className="text-xs text-slate-400">
            {nameOf(lines, r.line_id)}
            {r.oem_vendor_id ? ` · ${nameOf(oems, r.oem_vendor_id)}` : ''}
          </div>
        </div>
      ),
    },
    { key: 'ff', header: 'Free floor', sortKey: 'free_floor_days', align: 'right', render: (r) => <span className="font-mono tabular-nums text-slate-300">{r.free_floor_days} d</span> },
    {
      key: 'rate',
      header: 'Rate',
      sortKey: 'rate_bps',
      render: (r) => (
        <div>
          <span className="font-mono text-xs tabular-nums text-slate-200">{rateText(r)}</span>
          {r.sau_penalty_rate_bps !== null && <div className="text-2xs text-slate-500">Penalty {bpsToPct(r.sau_penalty_rate_bps)} after payoff date</div>}
        </div>
      ),
    },
    {
      key: 'payoff',
      header: 'Payoff',
      render: (r) => <span className="text-xs text-slate-400">{r.payoff_terms === 'DAYS_AFTER_SALE' ? `${r.payoff_days} days after sale` : labelOf(PAYOFF_TERMS, r.payoff_terms)}</span>,
    },
    { key: 'curt', header: 'Curtailments', render: (r) => <span className="block max-w-[240px] truncate text-xs text-slate-400" title={describeSchedule(r.curtailment_schedule)}>{describeSchedule(r.curtailment_schedule)}</span> },
    { key: 'term', header: 'Max term', align: 'right', render: (r) => <span className="font-mono text-xs tabular-nums text-slate-400">{r.max_term_days ? `${r.max_term_days} d` : '—'}</span> },
    { key: 'eff', header: 'Effective', sortKey: 'effective_from', render: (r) => <span className="whitespace-nowrap font-mono text-xs tabular-nums text-slate-400">{dateLabel(r.effective_from)}{r.effective_to ? ` – ${dateLabel(r.effective_to)}` : ''}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', render: (r) => <Pill label={labelOf(PROGRAM_STATUS, r.status)} tone={toneOf(PROGRAM_STATUS, r.status)} /> },
  ];

  return (
    <Section
      title="Programs"
      description="The lender’s terms by manufacturer or product group: free floor, rate, payoff timing and curtailments."
      actions={
        <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" onClick={() => setAdding(true)}>
          <Plus size={13} /> Add program
        </button>
      }
    >
      <TableToolbar>
        <div className="w-60">
          <LookupPicker kind="lines" value={list.state.filters.line_id ?? null} onChange={(id) => list.setFilter('line_id', id)} placeholder="All lines" aria-label="Filter programs by line" />
        </div>
      </TableToolbar>
      <DealerTable<FpProgram>
        caption="Floor-plan programs"
        columns={cols}
        rows={rows}
        isLoading={list.isLoading}
        error={list.error}
        onRetry={list.refetch}
        sort={list.state.sort}
        dir={list.state.dir}
        onSort={list.setSort}
        onRowClick={(r) => setEdit(r)}
        keyboard={false}
        page={list.data?.page}
        perPage={list.data?.perPage}
        total={list.data?.total}
        noun="programs"
        onPageChange={list.setPage}
        empty={{
          icon: Layers,
          title: 'No programs yet',
          description: 'Add a program for each set of lender terms (free-floor days, rate, curtailment schedule). Notes copy the terms when they’re floored.',
          action: (
            <button type="button" className="btn-primary btn-sm" onClick={() => setAdding(true)}>
              Add a program
            </button>
          ),
        }}
      />
      {locationId && (
        <ProgramFormModal
          open={adding || !!edit}
          onClose={() => {
            setAdding(false);
            setEdit(null);
          }}
          program={edit}
          defaultLineId={list.state.filters.line_id ?? null}
          locationId={locationId}
          onSaved={() => void list.refetch()}
        />
      )}
    </Section>
  );
}
