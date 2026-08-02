'use client';

/**
 * Consolidated statements (GATE 11a — the multi-entity moat).
 *
 * Two tabs:
 *   • Statements — consolidated P&L + balance sheet across an entity group, with a
 *     visible ELIMINATIONS column, a non-controlling-interest (NCI) line, and
 *     one-line equity-method investments. Entity-group selector scopes to a subtree.
 *   • Ownership — maintain the parent/child/%/method structure the engine consumes.
 *
 * The engine is pure and lives in lib/consolidation; this screen only renders it.
 */

import { useMemo, useState } from 'react';
import {
  Combine, Layers, Loader2, AlertCircle, Plus, Trash2, Info, SlidersHorizontal, Building2,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery, addToast } from '@/hooks';
import { api } from '@/lib/api-client';
import { PageHeader, EmptyState } from '@/components/ui';

// ── Types mirroring the API payloads ─────────────────────────────────────────
type Method = 'FULL' | 'EQUITY' | 'NONE';
type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'COGS' | 'OPEX' | 'OTHER';

interface EntityRow { id: string; name: string; shortCode: string | null; parentEntityId: string | null }
interface EntityMeta { entityId: string; name: string; method: Method; ownershipPercent: number }
interface AccountLine {
  accountNumber: string; accountName: string; accountType: AccountType; isEliminating: boolean;
  grossCents: number; eliminationCents: number; consolidatedCents: number; byEntity: Record<string, number>;
}
interface EquityMethodLine {
  entityId: string; name: string; ownershipPercent: number; investmentCents: number; equityInEarningsCents: number;
}
interface NciShare {
  entityId: string; name: string; ownershipPercent: number; minorityPercent: number; equityCents: number; netIncomeCents: number;
}
interface Totals {
  eliminationsCents: number; eliminatingResidualCents: number;
  revenueCents: number; cogsCents: number; opexCents: number; otherCents: number;
  netIncomeFullCents: number; netIncomeCents: number; netIncomeParentCents: number; netIncomeNciCents: number;
  assetsCents: number; liabilitiesCents: number; equityBookedCents: number; equitySectionCents: number; balanceCheckCents: number;
}
interface StatementsResp {
  period: { startDate: string; endDate: string };
  rootEntityId: string | null;
  entities: EntityRow[];
  entityMeta: EntityMeta[];
  ownershipTableAvailable: boolean;
  intercompanyRolesResolved: boolean;
  scanned: { entries: number; lines: number };
  accounts: AccountLine[];
  equityMethod: EquityMethodLine[];
  nci: { equityCents: number; netIncomeCents: number; byEntity: NciShare[] };
  totals: Totals;
  entitiesFull: string[]; entitiesEquityMethod: string[]; entitiesExcluded: string[];
  eliminationsApplied: boolean;
}
interface OwnershipRow {
  id: string; parent_entity_id: string; child_entity_id: string;
  ownership_percent: number; consolidation_method: Method;
  effective_start: string; effective_end: string | null; notes: string | null;
}
interface OwnershipResp { entities: EntityRow[]; ownership: OwnershipRow[]; ownershipTableAvailable: boolean }

const fmt = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmtPct = (p: number) => `${(Math.round(p * 100) / 100).toString()}%`;
const today = () => new Date().toISOString().slice(0, 10);
const yearStart = () => `${new Date().getUTCFullYear()}-01-01`;

const METHOD_BADGE: Record<Method, string> = {
  FULL: 'badge-success', EQUITY: 'badge-info', NONE: 'badge-neutral',
};
const METHOD_LABEL: Record<Method, string> = {
  FULL: 'Full', EQUITY: 'Equity method', NONE: 'Excluded',
};

const PNL_TYPES: AccountType[] = ['REVENUE', 'COGS', 'OPEX', 'OTHER'];
const BS_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY'];
const TYPE_LABEL: Record<AccountType, string> = {
  REVENUE: 'Revenue', COGS: 'Cost of goods sold', OPEX: 'Operating expenses', OTHER: 'Other',
  ASSET: 'Assets', LIABILITY: 'Liabilities', EQUITY: 'Equity',
};

export default function ConsolidationPage() {
  const [tab, setTab] = useState<'statements' | 'ownership'>('statements');
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <PageHeader
        title="Consolidation"
        description="Multi-entity consolidated financials — ownership %, intercompany eliminations, and non-controlling interest."
        actions={
          <div className="flex items-center gap-1 rounded-lg bg-surface-900 border border-slate-800 p-1">
            <TabBtn active={tab === 'statements'} onClick={() => setTab('statements')} icon={<Layers size={14} />}>
              Statements
            </TabBtn>
            <TabBtn active={tab === 'ownership'} onClick={() => setTab('ownership')} icon={<SlidersHorizontal size={14} />}>
              Ownership
            </TabBtn>
          </div>
        }
      />
      {tab === 'statements' ? <StatementsTab /> : <OwnershipTab />}
    </div>
  );
}

function TabBtn({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-brand-500 text-white' : 'text-slate-400 hover:text-slate-200',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// STATEMENTS TAB
// ─────────────────────────────────────────────────────────────────────────────
function StatementsTab() {
  const [startDate, setStartDate] = useState(yearStart());
  const [endDate, setEndDate] = useState(today());
  const [rootId, setRootId] = useState<string>('');
  const [eliminate, setEliminate] = useState(true);
  const [showEntities, setShowEntities] = useState(false);

  const qs = new URLSearchParams({ start_date: startDate, end_date: endDate, eliminate: String(eliminate) });
  if (rootId) qs.set('root_entity_id', rootId);
  const { data, isLoading, error } = useQuery<StatementsResp>(`/api/consolidation/statements?${qs.toString()}`, {
    key: `${startDate}|${endDate}|${rootId}|${eliminate}`,
  });

  const fullEntities = useMemo(
    () => (data?.entities ?? []).filter((e) => (data?.entitiesFull ?? []).includes(e.id)),
    [data],
  );
  const metaById = useMemo(() => {
    const m = new Map<string, EntityMeta>();
    for (const em of data?.entityMeta ?? []) m.set(em.entityId, em);
    return m;
  }, [data]);

  return (
    <div className="space-y-5">
      {/* Controls */}
      <div className="card p-4 flex flex-wrap items-end gap-4">
        <Field label="Entity group">
          <select className="input min-w-[200px]" value={rootId} onChange={(e) => setRootId(e.target.value)}>
            <option value="">All entities</option>
            {(data?.entities ?? []).map((e) => (
              <option key={e.id} value={e.id}>{e.name}{e.shortCode ? ` (${e.shortCode})` : ''}</option>
            ))}
          </select>
        </Field>
        <Field label="Period start">
          <input type="date" className="input" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)} />
        </Field>
        <Field label="As of / period end">
          <input type="date" className="input" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pb-2">
          <input type="checkbox" checked={eliminate} onChange={(e) => setEliminate(e.target.checked)} className="accent-emerald-500" />
          Apply eliminations
        </label>
        <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer pb-2">
          <input type="checkbox" checked={showEntities} onChange={(e) => setShowEntities(e.target.checked)} className="accent-emerald-500" />
          Show per-entity columns
        </label>
      </div>

      {!data?.ownershipTableAvailable && !isLoading && (
        <Banner tone="info">
          Ownership structure not yet initialized (migration 076 pending or empty) — every entity is consolidated
          <strong> Full at 100%</strong>. Add structure in the Ownership tab to model NCI and equity-method affiliates.
        </Banner>
      )}
      {data && data.totals.eliminatingResidualCents !== 0 && (
        <Banner tone="warning">
          Intercompany positions are out of balance by {fmt(Math.abs(data.totals.eliminatingResidualCents))} — they will not
          fully eliminate. Review the intercompany-balance exceptions before relying on this consolidation.
        </Banner>
      )}

      {isLoading ? (
        <div className="card p-16 flex items-center justify-center text-slate-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Consolidating…
        </div>
      ) : error ? (
        <div className="card p-6 flex items-center gap-2 text-red-400">
          <AlertCircle size={18} /> {error}
        </div>
      ) : !data || data.accounts.length === 0 ? (
        <EmptyState icon={Combine} title="Nothing to consolidate yet"
          description="No posted activity in this period for the selected group. Post journal entries, then reopen this report." />
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Metric label="Consolidated revenue" value={fmt(data.totals.revenueCents)} />
            <Metric label="Net income (total)" value={fmt(data.totals.netIncomeCents)} accent />
            <Metric label="Attributable to parent" value={fmt(data.totals.netIncomeParentCents)} />
            <Metric label="Attributable to NCI" value={fmt(data.totals.netIncomeNciCents)} muted />
            <Metric label="Total eliminations" value={fmt(data.totals.eliminationsCents)} muted />
            <Metric label="Consolidated assets" value={fmt(data.totals.assetsCents)} />
            <Metric label="Non-controlling interest (equity)" value={fmt(data.nci.equityCents)} muted />
            <Metric label="Balance check" value={fmt(data.totals.balanceCheckCents)}
              tone={data.totals.balanceCheckCents === 0 ? 'ok' : 'bad'} />
          </div>

          <Statement title="Income statement" types={PNL_TYPES} data={data} fullEntities={fullEntities}
            metaById={metaById} showEntities={showEntities} eliminate={eliminate}
            footer={
              <>
                <SubtotalRow label="Net income (fully consolidated)" cents={data.totals.netIncomeFullCents} cols={colCount(fullEntities, showEntities)} />
                {data.equityMethod.length > 0 && (
                  <SubtotalRow label="Equity in earnings of affiliates" cols={colCount(fullEntities, showEntities)}
                    cents={data.equityMethod.reduce((s, e) => s + e.equityInEarningsCents, 0)} />
                )}
                <SubtotalRow label="Consolidated net income" cents={data.totals.netIncomeCents} cols={colCount(fullEntities, showEntities)} strong />
                <SubtotalRow label="Less: net income attributable to NCI" cents={-data.totals.netIncomeNciCents} cols={colCount(fullEntities, showEntities)} muted />
                <SubtotalRow label="Net income attributable to parent" cents={data.totals.netIncomeParentCents} cols={colCount(fullEntities, showEntities)} strong />
              </>
            } />

          <Statement title="Balance sheet" types={BS_TYPES} data={data} fullEntities={fullEntities}
            metaById={metaById} showEntities={showEntities} eliminate={eliminate}
            footer={
              <>
                {data.nci.equityCents !== 0 && (
                  <SubtotalRow label="Non-controlling interest" cents={data.nci.equityCents} cols={colCount(fullEntities, showEntities)} />
                )}
                <SubtotalRow label="Current-period net income (to equity)" cents={data.totals.netIncomeFullCents} cols={colCount(fullEntities, showEntities)} muted />
                <SubtotalRow label="Total equity section" cents={data.totals.equitySectionCents} cols={colCount(fullEntities, showEntities)} strong />
              </>
            } />

          {/* Equity-method investments */}
          {data.equityMethod.length > 0 && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                <Building2 size={15} className="text-blue-400" /> Equity-method investments
              </h3>
              <p className="text-xs text-slate-500 mb-3">Affiliates with significant influence appear one-line, not consolidated.</p>
              <table className="w-full text-sm">
                <thead><tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="text-left py-2">Affiliate</th><th className="text-right">Ownership</th>
                  <th className="text-right">Investment</th><th className="text-right">Equity in earnings</th>
                </tr></thead>
                <tbody>
                  {data.equityMethod.map((e) => (
                    <tr key={e.entityId} className="border-b border-slate-800/60">
                      <td className="py-2 text-slate-200">{e.name}</td>
                      <td className="text-right text-slate-300 font-mono">{fmtPct(e.ownershipPercent)}</td>
                      <td className="text-right text-slate-200 font-mono">{fmt(e.investmentCents)}</td>
                      <td className="text-right text-emerald-400 font-mono">{fmt(e.equityInEarningsCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* NCI detail */}
          {data.nci.byEntity.length > 0 && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-white mb-1">Non-controlling interest by subsidiary</h3>
              <p className="text-xs text-slate-500 mb-3">The minority owners&apos; share of each partially-owned subsidiary.</p>
              <table className="w-full text-sm">
                <thead><tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
                  <th className="text-left py-2">Subsidiary</th><th className="text-right">Owned</th><th className="text-right">Minority</th>
                  <th className="text-right">NCI equity</th><th className="text-right">NCI net income</th>
                </tr></thead>
                <tbody>
                  {data.nci.byEntity.map((n) => (
                    <tr key={n.entityId} className="border-b border-slate-800/60">
                      <td className="py-2 text-slate-200">{n.name}</td>
                      <td className="text-right text-slate-300 font-mono">{fmtPct(n.ownershipPercent)}</td>
                      <td className="text-right text-slate-400 font-mono">{fmtPct(n.minorityPercent)}</td>
                      <td className="text-right text-slate-200 font-mono">{fmt(n.equityCents)}</td>
                      <td className="text-right text-slate-200 font-mono">{fmt(n.netIncomeCents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-2xs text-slate-600 flex items-center gap-1.5">
            <Info size={12} /> {data.scanned.lines.toLocaleString()} posted lines across {data.entitiesFull.length} fully-consolidated
            {data.entitiesEquityMethod.length ? `, ${data.entitiesEquityMethod.length} equity-method` : ''}
            {data.entitiesExcluded.length ? `, ${data.entitiesExcluded.length} excluded` : ''} entities.
            {!data.intercompanyRolesResolved && ' Intercompany AR/AP roles unmapped — role-based eliminations skipped.'}
          </p>
        </>
      )}
    </div>
  );
}

function colCount(fullEntities: EntityRow[], showEntities: boolean): number {
  // Account label + (per-entity) + gross + eliminations + consolidated
  return 1 + (showEntities ? fullEntities.length : 1) + 2;
}

function Statement({
  title, types, data, fullEntities, metaById, showEntities, eliminate, footer,
}: {
  title: string; types: AccountType[]; data: StatementsResp; fullEntities: EntityRow[];
  metaById: Map<string, EntityMeta>; showEntities: boolean; eliminate: boolean; footer?: React.ReactNode;
}) {
  const rows = data.accounts.filter((a) => types.includes(a.accountType));
  return (
    <div className="card overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <th className="text-left py-2 px-4 sticky left-0 bg-surface-900">Account</th>
              {showEntities && fullEntities.map((e) => {
                const m = metaById.get(e.id);
                return (
                  <th key={e.id} className="text-right px-3 whitespace-nowrap">
                    {e.shortCode ?? e.name}
                    {m && m.ownershipPercent < 100 && <span className="text-amber-400 ml-1">{fmtPct(m.ownershipPercent)}</span>}
                  </th>
                );
              })}
              {!showEntities && <th className="text-right px-3">Combined</th>}
              <th className="text-right px-3 text-amber-400">Eliminations</th>
              <th className="text-right px-4">Consolidated</th>
            </tr>
          </thead>
          <tbody>
            {types.map((t) => {
              const typeRows = rows.filter((r) => r.accountType === t);
              if (typeRows.length === 0) return null;
              return (
                <TypeGroup key={t} type={t} typeRows={typeRows} fullEntities={fullEntities}
                  showEntities={showEntities} />
              );
            })}
            {footer}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TypeGroup({ type, typeRows, fullEntities, showEntities }: {
  type: AccountType; typeRows: AccountLine[]; fullEntities: EntityRow[]; showEntities: boolean;
}) {
  const subtotalGross = typeRows.reduce((s, r) => s + r.grossCents, 0);
  const subtotalElim = typeRows.reduce((s, r) => s + r.eliminationCents, 0);
  const subtotalCons = typeRows.reduce((s, r) => s + r.consolidatedCents, 0);
  return (
    <>
      <tr className="bg-surface-950/40">
        <td colSpan={colCount(fullEntities, showEntities)} className="px-4 py-1.5 text-2xs uppercase tracking-wide text-slate-400 font-semibold sticky left-0 bg-surface-950/40">
          {TYPE_LABEL[type]}
        </td>
      </tr>
      {typeRows.map((r) => (
        <tr key={r.accountNumber} className={clsx('border-b border-slate-800/40', r.isEliminating && 'text-slate-500')}>
          <td className="py-1.5 px-4 sticky left-0 bg-surface-900">
            <span className="font-mono text-2xs text-slate-500 mr-2">{r.accountNumber}</span>
            <span className="text-slate-300">{r.accountName}</span>
            {r.isEliminating && <span className="badge-neutral ml-2">interco</span>}
          </td>
          {showEntities && fullEntities.map((e) => (
            <td key={e.id} className="text-right px-3 font-mono text-slate-400">
              {r.byEntity[e.id] ? fmt(r.byEntity[e.id]) : '—'}
            </td>
          ))}
          {!showEntities && <td className="text-right px-3 font-mono text-slate-400">{fmt(r.grossCents)}</td>}
          <td className="text-right px-3 font-mono text-amber-400/80">{r.eliminationCents ? fmt(r.eliminationCents) : '—'}</td>
          <td className="text-right px-4 font-mono text-slate-200">{fmt(r.consolidatedCents)}</td>
        </tr>
      ))}
      <tr className="border-b border-slate-800 font-medium">
        <td className="py-1.5 px-4 text-slate-300 sticky left-0 bg-surface-900">Total {TYPE_LABEL[type].toLowerCase()}</td>
        {showEntities && fullEntities.map((e) => {
          const v = typeRows.reduce((s, r) => s + (r.byEntity[e.id] ?? 0), 0);
          return <td key={e.id} className="text-right px-3 font-mono text-slate-300">{v ? fmt(v) : '—'}</td>;
        })}
        {!showEntities && <td className="text-right px-3 font-mono text-slate-300">{fmt(subtotalGross)}</td>}
        <td className="text-right px-3 font-mono text-amber-400">{subtotalElim ? fmt(subtotalElim) : '—'}</td>
        <td className="text-right px-4 font-mono text-white">{fmt(subtotalCons)}</td>
      </tr>
    </>
  );
}

function SubtotalRow({ label, cents, cols, strong, muted }: {
  label: string; cents: number; cols: number; strong?: boolean; muted?: boolean;
}) {
  return (
    <tr className={clsx('border-b border-slate-800/40', strong && 'bg-surface-950/40')}>
      <td colSpan={cols - 1} className={clsx('py-1.5 px-4 sticky left-0', strong ? 'bg-surface-950/40 text-white font-semibold' : muted ? 'text-slate-500' : 'text-slate-300', !strong && 'bg-surface-900')}>
        {label}
      </td>
      <td className={clsx('text-right px-4 font-mono', strong ? 'text-white font-semibold' : muted ? 'text-slate-500' : 'text-slate-200')}>
        {fmt(cents)}
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// OWNERSHIP TAB
// ─────────────────────────────────────────────────────────────────────────────
interface EditState {
  id?: string; parentEntityId: string; childEntityId: string; ownershipPercent: string;
  method: Method; effectiveStart: string; effectiveEnd: string; notes: string;
}
const EMPTY_EDIT: EditState = {
  parentEntityId: '', childEntityId: '', ownershipPercent: '100', method: 'FULL',
  effectiveStart: today(), effectiveEnd: '', notes: '',
};

function OwnershipTab() {
  const { data, isLoading, error, refetch } = useQuery<OwnershipResp>('/api/consolidation/ownership');
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const entities = data?.entities ?? [];
  const nameById = useMemo(() => new Map(entities.map((e) => [e.id, e.name])), [entities]);

  const save = async () => {
    if (!edit) return;
    setFormErr(null);
    const pct = parseFloat(edit.ownershipPercent);
    if (!edit.parentEntityId || !edit.childEntityId) return setFormErr('Choose both parent and child entities.');
    if (edit.parentEntityId === edit.childEntityId) return setFormErr('Parent and child must differ.');
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return setFormErr('Ownership must be between 0 and 100.');
    setSaving(true);
    const res = await api.post<{ ok: boolean }>('/api/consolidation/ownership', {
      id: edit.id,
      parent_entity_id: edit.parentEntityId,
      child_entity_id: edit.childEntityId,
      ownership_percent: pct,
      consolidation_method: edit.method,
      effective_start: edit.effectiveStart || undefined,
      effective_end: edit.effectiveEnd || null,
      notes: edit.notes || undefined,
    });
    setSaving(false);
    if (res.error) { setFormErr(res.error.error); return; }
    addToast('success', 'Ownership structure saved');
    setEdit(null);
    refetch();
  };

  const remove = async (row: OwnershipRow) => {
    if (!window.confirm(`Remove ${nameById.get(row.parent_entity_id)} → ${nameById.get(row.child_entity_id)} structure?`)) return;
    setBusyId(row.id);
    const res = await api.delete(`/api/consolidation/ownership?id=${row.id}`);
    setBusyId(null);
    if (res.error) { addToast('error', `Delete failed: ${res.error.error}`); return; }
    addToast('success', 'Structure row removed');
    refetch();
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-400 max-w-2xl">
          Define, for each subsidiary, the group&apos;s ownership % and how it consolidates. Any entity without a row is
          treated as <strong className="text-slate-300">Full at 100%</strong>.
        </p>
        <button className="btn-primary btn-sm shrink-0" onClick={() => { setFormErr(null); setEdit({ ...EMPTY_EDIT }); }}>
          <Plus size={14} /> Add structure
        </button>
      </div>

      {!isLoading && data && !data.ownershipTableAvailable && (
        <Banner tone="info">Migration 076 is not applied yet — saving will be unavailable until the ownership table exists.</Banner>
      )}

      {isLoading ? (
        <div className="card p-16 flex items-center justify-center text-slate-400">
          <Loader2 className="animate-spin mr-2" size={18} /> Loading…
        </div>
      ) : error ? (
        <div className="card p-6 flex items-center gap-2 text-red-400"><AlertCircle size={18} /> {error}</div>
      ) : (data?.ownership.length ?? 0) === 0 ? (
        <EmptyState icon={SlidersHorizontal} title="No ownership structure yet"
          description="Add a parent → child relationship with an ownership % and consolidation method to model NCI and equity-method affiliates."
          action={{ label: 'Add structure', onClick: () => setEdit({ ...EMPTY_EDIT }) }} />
      ) : (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead><tr className="text-2xs uppercase tracking-wide text-slate-500 border-b border-slate-800">
              <th className="text-left py-2 px-4">Parent</th><th className="text-left">Child</th>
              <th className="text-right">Ownership</th><th className="text-left px-3">Method</th>
              <th className="text-left">Effective</th><th></th>
            </tr></thead>
            <tbody>
              {(data?.ownership ?? []).map((r) => (
                <tr key={r.id} className="border-b border-slate-800/50 table-row-hover">
                  <td className="py-2 px-4 text-slate-200">{nameById.get(r.parent_entity_id) ?? '—'}</td>
                  <td className="text-slate-200">{nameById.get(r.child_entity_id) ?? '—'}</td>
                  <td className="text-right font-mono text-slate-300">{fmtPct(r.ownership_percent)}</td>
                  <td className="px-3"><span className={METHOD_BADGE[r.consolidation_method]}>{METHOD_LABEL[r.consolidation_method]}</span></td>
                  <td className="text-slate-400 text-xs">{r.effective_start}{r.effective_end ? ` → ${r.effective_end}` : ' →'}</td>
                  <td className="text-right px-4">
                    <div className="flex items-center justify-end gap-1">
                      <button className="btn-ghost btn-sm" onClick={() => setEdit({
                        id: r.id, parentEntityId: r.parent_entity_id, childEntityId: r.child_entity_id,
                        ownershipPercent: String(r.ownership_percent), method: r.consolidation_method,
                        effectiveStart: r.effective_start, effectiveEnd: r.effective_end ?? '', notes: r.notes ?? '',
                      })}>Edit</button>
                      <button className="btn-ghost btn-sm text-red-400" disabled={busyId === r.id} onClick={() => remove(r)}>
                        {busyId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Editor slide-over */}
      {edit && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/50" onClick={() => setEdit(null)}>
          <div className="w-full max-w-md h-full bg-surface-950 border-l border-slate-800 p-6 overflow-y-auto animate-in" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-white mb-4">{edit.id ? 'Edit' : 'Add'} ownership structure</h2>
            {formErr && <div className="mb-3 text-xs text-red-400 flex items-center gap-1"><AlertCircle size={13} /> {formErr}</div>}
            <div className="space-y-4">
              <Field label="Parent entity">
                <select className="input" value={edit.parentEntityId} onChange={(e) => setEdit({ ...edit, parentEntityId: e.target.value })}>
                  <option value="">Select…</option>
                  {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
              <Field label="Child entity (subsidiary / affiliate)">
                <select className="input" value={edit.childEntityId} onChange={(e) => setEdit({ ...edit, childEntityId: e.target.value })}>
                  <option value="">Select…</option>
                  {entities.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </Field>
              <Field label="Ownership %">
                <input type="number" min={0} max={100} step="0.0001" className="input" value={edit.ownershipPercent}
                  onChange={(e) => setEdit({ ...edit, ownershipPercent: e.target.value })} />
              </Field>
              <Field label="Consolidation method">
                <select className="input" value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value as Method })}>
                  <option value="FULL">Full — line-by-line + NCI for the minority</option>
                  <option value="EQUITY">Equity method — one-line investment</option>
                  <option value="NONE">None — excluded from consolidation</option>
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Effective start">
                  <input type="date" className="input" value={edit.effectiveStart} onChange={(e) => setEdit({ ...edit, effectiveStart: e.target.value })} />
                </Field>
                <Field label="Effective end (optional)">
                  <input type="date" className="input" value={edit.effectiveEnd} onChange={(e) => setEdit({ ...edit, effectiveEnd: e.target.value })} />
                </Field>
              </div>
              <Field label="Notes (optional)">
                <input type="text" className="input" value={edit.notes} maxLength={500} placeholder="e.g. bought up from 60% in Q2"
                  onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
              </Field>
            </div>
            <div className="flex items-center gap-2 mt-6">
              <button className="btn-primary btn-sm" disabled={saving} onClick={save}>
                {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-2xs uppercase tracking-wide text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value, accent, muted, tone }: {
  label: string; value: string; accent?: boolean; muted?: boolean; tone?: 'ok' | 'bad';
}) {
  return (
    <div className="card p-3">
      <div className="text-2xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className={clsx('mt-1 text-lg font-mono font-semibold',
        tone === 'bad' ? 'text-red-400' : tone === 'ok' ? 'text-emerald-400' : accent ? 'text-emerald-400' : muted ? 'text-slate-400' : 'text-white',
      )}>
        {value}
      </div>
    </div>
  );
}

function Banner({ tone, children }: { tone: 'info' | 'warning'; children: React.ReactNode }) {
  return (
    <div className={clsx('rounded-lg border px-4 py-3 text-xs flex items-start gap-2',
      tone === 'warning' ? 'border-amber-500/30 bg-amber-500/5 text-amber-300' : 'border-blue-500/30 bg-blue-500/5 text-blue-300')}>
      <Info size={14} className="mt-0.5 shrink-0" />
      <p>{children}</p>
    </div>
  );
}
