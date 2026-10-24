'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bands,
  Button,
  Dialog,
  Drawer,
  Field,
  Input,
  KV,
  ListPager,
  PanelSection,
  Pip,
  QueueTable,
  Search,
  Textarea,
  api,
  toast,
  useDebounce,
  useQuery,
  type PipKind,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { accountLabel, postForFile, usd, shortDate, todayLocal, who, type CheckAccount, type CheckStatus, type RegisterResponse, type RegisterRow } from './checks-types';
import s from './checks.module.css';

type Filter = 'all' | 'outstanding' | 'cleared' | 'void' | 'spoiled' | 'stale';
type Sort = 'number' | 'date' | 'amount' | 'payee';
type ActionKind = 'void' | 'spoil' | 'reprint' | 'mail';
const PAGE = 50;

const PIP: Record<CheckStatus, PipKind> = {
  PRINTED: 'open',
  ISSUED: 'track',
  MAILED: 'track',
  CLEARED: 'ready',
  VOIDED: 'closed',
  SPOILED: 'closed',
};

function StatusPill({ r }: { r: RegisterRow }) {
  return (
    <span className={s.pill}>
      <Pip kind={r.stale ? 'overdue' : PIP[r.status]} />
      {r.statusLabel}
      {r.stale ? ' · stale' : r.pastVoidDate ? ' · past void date' : ''}
    </span>
  );
}

export interface RegisterTabProps {
  account: CheckAccount;
  userId: string | null;
  onChanged: () => void;
}

/** The check register (FPB §4.2): outstanding / cleared / void / spoiled / stale, gaps, actions. */
export function RegisterTab({ account, userId, onChanged }: RegisterTabProps) {
  const [filter, setFilter] = useState<Filter>('outstanding');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 250);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<Sort>('number');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [matching, setMatching] = useState(false);

  useEffect(() => { setPage(1); }, [filter, q, from, to, sort, dir, account.id]);

  const params = {
    bank_account_id: account.id,
    filter,
    q: q || undefined,
    from: from || undefined,
    to: to || undefined,
    sort,
    dir,
    page: String(page),
    page_size: String(PAGE),
  };
  const { data, error, isLoading, refetch } = useQuery<RegisterResponse>('/api/ap/checks/register', params, { key: String(refresh), scope: false });
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const open = rows.find((r) => r.id === openId) ?? null;
  const sum = data?.summary;

  const reload = useCallback(() => { setRefresh((n) => n + 1); onChanged(); }, [onChanged]);

  const sortable = (id: Sort, label: string) => ({
    direction: sort === id ? dir : null,
    onToggle: () => {
      if (sort === id) setDir(dir === 'asc' ? 'desc' : 'asc');
      else { setSort(id); setDir(id === 'payee' ? 'asc' : 'desc'); }
    },
    label,
  });

  const columns = useMemo<QueueColumn<RegisterRow>[]>(
    () => [
      { id: 'number', header: 'Check', width: 96, numeric: true, sort: sortable('number', 'Sort by check number'), cell: (r) => <span className="tnum">{r.checkNumber}</span> },
      { id: 'date', header: 'Date', width: 120, sort: sortable('date', 'Sort by date'), cell: (r) => shortDate(r.checkDate) },
      {
        id: 'payee',
        header: 'Payee',
        sort: sortable('payee', 'Sort by payee'),
        cell: (r) => (
          <>
            <span className="l1">{r.payeeName}</span>
            <span className="l2">{r.bills.map((b) => b.billNumber ?? 'bill').join(', ') || r.memo || '—'}</span>
          </>
        ),
      },
      { id: 'status', header: 'Status', width: 190, cell: (r) => <StatusPill r={r} /> },
      {
        id: 'cleared',
        header: 'Cleared / voided',
        width: 150,
        cell: (r) => (r.clearedAt ? shortDate(r.clearedAt) : r.voidedAt ? shortDate(r.voidedAt) : <span className={s.muted}>—</span>),
      },
      { id: 'amount', header: 'Amount', width: 130, numeric: true, sort: sortable('amount', 'Sort by amount'), cell: (r) => <span className="tnum">{usd(r.amountCents)}</span> },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sort, dir],
  );

  const matchCleared = async () => {
    setMatching(true);
    const res = await api.post<{ cleared: number; flagged: number }>('/api/ap/checks/clear', { bankAccountId: account.id });
    setMatching(false);
    if (res.error) { toast.error(res.error.error); return; }
    const n = res.data?.cleared ?? 0;
    toast(n === 0 ? 'No new cleared checks in the bank feed.' : `${n} check${n === 1 ? '' : 's'} cleared from the bank feed${res.data?.flagged ? ` (${res.data.flagged} need a look)` : ''}.`);
    reload();
  };

  const csvHref = `/api/ap/checks/register?${new URLSearchParams(Object.entries({ ...params, format: 'csv', page: '1' }).filter(([, v]) => v != null) as Array<[string, string]>).toString()}`;

  return (
    <div>
      <div className={s.strip}>
        <div className={s.cell}>
          <span className={s.cellL}>Outstanding</span>
          <span className={s.cellV}>{sum ? usd(sum.outstandingCents) : '—'}</span>
          <span className={s.cellS}>{sum ? `${sum.outstandingCount} check${sum.outstandingCount === 1 ? '' : 's'} not yet cleared` : ' '}</span>
        </div>
        <div className={s.cell}>
          <span className={s.cellL}>Cleared this month</span>
          <span className={s.cellV}>{sum ? usd(sum.clearedThisMonthCents) : '—'}</span>
          <span className={s.cellS}>{sum ? `${sum.clearedThisMonthCount} from the bank feed` : ' '}</span>
        </div>
        <div className={`${s.cell} ${sum && sum.staleCount > 0 ? s.cellWarn : ''}`}>
          <span className={s.cellL}>Stale</span>
          <span className={s.cellV}>{sum ? sum.staleCount : '—'}</span>
          <span className={s.cellS}>{sum ? `Outstanding over ${data?.staleAfterDays ?? 180} days${sum.staleCount ? ` · ${usd(sum.staleCents)}` : ''}` : ' '}</span>
        </div>
        <div className={`${s.cell} ${sum && sum.gaps.length > 0 ? s.cellWarn : ''}`}>
          <span className={s.cellL}>Number check</span>
          <span className={s.cellV}>{sum ? (sum.gaps.length ? `${sum.gaps.length}${sum.gapsTruncated ? '+' : ''} missing` : 'No gaps') : '—'}</span>
          <span className={s.cellS}>
            {sum ? (sum.gaps.length ? `Missing: ${sum.gapsLabel}` : sum.lowNumber ? `${sum.lowNumber}–${sum.highNumber} all accounted for` : 'No checks yet') : ' '}
          </span>
        </div>
        <div className={s.cell}>
          <span className={s.cellL}>Not sent to the bank</span>
          <span className={s.cellV}>{sum ? sum.notSentToBank : '—'}</span>
          <span className={s.cellS}>Issues and voids for the next positive-pay file</span>
        </div>
      </div>

      <Bands<Filter>
        aria-label="Register filter"
        value={filter}
        onChange={setFilter}
        items={[
          { value: 'outstanding', label: 'Outstanding', count: sum ? sum.outstandingCount : '—' },
          { value: 'cleared', label: 'Cleared', count: sum ? sum.clearedThisMonthCount : '—', caption: 'this month' },
          { value: 'stale', label: 'Stale', count: sum ? sum.staleCount : '—' },
          { value: 'void', label: 'Voided', count: sum ? sum.voidCount : '—' },
          { value: 'spoiled', label: 'Spoiled', count: sum ? sum.spoiledCount : '—' },
          { value: 'all', label: 'All', count: filter === 'all' && data ? data.total : ' ' },
        ]}
      />

      <div className={s.surface}>
        <div className={s.toolbar}>
          <Search aria-label="Search payee or check number" placeholder="Payee or check number" value={search} onChange={(e) => setSearch(e.target.value)} slashToFocus />
          <div className={s.dateRange} role="group" aria-label="Check date range">
            <Input type="date" aria-label="From date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
            <span className={s.muted} aria-hidden="true">to</span>
            <Input type="date" aria-label="To date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className={s.grow} />
          <Button variant="quiet" onClick={() => void matchCleared()} disabled={matching}>{matching ? 'Matching…' : 'Match cleared checks'}</Button>
          <a className="btn" href={csvHref}>Export CSV</a>
        </div>
        {isLoading && !data ? (
          <div className="wg-loading" style={{ height: 240 }} aria-busy="true"><span className="bar-l" style={{ width: '55%' }} /></div>
        ) : error ? (
          <div className={s.state} role="alert">
            <p>Couldn&apos;t load the register. {error}</p>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        ) : rows.length === 0 ? (
          <div className={s.state}>
            <h2 className="t-section">{filter === 'all' && !q && !from && !to ? 'No checks yet' : 'No checks match'}</h2>
            <p>{filter === 'all' ? `Checks printed on ${accountLabel(account)} are listed here with their status until they clear.` : 'Try another filter or clear the search.'}</p>
          </div>
        ) : (
          <QueueTable<RegisterRow>
            aria-label={`Check register for ${accountLabel(account)}`}
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            rowState={(r) => ({ attn: r.stale || !!r.clearNote, done: r.status === 'VOIDED' || r.status === 'SPOILED' })}
            cursorId={cursor}
            onCursorChange={(id) => setCursor(id)}
            onOpen={(r) => setOpenId(r.id)}
            openOnClick
            actions={[
              { key: 'v', label: 'Void', run: (rs) => { if (rs[0]) { setOpenId(rs[0].id); setAction('void'); } } },
              { key: 's', label: 'Spoil', run: (rs) => { if (rs[0] && canSpoil(rs[0], userId)) { setOpenId(rs[0].id); setAction('spoil'); } } },
            ]}
          />
        )}
      </div>
      {data && <ListPager page={page} perPage={PAGE} total={data.total} onPage={setPage} noun="checks" />}

      <Drawer
        open={!!open}
        onClose={() => { setOpenId(null); setAction(null); }}
        eyebrow={['Check', open ? `#${open.checkNumber}` : '']}
        title={open?.payeeName ?? ''}
        figure={open ? <span className="tnum">{usd(open.amountCents)}</span> : null}
        width={440}
        foot={open ? <CheckActions row={open} userId={userId} onAction={setAction} onMarked={reload} /> : null}
      >
        {open && (
          <>
            <PanelSection title="Status">
              <KV className={s.kvWide} items={[
                { term: 'Status', value: <StatusPill r={open} /> },
                { term: 'Check date', value: shortDate(open.checkDate) },
                { term: 'Printed', value: `${shortDate(open.printedAt)} by ${who(data?.names ?? {}, open.printedBy, userId)}` },
                { term: 'Cleared', value: open.clearedAt ? shortDate(open.clearedAt) : '—' },
                { term: 'Voided', value: open.voidedAt ? `${shortDate(open.voidedAt)} — ${open.voidReason ?? ''}` : '—' },
                { term: 'Reversal', value: open.reversalMode === 'VOID_IN_PLACE' ? 'Payment entry voided (open period)' : open.reversalMode === 'REVERSING_ENTRY' ? 'Reversing entry in the open period' : open.reversalMode === 'MIXED' ? 'Voided + reversing entries' : '—' },
                { term: 'Sent to the bank', value: open.sentToBank ? 'In a positive-pay file' : 'Not yet' },
              ]} />
              {open.clearNote && <p className={s.blocked} style={{ marginTop: 8 }}>{open.clearNote}</p>}
              {open.replacesCheckId && <p className="t-cap" style={{ marginTop: 8 }}>Reprint of a spoiled check.</p>}
            </PanelSection>
            <PanelSection title="Bills paid">
              <KV items={open.bills.map((b) => ({ term: b.billNumber ?? 'Bill', value: <span className="tnum">{usd(b.amountCents)}</span> }))} />
              {open.memo && <p className="t-cap" style={{ marginTop: 8 }}>Memo: {open.memo}</p>}
            </PanelSection>
          </>
        )}
      </Drawer>

      {open && action && (
        <ActionDialog
          row={open}
          kind={action}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); reload(); }}
        />
      )}
    </div>
  );
}

/** Spoil / reprint only for the person who printed it, within 24 h (the server re-checks). */
function canSpoil(row: RegisterRow, userId: string | null): boolean {
  return row.status === 'PRINTED' && !!userId && row.printedBy === userId && Date.now() - new Date(row.printedAt).getTime() <= 24 * 3600_000;
}

function CheckActions({ row, userId, onAction, onMarked }: { row: RegisterRow; userId: string | null; onAction: (k: ActionKind) => void; onMarked: () => void }) {
  const outstanding = row.status === 'PRINTED' || row.status === 'ISSUED' || row.status === 'MAILED';
  const spoilable = canSpoil(row, userId);
  const [busy, setBusy] = useState(false);
  const mark = async (to: 'issue') => {
    setBusy(true);
    const res = await api.post<{ ok: boolean }>(`/api/ap/checks/${row.id}`, { action: to });
    setBusy(false);
    if (res.error) toast.error(res.error.error);
    else { toast(`Check ${row.checkNumber} marked handed out.`); onMarked(); }
  };
  if (!outstanding) return <span className="t-cap">{row.status === 'CLEARED' ? 'Cleared checks can’t be voided.' : 'No further actions.'}</span>;
  return (
    <div className="btn-row">
      {row.status === 'PRINTED' && <Button onClick={() => void mark('issue')} disabled={busy}>Handed out</Button>}
      {row.status !== 'MAILED' && <Button onClick={() => onAction('mail')}>Mailed</Button>}
      {spoilable && <Button onClick={() => onAction('reprint')}>Reprint</Button>}
      {spoilable && <Button onClick={() => onAction('spoil')}>Spoil</Button>}
      <Button variant="danger" onClick={() => onAction('void')}>Void</Button>
      {row.status === 'PRINTED' && !spoilable && (
        <span className="t-cap">Only the person who printed this check can spoil or reprint it, within 24 hours. Void it instead.</span>
      )}
    </div>
  );
}

function ActionDialog({ row, kind, onClose, onDone }: { row: RegisterRow; kind: ActionKind; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [voidDate, setVoidDate] = useState(todayLocal());
  const [tracking, setTracking] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const needsReason = kind !== 'mail';
  const ready = !needsReason || reason.trim().length >= 3;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      if (kind === 'reprint') {
        const tab = window.open('', '_blank');
        const h = await postForFile(`/api/ap/checks/${row.id}`, { action: 'reprint', reason: reason.trim() }, `check-${row.checkNumber}-reprint.pdf`, tab);
        toast(`Check ${row.checkNumber} spoiled and reprinted as ${h.get('X-Check-First') ?? 'the next number'}.`);
      } else {
        const body = kind === 'void' ? { action: 'void', reason: reason.trim(), voidDate } : kind === 'spoil' ? { action: 'spoil', reason: reason.trim() } : { action: 'mail', tracking: tracking.trim() || null };
        const res = await api.post<{ mode?: string }>(`/api/ap/checks/${row.id}`, body);
        if (res.error) throw new Error(res.error.error);
        toast(
          kind === 'void'
            ? `Check ${row.checkNumber} voided. ${res.data?.mode === 'REVERSING_ENTRY' ? 'A reversing entry posted in the open period.' : 'The payment entry was voided.'} The bills are open again.`
            : kind === 'spoil'
              ? `Check ${row.checkNumber} spoiled. Its bills are back under Print checks.`
              : `Check ${row.checkNumber} marked mailed.`,
        );
      }
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const title = kind === 'void' ? `Void check ${row.checkNumber}?` : kind === 'spoil' ? `Spoil check ${row.checkNumber}?` : kind === 'reprint' ? `Reprint check ${row.checkNumber}?` : `Mark check ${row.checkNumber} mailed`;
  const verb = kind === 'void' ? `Void ${row.checkNumber}` : kind === 'spoil' ? `Spoil ${row.checkNumber}` : kind === 'reprint' ? 'Spoil and reprint' : 'Mark mailed';
  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      title={title}
      role={kind === 'void' ? 'alertdialog' : 'dialog'}
      dismissOnScrim={false}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant={kind === 'void' ? 'danger' : 'primary'} onClick={() => void submit()} disabled={!ready || busy}>{busy ? 'Working…' : verb}</Button>
        </>
      }
      footNote={
        kind === 'void'
          ? 'Voiding reverses the payment: if its month is still open the entry is voided; if the month is closed, a reversing entry posts on the void date. The bills reopen and can be paid again.'
          : kind === 'spoil'
            ? 'Use for a check that was never handed out (jam, misprint). The number is used up and nothing posts.'
            : kind === 'reprint'
              ? 'The old number is spoiled and the same bills print on the next number.'
              : undefined
      }
    >
      <p>{row.payeeName} · <span className="tnum">{usd(row.amountCents)}</span> · dated {shortDate(row.checkDate)}</p>
      {needsReason && (
        <Field label="Reason" help="Kept in the audit trail.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} autoFocus />
        </Field>
      )}
      {kind === 'void' && (
        <Field label="Void date" help="Defaults to today. Must be on or after the check date.">
          <Input type="date" value={voidDate} min={row.checkDate} max={todayLocal()} onChange={(e) => setVoidDate(e.target.value)} />
        </Field>
      )}
      {kind === 'mail' && (
        <Field label="Tracking or note (optional)">
          <Input value={tracking} onChange={(e) => setTracking(e.target.value)} maxLength={120} />
        </Field>
      )}
      {err && <p className={s.blocked} role="alert">{err}</p>}
    </Dialog>
  );
}
