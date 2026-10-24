'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Dialog, Field, Icon, InlineNotice, Input, Keyhints, Popover, Tag, toast, api } from '@meritbooks/merit-ui';
import { PageHeader } from '@/components/ui';
import { toCsv, downloadBlob } from '@/lib/reports/export/csv';
import { buildExportFilename } from '@/lib/reports/export/statement-model';
import { toStatementModel } from '@/lib/reports/engine/to-model';
import type { ReportResult } from '@/lib/reports/engine/types';
import { findEngineReport, SHELVES } from './catalog';
import { Controls } from './controls';
import { DrillPanel } from './drill-panel';
import { StatementChart } from './statement-chart';
import { StatementGrid, type CellDrill } from './statement-grid';
import { useEngineMeta, usePrefs, useReport } from './use-engine';
import { fromQuery, toPackSpec, toQuery, toRequest, type ViewState } from './view-state';
import s from './engine.module.css';

export interface StatementViewerProps {
  reportKey: string;
  today: string;
  activeCompanyId: string | null;
  onBack: () => void;
}

/** The 3D governance fields the viewer shows (ReportResult.governance is open-ended). */
export function governanceView(r: ReportResult): { banner: string | null; watermark: string | null; closedThrough: string | null; withheld: number } {
  const g = r.governance ?? null;
  if (!g) return { banner: null, watermark: null, closedThrough: null, withheld: 0 };
  const b = g.banner as { text?: unknown } | null | undefined;
  const withheld = Array.isArray(g.withheldColumnIds) ? g.withheldColumnIds.length : 0;
  const ct = typeof g.booksClosedThrough === 'string' ? g.booksClosedThrough : null;
  return {
    banner: b && typeof b.text === 'string' ? b.text : null,
    watermark: typeof g.watermark === 'string' ? g.watermark : null,
    closedThrough: ct ? new Date(`${ct.length === 7 ? `${ct}-01` : ct}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : null,
    withheld,
  };
}

function hasFigures(r: ReportResult): boolean {
  return r.rows.some((row) => row.kind === 'account' && row.values.some((v) => v != null && v !== 0));
}

/** The one statement viewer for every engine report (FPB-financial-reports §4 AC3A.23). */
export function StatementViewer({ reportKey, today, activeCompanyId, onBack }: StatementViewerProps) {
  const router = useRouter();
  const params = useSearchParams();
  const def = findEngineReport(reportKey);
  const statement = def?.preset?.statement ?? 'income_statement';
  const [state, setState] = useState<ViewState>(() => fromQuery(new URLSearchParams(params?.toString() ?? `report=${reportKey}`), today, activeCompanyId));
  const meta = useEngineMeta();
  const prefs = usePrefs();
  const request = useMemo(() => toRequest(state), [state]);
  const report = useReport(request, reportKey);
  const [drill, setDrill] = useState<CellDrill | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [saveOpen, setSaveOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLButtonElement>(null);
  const result = report.data;

  // URL is the source of truth for sharing: reflect state without a navigation.
  useEffect(() => {
    const q = toQuery(state).toString();
    if (q !== (params?.toString() ?? '')) router.replace(`/reports?${q}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const change = useCallback((patch: Partial<ViewState>) => setState((st) => ({ ...st, ...patch })), []);
  const toggle = useCallback((id: string) => setCollapsed((c) => {
    const n = new Set(c);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  }), []);
  const parents = useMemo(() => new Set((result?.rows ?? []).filter((r) => r.collapsible).map((r) => r.id)), [result]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '[') setCollapsed(new Set(parents));
      else if (e.key === ']') setCollapsed(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parents]);

  const companyNames = useMemo(() => new Map((meta.data?.companies ?? []).map((c) => [c.id, c.name])), [meta.data]);
  const favorite = prefs.data?.find((p) => p.reportKey === reportKey)?.isFavorite ?? false;
  const timeSplit = state.columns === 'month' || state.columns === 'quarter' || state.columns === 'year';

  const doExport = async (fmt: 'csv' | 'xlsx' | 'pdf') => {
    if (!result) return;
    setExportOpen(false);
    const model = toStatementModel(result, { collapsed });
    if (fmt === 'csv') {
      downloadBlob(new Blob([toCsv(model)], { type: 'text/csv;charset=utf-8' }), buildExportFilename(model.title, 'csv'));
      return;
    }
    setBusy(true);
    try {
      // Governed export: the server RE-RUNS the request (never renders a client-sent model).
      const resp = await fetch(`/api/reports/export/${fmt}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: request, collapsed: Array.from(collapsed) }) });
      if (!resp.ok) throw new Error(`Export failed (${resp.status})`);
      downloadBlob(await resp.blob(), buildExportFilename(model.title, fmt));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  };

  const saveView = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const r = await api.post('/api/reports/views', { name: name.trim(), report_key: reportKey, config: { engine: state, query: toQuery(state).toString() } });
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return; }
    setSaveOpen(false);
    setName('');
    toast(`Saved view “${name.trim()}”. It is in the report library under Saved views.`);
  };

  const packSpec = toPackSpec(state);
  const addToPack = async () => {
    if (!name.trim() || !packSpec) return;
    setBusy(true);
    const r = await api.post('/api/reports/packs', { name: name.trim(), specs: [packSpec], location_ids: state.companies, entity_label: state.companies.length === 1 ? companyNames.get(state.companies[0]) : undefined });
    setBusy(false);
    if (r.error) { toast.error(r.error.error); return; }
    setPackOpen(false);
    setName('');
    toast('Report pack created. Set its schedule and recipients under Saved packs.');
  };

  const shelf = SHELVES.find((x) => x.key === def?.shelf)?.label ?? 'Reports';
  const warnings = result?.warnings ?? [];
  const gov = result ? governanceView(result) : null;
  const failedChecks = (result?.checks ?? []).filter((c) => !c.ok);

  return (
    <div>
      <button type="button" className={s.crumb} onClick={onBack}><Icon name="left" /> Report library</button>
      <PageHeader
        eyebrow={['Reports', shelf]}
        title={result?.title ?? def?.label ?? 'Report'}
        description={result?.subtitle ?? def?.desc}
        actions={
          <div className={s.actions}>
            <Button variant="quiet" iconOnly icon="flag" aria-pressed={favorite} aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'} onClick={() => void prefs.toggle(reportKey, !favorite)} />
            <Button icon="history" onClick={() => { setName(def?.label ?? ''); setSaveOpen(true); }} disabled={!result}>Save view</Button>
            <Button icon="calendar" onClick={() => { setName(def?.label ?? ''); setPackOpen(true); }} disabled={!result || !packSpec} title={packSpec ? undefined : 'This statement is not available in report packs yet'}>Add to pack</Button>
            <Button ref={exportRef} icon="upload" iconAfter="down" aria-haspopup="menu" aria-expanded={exportOpen} disabled={!result || busy} onClick={() => setExportOpen((o) => !o)}>{busy ? 'Exporting…' : 'Export'}</Button>
            <Popover open={exportOpen} onClose={() => setExportOpen(false)} anchorRef={exportRef} width={220} role="menu" aria-label="Export" placement="bottom-end">
              <div className={s.pickList} role="none">
                <Button variant="quiet" className={s.menuItem} role="menuitem" onClick={() => void doExport('pdf')}>PDF (print-ready)</Button>
                <Button variant="quiet" className={s.menuItem} role="menuitem" onClick={() => void doExport('xlsx')}>Excel (.xlsx)</Button>
                <Button variant="quiet" className={s.menuItem} role="menuitem" onClick={() => void doExport('csv')}>CSV</Button>
              </div>
            </Popover>
            <Button variant="quiet" icon="file-text" onClick={() => window.print()} disabled={!result}>Print</Button>
            {(statement === 'income_statement' || statement === 'balance_sheet') && (
              <Link className="btn btn--quiet" href="/reports/layouts"><Icon name="sliders" />Layouts</Link>
            )}
          </div>
        }
      />

      <Controls state={state} statement={statement} meta={meta.data} onChange={change} today={today} />

      {result && (
        <div className={s.chips}>
          <Tag>{result.basisLabel}</Tag>
          {result.columns.some((c) => c.status === 'preliminary') && <Tag tone="warn">P = preliminary (not hard-closed)</Tag>}
          {result.columns.some((c) => c.status === 'partial') && <Tag tone="warn">* = in progress</Tag>}
          {state.consolidate && <Tag tone="solid">Consolidated</Tag>}
          {gov?.closedThrough && <Tag>Books closed through {gov.closedThrough}</Tag>}
          {gov?.watermark === 'preview' && <Tag tone="warn">Preview — not released</Tag>}
          {gov?.watermark === 'preliminary' && <Tag tone="warn">Preliminary</Tag>}
          {(gov?.withheld ?? 0) > 0 && <Tag tone="warn">{gov!.withheld} column{gov!.withheld === 1 ? '' : 's'} not released</Tag>}
        </div>
      )}

      {gov?.banner && <InlineNotice className={s.notice} tone="warn" title={gov.banner} />}

      <div style={{ height: 12 }} />

      {warnings.filter((w) => w.code !== 'PARTIAL_PERIOD').map((w, i) => (
        <InlineNotice key={i} className={s.notice} tone={w.code === 'OUT_OF_BALANCE' || w.code === 'CASH_DOES_NOT_TIE' || w.code === 'ELIMINATION_RESIDUAL' ? 'neg' : 'warn'} title={w.message} />
      ))}

      {result && result.checks.length > 0 && (
        <p className={s.checks} role="status">
          {failedChecks.length === 0
            ? <span className={s.checkOk}><Icon name="check" /> {result.checks.length === 1 ? result.checks[0].label : `All ${result.checks.length} checks tie`}</span>
            : failedChecks.map((c) => <span key={c.id} className={s.checkBad}>{c.label}: {c.differenceCents === null ? 'does not tie' : `off by ${c.differenceCents} cents`}</span>)}
        </p>
      )}

      {report.loading && !result ? (
        <div className={s.skeleton} aria-busy="true" aria-label="Loading the statement">
          {Array.from({ length: 12 }).map((_, i) => <div key={i} className={s.skRow} style={{ width: `${40 + ((i * 37) % 55)}%` }} />)}
        </div>
      ) : report.error ? (
        <div className={s.stateBox} role="alert">
          <h2 className="t-section">{report.code === 'CLIENT_SCOPE_DENIED' ? 'That company is outside your access' : 'This statement could not be produced'}</h2>
          <p>{report.code === 'CLIENT_SCOPE_DENIED' ? 'You can only report on the companies assigned to you. Choose companies you have access to, or ask an administrator for access.' : report.error}</p>
          {report.code === 'CLIENT_SCOPE_DENIED'
            ? <Button onClick={() => change({ companies: [] })}>Use my companies</Button>
            : <Button onClick={report.reload}>Try again</Button>}
        </div>
      ) : result && !hasFigures(result) ? (
        <div className={s.stateBox}>
          <h2 className="t-section">No posted activity for this selection</h2>
          <p>Nothing has posted to {result.companies.length === 1 ? result.companies[0].name : 'these companies'} for {result.subtitle.split(' · ')[1] ?? 'this period'}. Pick an earlier period, add companies, or post journal entries — statements update the moment entries post.</p>
          <Button onClick={() => change({ preset: 'year' })}>Show the whole fiscal year</Button>
        </div>
      ) : result ? (
        <>
          {timeSplit && (statement === 'income_statement' || statement === 'balance_sheet') && (
            <div className={s.chartSlot}><StatementChart result={result} /></div>
          )}
          {parents.size > 0 && (
            <div className={s.actions} style={{ marginBottom: 8 }}>
              <Button variant="quiet" onClick={() => setCollapsed(new Set(parents))} chord="[">Collapse groups</Button>
              <Button variant="quiet" onClick={() => setCollapsed(new Set())} chord="]">Expand all</Button>
            </div>
          )}
          <div aria-busy={report.loading || undefined} style={report.loading ? { opacity: 0.6 } : undefined}>
            <StatementGrid result={result} onDrill={setDrill} collapsed={collapsed} onToggle={toggle} />
          </div>
          <div className={s.foot}>
            <div>
              {result.notes.map((n, i) => <p key={i}>{n}</p>)}
              {result.rounding !== 'cents' && <p>Rounded for display; totals are computed from exact cents before rounding, so a column may differ from the sum of its rounded lines by a rounding difference. Exports carry exact cents.</p>}
              <p>{result.basisLabel}. Generated {new Date(result.generatedAt).toLocaleString('en-US')}. Click any figure to see the ledger lines behind it.</p>
            </div>
            <Keyhints className={s.kbd} hints={[{ chord: 'j', label: 'next row' }, { chord: 'k', label: 'previous row' }, { chord: 'enter', label: 'open lines' }, { chord: '[', label: 'collapse all' }, { chord: ']', label: 'expand all' }]} />
          </div>
        </>
      ) : null}

      {result && <DrillPanel drill={drill} result={result} companyNames={companyNames} onClose={() => setDrill(null)} />}

      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="Save this view"
        actions={<><Button variant="quiet" onClick={() => setSaveOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={() => void saveView()}>Save view</Button></>}
        footNote="Saves the period, comparisons, columns, companies, basis and layout. Everyone in your organization can open it."
      >
        <Field label="Name"><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus /></Field>
      </Dialog>

      <Dialog
        open={packOpen}
        onClose={() => setPackOpen(false)}
        title="Add to a new report pack"
        actions={<><Button variant="quiet" onClick={() => setPackOpen(false)}>Cancel</Button><Button variant="primary" disabled={!name.trim() || busy} onClick={() => void addToPack()}>Create pack</Button></>}
        footNote="Packs re-run on their schedule with the period rolled forward. Set recipients and cadence under Saved packs."
      >
        <Field label="Pack name"><Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-autofocus /></Field>
      </Dialog>
    </div>
  );
}
