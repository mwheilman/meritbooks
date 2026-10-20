'use client';

/**
 * Manufacturer credit-matching workspace (FPB §5 A3 — propose; auto-settle only
 * exact). "Find matches" runs the matcher over this statement's open lines and this
 * manufacturer's open claims; each suggestion shows its confidence, how it was found
 * and any short-pay, and a person accepts (posts the credit to the claim), rejects
 * (leaves the line unmatched — this session) or ignores the line. Lines without a
 * suggestion can be applied to a hand-picked claim. Keyboard mirrors the bank feed:
 * j / k move, a accept, r reject, i ignore.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Keyboard, Loader2, Sparkles, Zap } from 'lucide-react';
import { PageHeader } from '@/components/ui';
import { OEM_STATEMENT_STATUS, labelOf, toneOf } from '@/lib/dealer/ui/labels';
import { dateLabel, money } from '@/lib/dealer/ui/format';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { addToast } from '@/hooks/use-toast';
import { explainDealerError } from '@/lib/dealer/ui/errors';
import {
  proposalFromLine,
  type OemMatchProposal,
  type OemMatchResponse,
  type OemStatementLineRow,
  type OemStatementRow,
} from '@/lib/dealer/ui/claims';
import { dealerMutate, dealerSend, nameOf, useDealerList, useDealerQuery, useNames, type DealerApiError } from '../../../_lib/use-dealer';
import { useDealerPack } from '../../../_components/dealer-shell';
import { ConfirmDialog, DateInput, Field } from '../../../_components/forms';
import { Empty, ErrorPanel, Mono, Notice, Pill, Spinner } from '../../../_components/ui';
import { StatementLine } from './statement-line';
import { useOpenClaims, type ClaimCandidate } from './use-open-claims';

export function MatchingWorkspace({ statementId }: { statementId: string }) {
  const { locationId } = useDealerPack();
  const st = useDealerQuery<OemStatementRow>('/api/dealer/record', { kind: 'oem_statement', id: statementId });
  const statement = st.data;
  const lines = useDealerList<OemStatementLineRow>('/api/dealer/oem-statements/lines', { sort: 'line_number', dir: 'asc', perPage: 100, filters: { statement_id: statementId } });
  const claims = useOpenClaims(statement?.oem_vendor_id ?? null);
  const vendors = useNames('vendors', [statement?.oem_vendor_id]);
  const manufacturer = statement ? nameOf(vendors, statement.oem_vendor_id) : '';

  const [proposals, setProposals] = useState<Map<string, OemMatchProposal>>(new Map());
  const [autoSettled, setAutoSettled] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState<DealerApiError | null>(null);
  const [lastRun, setLastRun] = useState<{ proposals: number; auto: number } | null>(null);
  const [busyLine, setBusyLine] = useState<string | null>(null);
  const [ignoreLine, setIgnoreLine] = useState<OemStatementLineRow | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [applyDate, setApplyDate] = useState('');
  const [focus, setFocus] = useState(0);
  const itemRefs = useRef<Array<HTMLLIElement | null>>([]);

  useEffect(() => {
    if (statement && !applyDate) setApplyDate(statement.statement_date);
  }, [statement, applyDate]);

  const rows = useMemo(() => lines.data?.rows ?? [], [lines.data]);

  /** The live suggestion for a line: this session's matcher run, else what's persisted. */
  const proposalFor = useCallback(
    (l: OemStatementLineRow): OemMatchProposal | null => {
      if (l.match_status === 'SETTLED' || l.match_status === 'IGNORED' || rejected.has(l.id)) return null;
      const fresh = proposals.get(l.id);
      if (fresh) {
        const c = claims.byId.get(fresh.claimId);
        return c ? { ...fresh, shortPayCents: Math.max(0, c.openCents - l.amount_cents) } : fresh;
      }
      const cid = l.matched_warranty_claim_id ?? l.matched_incentive_claim_id;
      return proposalFromLine(l, cid ? claims.byId.get(cid)?.openCents ?? null : null);
    },
    [proposals, rejected, claims.byId],
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([lines.refetch(), claims.refetch(), st.refetch()]);
  }, [lines, claims, st]);

  async function findMatches() {
    if (!locationId) return;
    setMatching(true);
    setMatchError(null);
    const res = await dealerSend<OemMatchResponse>('post', '/api/dealer/oem-statements/match', locationId, { statementId });
    setMatching(false);
    if (res.error || !res.data) {
      setMatchError(res.error);
      return;
    }
    setProposals(new Map(res.data.proposals.map((p) => [p.lineId, p])));
    setAutoSettled((s) => new Set([...s, ...res.data!.autoSettled]));
    setRejected(new Set());
    setLastRun({ proposals: res.data.proposals.length - res.data.autoSettled.length, auto: res.data.autoSettled.length });
    await refreshAll();
  }

  async function settle(line: OemStatementLineRow, pick?: ClaimCandidate) {
    if (!locationId || !/^\d{4}-\d{2}-\d{2}$/.test(applyDate)) return;
    const p = pick ? null : proposalFor(line);
    const claimKind = pick?.kind ?? p?.claimKind;
    const claimId = pick?.id ?? p?.claimId;
    if (!claimKind || !claimId) return;
    setBusyLine(line.id);
    const res = await dealerMutate('post', '/api/dealer/oem-statements/settle-line', locationId, { lineId: line.id, date: applyDate, claimKind, claimId }, `${money(line.amount_cents)} applied to the claim`);
    setBusyLine(null);
    if (!res.error) await refreshAll();
  }

  async function ignore(line: OemStatementLineRow) {
    if (!locationId) return;
    setBusyLine(line.id);
    const res = await dealerMutate('post', '/api/dealer/oem-statements/ignore-line', locationId, { lineId: line.id }, 'Line ignored');
    setBusyLine(null);
    setIgnoreLine(null);
    if (!res.error) await lines.refetch();
  }

  const exact = rows.filter((l) => {
    const p = proposalFor(l);
    return p && p.method === 'CLAIM_NUMBER' && p.shortPayCents === 0 && claims.byId.has(p.claimId);
  });

  async function applyAllExact() {
    if (!locationId) return;
    setBulkBusy(true);
    let ok = 0;
    let failed: string | null = null;
    for (const l of exact) {
      const p = proposalFor(l)!;
      const res = await dealerSend('post', '/api/dealer/oem-statements/settle-line', locationId, { lineId: l.id, date: applyDate, claimKind: p.claimKind, claimId: p.claimId });
      if (res.error) {
        failed = `${explainDealerError(res.error).title}. ${explainDealerError(res.error).message}`;
        break;
      }
      ok += 1;
    }
    setBulkBusy(false);
    setBulkOpen(false);
    addToast(failed ? 'error' : 'success', failed ? `Applied ${ok} of ${exact.length}. Stopped: ${failed}` : `Applied ${ok} exact match${ok === 1 ? '' : 'es'}`);
    await refreshAll();
  }

  // Keyboard: j / k move, a accept, r reject, i ignore (bank-feed muscle memory).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('[role="dialog"]')) return;
      if (rows.length === 0) return;
      const line = rows[Math.min(focus, rows.length - 1)];
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus((f) => Math.min(f + 1, rows.length - 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus((f) => Math.max(f - 1, 0));
      } else if (e.key === 'a' && line && proposalFor(line) && !busyLine) {
        e.preventDefault();
        void settle(line);
      } else if (e.key === 'r' && line && proposalFor(line)) {
        e.preventDefault();
        setRejected((s) => new Set([...s, line.id]));
      } else if (e.key === 'i' && line && line.match_status !== 'SETTLED' && line.match_status !== 'IGNORED') {
        e.preventDefault();
        setIgnoreLine(line);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    itemRefs.current[focus]?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  if (!locationId) return null;
  if (st.error) {
    return (
      <div>
        <BackLink />
        <div className="card">
          <ErrorPanel error={st.error} onRetry={() => void st.refetch()} />
        </div>
      </div>
    );
  }
  if (!statement) return <Spinner label="Loading the statement…" />;

  const credits = rows.filter((l) => l.amount_cents > 0);
  const applied = rows.filter((l) => l.match_status === 'SETTLED');
  const waiting = rows.filter((l) => proposalFor(l)).length;
  const unmatchedCredits = credits.filter((l) => l.match_status !== 'SETTLED' && l.match_status !== 'IGNORED' && !proposalFor(l));
  const sum = (ls: OemStatementLineRow[]) => ls.reduce((s, l) => s + l.amount_cents, 0);

  return (
    <div>
      <BackLink />
      <PageHeader
        title={`${manufacturer || 'Manufacturer'} statement · ${dateLabel(statement.statement_date)}`}
        description="Apply each credit to the claim it pays. Suggestions are proposals — nothing posts until you accept."
        actions={
          <>
            {exact.length > 0 && (
              <button type="button" className="btn-secondary btn-sm" onClick={() => setBulkOpen(true)}>
                <Zap size={13} /> Apply {exact.length} exact match{exact.length === 1 ? '' : 'es'}
              </button>
            )}
            <button type="button" className="btn-primary btn-sm" onClick={() => void findMatches()} disabled={matching || rows.length === 0}>
              {matching ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Find matches
            </button>
          </>
        }
      />

      <div className="card mb-4 grid grid-cols-2 divide-slate-800 sm:grid-cols-4 sm:divide-x">
        <Stat label="Statement total" value={money(statement.footer_total_cents)} sub={<Pill label={labelOf(OEM_STATEMENT_STATUS, statement.status)} tone={toneOf(OEM_STATEMENT_STATUS, statement.status)} />} />
        <Stat label="Applied" value={money(sum(applied))} sub={`${applied.length} of ${credits.length} credit lines`} tone="success" />
        <Stat label="Suggestions to review" value={String(waiting)} sub="Accept or reject each" tone={waiting ? 'ai' : undefined} />
        <Stat label="Credits with no match" value={money(sum(unmatchedCredits))} sub={`${unmatchedCredits.length} line${unmatchedCredits.length === 1 ? '' : 's'} — pick the claim`} tone={unmatchedCredits.length ? 'warning' : undefined} />
      </div>

      {matchError && <ErrorPanel error={matchError} onRetry={() => void findMatches()} compact />}
      {lastRun && !matchError && (
        <Notice tone="info">
          {lastRun.proposals + lastRun.auto === 0
            ? 'No matches found. Check that the claims were submitted with the manufacturer’s claim numbers, or apply credits by hand below.'
            : `${lastRun.proposals} suggestion${lastRun.proposals === 1 ? '' : 's'} to review${lastRun.auto ? `; ${lastRun.auto} applied automatically (exact claim number and amount, allowed by your autonomy setting)` : ''}.`}
        </Notice>
      )}
      {claims.error && <ErrorPanel error={claims.error} onRetry={() => void claims.refetch()} compact />}

      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-800 px-5 py-3">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Keyboard size={13} />
            <span>
              <kbd className="font-mono text-slate-300">j</kbd>/<kbd className="font-mono text-slate-300">k</kbd> move · <kbd className="font-mono text-slate-300">a</kbd> accept · <kbd className="font-mono text-slate-300">r</kbd> reject · <kbd className="font-mono text-slate-300">i</kbd> ignore
            </span>
          </div>
          <div className="w-44">
            <Field label="Apply credits on" htmlFor="apply-date" hint="Defaults to the statement date">
              <DateInput id="apply-date" value={applyDate} onChange={setApplyDate} />
            </Field>
          </div>
        </div>
        {lines.error ? (
          <ErrorPanel error={lines.error} onRetry={() => void lines.refetch()} />
        ) : lines.isLoading && rows.length === 0 ? (
          <ul className="divide-y divide-slate-800/50" aria-busy>
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="grid gap-4 px-5 py-5 lg:grid-cols-2">
                <div className="h-4 w-2/3 animate-pulse rounded bg-slate-800" />
                <div className="h-4 w-1/2 animate-pulse rounded bg-slate-800" />
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <Empty icon={Sparkles} title="This statement has no lines" description="A statement with no lines has nothing to match. Enter or import the statement again with its lines." action={<Link href={dealerLinks.oemStatements()} className="btn-secondary btn-sm">Back to statements</Link>} />
        ) : (
          <ul className="divide-y divide-slate-800/50" aria-label="Statement lines">
            {rows.map((l, i) => {
              const p = proposalFor(l);
              return (
                <StatementLine
                  key={l.id}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  line={l}
                  proposal={p}
                  claim={p ? claims.byId.get(p.claimId) ?? null : null}
                  candidates={claims.list}
                  autoApplied={autoSettled.has(l.id)}
                  focused={i === focus}
                  busy={busyLine === l.id || bulkBusy}
                  onFocus={() => setFocus(i)}
                  onAccept={() => void settle(l)}
                  onReject={() => setRejected((s) => new Set([...s, l.id]))}
                  onIgnore={() => setIgnoreLine(l)}
                  onPick={(c) => void settle(l, c)}
                />
              );
            })}
          </ul>
        )}
        {(lines.data?.totalPages ?? 1) > 1 && (
          <div className="flex items-center justify-between border-t border-slate-800 px-5 py-3 text-xs text-slate-500">
            <span className="font-mono tabular-nums">
              Page {lines.state.page} of {lines.data?.totalPages} · {lines.data?.total} lines
            </span>
            <div className="flex gap-2">
              <button type="button" className="btn-secondary btn-sm" disabled={lines.state.page <= 1} onClick={() => { lines.setPage(lines.state.page - 1); setFocus(0); }}>
                Previous
              </button>
              <button type="button" className="btn-secondary btn-sm" disabled={lines.state.page >= (lines.data?.totalPages ?? 1)} onClick={() => { lines.setPage(lines.state.page + 1); setFocus(0); }}>
                Next
              </button>
            </div>
          </div>
        )}
      </section>
      {rejected.size > 0 && <p className="mt-3 text-xs text-slate-500">Rejected suggestions are set aside for this visit; those lines stay unapplied and can be matched by hand.</p>}

      <ConfirmDialog
        open={!!ignoreLine}
        onClose={() => setIgnoreLine(null)}
        title="Ignore this line?"
        confirmLabel="Ignore line"
        busy={!!ignoreLine && busyLine === ignoreLine.id}
        body={<p>The line ({ignoreLine ? money(ignoreLine.amount_cents) : ''}) is set aside and won’t be suggested again. Nothing posts. Use this for lines handled elsewhere, like parts invoices entered as bills.</p>}
        onConfirm={() => (ignoreLine ? ignore(ignoreLine) : undefined)}
      />
      <ConfirmDialog
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        title={`Apply ${exact.length} exact match${exact.length === 1 ? '' : 'es'}?`}
        confirmLabel="Apply all"
        busy={bulkBusy}
        body={
          <p>
            Each credit has the same claim number as its claim and pays exactly what is open — {money(exact.reduce((s, l) => s + l.amount_cents, 0))} in total, applied on{' '}
            <Mono>{dateLabel(applyDate)}</Mono> as manufacturer statement credits. Short-pays are never included.
          </p>
        }
        onConfirm={() => applyAllExact()}
      />
    </div>
  );
}

function BackLink() {
  return (
    <Link href={dealerLinks.oemStatements()} className="mb-3 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200">
      <ArrowLeft size={12} /> Manufacturer statements
    </Link>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: React.ReactNode; tone?: 'success' | 'warning' | 'ai' }) {
  return (
    <div className="p-4">
      <p className="text-caption uppercase tracking-caps text-slate-500">{label}</p>
      <p className={`mt-1 font-mono text-xl font-semibold tabular-nums ${tone === 'warning' ? 'text-amber-300' : tone === 'ai' ? 'text-indigo-300' : 'text-white'}`}>{value}</p>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
