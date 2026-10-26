'use client';

/**
 * /fpna — the FP&A workspace (FPB-reports-fpna §4.13). One header (scope · period with compare ·
 * Summarize · Export PDF), eight tabs in the URL, and the books-closed-through footer. Every
 * number comes from /api/fpna/workspace/* (one governed dataset per view); nothing here
 * computes a figure. Report density for owners / CFOs, cockpit density for finance staff.
 */
import { useCallback, useMemo, useState } from 'react';
import { Button, ButtonLink, InlineNotice, Input, Seg, Select, Tabs, useQuery } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { PeriodPicker, usePeriodParam } from '@/components/period';
import { useMe } from '@/lib/hooks/use-me';
import { useActiveCompany } from '@/lib/hooks/use-active-company';
import { TAB_LABEL, FPNA_TABS, type BlocksViewResponse, type CardModel, type FpnaTab, type WsBlock } from '@/lib/fpna/workspace/types';
import type { PeriodBasis, PeriodComparison } from '@/lib/period/resolve';
import { Block } from './_ws/block';
import { DashboardTab } from './_ws/dashboard-tab';
import { DrillDrawer, type DrillTarget } from './_ws/drill-drawer';
import { monthName } from './_ws/format';
import { ScenarioPanel } from './_ws/scenario-panel';
import { ScopeBar } from './_ws/scope-bar';
import { SummaryPanel } from './_ws/summary-panel';
import { useWsUrlState, type ProfitBy } from './_ws/url-state';
import s from './_ws/fpna.module.css';

/** The windows the metric registry evaluates (lib/fpna/workspace/period.ts maps them; no custom range). */
const PICKER_BASES: readonly PeriodBasis[] = ['month', 'qtd', 'quarter', 'ytd', 'fy', 'ttm'];
const COMPARISONS: readonly PeriodComparison[] = ['prior_period', 'prior_year', 'budget'];
const PANEL = 'fpna-panel';
const REPORT_ROLES = new Set(['company_admin', 'cfo', 'business_user']);
const RANGE_TABS = new Set<FpnaTab>(['performance', 'working-capital', 'leverage']);
/** Materiality presets for budget vs actual ($ threshold in cents : % of budget). */
const MATERIALITY: Array<{ value: string; label: string }> = [
  { value: '500000:0.05', label: '$5K or 5%' },
  { value: '1000000:0.1', label: '$10K or 10%' },
  { value: '2500000:0.1', label: '$25K or 10%' },
  { value: '10000000:0.15', label: '$100K or 15%' },
];
const BY_ITEMS: Array<{ value: ProfitBy; label: string }> = [
  { value: 'company', label: 'Company' },
  { value: 'department', label: 'Department' },
  { value: 'class', label: 'Class' },
  { value: 'job', label: 'Job' },
  { value: 'customer', label: 'Customer' },
];

/** Blocks that read best full width. */
function wide(b: WsBlock): boolean {
  return b.kind === 'league' || b.kind === 'heat' || b.kind === 'yoy' || b.kind === 'tiles' || (b.kind === 'series' && b.chart === 'combo' && b.id.startsWith('perf-revenue')) || b.id === 'bva-groups' || b.id === 'group-r40';
}

export function FpnaWorkspace() {
  const me = useMe();
  const role = me.user?.role ?? null;
  const density = role && REPORT_ROLES.has(role) ? 'density-report' : 'density-cockpit';
  const { companies: allCompanies } = useActiveCompany();
  const [ws, setWs, urlReady] = useWsUrlState();
  const pp = usePeriodParam({ pageKey: 'fpna', defaultPreset: 'ytd', bases: PICKER_BASES, comparisons: COMPARISONS, defaultCompare: 'prior_year' });
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [dashParams, setDashParams] = useState<Record<string, string>>({});
  const [mat, setMat] = useState('1000000:0.1');

  const names = useMemo(() => new Map(allCompanies.map((c) => [c.id, c.name])), [allCompanies]);

  const base = useMemo(() => {
    const p: Record<string, string> = { period: pp.selection.end, basis: pp.selection.basis, weighting: ws.weighting, range: ws.range };
    if (pp.selection.compare && pp.selection.compare !== 'none') p.compare = pp.selection.compare;
    else p.compare = 'none';
    if (ws.companies.length) p.companies = ws.companies.join(',');
    return p;
  }, [pp.selection, ws.weighting, ws.range, ws.companies]);

  const tabParams = useMemo(() => {
    const p: Record<string, string> = { ...base, tab: ws.tab };
    if (ws.tab === 'profitability') p.by = ws.by;
    if (ws.tab === 'bridges' && ws.from) p.from = ws.from;
    if (ws.tab === 'budget') {
      const [amount, pct] = mat.split(':');
      p.mat_amount = amount;
      p.mat_pct = pct;
    }
    return p;
  }, [base, ws.tab, ws.by, ws.from, mat]);

  const ready = pp.ready && urlReady;
  const view = useQuery<BlocksViewResponse>(ready && ws.tab !== 'dashboard' ? '/api/fpna/workspace/view' : null, tabParams, { scope: false });
  const current = ws.tab === 'dashboard' ? dashParams : tabParams;
  const exportHref = `/api/fpna/workspace/export?${new URLSearchParams(current).toString()}`;
  const onDashParams = useCallback((p: Record<string, string>) => setDashParams(p), []);

  const cardDrill = (c: CardModel) => {
    const d = c.drill.find((x) => x.accountIds.length > 0);
    if (!d) return;
    setDrill({ title: `${c.name} — ${d.label}`, accountIds: d.accountIds, companyIds: c.scope.included, from: d.kind === 'gl_balance' ? null : c.window.from, to: c.window.to, sign: d.sign, companyNames: names });
  };

  const blockDrill = (b: WsBlock, key: string) => {
    const companyIds = view.data?.scope.companies.map((x) => x.id) ?? [];
    if (b.kind === 'series' && b.drill && /^\d{4}-\d{2}$/.test(key)) {
      setDrill({ title: `${b.eyebrow} — ${monthName(key)}`, accountIds: b.drill.accountIds, companyIds, from: key, to: key, sign: b.drill.sign, companyNames: names });
    } else if (b.kind === 'variance' && b.drillRange) {
      const row = b.rows.find((r) => r.key === key);
      if (row?.accountIds?.length) {
        setDrill({ title: row.label, accountIds: row.accountIds, companyIds: b.drillRange.companyIds, from: b.drillRange.from.slice(0, 7), to: b.drillRange.to.slice(0, 7), sign: row.direction === 'higher_is_better' ? -1 : 1, companyNames: names });
      }
    } else if ((b.kind === 'league' || b.kind === 'heat' || b.kind === 'scatter' || b.kind === 'share') && names.has(key)) {
      setWs({ tab: 'performance', companies: [key] });
    }
  };

  const companyId = ws.companies.length === 1 ? ws.companies[0] : null;
  const fiscalYear = Number((pp.period.fiscalYearLabel.match(/\d{4}/) ?? [String(new Date().getFullYear())])[0]);

  return (
    <div className={`${s.root} ${density}`}>
      <PageHeader
        eyebrow={['Planning & reports', 'FP&A']}
        title="FP&A"
        description="How the business is doing, why, and what to look at next — computed from the books, governed for who is reading, and every figure drillable to its entries."
        actions={
          <>
            <Button variant="quiet" onClick={() => setSummaryOpen(true)}>Summarize this view</Button>
            <ButtonLink href={exportHref} variant="default">Export PDF</ButtonLink>
          </>
        }
      />

      <div className={s.controls}>
        <ScopeBar companies={ws.companies} weighting={ws.weighting} onChange={(patch) => setWs(patch)} />
        <PeriodPicker {...pp.pickerProps} label="Period" placement="bottom-start" />
        <span className={s.controlsGrow} />
        {RANGE_TABS.has(ws.tab) && (
          <Seg<'12' | '24' | '36'> aria-label="Months shown" value={ws.range} onChange={(r) => setWs({ range: r })} items={[{ value: '12', label: '12M' }, { value: '24', label: '24M' }, { value: '36', label: '36M' }]} />
        )}
        {ws.tab === 'budget' && (
          <label className={s.row} style={{ alignItems: 'center', gap: 8 }}>
            <span className={s.muted}>Material at</span>
            <Select aria-label="Materiality" value={mat} onChange={(e) => setMat(e.target.value)}>
              {MATERIALITY.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </Select>
          </label>
        )}
        {ws.tab === 'profitability' && <Seg<ProfitBy> aria-label="Profitability by" value={ws.by} onChange={(by) => setWs({ by })} items={BY_ITEMS} />}
        {ws.tab === 'bridges' && (
          <label className={s.row} style={{ alignItems: 'center', gap: 8 }}>
            <span className={s.muted}>From the period ending</span>
            <Input type="month" aria-label="Bridge from" value={ws.from ?? ''} max={pp.selection.end} onChange={(e) => setWs({ from: e.target.value || null })} style={{ width: 160 }} />
          </label>
        )}
      </div>

      {summaryOpen && <SummaryPanel params={current} onClose={() => setSummaryOpen(false)} />}

      <Tabs<FpnaTab>
        className={s.tabs}
        aria-label="FP&A views"
        value={ws.tab}
        onChange={(tab) => setWs({ tab })}
        items={FPNA_TABS.map((t) => ({ value: t, label: TAB_LABEL[t], panelId: PANEL }))}
      />

      <div id={PANEL} role="tabpanel" aria-label={TAB_LABEL[ws.tab]}>
        {!ready ? (
          <div className={s.skeletonWide} aria-busy="true" />
        ) : ws.tab === 'dashboard' ? (
          <DashboardTab
            params={base}
            dashboardRef={ws.dashboard}
            setDashboardRef={(ref) => setWs({ dashboard: ref })}
            onDrill={cardDrill}
            onParams={onDashParams}
            companies={ws.companies}
            weighting={ws.weighting}
          />
        ) : view.error ? (
          <InlineNotice tone="neg" title={`Couldn’t compute ${TAB_LABEL[ws.tab].toLowerCase()}.`}>
            {view.error} <Button variant="quiet" onClick={() => void view.refetch()}>Try again</Button>
          </InlineNotice>
        ) : !view.data ? (
          <div className={s.blocks} aria-busy="true">
            <div className={`${s.skeletonWide} ${s.wide}`} />
            <div className={s.skeletonWide} />
            <div className={s.skeletonWide} />
          </div>
        ) : (
          <>
            {view.data.notices.map((n) => (
              <InlineNotice key={n.title} className={s.notice} tone={n.tone} title={n.title}>
                {n.body} {n.href && <ButtonLink variant="quiet" href={n.href}>{n.hrefLabel ?? 'Open'}</ButtonLink>}
              </InlineNotice>
            ))}
            {view.data.scope.companies.length === 0 ? (
              <InlineNotice tone="info" title="No companies in this view.">Choose companies you have access to, or ask an administrator for access.</InlineNotice>
            ) : (
              <div className={s.blocks} aria-busy={view.isLoading}>
                {view.data.blocks.map((b, i) => (
                  <Block
                    key={b.id}
                    block={b}
                    index={i + 1}
                    className={wide(b) ? s.wide : undefined}
                    closedThrough={view.data?.governance.closedThrough ? monthName(view.data.governance.closedThrough) : undefined}
                    onDrill={blockDrill}
                    exportMeta={[`Scope: ${view.data?.scope.companies.map((c) => c.name).join(', ') ?? ''}`, `Period: ${view.data?.period.label ?? ''}`, view.data?.governance.footnote ?? '']}
                  />
                ))}
              </div>
            )}
            {ws.tab === 'performance' && (
              <section style={{ marginTop: 24 }} aria-label="What if">
                <h2 className="t-section">What if…</h2>
                <ScenarioPanel companyId={companyId} companyName={companyId ? names.get(companyId) ?? null : null} fiscalYear={fiscalYear} />
              </section>
            )}
          </>
        )}
      </div>

      {(view.data || ws.tab === 'dashboard') && (
        <footer className={s.footer}>
          <span>{ws.tab === 'dashboard' ? 'Every card is computed from the posted ledger by the metric registry; open (i) for its formula.' : view.data?.governance.footnote}</span>
          {view.data?.governance.preview && <span>Preview: includes months that are not closed</span>}
          {view.data && <span>{view.data.cached ? 'Served from a recent computation' : `Computed ${new Date(view.data.generatedAt).toLocaleTimeString('en-US')}`}</span>}
        </footer>
      )}

      <DrillDrawer target={drill} onClose={() => setDrill(null)} />
    </div>
  );
}
