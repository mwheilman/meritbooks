'use client';

/**
 * Interest (FPB §3.2, DL-9):
 *  - Month-end accrual: preview per note (unit, line, department, days, rate,
 *    penalty days, interest) and skipped notes explained → post one batch entry.
 *  - Lender interest bill: clears the accrual; a difference over the client's
 *    tolerance comes back as INTEREST_VARIANCE — shown side by side, and an approver
 *    may accept it and post.
 *  - Lender fees, and the interest/fee history.
 */

import { useId, useState } from 'react';
import { Calculator, History, Loader2, Receipt } from 'lucide-react';
import type { AccrualResult } from '@/lib/dealer/service/floor-plan';
import type { FloorTxnType } from '@/lib/dealer/types';
import { addDays } from '@/lib/dealer/dates';
import { DEPT_ROLE, ROW_STATUS, TXN_TYPE, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { bpsToPct, dateLabel, lastDayOfPriorMonth, money, todayLocal } from '@/lib/dealer/ui/format';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { addToast } from '@/hooks/use-toast';
import { dealerMutate, nameOf, useDealerList, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { ConfirmDialog, DateInput, Field, MoneyInput, TextInput } from '../../_components/forms';
import { LookupPicker } from '../../_components/lookup-picker';
import { ErrorPanel, Money, Pill, Section } from '../../_components/ui';
import { useNoteRefs } from '../_lib/hooks';
import type { FpNote, FpTxn } from '../_lib/types';
import { JeLink, NoteLink, UnitLink } from './bits';
import { NotePicker } from './note-picker';

type AccrualRow = AccrualResult['rows'][number] & { id: string };

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function InterestTab() {
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  return (
    <div>
      <AccrualSection onPosted={bump} />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <InterestBillSection onPosted={bump} />
        <FeeSection onPosted={bump} />
      </div>
      <HistorySection key={version} />
    </div>
  );
}

function AccrualSection({ onPosted }: { onPosted: () => void }) {
  const { locationId, settings } = useDealerPack();
  const [periodEnd, setPeriodEnd] = useState(lastDayOfPriorMonth(todayLocal()));
  const [result, setResult] = useState<AccrualResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [confirm, setConfirm] = useState(false);
  const dateId = useId();
  const rows: AccrualRow[] = (result?.rows ?? []).map((r) => ({ ...r, id: r.noteId }));
  const units = useNames('units', rows.map((r) => r.unitId));
  const lines = useNames('lines', rows.map((r) => r.lineId));
  const { refs } = useNoteRefs([...rows.map((r) => r.noteId), ...(result?.skipped ?? []).map((s) => s.noteId)]);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(periodEnd);

  async function run(post: boolean) {
    if (!locationId || !valid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<AccrualResult>('post', '/api/dealer/interest/accrue', locationId, { periodEnd, post }, post ? 'Interest accrual posted' : undefined);
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      setResult(res.data);
      onPosted();
    }
    if (post) setConfirm(false);
  }

  const columns: DealerColumn<AccrualRow>[] = [
    {
      key: 'unit',
      header: 'Unit / note',
      render: (r) => (
        <div>
          {r.unitId ? <UnitLink unitId={r.unitId} serial={units.get(r.unitId)?.label} /> : <span className="text-xs text-slate-400">Open account</span>}
          <div className="text-2xs text-slate-500">
            <NoteLink noteId={r.noteId} invoice={refs.get(r.noteId)?.lender_invoice_number} />
          </div>
        </div>
      ),
    },
    { key: 'line', header: 'Line', render: (r) => <span className="text-slate-300">{nameOf(lines, r.lineId)}</span> },
    { key: 'dept', header: 'Department', render: (r) => <span className="text-xs text-slate-400">{labelOf(DEPT_ROLE, r.deptRole)}</span> },
    {
      key: 'period',
      header: 'Days covered',
      render: (r) => (
        <span className="whitespace-nowrap font-mono text-xs tabular-nums text-slate-300">
          {dateLabel(addDays(r.fromExclusive, 1))} – {dateLabel(r.toInclusive)}
        </span>
      ),
    },
    { key: 'rate', header: 'Rate', align: 'right', render: (r) => <span className="font-mono tabular-nums text-slate-300">{bpsToPct(r.rateBps)}</span> },
    { key: 'days', header: 'Interest days', align: 'right', render: (r) => <span className="font-mono tabular-nums text-slate-300">{r.interestBearingDays}</span> },
    {
      key: 'pen',
      header: 'Penalty days',
      align: 'right',
      render: (r) => (r.penaltyDays > 0 ? <span className="font-mono tabular-nums text-red-300" title="Days at the sold-and-unpaid penalty rate">{r.penaltyDays}</span> : <span className="text-slate-500">—</span>),
    },
    { key: 'int', header: 'Interest', align: 'right', render: (r) => <Money cents={r.interestCents} /> },
  ];

  return (
    <Section
      title="Month-end interest accrual"
      description="Interest is figured per note on each day’s balance, only after free floor ends; sold units past their payoff date use the program’s penalty rate. Preview first, then post one entry."
      actions={
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-44">
            <label htmlFor={dateId} className="sr-only">
              Accrue through
            </label>
            <DateInput id={dateId} value={periodEnd} onChange={(v) => { setPeriodEnd(v); setResult(null); }} invalid={!valid} />
          </div>
          <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" disabled={!valid || busy} onClick={() => void run(false)}>
            {busy && !confirm ? <Loader2 size={13} className="animate-spin" /> : <Calculator size={13} />} Preview
          </button>
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={!result || result.posted || result.rows.length === 0 || busy || !settings?.enabled}
            title={settings?.enabled ? undefined : 'Switch the dealer pack on to post'}
            onClick={() => setConfirm(true)}
          >
            Post accrual
          </button>
        </div>
      }
    >
      {error && <ErrorPanel error={error} onRetry={() => void run(false)} />}
      {!result && !error && (
        <div className="px-5 py-10 text-center text-sm text-slate-400">
          Pick the date to accrue through (usually the last day of last month) and preview. Nothing posts until you confirm.
        </div>
      )}
      {result && (
        <>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-800 px-5 py-3 text-sm">
            <span className="text-slate-400">
              Through <span className="font-mono tabular-nums text-slate-200">{dateLabel(result.periodEnd)}</span>
            </span>
            <span className="text-slate-400">
              {result.rows.length} note{result.rows.length === 1 ? '' : 's'} · total <span className="font-mono text-base tabular-nums text-white">{money(result.totalCents)}</span>
            </span>
            {result.posted ? (
              <span className="inline-flex items-center gap-2">
                <Pill label="Posted" tone="success" />
                <JeLink glEntryId={result.glEntryId} />
              </span>
            ) : (
              <Pill label="Preview — not posted" tone="warning" />
            )}
          </div>
          <DealerTable<AccrualRow>
            caption="Interest accrual preview"
            columns={columns}
            rows={rows}
            isLoading={busy && rows.length === 0}
            keyboard={false}
            empty={{ icon: Calculator, title: 'No interest to accrue', description: 'Every note is either inside free floor, already accrued through this date, or has no balance.' }}
          />
          {result.skipped.length > 0 && (
            <div className="border-t border-slate-800 px-5 py-4">
              <h3 className="mb-2 text-caption uppercase tracking-caps text-slate-500">Skipped ({result.skipped.length})</h3>
              <ul className="space-y-1 text-xs text-slate-400">
                {result.skipped.map((s) => (
                  <li key={s.noteId}>
                    <NoteLink noteId={s.noteId} invoice={refs.get(s.noteId)?.lender_invoice_number} /> — {s.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Post interest accrual"
        confirmLabel="Post accrual"
        busy={busy}
        body={
          <>
            <p>
              Books one entry of <span className="font-mono tabular-nums text-white">{money(result?.totalCents ?? 0)}</span> through {dateLabel(periodEnd)}: debit floor-plan interest expense by
              department, credit accrued floor-plan interest.
            </p>
            <p className="mt-2 text-slate-400">Each note is then marked accrued through this date, so the next run starts the day after.</p>
          </>
        }
        error={error ? <p className="text-xs text-red-300">{explainDealerError(error).message}</p> : null}
        onConfirm={() => run(true)}
      />
    </Section>
  );
}

interface VarianceDetails {
  billedCents: number;
  accruedCents: number;
  trueUpCents: number;
  toleranceCents: number;
}

function InterestBillSection({ onPosted }: { onPosted: () => void }) {
  const { locationId, settings } = useDealerPack();
  const [lineId, setLineId] = useState<string | null>(null);
  const [billed, setBilled] = useState<number | null>(null);
  const [billDate, setBillDate] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [cleared, setCleared] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [variance, setVariance] = useState<VarianceDetails | null>(null);
  const [touched, setTouched] = useState(false);
  const ids = { line: useId(), amt: useId(), date: useId(), ref: useId(), clr: useId() };

  const errs = {
    line: !lineId ? 'Choose the line the lender billed.' : null,
    billed: billed === null || billed <= 0 ? 'Enter the interest the lender billed.' : null,
    date: !/^\d{4}-\d{2}-\d{2}$/.test(billDate) ? 'Enter the bill date.' : null,
    ref: reference.length > 200 ? 'Keep the reference under 200 characters.' : null,
  };
  const ok = !errs.line && !errs.billed && !errs.date && !errs.ref;

  async function submit(acceptVariance: boolean) {
    setTouched(true);
    if (!ok || !locationId) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<{ txn: FpTxn; trueUpCents: number }>(
      'post',
      '/api/dealer/interest/billed',
      locationId,
      { lineId, billedCents: billed, billDate, reference: reference.trim() || null, accrualClearedCents: cleared, acceptVariance: acceptVariance || undefined },
      undefined,
    );
    setBusy(false);
    if (res.error) {
      if (res.error.code === 'INTEREST_VARIANCE') {
        const d = rec(res.error.details);
        setVariance({ billedCents: Number(d.billedCents), accruedCents: Number(d.accruedCents), trueUpCents: Number(d.trueUpCents), toleranceCents: Number(d.toleranceCents) });
      } else setError(res.error);
      return;
    }
    const t = res.data?.trueUpCents ?? 0;
    addToast('success', `Lender interest posted${t !== 0 ? ` — true-up ${money(t)}` : ''}`);
    onPosted();
    setVariance(null);
    setBilled(null);
    setReference('');
    setCleared(null);
    setTouched(false);
  }

  return (
    <Section title="Record a lender interest bill" description="Clears what Books accrued for the line; any small difference posts as a true-up to interest expense.">
      <form
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        noValidate
      >
        <Field label="Line" htmlFor={ids.line} required error={touched ? errs.line : null}>
          <LookupPicker id={ids.line} kind="lines" value={lineId} onChange={(id) => { setLineId(id); setVariance(null); }} invalid={touched && !!errs.line} placeholder="Choose a line" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Interest billed" htmlFor={ids.amt} required error={touched ? errs.billed : null}>
            <MoneyInput id={ids.amt} cents={billed} onChange={(c) => { setBilled(c); setVariance(null); }} invalid={touched && !!errs.billed} />
          </Field>
          <Field label="Bill date" htmlFor={ids.date} required error={touched ? errs.date : null}>
            <DateInput id={ids.date} value={billDate} onChange={setBillDate} />
          </Field>
        </div>
        <Field label="Lender reference" htmlFor={ids.ref} hint="The bill or debit reference — keeps a repeat entry from posting twice." error={errs.ref}>
          <TextInput id={ids.ref} value={reference} onChange={setReference} maxLength={200} />
        </Field>
        <Field label="Accrual to clear" htmlFor={ids.clr} hint="Leave blank to clear everything Books has accrued on this line.">
          <MoneyInput id={ids.clr} cents={cleared} onChange={(c) => { setCleared(c); setVariance(null); }} placeholder="All accrued" />
        </Field>

        {variance && (
          <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-4 text-sm">
            <p className="font-medium text-amber-100">The bill is further from Books’ accrual than this client allows</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
              <div>
                <dt className="text-slate-500">Lender billed</dt>
                <dd className="font-mono tabular-nums text-white">{money(variance.billedCents)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Books accrued</dt>
                <dd className="font-mono tabular-nums text-white">{money(variance.accruedCents)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">True-up</dt>
                <dd className="font-mono tabular-nums text-amber-300">{money(variance.trueUpCents)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Tolerance</dt>
                <dd className="font-mono tabular-nums text-slate-300">{money(variance.toleranceCents)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-slate-400">
              Check the lender’s rate, free-floor days and payoff dates first. If the bill is right, an approver can accept the difference and post it to interest expense.
              {settings ? ` (Tolerance: the greater of ${money(settings.interest_tolerance_cents)} or ${bpsToPct(settings.interest_tolerance_bps, 0)} of the bill.)` : ''}
            </p>
            <div className="mt-3 flex gap-2">
              <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" disabled={busy} onClick={() => void submit(true)}>
                {busy && <Loader2 size={13} className="animate-spin" />} Accept variance and post
              </button>
              <button type="button" className="btn-ghost btn-sm" onClick={() => setVariance(null)}>
                Not now
              </button>
            </div>
          </div>
        )}
        {error && <ErrorPanel error={error} compact />}
        <div className="flex justify-end">
          <button type="submit" className="btn-secondary btn-sm inline-flex items-center gap-1.5" disabled={busy || !settings?.enabled}>
            {busy && !variance && <Loader2 size={13} className="animate-spin" />}
            <Receipt size={13} /> Post interest bill
          </button>
        </div>
      </form>
    </Section>
  );
}

function FeeSection({ onPosted }: { onPosted: () => void }) {
  const { locationId, settings } = useDealerPack();
  const [lineId, setLineId] = useState<string | null>(null);
  const [note, setNote] = useState<FpNote | null>(null);
  const [fee, setFee] = useState<number | null>(null);
  const [feeDate, setFeeDate] = useState(todayLocal());
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const [touched, setTouched] = useState(false);
  const ids = { line: useId(), note: useId(), amt: useId(), date: useId(), memo: useId() };
  const errs = {
    line: !lineId ? 'Choose the line.' : null,
    fee: fee === null || fee <= 0 ? 'Enter the fee amount.' : null,
    date: !/^\d{4}-\d{2}-\d{2}$/.test(feeDate) ? 'Enter the fee date.' : null,
    memo: !memo.trim() ? 'Say what the fee is for (for example, an audit fee or late fee).' : memo.length > 300 ? 'Keep it under 300 characters.' : null,
  };
  const ok = !errs.line && !errs.fee && !errs.date && !errs.memo;

  async function submit() {
    setTouched(true);
    if (!ok || !locationId) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate<FpTxn>('post', '/api/dealer/fees', locationId, { lineId, noteId: note?.id ?? null, feeCents: fee, feeDate, memo: memo.trim() }, 'Lender fee posted');
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      onPosted();
      setFee(null);
      setMemo('');
      setNote(null);
      setTouched(false);
    }
  }

  return (
    <Section title="Record a lender fee" description="Late fees, audit fees and other lender charges post to floor-plan fees.">
      <form
        className="space-y-4 p-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Line" htmlFor={ids.line} required error={touched ? errs.line : null}>
          <LookupPicker id={ids.line} kind="lines" value={lineId} onChange={(id) => { setLineId(id); setNote(null); }} invalid={touched && !!errs.line} placeholder="Choose a line" />
        </Field>
        <Field label="Note (optional)" htmlFor={ids.note} hint="Tie the fee to one unit’s note so its department is charged.">
          <NotePicker id={ids.note} lineId={lineId} value={note} onChange={setNote} />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="Fee" htmlFor={ids.amt} required error={touched ? errs.fee : null}>
            <MoneyInput id={ids.amt} cents={fee} onChange={setFee} invalid={touched && !!errs.fee} />
          </Field>
          <Field label="Date" htmlFor={ids.date} required error={touched ? errs.date : null}>
            <DateInput id={ids.date} value={feeDate} onChange={setFeeDate} />
          </Field>
        </div>
        <Field label="What it’s for" htmlFor={ids.memo} required error={touched ? errs.memo : null}>
          <TextInput id={ids.memo} value={memo} onChange={setMemo} maxLength={300} invalid={touched && !!errs.memo} />
        </Field>
        {error && <ErrorPanel error={error} compact />}
        <div className="flex justify-end">
          <button type="submit" className="btn-secondary btn-sm inline-flex items-center gap-1.5" disabled={busy || !settings?.enabled}>
            {busy && <Loader2 size={13} className="animate-spin" />} Post fee
          </button>
        </div>
      </form>
    </Section>
  );
}

type HistSeg = 'INTEREST_ACCRUAL,INTEREST_BILLED,FEE' | 'INTEREST_ACCRUAL' | 'INTEREST_BILLED' | 'FEE';

function HistorySection() {
  const list = useDealerList<FpTxn>('/api/dealer/transactions', { sort: 'txn_date', dir: 'desc', filters: { txn_type: 'INTEREST_ACCRUAL,INTEREST_BILLED,FEE' } });
  const rows = list.data?.rows ?? [];
  const lines = useNames('lines', rows.map((r) => r.line_id));
  const { refs } = useNoteRefs(rows.map((r) => r.note_id));
  const columns: DealerColumn<FpTxn>[] = [
    { key: 'date', header: 'Date', sortKey: 'txn_date', render: (t) => <span className="font-mono tabular-nums text-slate-300">{dateLabel(t.txn_date)}</span> },
    { key: 'type', header: 'What', sortKey: 'txn_type', render: (t) => <span className="text-slate-200">{labelOf(TXN_TYPE, t.txn_type as FloorTxnType)}</span> },
    { key: 'line', header: 'Line', render: (t) => <span className="text-slate-300">{nameOf(lines, t.line_id)}</span> },
    { key: 'note', header: 'Note', render: (t) => (t.note_id ? <NoteLink noteId={t.note_id} invoice={refs.get(t.note_id)?.lender_invoice_number} /> : <span className="text-slate-500">Whole line</span>) },
    { key: 'int', header: 'Interest', sortKey: 'interest_cents', align: 'right', render: (t) => (t.interest_cents ? <Money cents={t.interest_cents} /> : <span className="text-slate-500">—</span>) },
    {
      key: 'clr',
      header: 'Accrual cleared',
      align: 'right',
      render: (t) => (t.txn_type === 'INTEREST_BILLED' ? <Money cents={t.accrual_cleared_cents} muted /> : <span className="text-slate-500">—</span>),
    },
    { key: 'fee', header: 'Fee', align: 'right', render: (t) => (t.fee_cents ? <Money cents={t.fee_cents} /> : <span className="text-slate-500">—</span>) },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      render: (t) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Pill label={labelOf(ROW_STATUS, t.status)} tone={toneOf(ROW_STATUS, t.status)} />
          {t.disposition === 'VARIANCE_ACCEPTED' && <Pill label="Variance accepted" tone="warning" />}
        </span>
      ),
    },
    { key: 'memo', header: 'Memo', render: (t) => <span className="block max-w-[220px] truncate text-xs text-slate-400" title={t.memo ?? undefined}>{t.memo ?? '—'}</span> },
    { key: 'je', header: '', align: 'right', render: (t) => <JeLink glEntryId={t.gl_entry_id} /> },
  ];
  return (
    <Section title="Interest and fee history" description="Accruals (per note), lender bills and fees for this client, newest first.">
      <TableToolbar>
        <Segments<HistSeg>
          label="Kind"
          value={(list.state.filters.txn_type ?? 'INTEREST_ACCRUAL,INTEREST_BILLED,FEE') as HistSeg}
          onChange={(v) => list.setFilter('txn_type', v)}
          options={[
            { value: 'INTEREST_ACCRUAL,INTEREST_BILLED,FEE', label: 'All' },
            { value: 'INTEREST_ACCRUAL', label: 'Accruals' },
            { value: 'INTEREST_BILLED', label: 'Lender bills' },
            { value: 'FEE', label: 'Fees' },
          ]}
        />
      </TableToolbar>
      <DealerTable<FpTxn>
        caption="Interest and fee history"
        columns={columns}
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
        noun="entries"
        onPageChange={list.setPage}
        empty={{ icon: History, title: 'No interest or fees yet', description: 'Preview and post a month-end accrual above, or record a lender bill or fee.' }}
      />
    </Section>
  );
}
