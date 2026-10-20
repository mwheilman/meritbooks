'use client';

/**
 * Reconciliation workspace for one lender statement / floor check (FPB §3.10):
 *   Run match → work the lanes (needs attention · matched · balance differs ·
 *   lender only · Books only · resolved) → resolve each exception with a note →
 *   Prepare (refused while blocking lines remain — they're highlighted) → a
 *   different person Signs off. Lender-coded sold-and-unpaid units that Books still
 *   shows in stock are Books errors: a red "record the sale" callout per unit.
 */

import { useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { AlertOctagon, ArrowLeft, ArrowRight, CheckCircle2, FileSearch, Loader2, Play, RotateCcw, ShieldCheck } from 'lucide-react';
import { clsx } from 'clsx';
import { PageHeader } from '@/components/ui';
import type { MatchResult } from '@/lib/dealer/engine/statement-match';
import type { StatementMatchStatus } from '@/lib/dealer/types';
import { MATCH_METHOD, NOTE_STATUS, STATEMENT_KIND, STATEMENT_MATCH, STATEMENT_STATUS, hintOf, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { explainDealerError, type DealerApiError } from '@/lib/dealer/ui/errors';
import { dealerMutate, nameOf, useDealerList, useDealerQuery, useNames } from '../../_lib/use-dealer';
import { useDealerPack } from '../../_components/dealer-shell';
import { DealerTable, Segments, TableToolbar, type DealerColumn } from '../../_components/dealer-table';
import { ConfirmDialog, Field, Modal, TextArea } from '../../_components/forms';
import { ErrorPanel, Money, Notice, Pill, Section } from '../../_components/ui';
import { actorLabel, invalidateNoteRefs, useMe, useNoteRefs } from '../../floor-plan/_lib/hooks';
import type { LenderStatementLine, StatementDetail } from '../../floor-plan/_lib/types';
import { NoteLink, UnitLink } from '../../floor-plan/_components/bits';

type Lane = 'ATTENTION' | StatementMatchStatus | 'ALL';
const ATTENTION = 'UNMATCHED,VARIANCE,LENDER_ONLY,BOOKS_ONLY';
const LANE_FILTER: Record<Lane, string | null> = {
  ATTENTION,
  UNMATCHED: 'UNMATCHED',
  MATCHED: 'MATCHED',
  VARIANCE: 'VARIANCE',
  LENDER_ONLY: 'LENDER_ONLY',
  BOOKS_ONLY: 'BOOKS_ONLY',
  RESOLVED: 'RESOLVED',
  ALL: null,
};
const RESOLVABLE = new Set<StatementMatchStatus>(['UNMATCHED', 'VARIANCE', 'LENDER_ONLY', 'BOOKS_ONLY']);

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Books balance for a line (the lender's balance minus the variance; Books-only rows carry it in variance). */
function booksBalance(l: LenderStatementLine): number | null {
  if (l.match_status === 'BOOKS_ONLY') return l.variance_cents;
  if (!l.matched_note_id) return null;
  return (l.current_cents ?? 0) - l.variance_cents;
}

export function ReconciliationWorkspace({ id }: { id: string }) {
  const { locationId, settings } = useDealerPack();
  const me = useMe();
  const detail = useDealerQuery<StatementDetail>('/api/dealer/statement-detail', { id });
  const d = detail.data;
  const st = d?.statement ?? null;
  const tol = d?.toleranceCents ?? settings?.statement_tolerance_cents ?? 100;
  const lender = useNames('vendors', [d?.line?.lender_vendor_id]);

  const [lane, setLane] = useState<Lane>('ATTENTION');
  const list = useDealerList<LenderStatementLine>('/api/dealer/lender-statements/lines', {
    sort: 'line_number',
    dir: 'asc',
    filters: { statement_id: id, match_status: ATTENTION },
  });
  const { setFilter } = list;
  useEffect(() => {
    setFilter('match_status', LANE_FILTER[lane]);
  }, [lane, setFilter]);

  const rows = list.data?.rows ?? [];
  const [refV, setRefV] = useState(0);
  const { refs } = useNoteRefs([...rows.map((r) => r.matched_note_id), ...(d?.sauOpenNoteIds ?? []).map((t) => t.noteId)], refV);

  const [busy, setBusy] = useState<null | 'match' | 'prepare' | 'approve' | 'reopen'>(null);
  const [lastMatch, setLastMatch] = useState<MatchResult | null>(null);
  const [blocking, setBlocking] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<DealerApiError | null>(null);
  const [confirm, setConfirm] = useState<null | 'prepare' | 'approve' | 'reopen'>(null);
  const [resolveLine, setResolveLine] = useState<LenderStatementLine | null>(null);

  const editable = st?.status === 'IMPORTED' || st?.status === 'MATCHING';

  function reload() {
    invalidateNoteRefs();
    setRefV((v) => v + 1);
    void detail.refetch();
    void list.refetch();
  }

  async function act(kind: 'match' | 'prepare' | 'approve' | 'reopen') {
    if (!locationId) return;
    setBusy(kind);
    setActionError(null);
    const path = { match: 'match', prepare: 'prepare', approve: 'approve', reopen: 'reopen' }[kind];
    const ok = { match: 'Matched to Books', prepare: 'Prepared — ready for sign-off', approve: 'Reconciliation signed off', reopen: 'Reopened for matching' }[kind];
    const res = await dealerMutate<MatchResult>('post', `/api/dealer/lender-statements/${path}`, locationId, { statementId: id }, ok);
    setBusy(null);
    setConfirm(null);
    if (res.error) {
      setActionError(res.error);
      const ids = rec(res.error.details).lineIds;
      if (kind === 'prepare' && Array.isArray(ids)) {
        setBlocking(new Set(ids as string[]));
        setLane('ATTENTION');
      }
      return;
    }
    if (kind === 'match' && res.data) {
      setLastMatch(res.data);
      setBlocking(new Set());
      setLane(res.data.summary.lenderOnly + res.data.summary.booksOnly + res.data.summary.variance > 0 ? 'ATTENTION' : 'MATCHED');
    }
    if (kind === 'prepare') setBlocking(new Set());
    reload();
  }

  if (detail.error) {
    return (
      <div>
        <BackLink />
        <div className="card">
          <ErrorPanel error={detail.error} onRetry={detail.refetch} />
        </div>
      </div>
    );
  }
  if (!d || !st) {
    return (
      <div>
        <BackLink />
        <div className="mb-6 h-8 w-72 animate-pulse rounded bg-slate-800" />
        <div className="card mb-6 h-32 animate-pulse" />
        <div className="card h-64 animate-pulse" />
      </div>
    );
  }

  const lanes = d.lanes;
  const attentionCount = lanes.UNMATCHED.count + lanes.VARIANCE.count + lanes.LENDER_ONLY.count + lanes.BOOKS_ONLY.count;
  const blockingCount = lanes.UNMATCHED.count + lanes.LENDER_ONLY.count + lanes.BOOKS_ONLY.count + d.overToleranceCount;
  const totalLines = Object.values(lanes).reduce((s, l) => s + l.count, 0);
  const matchedNever = st.status === 'IMPORTED';
  const preparedByMe = !!me && st.prepared_by === me;

  const laneOptions: Array<{ value: Lane; label: string; count?: number }> = [
    { value: 'ATTENTION', label: 'Needs attention', count: attentionCount },
    { value: 'MATCHED', label: 'Matched', count: lanes.MATCHED.count },
    { value: 'VARIANCE', label: 'Balance differs', count: lanes.VARIANCE.count },
    { value: 'LENDER_ONLY', label: 'Lender only', count: lanes.LENDER_ONLY.count },
    { value: 'BOOKS_ONLY', label: 'Books only', count: lanes.BOOKS_ONLY.count },
    { value: 'RESOLVED', label: 'Resolved', count: lanes.RESOLVED.count },
    ...(lanes.UNMATCHED.count ? [{ value: 'UNMATCHED' as Lane, label: 'Not matched yet', count: lanes.UNMATCHED.count }] : []),
    { value: 'ALL', label: 'All', count: totalLines },
  ];

  const cols: DealerColumn<LenderStatementLine>[] = [
    { key: 'n', header: '#', sortKey: 'line_number', align: 'right', render: (l) => <span className="font-mono tabular-nums text-slate-500">{l.line_number ?? '—'}</span> },
    {
      key: 'inv',
      header: 'Lender invoice #',
      render: (l) => (
        <div>
          <span className="font-mono tabular-nums text-white">{l.lender_invoice_number ?? '—'}</span>
          {(l.serial_number || l.model) && (
            <div className="text-2xs text-slate-500">
              {[l.serial_number, l.model].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'lender',
      header: 'Lender balance',
      sortKey: 'current_cents',
      align: 'right',
      render: (l) => (l.match_status === 'BOOKS_ONLY' ? <span className="text-xs text-slate-500">Not on statement</span> : <Money cents={l.current_cents} />),
    },
    {
      key: 'books',
      header: 'Books balance',
      align: 'right',
      render: (l) => {
        const b = booksBalance(l);
        return b === null ? <span className="text-xs text-slate-500">Not in Books</span> : <Money cents={b} muted />;
      },
    },
    {
      key: 'var',
      header: 'Difference',
      sortKey: 'variance_cents',
      align: 'right',
      render: (l) => {
        if (l.match_status === 'BOOKS_ONLY' || l.match_status === 'LENDER_ONLY' || l.match_status === 'UNMATCHED') return <span className="text-slate-500">—</span>;
        const over = Math.abs(l.variance_cents) > tol;
        if (l.variance_cents === 0) return <span className="font-mono tabular-nums text-slate-500">{money(0)}</span>;
        return (
          <div className="text-right">
            <span className={clsx('font-mono tabular-nums', over ? 'text-red-300' : 'text-amber-300')}>{money(l.variance_cents)}</span>
            {over && <div className="text-2xs text-red-400">over {money(tol)} tolerance</div>}
          </div>
        );
      },
    },
    {
      key: 'how',
      header: 'Matched by',
      render: (l) => <span className="text-xs text-slate-400">{l.match_method && l.match_status !== 'BOOKS_ONLY' ? labelOf(MATCH_METHOD, l.match_method) : '—'}</span>,
    },
    {
      key: 'note',
      header: 'Books note',
      render: (l) => {
        const n = l.matched_note_id ? refs.get(l.matched_note_id) : undefined;
        if (!l.matched_note_id) return <span className="text-slate-500">—</span>;
        return (
          <div className="space-y-0.5">
            <NoteLink noteId={l.matched_note_id} invoice={n?.lender_invoice_number} />
            {n && (
              <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                {n.unit_id && <UnitLink unitId={n.unit_id} serial={n.serial_number} className="text-2xs" />}
                <span className="text-slate-500">{labelOf(NOTE_STATUS, n.status)}</span>
              </div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Result',
      render: (l) => (
        <span className="flex flex-wrap gap-1">
          <Pill label={labelOf(STATEMENT_MATCH, l.match_status)} tone={toneOf(STATEMENT_MATCH, l.match_status)} title={hintOf(STATEMENT_MATCH, l.match_status)} />
          {l.sau_flag && <Pill label="Lender says sold & unpaid" tone="danger" title={l.lender_code ? `Lender code ${l.lender_code}` : undefined} />}
        </span>
      ),
    },
    {
      key: 'res',
      header: '',
      align: 'right',
      render: (l) =>
        l.match_status === 'RESOLVED' ? (
          <span className="block max-w-[220px] truncate text-left text-xs text-slate-400" title={l.resolution ?? undefined}>
            {l.resolution}
            <span className="block text-2xs text-slate-600">{actorLabel(l.resolved_by, me)}</span>
          </span>
        ) : editable && RESOLVABLE.has(l.match_status) ? (
          <button type="button" className="btn-secondary btn-sm" onClick={() => setResolveLine(l)}>
            Resolve
          </button>
        ) : null,
    },
  ];

  const sauTasks = d.sauOpenNoteIds;

  return (
    <div>
      <BackLink />
      <PageHeader
        title={`${labelOf(STATEMENT_KIND, st.kind)} · ${dateLabel(st.statement_date)}`}
        description={`${d.line?.name ?? 'Line'}${d.line ? ` · ${nameOf(lender, d.line.lender_vendor_id)}` : ''}`}
        breadcrumbs={[{ label: 'Dealer', href: '/dealer' }, { label: 'Lender statements', href: dealerLinks.lenderStatements() }, { label: dateLabel(st.statement_date) }]}
        actions={
          <div className="flex gap-2">
            {(st.status === 'IMPORTED' || st.status === 'MATCHING') && (
              <button
                type="button"
                className={clsx('btn-sm inline-flex items-center gap-1.5', matchedNever ? 'btn-primary' : 'btn-secondary')}
                disabled={!!busy}
                onClick={() => void act('match')}
              >
                {busy === 'match' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} {matchedNever ? 'Run match' : 'Run match again'}
              </button>
            )}
            {st.status === 'MATCHING' && (
              <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => setConfirm('prepare')}>
                <CheckCircle2 size={13} /> Prepare
              </button>
            )}
            {st.status === 'PREPARED' && (
              <>
                <button type="button" className="btn-secondary btn-sm inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => setConfirm('reopen')}>
                  <RotateCcw size={13} /> Reopen
                </button>
                <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={!!busy} onClick={() => setConfirm('approve')}>
                  <ShieldCheck size={13} /> Sign off
                </button>
              </>
            )}
          </div>
        }
      />

      <section className="card mb-6 p-6" aria-label="Statement summary">
        <div className="flex flex-wrap items-start justify-between gap-6">
          <div>
            <div className="text-caption uppercase tracking-caps text-slate-500">Lender principal</div>
            <div className="mt-1 font-mono text-display tabular-nums text-white">{money(st.footer_principal_cents)}</div>
            <div className="mt-1 text-xs text-slate-400">
              {st.footer_line_count ?? totalLines - lanes.BOOKS_ONLY.count} lines
              {st.footer_interest_cents !== null && (
                <>
                  {' '}· interest <span className="font-mono tabular-nums">{money(st.footer_interest_cents)}</span>
                </>
              )}
              {st.footer_fees_cents !== null && (
                <>
                  {' '}· fees <span className="font-mono tabular-nums">{money(st.footer_fees_cents)}</span>
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 text-body-sm sm:grid-cols-4">
            <div>
              <div className="text-caption uppercase tracking-caps text-slate-500">Status</div>
              <div className="mt-1">
                <Pill label={labelOf(STATEMENT_STATUS, st.status)} tone={toneOf(STATEMENT_STATUS, st.status)} />
              </div>
            </div>
            <div>
              <div className="text-caption uppercase tracking-caps text-slate-500">Prepared</div>
              <div className="mt-1 text-slate-300">{st.prepared_by ? `${actorLabel(st.prepared_by, me)} · ${dateLabel(st.prepared_at?.slice(0, 10))}` : '—'}</div>
            </div>
            <div>
              <div className="text-caption uppercase tracking-caps text-slate-500">Signed off</div>
              <div className="mt-1 text-slate-300">{st.approved_by ? `${actorLabel(st.approved_by, me)} · ${dateLabel(st.approved_at?.slice(0, 10))}` : '—'}</div>
            </div>
            <div>
              <div className="text-caption uppercase tracking-caps text-slate-500">Tolerance</div>
              <div className="mt-1 font-mono tabular-nums text-slate-300">{money(tol)}</div>
            </div>
          </div>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-5">
          {(
            [
              ['MATCHED', 'Matched', lanes.MATCHED.lenderCents, 'success'],
              ['VARIANCE', 'Balance differs', lanes.VARIANCE.absVarianceCents, d.overToleranceCount ? 'danger' : lanes.VARIANCE.count ? 'warning' : 'neutral'],
              ['LENDER_ONLY', 'Lender only', lanes.LENDER_ONLY.lenderCents, lanes.LENDER_ONLY.count ? 'danger' : 'neutral'],
              ['BOOKS_ONLY', 'Books only', lanes.BOOKS_ONLY.booksCents, lanes.BOOKS_ONLY.count ? 'danger' : 'neutral'],
              ['RESOLVED', 'Resolved', lanes.RESOLVED.lenderCents, 'neutral'],
            ] as Array<[StatementMatchStatus, string, number, 'success' | 'warning' | 'danger' | 'neutral']>
          ).map(([key, label, cents, tone]) => (
            <button
              key={key}
              type="button"
              onClick={() => setLane(key)}
              aria-pressed={lane === key}
              className={clsx('bg-surface-900 px-4 py-3 text-left transition-colors duration-fast hover:bg-surface-850 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500/60', lane === key && 'bg-surface-850')}
            >
              <div className="text-caption uppercase tracking-caps text-slate-500">{label}</div>
              <div className={clsx('mt-1 font-mono text-lg tabular-nums', tone === 'danger' ? 'text-red-300' : tone === 'warning' ? 'text-amber-300' : 'text-white')}>{lanes[key].count}</div>
              <div className="font-mono text-2xs tabular-nums text-slate-500">
                {key === 'VARIANCE' ? `${money(cents)} apart${d.overToleranceCount ? ` · ${d.overToleranceCount} over tolerance` : ''}` : money(cents)}
              </div>
            </button>
          ))}
        </div>
        {st.notes && <p className="mt-4 text-sm text-slate-400">{st.notes}</p>}
      </section>

      {matchedNever && (
        <Notice tone="info" action={<button type="button" className="btn-primary btn-sm" onClick={() => void act('match')} disabled={!!busy}>Run match</button>}>
          This statement foots. Run the match to pair each line with a Books note — by lender invoice #, then serial, then model and amount.
        </Notice>
      )}
      {lastMatch && (
        <Notice tone={lastMatch.summary.lenderOnly + lastMatch.summary.booksOnly + lastMatch.summary.overTolerance > 0 ? 'warning' : 'info'}>
          Match finished: {lastMatch.summary.matched} matched, {lastMatch.summary.variance} with a different balance ({lastMatch.summary.overTolerance} over tolerance), {lastMatch.summary.lenderOnly} only on
          the lender’s side, {lastMatch.summary.booksOnly} only in Books.
        </Notice>
      )}
      {st.status === 'APPROVED' && (
        <Notice tone="info">
          Signed off by {actorLabel(st.approved_by, me).toLowerCase()} on {dateLabel(st.approved_at?.slice(0, 10))}. This reconciliation is closed.
        </Notice>
      )}
      {st.status === 'PREPARED' && preparedByMe && <Notice tone="warning">You prepared this reconciliation, so a different person must sign it off.</Notice>}
      {actionError && (
        <div className="mb-4">
          <ErrorPanel error={actionError} compact />
          {blocking.size > 0 && (
            <p className="mt-2 text-xs text-red-300">
              {blocking.size} line{blocking.size === 1 ? '' : 's'} still need a resolution — they’re outlined in red under “Needs attention”.
            </p>
          )}
        </div>
      )}

      {sauTasks.length > 0 && (
        <section className="mb-6 rounded-xl border border-red-500/40 bg-red-500/[0.05]" aria-label="Books errors">
          <header className="flex items-start gap-3 border-b border-red-500/20 px-5 py-4">
            <AlertOctagon size={16} className="mt-0.5 shrink-0 text-red-400" />
            <div>
              <h2 className="text-heading text-red-100">Books error: record the sale</h2>
              <p className="mt-0.5 text-xs text-red-200/80">
                The lender coded {sauTasks.length === 1 ? 'this unit' : 'these units'} sold and unpaid, but Books still shows {sauTasks.length === 1 ? 'it' : 'them'} in stock. Record the sale so the payoff is
                proposed — until then {sauTasks.length === 1 ? 'it’s' : 'they’re'} sold out of trust.
              </p>
            </div>
          </header>
          <ul className="divide-y divide-red-500/10">
            {sauTasks.map((t) => {
              const n = refs.get(t.noteId);
              return (
                <li key={t.lineId} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm">
                  <span className="text-red-100">
                    Unit <span className="font-mono tabular-nums">{n?.serial_number ?? '…'}</span>
                    {n?.model ? ` · ${n.model}` : ''} — note <NoteLink noteId={t.noteId} invoice={n?.lender_invoice_number} /> · <span className="font-mono tabular-nums">{money(n?.principal_balance_cents)}</span>
                  </span>
                  {n?.unit_id ? (
                    <Link href={dealerLinks.unit(n.unit_id)} className="inline-flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-100 hover:bg-red-500/20">
                      Record the sale <ArrowRight size={12} />
                    </Link>
                  ) : (
                    <Link href={dealerLinks.note(t.noteId)} className="text-xs text-red-200 hover:underline">
                      Open note →
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <Section
        title="Lines"
        description={
          editable
            ? blockingCount > 0
              ? `${blockingCount} line${blockingCount === 1 ? '' : 's'} must be resolved before this can be prepared: lender-only, Books-only, not matched, or a balance over the ${money(tol)} tolerance.`
              : 'Everything that blocks preparation is matched or resolved.'
            : 'Read only — reopen a prepared reconciliation to change it.'
        }
      >
        <TableToolbar>
          <Segments<Lane> label="Match lane" value={lane} onChange={setLane} options={laneOptions} />
          <div className="relative ml-auto w-full max-w-xs">
            <FileSearch size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" aria-hidden />
            <input
              type="search"
              aria-label="Search lines by invoice #, serial or model"
              placeholder="Search invoice #, serial, model…"
              value={list.state.search}
              onChange={(e) => list.setSearch(e.target.value)}
              className="input w-full pl-8"
            />
          </div>
        </TableToolbar>
        <DealerTable<LenderStatementLine>
          caption="Statement lines"
          columns={cols}
          rows={rows}
          isLoading={list.isLoading}
          error={list.error}
          onRetry={list.refetch}
          sort={list.state.sort}
          dir={list.state.dir}
          onSort={list.setSort}
          keyboard={false}
          rowClassName={(l) =>
            blocking.has(l.id)
              ? 'outline outline-1 -outline-offset-1 outline-red-500/60 bg-red-500/[0.06]'
              : l.sau_flag
                ? 'bg-red-500/[0.04]'
                : l.match_status === 'VARIANCE' && Math.abs(l.variance_cents) > tol
                  ? 'bg-amber-500/[0.04]'
                  : undefined
          }
          page={list.data?.page}
          perPage={list.data?.perPage}
          total={list.data?.total}
          noun="lines"
          onPageChange={list.setPage}
          empty={{
            icon: lane === 'ATTENTION' ? CheckCircle2 : FileSearch,
            title: lane === 'ATTENTION' ? (matchedNever ? 'Not matched yet' : 'Nothing needs attention') : 'No lines in this lane',
            description:
              lane === 'ATTENTION'
                ? matchedNever
                  ? 'Run the match to compare each line with Books.'
                  : 'Every line is matched or resolved. Prepare the reconciliation when you’re ready.'
                : 'Pick another lane above.',
          }}
        />
      </Section>

      {locationId && (
        <ResolveModal
          line={resolveLine}
          onClose={() => setResolveLine(null)}
          locationId={locationId}
          onDone={() => {
            setBlocking((b) => {
              const n = new Set(b);
              if (resolveLine) n.delete(resolveLine.id);
              return n;
            });
            reload();
          }}
        />
      )}

      <ConfirmDialog
        open={confirm === 'prepare'}
        onClose={() => setConfirm(null)}
        title="Prepare reconciliation"
        confirmLabel="Prepare"
        busy={busy === 'prepare'}
        body={
          <>
            <p>Marks this reconciliation as prepared by you and sends it for sign-off. Lines can’t be changed while it’s prepared.</p>
            {blockingCount > 0 && <p className="mt-2 text-amber-200/90">{blockingCount} line{blockingCount === 1 ? ' still blocks' : 's still block'} preparation — it will be refused until they’re resolved.</p>}
          </>
        }
        error={confirm === 'prepare' && actionError ? <p className="text-xs text-red-300">{explainDealerError(actionError).message}</p> : null}
        onConfirm={() => act('prepare')}
      />
      <ConfirmDialog
        open={confirm === 'approve'}
        onClose={() => setConfirm(null)}
        title="Sign off reconciliation"
        confirmLabel="Sign off"
        busy={busy === 'approve'}
        body={
          <>
            <p>Confirms the lender’s {labelOf(STATEMENT_KIND, st.kind).toLowerCase()} of {dateLabel(st.statement_date)} agrees with Books, with every difference explained.</p>
            <p className="mt-2 text-slate-400">A different person than the preparer must sign off.</p>
            {preparedByMe && <p className="mt-2 text-red-300">You prepared it, so your sign-off will be refused.</p>}
          </>
        }
        onConfirm={() => act('approve')}
      />
      <ConfirmDialog
        open={confirm === 'reopen'}
        onClose={() => setConfirm(null)}
        title="Reopen reconciliation"
        confirmLabel="Reopen"
        busy={busy === 'reopen'}
        body={<p>Sends it back to matching and clears the preparer, so lines can be changed and it can be prepared again.</p>}
        onConfirm={() => act('reopen')}
      />
    </div>
  );
}

const QUICK = [
  'Timing — the lender posted this after the statement date.',
  'Recorded the missing flooring in Books.',
  'Paid off — the lender hadn’t applied the payment yet.',
  'Lender error — disputed with the lender.',
];

function ResolveModal({ line, onClose, locationId, onDone }: { line: LenderStatementLine | null; onClose: () => void; locationId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DealerApiError | null>(null);
  const tid = useId();
  useEffect(() => {
    if (line) {
      setText('');
      setError(null);
    }
  }, [line]);
  const trimmed = text.trim();
  const invalid = trimmed.length === 0 || trimmed.length > 1000;

  async function save() {
    if (!line || invalid) return;
    setBusy(true);
    setError(null);
    const res = await dealerMutate('post', '/api/dealer/lender-statements/resolve-line', locationId, { lineId: line.id, resolution: trimmed }, 'Line resolved');
    setBusy(false);
    if (res.error) setError(res.error);
    else {
      onDone();
      onClose();
    }
  }

  return (
    <Modal
      open={!!line}
      onClose={busy ? () => undefined : onClose}
      title="Resolve this line"
      description={line ? `${labelOf(STATEMENT_MATCH, line.match_status)} · lender invoice ${line.lender_invoice_number ?? '—'}${line.serial_number ? ` · serial ${line.serial_number}` : ''}` : undefined}
      width="md"
      footer={
        <>
          <button type="button" className="btn-secondary btn-sm" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn-primary btn-sm inline-flex items-center gap-1.5" disabled={busy || invalid} onClick={() => void save()}>
            {busy && <Loader2 size={13} className="animate-spin" />} Resolve
          </button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-slate-300">
          Say what explains the difference, or what you did about it. The note is kept with the reconciliation for whoever signs it off. If Books is wrong, fix Books first (record the sale, floor the unit,
          release the payoff).
        </p>
        <div className="flex flex-wrap gap-1.5" aria-label="Common resolutions">
          {QUICK.map((q) => (
            <button key={q} type="button" className="rounded-full border border-slate-700 px-2.5 py-1 text-2xs text-slate-300 hover:border-slate-500 hover:text-white" onClick={() => setText((t) => (t.trim() ? `${t.trim()} ${q}` : q))}>
              {q}
            </button>
          ))}
        </div>
        <Field label="Resolution" htmlFor={tid} required error={trimmed.length > 1000 ? 'Keep it under 1,000 characters.' : null}>
          <TextArea id={tid} value={text} onChange={setText} rows={4} maxLength={1000} />
        </Field>
        {error && <ErrorPanel error={error} compact />}
      </div>
    </Modal>
  );
}

function BackLink() {
  return (
    <Link href={dealerLinks.lenderStatements()} className="mb-3 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
      <ArrowLeft size={12} /> All statements
    </Link>
  );
}
