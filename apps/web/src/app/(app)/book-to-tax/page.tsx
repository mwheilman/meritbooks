'use client';

import { useMemo, useState } from 'react';
import {
  Loader2, AlertCircle, Scale, Sparkles, Tag, Check, X, Wand2, Info, ArrowUpRight, ArrowDownRight,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';
import { HubTabs } from '../_components/hub-tabs';

// ── Types mirrored from the API responses ───────────────────────────────────────
type DifferenceType = 'PERMANENT' | 'TEMPORARY';
type TaxableEffect = 'ADD' | 'SUBTRACT';

interface M1Line {
  code: string;
  label: string;
  m1Line: string;
  differenceType: DifferenceType;
  taxableEffect: TaxableEffect;
  codeSection: string;
  amountCents: number;
}
interface M1Report {
  bookNetIncomeCents: number;
  additions: M1Line[];
  subtractions: M1Line[];
  totalAdditionsCents: number;
  totalSubtractionsCents: number;
  taxableIncomeCents: number;
  permanentNetCents: number;
  temporaryNetCents: number;
  permanentAdditionsCents: number;
  permanentSubtractionsCents: number;
  temporaryAdditionsCents: number;
  temporarySubtractionsCents: number;
  adjustmentCount: number;
  startDate: string;
  endDate: string;
  taggedAccountCount: number;
  untaggedAccountCount: number;
}

interface CatalogLine {
  code: string;
  label: string;
  m1Line: string;
  differenceType: DifferenceType;
  taxableEffect: TaxableEffect;
  defaultDisallowancePct: number | null;
  codeSection: string;
  description: string;
}
interface AccountTag {
  m_line_code: string;
  difference_type: DifferenceType;
  taxable_effect: TaxableEffect;
  disallowance_pct: number | null;
  note: string | null;
  source: string;
}
interface Proposal {
  id: string;
  confidence: number | null;
  reasoning: string | null;
  code: string;
  label: string;
  method: string;
}
interface AccountRow {
  accountId: string;
  accountNumber: string;
  accountName: string;
  accountType: string;
  tag: AccountTag | null;
  proposal: Proposal | null;
}
interface TagsPayload {
  catalog: CatalogLine[];
  accounts: AccountRow[];
  taggedCount: number;
  proposalCount: number;
}

const fmt = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export default function BookToTaxPage() {
  const [tab, setTab] = useState<'schedule' | 'tags'>('schedule');
  const now = new Date();
  const [startDate, setStartDate] = useState(`${now.getFullYear()}-01-01`);
  const [endDate, setEndDate] = useState(`${now.getFullYear()}-12-31`);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <PageHeader
        title="Book-to-Tax (Schedule M-1)"
        description="Bridge book net income to taxable income. Every difference is classified permanent vs temporary on its labeled M-1 line — the AI proposes the tag, the ledger computes the number."
      />

      <HubTabs section="tax" />

      <div className="flex items-center gap-1 mb-5 border-b border-slate-800">
        <TabButton active={tab === 'schedule'} onClick={() => setTab('schedule')} icon={Scale} label="Schedule M-1 / M-3" />
        <TabButton active={tab === 'tags'} onClick={() => setTab('tags')} icon={Tag} label="Account tagging" />
      </div>

      {tab === 'schedule' ? (
        <ScheduleTab
          startDate={startDate}
          endDate={endDate}
          setStartDate={setStartDate}
          setEndDate={setEndDate}
        />
      ) : (
        <TaggingTab />
      )}
    </div>
  );
}

function TabButton(props: { active: boolean; onClick: () => void; icon: React.ElementType; label: string }) {
  const { active, onClick, icon: Icon, label } = props;
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors',
        active ? 'border-emerald-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-200',
      )}
    >
      <Icon size={15} /> {label}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Schedule M-1 / M-3 tab
// ══════════════════════════════════════════════════════════════════════════════
function ScheduleTab(props: {
  startDate: string;
  endDate: string;
  setStartDate: (v: string) => void;
  setEndDate: (v: string) => void;
}) {
  const { startDate, endDate, setStartDate, setEndDate } = props;
  const params = useMemo(() => ({ start_date: startDate, end_date: endDate }), [startDate, endDate]);
  const { data, isLoading, error } = useQuery<M1Report>('/api/tax/m1', params);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs text-slate-400">Period start</label>
          <input type="date" className="input mt-1" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label className="text-xs text-slate-400">Period end</label>
          <input type="date" className="input mt-1" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <Loader2 className="animate-spin" size={20} />
        </div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle size={16} /> {error}
        </div>
      )}

      {!isLoading && !error && data && (
        <>
          {/* Summary cards */}
          <div className="grid gap-3 sm:grid-cols-4">
            <SummaryCard label="Book net income" valueCents={data.bookNetIncomeCents} />
            <SummaryCard label="Additions" valueCents={data.totalAdditionsCents} tone="add" />
            <SummaryCard label="Subtractions" valueCents={data.totalSubtractionsCents} tone="sub" />
            <SummaryCard label="Taxable income" valueCents={data.taxableIncomeCents} emphasize />
          </div>

          {data.adjustmentCount === 0 && (
            <div className="card p-4 flex items-start gap-3 border-blue-500/30">
              <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
              <div className="text-sm text-slate-300">
                No book-tax differences are tagged for this period, so <span className="font-medium text-white">taxable income equals book net income</span>.
                Tag accounts (meals, penalties, depreciation…) on the <span className="text-emerald-400">Account tagging</span> tab — or let the AI propose them — to build the reconciliation.
              </div>
            </div>
          )}

          {/* M-1 reconciliation ladder */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Schedule M-1 — book income to taxable income</h2>
              <p className="text-2xs text-slate-500 mt-0.5">
                {data.startDate} → {data.endDate} · {data.taggedAccountCount} tagged / {data.untaggedAccountCount} untagged accounts
              </p>
            </div>
            <table className="w-full text-sm">
              <tbody>
                <LadderRow label="Net income per books" amountCents={data.bookNetIncomeCents} bold />

                {(data.additions?.length ?? 0) > 0 && (
                  <tr className="border-t border-slate-800/60">
                    <td colSpan={3} className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-emerald-400/80">
                      Additions (taxable income above book)
                    </td>
                  </tr>
                )}
                {(data.additions ?? []).map((l) => <DiffRow key={l.code} line={l} />)}
                {(data.additions?.length ?? 0) > 0 && (
                  <SubtotalRow label="Total additions" amountCents={data.totalAdditionsCents} tone="add" />
                )}

                {(data.subtractions?.length ?? 0) > 0 && (
                  <tr className="border-t border-slate-800/60">
                    <td colSpan={3} className="px-4 pt-3 pb-1 text-2xs uppercase tracking-wide text-red-400/80">
                      Subtractions (taxable income below book)
                    </td>
                  </tr>
                )}
                {(data.subtractions ?? []).map((l) => <DiffRow key={l.code} line={l} negative />)}
                {(data.subtractions?.length ?? 0) > 0 && (
                  <SubtotalRow label="Total subtractions" amountCents={data.totalSubtractionsCents} tone="sub" />
                )}

                <tr className="border-t-2 border-slate-700 bg-slate-900/40">
                  <td className="px-4 py-3 font-semibold text-white" colSpan={2}>Taxable income (before NOL / special deductions)</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-emerald-300">{fmt(data.taxableIncomeCents)}</td>
                </tr>
              </tbody>
            </table>
          </section>

          {/* M-3 permanent / temporary summary */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-800">
              <h2 className="text-sm font-semibold text-white">Schedule M-3 summary — permanent vs temporary</h2>
              <p className="text-2xs text-slate-500 mt-0.5">
                Temporary differences reverse in a later year (the ASC 740 deferred-tax input); permanent differences never reverse.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Character</th>
                  <th className="text-right font-medium px-4 py-2.5">Additions</th>
                  <th className="text-right font-medium px-4 py-2.5">Subtractions</th>
                  <th className="text-right font-medium px-4 py-2.5">Net impact</th>
                </tr>
              </thead>
              <tbody>
                <M3Row label="Permanent" add={data.permanentAdditionsCents} sub={data.permanentSubtractionsCents} net={data.permanentNetCents} />
                <M3Row label="Temporary" add={data.temporaryAdditionsCents} sub={data.temporarySubtractionsCents} net={data.temporaryNetCents} />
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function SummaryCard(props: { label: string; valueCents: number; tone?: 'add' | 'sub'; emphasize?: boolean }) {
  const { label, valueCents, tone, emphasize } = props;
  return (
    <div className={clsx('card p-3', emphasize && 'border-emerald-500/40')}>
      <p className="text-2xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className={clsx(
        'mt-1 font-mono text-lg',
        emphasize ? 'text-emerald-300' : tone === 'add' ? 'text-emerald-400' : tone === 'sub' ? 'text-red-400' : 'text-white',
      )}>
        {tone === 'add' ? '+' : tone === 'sub' ? '−' : ''}{fmt(Math.abs(valueCents))}
      </p>
    </div>
  );
}

function LadderRow(props: { label: string; amountCents: number; bold?: boolean }) {
  return (
    <tr>
      <td className={clsx('px-4 py-3', props.bold ? 'font-semibold text-white' : 'text-slate-300')} colSpan={2}>{props.label}</td>
      <td className={clsx('px-4 py-3 text-right font-mono', props.bold ? 'font-semibold text-white' : 'text-slate-200')}>{fmt(props.amountCents)}</td>
    </tr>
  );
}

function SubtotalRow(props: { label: string; amountCents: number; tone: 'add' | 'sub' }) {
  const { label, amountCents, tone } = props;
  return (
    <tr className="border-t border-slate-800 bg-slate-900/20">
      <td className="px-4 py-2 pl-8 text-slate-200 font-medium" colSpan={2}>{label}</td>
      <td className={clsx('px-4 py-2 text-right font-mono font-medium', tone === 'add' ? 'text-emerald-300' : 'text-red-300')}>
        {tone === 'add' ? '+' : '−'}{fmt(amountCents)}
      </td>
    </tr>
  );
}

function DiffRow(props: { line: M1Line; negative?: boolean }) {
  const { line, negative } = props;
  return (
    <tr className="border-b border-slate-800/40 last:border-0">
      <td className="px-4 py-2 pl-8 text-slate-300">
        <span className="inline-flex items-center gap-2">
          {negative ? <ArrowDownRight size={13} className="text-red-400/70" /> : <ArrowUpRight size={13} className="text-emerald-400/70" />}
          {line.label}
        </span>
        {line.codeSection && <span className="ml-2 text-2xs font-mono text-slate-600">{line.codeSection}</span>}
      </td>
      <td className="px-2 py-2">
        <span className={clsx('badge', line.differenceType === 'PERMANENT' ? 'badge-neutral' : 'badge-info')}>
          {line.differenceType === 'PERMANENT' ? 'Permanent' : 'Temporary'}
        </span>
        {line.m1Line && <span className="ml-2 text-2xs text-slate-600">M-1 {line.m1Line}</span>}
      </td>
      <td className={clsx('px-4 py-2 text-right font-mono', negative ? 'text-red-400' : 'text-emerald-400')}>
        {negative ? '−' : '+'}{fmt(line.amountCents)}
      </td>
    </tr>
  );
}

function M3Row(props: { label: string; add: number; sub: number; net: number }) {
  return (
    <tr className="border-b border-slate-800/40 last:border-0">
      <td className="px-4 py-2.5 text-slate-300">{props.label}</td>
      <td className="px-4 py-2.5 text-right font-mono text-emerald-400">{props.add ? `+${fmt(props.add)}` : '—'}</td>
      <td className="px-4 py-2.5 text-right font-mono text-red-400">{props.sub ? `−${fmt(props.sub)}` : '—'}</td>
      <td className={clsx('px-4 py-2.5 text-right font-mono', props.net >= 0 ? 'text-emerald-300' : 'text-red-300')}>
        {props.net >= 0 ? '+' : '−'}{fmt(Math.abs(props.net))}
      </td>
    </tr>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Account tagging tab
// ══════════════════════════════════════════════════════════════════════════════
function TaggingTab() {
  const { data, isLoading, error, refetch } = useQuery<TagsPayload>('/api/tax/tags');
  const [busy, setBusy] = useState<string | null>(null);
  const [proposing, setProposing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tagged' | 'untagged' | 'proposed'>('all');

  const catalog = data?.catalog ?? [];
  const accounts = useMemo(() => {
    const rows = data?.accounts ?? [];
    if (filter === 'tagged') return rows.filter((r) => r.tag);
    if (filter === 'untagged') return rows.filter((r) => !r.tag);
    if (filter === 'proposed') return rows.filter((r) => r.proposal && !r.tag);
    return rows;
  }, [data, filter]);

  const setTag = async (accountId: string, code: string, aiDecisionId?: string) => {
    setBusy(accountId);
    const res = await api.post('/api/tax/tags', { account_id: accountId, m_line_code: code, ai_decision_id: aiDecisionId });
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Tag saved');
    refetch();
  };
  const clearTag = async (accountId: string) => {
    setBusy(accountId);
    const res = await api.delete(`/api/tax/tags?account_id=${accountId}`);
    setBusy(null);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', 'Tag cleared');
    refetch();
  };
  const propose = async () => {
    setProposing(true);
    const res = await api.post<{ proposed: number; candidates: number }>('/api/tax/tags/propose', {});
    setProposing(false);
    if (res.error) { addToast('error', res.error.error); return; }
    addToast('success', `AI proposed ${res.data?.proposed ?? 0} tag${res.data?.proposed === 1 ? '' : 's'} across ${res.data?.candidates ?? 0} untagged account${res.data?.candidates === 1 ? '' : 's'}`);
    refetch();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          {(['all', 'tagged', 'untagged', 'proposed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx('px-3 py-1.5 rounded text-xs font-medium capitalize', filter === f ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-slate-200')}
            >
              {f}
            </button>
          ))}
        </div>
        <button className="btn btn-primary btn-sm" onClick={propose} disabled={proposing}>
          {proposing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Propose tags with AI
        </button>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center py-20 text-slate-500"><Loader2 className="animate-spin" size={20} /></div>
      )}
      {error && !isLoading && (
        <div className="card p-4 flex items-center gap-2 text-red-400 text-sm"><AlertCircle size={16} /> {error}</div>
      )}

      {!isLoading && !error && data && (
        accounts.length === 0 ? (
          <EmptyState icon={Tag} title="No accounts in this view" description="Adjust the filter, or seed the chart of accounts first." />
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                <tr>
                  <th className="text-left font-medium px-4 py-2.5">Account</th>
                  <th className="text-left font-medium px-4 py-2.5">Book-tax treatment</th>
                  <th className="text-left font-medium px-4 py-2.5">Character</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => (
                  <TagRow
                    key={row.accountId}
                    row={row}
                    catalog={catalog}
                    busy={busy === row.accountId}
                    onSet={(code) => setTag(row.accountId, code)}
                    onAccept={(code, id) => setTag(row.accountId, code, id)}
                    onClear={() => clearTag(row.accountId)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}

function TagRow(props: {
  row: AccountRow;
  catalog: CatalogLine[];
  busy: boolean;
  onSet: (code: string) => void;
  onAccept: (code: string, decisionId: string) => void;
  onClear: () => void;
}) {
  const { row, catalog, busy, onSet, onAccept, onClear } = props;
  const current = row.tag?.m_line_code ?? '';
  const def = catalog.find((c) => c.code === current);

  return (
    <tr className="border-b border-slate-800/60 last:border-0">
      <td className="px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-slate-500">{row.accountNumber}</span>
          <span className="text-slate-200">{row.accountName}</span>
        </div>
        <span className="text-2xs text-slate-600">{row.accountType}</span>
      </td>
      <td className="px-4 py-2.5">
        <select
          className="input py-1.5 text-xs max-w-xs"
          value={current}
          disabled={busy}
          onChange={(e) => (e.target.value ? onSet(e.target.value) : onClear())}
        >
          <option value="">— No difference —</option>
          {catalog.map((c) => (
            <option key={c.code} value={c.code}>{c.label}{c.defaultDisallowancePct != null ? ` (${c.defaultDisallowancePct}%)` : ''}</option>
          ))}
        </select>
        {row.proposal && !row.tag && (
          <div className="mt-1.5 flex items-center gap-2 text-2xs">
            <span className="badge bg-indigo-500/10 text-indigo-400 inline-flex items-center gap-1"><Sparkles size={10} /> AI: {row.proposal.label}</span>
            {row.proposal.confidence != null && <span className="text-slate-500">{Math.round(row.proposal.confidence * 100)}%</span>}
            <button className="text-emerald-400 hover:text-emerald-300 inline-flex items-center gap-0.5" disabled={busy} onClick={() => onAccept(row.proposal!.code, row.proposal!.id)}>
              <Check size={11} /> Accept
            </button>
          </div>
        )}
        {row.proposal?.reasoning && !row.tag && (
          <p className="mt-0.5 text-2xs text-slate-600 max-w-md">{row.proposal.reasoning}</p>
        )}
      </td>
      <td className="px-4 py-2.5">
        {def ? (
          <div className="flex items-center gap-2">
            <span className={clsx('badge', def.differenceType === 'PERMANENT' ? 'badge-neutral' : 'badge-info')}>
              {def.differenceType === 'PERMANENT' ? 'Permanent' : 'Temporary'}
            </span>
            <span className="text-2xs font-mono text-slate-600">{def.codeSection}</span>
          </div>
        ) : (
          <span className="text-slate-600 text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-2.5 text-right">
        {row.tag && (
          <button className="btn btn-ghost btn-sm text-slate-500 hover:text-red-400" disabled={busy} onClick={onClear} title="Clear tag">
            {busy ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
          </button>
        )}
      </td>
    </tr>
  );
}
