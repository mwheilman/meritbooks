'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import {
  Bands,
  Button,
  Field,
  InlineNotice,
  Meter,
  Pip,
  QueueTable,
  Search,
  Select,
  Tag,
  countStrokes,
  money,
  useDebounce,
  useQuery,
  type QueueColumn,
} from '@meritbooks/merit-ui';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { useMe } from '@/lib/hooks/use-me';
import { BASIS_LABEL, type FluxBoard, type FluxBoardLine } from '@/lib/close/flux/types';
import { FluxPanel } from './flux-panel';
import { FluxPolicyDialog } from './flux-policy';
import { FluxWaiverDialog } from './flux-waiver';
import { STATUS, pctText } from './flux-format';
import s from './flux.module.css';

type Band = 'open' | 'unexplained' | 'review' | 'reviewed' | 'material' | 'all';

const TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER', 'ASSET', 'LIABILITY', 'EQUITY'] as const;

/** The month being closed: last month by default. */
function defaultPeriod(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function recentPeriods(n = 15): { value: string; label: string }[] {
  const d = new Date();
  d.setDate(1);
  return Array.from({ length: n }, (_, i) => {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    return {
      value: `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`,
      label: x.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    };
  });
}

/** Six-point trend, oldest → newest (sparkline-ready series from the API). */
function Sparkline({ points, label }: { points: number[]; label: string }) {
  const w = 72;
  const h = 20;
  if (points.length < 2) return <span className={s.muted}>—</span>;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const xy = points.map((p, i) => `${((i / (points.length - 1)) * (w - 4) + 2).toFixed(1)},${(h - 2 - ((p - min) / span) * (h - 4)).toFixed(1)}`);
  const last = xy[xy.length - 1].split(',');
  return (
    <svg className={s.spark} width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label}>
      <polyline points={xy.join(' ')} fill="none" stroke="var(--steel, var(--ink-2))" strokeWidth="1.25" />
      <circle cx={last[0]} cy={last[1]} r="2" fill="var(--electric)" />
    </svg>
  );
}

function StatusPill({ l }: { l: FluxBoardLine }) {
  if (!l.material) return <span className={s.muted}>{l.threshold.excluded ? 'Excluded' : 'Below threshold'}</span>;
  const st = STATUS[l.status];
  return (
    <span className={s.pill}>
      <Pip kind={st.pip} />
      {st.word}
    </span>
  );
}

/** Close → Flux review (FPB-financial-reports §5): explain and review every material change before the hard close. */
export function FluxReview() {
  const { userId } = useAuth();
  const { can } = useMe();
  const canManage = can('close_mgmt', 'manage');
  const { activeCompanyId, isAll, companies } = useActiveCompany();
  const [pickedCompany, setPickedCompany] = useState<string | null>(null);
  const locationId = isAll ? pickedCompany ?? companies[0]?.id ?? null : activeCompanyId;
  const [period, setPeriod] = useState(defaultPeriod);
  const [year, month] = period.split('-').map(Number);
  const [refresh, setRefresh] = useState(0);
  const [band, setBand] = useState<Band>('open');
  const [type, setType] = useState<string>('');
  const [search, setSearch] = useState('');
  const q = useDebounce(search, 250).trim().toLowerCase();
  const [cursor, setCursor] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [waiverOpen, setWaiverOpen] = useState(false);

  const { data, error, isLoading, refetch } = useQuery<FluxBoard>(
    locationId ? '/api/close/flux' : null,
    { location_id: locationId ?? undefined, year: String(year), month: String(month) },
    { key: String(refresh), scope: false },
  );
  const reload = useCallback(() => setRefresh((n) => n + 1), []);

  const lines = useMemo(() => data?.lines ?? [], [data]);
  const rows = useMemo(() => {
    return lines.filter((l) => {
      if (type && l.accountType !== type) return false;
      if (q && !`${l.accountNumber} ${l.accountName} ${l.dimensionLabel ?? ''} ${l.groupName ?? ''}`.toLowerCase().includes(q)) return false;
      switch (band) {
        case 'open': return l.material && l.status !== 'REVIEWED';
        case 'unexplained': return l.material && (l.status === 'UNEXPLAINED' || l.status === 'DRAFT' || l.status === 'STALE');
        case 'review': return l.material && l.status === 'EXPLAINED';
        case 'reviewed': return l.material && l.status === 'REVIEWED';
        case 'material': return l.material;
        default: return true;
      }
    });
  }, [lines, band, type, q]);

  useEffect(() => {
    if (!rows.length) { setCursor(null); return; }
    if (!cursor || !rows.some((r) => r.lineKey === cursor)) setCursor(rows[0].lineKey);
  }, [rows, cursor]);
  const current = rows.find((r) => r.lineKey === cursor) ?? null;

  const sum = data?.summary;
  const gate = data?.gate;
  const columns = useMemo<QueueColumn<FluxBoardLine>[]>(
    () => [
      {
        id: 'account',
        header: 'Account',
        cell: (l) => (
          <>
            <span className="l1" title={`${l.accountNumber} · ${l.accountName}${l.dimensionLabel ? ` — ${l.dimensionLabel}` : ''}`}>{l.accountName}{l.dimensionLabel ? ` — ${l.dimensionLabel}` : ''}</span>
            <span className="l2">{l.accountNumber} · {l.statement === 'BS' ? 'Balance sheet' : l.groupName ?? 'P&L'}</span>
          </>
        ),
      },
      { id: 'current', header: 'This month', width: 112, numeric: true, cell: (l) => <span className="tnum">{money(l.currentCents)}</span> },
      { id: 'comparison', header: data ? BASIS_LABEL[data.policy.comparisonBasis] : 'Comparison', width: 120, numeric: true, cell: (l) => <span className="tnum">{money(l.comparisonCents)}</span> },
      {
        id: 'change',
        header: 'Change',
        width: 120,
        numeric: true,
        cell: (l) => (
          <>
            <span className="l1 tnum">{money(l.changeCents)}</span>
            <span className="l2 tnum">{pctText(l)}</span>
          </>
        ),
      },
      { id: 'trend', header: 'Trend', width: 76, cell: (l) => <Sparkline points={l.trailing.map((t) => t.cents)} label={`${l.accountName}, last six months`} /> },
      { id: 'status', header: 'Status', width: 140, cell: (l) => <StatusPill l={l} /> },
    ],
    [data],
  );

  const exportHref = locationId ? `/api/close/flux/export?location_id=${locationId}&year=${year}&month=${month}&format=csv` : undefined;
  const reviewedStrokes = sum && sum.material > 0 ? countStrokes(Math.min(sum.material, 20), Math.round((sum.reviewed / sum.material) * Math.min(sum.material, 20)), Math.round((sum.explained / sum.material) * Math.min(sum.material, 20))) : null;

  return (
    <div>
      <div className={s.bar}>
        {isAll && (
          <Field label="Company" className={s.company}>
            <Select value={locationId ?? ''} onChange={(e) => { setPickedCompany(e.target.value || null); setCursor(null); }}>
              {companies.length === 0 && <option value="">No companies</option>}
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Month being closed">
          <Select value={period} onChange={(e) => { setPeriod(e.target.value); setCursor(null); }}>
            {recentPeriods().map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </Select>
        </Field>
        <div className={s.grow} />
        {data && (
          <span className="t-cap">
            {data.policy.reviewRequired ? `Material = ${describe(data)} vs ${BASIS_LABEL[data.policy.comparisonBasis].toLowerCase()}` : 'No flux review required for this company'}
            {data.policy.source !== 'COMPANY' ? ` · ${data.policy.source === 'TENANT' ? 'organization default' : 'built-in default'}` : ''}
          </span>
        )}
        <Button variant="quiet" onClick={() => setPolicyOpen(true)} disabled={!locationId}>Materiality</Button>
        {exportHref && <a className="btn" href={exportHref}>Export CSV</a>}
      </div>

      {!locationId ? (
        <div className={`${s.surface} ${s.state}`}>
          <h2 className="t-section">Pick a company</h2>
          <p>Flux review runs per company and month. Choose a company to see which balances moved more than your materiality threshold.</p>
        </div>
      ) : isLoading && !data ? (
        <div className="wg-loading" style={{ height: 320 }} aria-busy="true"><span className="bar-l" style={{ width: '60%' }} /></div>
      ) : error ? (
        <InlineNotice tone="neg" title="Couldn't load the flux review.">
          {error} <Button variant="quiet" onClick={() => void refetch()}>Try again</Button>
        </InlineNotice>
      ) : data ? (
        <>
          {!data.editable && (
            <InlineNotice className={s.notice} title={`${data.period.label} is hard-closed.`}>
              The flux documentation is frozen with the books. Reopen the period to change it.
            </InlineNotice>
          )}
          {data.periodStatus === 'NO_PERIOD' && (
            <InlineNotice className={s.notice} tone="warn" title="No fiscal period for this month yet.">
              The numbers below come from the posted ledger; the close gate applies once the period exists.
            </InlineNotice>
          )}

          <div className={s.strip}>
            <div className={s.cell}>
              <span className={s.cellL}>Material changes</span>
              <span className={s.cellV}>{sum?.material ?? 0}</span>
              <span className={s.cellS}>of {sum?.totalLines ?? 0} lines with activity{sum?.excluded ? ` · ${sum.excluded} excluded` : ''}</span>
            </div>
            <div className={`${s.cell} ${(sum?.unexplained ?? 0) + (sum?.draft ?? 0) + (sum?.stale ?? 0) > 0 ? s.cellWarn : ''}`}>
              <span className={s.cellL}>Need an explanation</span>
              <span className={s.cellV}>{(sum?.unexplained ?? 0) + (sum?.draft ?? 0) + (sum?.stale ?? 0)}</span>
              <span className={s.cellS}>{sum?.stale ? `${sum.stale} moved since explained` : sum?.draft ? `${sum.draft} in draft` : 'Unexplained or in draft'}</span>
            </div>
            <div className={s.cell}>
              <span className={s.cellL}>Awaiting review</span>
              <span className={s.cellV}>{sum?.explained ?? 0}</span>
              <span className={s.cellS}>Reviewed by someone other than the preparer</span>
            </div>
            <div className={`${s.cell} ${gate && ['COMPLETE', 'NOTHING_MATERIAL', 'NOT_REQUIRED', 'WAIVED'].includes(gate.status) ? s.cellOk : s.cellWarn}`}>
              <span className={s.cellL}>Close gate</span>
              <span className={s.cellV}>{gateWord(data)}</span>
              <span className={s.cellS}>
                {sum?.reviewed ?? 0} of {sum?.material ?? 0} reviewed
                {data.waiver?.status === 'WAIVED' && data.waiver.reason ? ` · ${data.waiver.reason}` : ''}
              </span>
              {reviewedStrokes && <Meter className={s.meter} strokes={reviewedStrokes} label={`${sum?.reviewed ?? 0} of ${sum?.material ?? 0} material changes reviewed`} />}
            </div>
          </div>

          {canManage && data.editable && data.policy.reviewRequired && (gate?.status === 'OPEN' || gate?.status === 'WAIVED') && (
            <div className={s.row} style={{ marginBottom: 16 }}>
              <Button variant="quiet" onClick={() => setWaiverOpen(true)}>
                {gate?.status === 'WAIVED' ? 'Withdraw waiver' : 'Waive flux review…'}
              </Button>
              <span className="t-cap">Controller override: lets this month close without every line reviewed. Needs a reason; logged.</span>
            </div>
          )}

          <Bands<Band>
            aria-label="Flux status"
            value={band}
            onChange={(v) => { setBand(v); setCursor(null); }}
            items={[
              { value: 'open', label: 'Open', count: (sum?.material ?? 0) - (sum?.reviewed ?? 0), caption: 'Material, not yet reviewed' },
              { value: 'unexplained', label: 'Unexplained', count: (sum?.unexplained ?? 0) + (sum?.draft ?? 0) + (sum?.stale ?? 0) },
              { value: 'review', label: 'Awaiting review', count: sum?.explained ?? 0 },
              { value: 'reviewed', label: 'Reviewed', count: sum?.reviewed ?? 0 },
              { value: 'material', label: 'All material', count: sum?.material ?? 0 },
              { value: 'all', label: 'Every line', count: sum?.totalLines ?? 0, caption: 'Including below threshold' },
            ]}
          />

          <div className={s.cols}>
            <div className={s.surface}>
              <div className={s.toolbar}>
                <Search aria-label="Search accounts" placeholder="Account, number or department" value={search} onChange={(e) => setSearch(e.target.value)} slashToFocus />
                <Select aria-label="Account type" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">All account types</option>
                  {TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
                </Select>
                <div className={s.grow} />
                <span className="t-cap">J / K to move</span>
              </div>
              {rows.length === 0 ? (
                <div className={s.state}>
                  <h2 className="t-section">{emptyTitle(band, data)}</h2>
                  <p>{emptyBody(band, data)}</p>
                </div>
              ) : (
                <div className={s.tableScroll}>
                <QueueTable<FluxBoardLine>
                  aria-label={`${data.location.name}, flux lines for ${data.period.label}`}
                  columns={columns}
                  rows={rows}
                  getRowId={(l) => l.lineKey}
                  rowState={(l) => ({ attn: l.material && (l.status === 'UNEXPLAINED' || l.status === 'STALE'), done: l.status === 'REVIEWED' })}
                  cursorId={cursor}
                  onCursorChange={(id) => setCursor(id)}
                  onOpen={(l) => setCursor(l.lineKey)}
                  openOnClick
                />
                </div>
              )}
            </div>
            <div className={s.sticky}>
              <FluxPanel
                key={current ? `${current.lineKey}:${current.explanation?.updatedAt ?? ''}` : 'none'}
                board={data}
                line={current}
                userId={userId ?? null}
                canReview={canManage}
                onChanged={reload}
              />
            </div>
          </div>

          {data.policy.reviewRequired === false && (
            <p className="t-cap" style={{ marginTop: 16 }}><Tag>Not required</Tag> This company&apos;s materiality policy does not require a flux review, so the close task passes.</p>
          )}
        </>
      ) : null}

      {policyOpen && locationId && (
        <FluxPolicyDialog locationId={locationId} canEdit={canManage} onClose={() => setPolicyOpen(false)} onSaved={() => { setPolicyOpen(false); reload(); }} />
      )}
      {waiverOpen && data && locationId && (
        <FluxWaiverDialog board={data} onClose={() => setWaiverOpen(false)} onSaved={() => { setWaiverOpen(false); reload(); }} />
      )}
    </div>
  );
}

function describe(b: FluxBoard): string {
  const p = b.policy;
  const d = money(p.absThresholdCents, { decimals: 0 });
  const pct = `${(p.pctThresholdBps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  return p.thresholdMode === 'BOTH' ? `${d} and ${pct}` : p.thresholdMode === 'ABS_ONLY' ? d : p.thresholdMode === 'PCT_ONLY' ? pct : `${d} or ${pct}`;
}

function gateWord(b: FluxBoard): string {
  switch (b.gate.status) {
    case 'COMPLETE': return 'Clear';
    case 'NOTHING_MATERIAL': return 'Nothing material';
    case 'NOT_REQUIRED': return 'Not required';
    case 'WAIVED': return 'Waived';
    case 'UNKNOWN': return 'Unknown';
    default: return 'Blocking';
  }
}

function emptyTitle(band: Band, b: FluxBoard): string {
  if (b.summary.totalLines === 0) return 'No activity this month';
  if (band === 'open' && b.summary.material > 0) return 'Every material change is reviewed';
  if (b.summary.material === 0 && band !== 'all') return 'Nothing material this month';
  return 'Nothing in this view';
}

function emptyBody(band: Band, b: FluxBoard): string {
  if (b.summary.totalLines === 0) return `No posted activity for ${b.location.name} in ${b.period.label} or the months it compares against.`;
  if (band === 'open' && b.summary.material > 0) return 'The flux close task passes. Use “All material” to read back the explanations.';
  if (b.summary.material === 0) return 'No account moved more than the materiality threshold. Open “Every line” to see all movements.';
  return 'Try another band, account type, or clear the search.';
}
