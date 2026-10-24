'use client';

/**
 * ChartCard — the one frame every chart in Books sits in (FEATURE-GAP-AUDIT §4.4,
 * portal M7). Anatomy, top to bottom:
 *
 *   01 // EYEBROW                                   [period chip] (i) [Table] [Export]
 *   Title (Syne in report density · DM Sans 15/600 in cockpit)
 *   Basis line ("By month, Sep ’24 – Aug ’26, with the same month a year earlier")
 *   $1.24M  ▲ 13.1% improvement vs Aug 2025
 *   One deterministic plain-English sentence (doubles as the chart's alt text)
 *   Legend (toggles)
 *   ── chart ──  or  ── table ──  or  ── state ──
 *   Footer: Books closed through Jul 2026 · Aug 2026 preliminary (hatched) · gaps
 *
 * The table always prints under the chart (print CSS). Every chart child reads
 * the legend's hidden set and the live announcer from context.
 */
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Popover } from '@meritbooks/merit-ui';
import { ChangeChip } from './change-chip';
import { ChartStateView, type ChartState } from './chart-state';
import { ChartTableView } from './chart-table';
import { ChartCardContext } from './core/hooks';
import { formatValue, slug } from './core/format';
import { chartTableToCsv, type ChartTable } from './core/table';
import { chartTableToXlsx, XLSX_MIME } from './core/xlsx';
import { downloadBlob, downloadPng, downloadSvg } from './core/export-image';
import type { ChartUnit, MetricDirection, Value } from './core/types';
import { Legend, type LegendItem } from './legend';

export type ExportFormat = 'csv' | 'xlsx' | 'png' | 'svg';

export interface ChartCardDefinition {
  /** What the metric means, in a sentence an owner understands. Administrator-editable. */
  text: ReactNode;
  /** The formula, as written in the metric registry ("Operating income + D&A"). */
  formula?: string;
  /** Where the figures come from ("Posted GL, accrual basis"). */
  source?: string;
  /** Shown to administrators: opens the definition editor (page-text registry). */
  onEdit?: () => void;
}

export interface ChartCardProps {
  /** The one question this chart answers. */
  title: string;
  /** "01 // REVENUE" — the section label. */
  eyebrow?: string;
  index?: number;
  /** Basis line under the title. */
  basis?: string;
  /** Period chip ("Sep ’24 – Aug ’26", "YTD Aug 2026"). */
  period?: string;
  /** Headline figure. */
  value?: { value: Value; unit: ChartUnit; label?: string };
  /** Change chip beside the headline. */
  change?: { current: number; base: number; unit: ChartUnit; direction: MetricDirection; baseLabel: string };
  /** (i) popover. */
  definition?: ChartCardDefinition;
  /** Deterministic one-sentence summary (see core/summary.ts). Required: it is the alt text. */
  summary: string;
  legend?: ReadonlyArray<LegendItem>;
  /** The same data the chart drew — powers View as table, CSV, XLSX, print. */
  table: ChartTable;
  /** Extra lines for the export banner (scope, basis, generated). */
  exportMeta?: string[];
  exportFormats?: ReadonlyArray<ExportFormat>;
  /** Base file name (default: slug of title + period). */
  exportName?: string;
  /** Replaces the chart (loading / empty / unavailable / error). */
  state?: ChartState;
  /** "Jul 2026" → "Books closed through Jul 2026". */
  closedThrough?: string;
  /** Footer notes (preliminary, gaps, eliminations). */
  footnotes?: ReadonlyArray<string>;
  /** "Click a month to see its entries". Shown in the footer when drill is wired. */
  drillHint?: string;
  /** Reserved chart height (px) so states and the table toggle never shift layout. */
  height?: number;
  /** Start on the table (e.g. a screen-reader preference). */
  defaultView?: 'chart' | 'table';
  /** Header actions beside the built-ins (one primary per module). */
  actions?: ReactNode;
  /** Visual weight: primary = 2px Electric rule under the head. */
  primary?: boolean;
  /** Table row click → drill (pass the chart's onDrill). */
  onRowDrill?: (key: string) => void;
  className?: string;
  /** The chart. */
  children: ReactNode;
}

const EXPORT_LABEL: Record<ExportFormat, string> = { csv: 'CSV', xlsx: 'Excel (.xlsx)', png: 'Image (.png)', svg: 'Vector (.svg)' };

export function ChartCard({
  title,
  eyebrow,
  index,
  basis,
  period,
  value,
  change,
  definition,
  summary,
  legend,
  table,
  exportMeta,
  exportFormats = ['csv', 'xlsx', 'png', 'svg'],
  exportName,
  state,
  closedThrough,
  footnotes,
  drillHint,
  height = 240,
  defaultView = 'chart',
  actions,
  primary,
  onRowDrill,
  className,
  children,
}: ChartCardProps) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const titleId = `${uid}-t`;
  const summaryId = `${uid}-s`;
  const tableId = `${uid}-tbl`;
  const bodyRef = useRef<HTMLDivElement>(null);
  const defRef = useRef<HTMLButtonElement>(null);
  const expRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<'chart' | 'table'>(defaultView);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [live, setLive] = useState('');
  const [defOpen, setDefOpen] = useState(false);
  const [expOpen, setExpOpen] = useState(false);

  const announce = useCallback((m: string) => {
    // Re-set so the same message announces twice in a row.
    setLive('');
    window.setTimeout(() => setLive(m), 30);
  }, []);

  const toggle = useCallback(
    (key: string) => {
      setHidden((prev) => {
        const next = new Set(prev);
        const label = legend?.find((l) => l.key === key)?.label ?? key;
        if (next.has(key)) {
          next.delete(key);
          announce(`${label} shown`);
        } else {
          next.add(key);
          announce(`${label} hidden`);
        }
        return next;
      });
    },
    [announce, legend],
  );

  const ctx = useMemo(() => ({ hidden, announce, labelledBy: `${titleId} ${summaryId}` }), [hidden, announce, titleId, summaryId]);

  const fileBase = exportName ?? slug(`${title}${period ? ` ${period}` : ''}`);
  const meta = useMemo(
    () => [
      ...(period ? [`Period: ${period}`] : []),
      ...(basis ? [basis] : []),
      ...(closedThrough ? [`Books closed through ${closedThrough}`] : []),
      ...(exportMeta ?? []),
      summary,
    ],
    [period, basis, closedThrough, exportMeta, summary],
  );

  const doExport = useCallback(
    async (f: ExportFormat) => {
      setExpOpen(false);
      try {
        // BOM so Excel on Windows reads the UTF-8 (’ – —) correctly.
        if (f === 'csv') downloadBlob(new Blob(['\uFEFF', chartTableToCsv(table, meta)], { type: 'text/csv;charset=utf-8' }), `${fileBase}.csv`);
        else if (f === 'xlsx') downloadBlob(new Blob([chartTableToXlsx(table, meta)], { type: XLSX_MIME }), `${fileBase}.xlsx`);
        else {
          const svg = bodyRef.current?.querySelector<SVGSVGElement>('svg.mc-svg');
          if (!svg) {
            announce('Switch to the chart view to export an image');
            return;
          }
          if (f === 'svg') downloadSvg(svg, `${fileBase}.svg`, `${title}. ${summary}`);
          else await downloadPng(svg, `${fileBase}.png`, `${title}. ${summary}`);
        }
        announce(`${EXPORT_LABEL[f]} downloaded`);
      } catch (e) {
        announce(e instanceof Error ? e.message : 'Export failed');
      }
    },
    [announce, fileBase, meta, summary, table, title],
  );

  const ready = !state;
  const allNotes = [...(closedThrough ? [`Books closed through ${closedThrough}`] : []), ...(footnotes ?? [])];

  return (
    <ChartCardContext.Provider value={ctx}>
      <section className={['mc-card', primary ? 'mc-card--primary' : '', className ?? ''].filter(Boolean).join(' ')} aria-labelledby={titleId}>
        <header className={eyebrow || index != null ? 'mc-head' : 'mc-head mc-head--noeb'}>
          {(eyebrow || index != null) && (
            <p className="eyebrow mc-eyebrow">
              {index != null && <span className="tnum">{String(index).padStart(2, '0')}</span>}
              {index != null && eyebrow && <span className="sl">//</span>}
              {eyebrow}
            </p>
          )}
          <h3 className="mc-title" id={titleId}>
            {title}
          </h3>
          {basis && <p className="mc-basis">{basis}</p>}
          <div className="mc-head-act" data-print="hide">
            {period && <span className="mc-chip tnum">{period}</span>}
            {definition && (
              <>
                <button
                  ref={defRef}
                  type="button"
                  className="mc-icon-btn"
                  aria-label={`What ${title} means`}
                  aria-expanded={defOpen}
                  aria-haspopup="dialog"
                  onClick={() => setDefOpen((o) => !o)}
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <rect x="1.75" y="1.75" width="12.5" height="12.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    <path d="M8 7v4.5M8 4.5v1.2" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
                <Popover open={defOpen} onClose={() => setDefOpen(false)} anchorRef={defRef} aria-label={`Definition: ${title}`} width={360} placement="bottom-end">
                  <div className="mc-def">
                    <p className="eyebrow">Definition</p>
                    <div className="mc-def-t">{definition.text}</div>
                    {definition.formula && (
                      <p className="mc-def-f">
                        <span className="eyebrow">Formula</span>
                        <span>{definition.formula}</span>
                      </p>
                    )}
                    {definition.source && <p className="mc-def-s">{definition.source}</p>}
                    {definition.onEdit && (
                      <button
                        type="button"
                        className="btn btn--quiet mc-def-e"
                        onClick={() => {
                          setDefOpen(false);
                          definition.onEdit?.();
                        }}
                      >
                        Edit definition
                      </button>
                    )}
                  </div>
                </Popover>
              </>
            )}
            <button
              type="button"
              className="mc-tbtn"
              aria-pressed={view === 'table'}
              aria-controls={view === 'table' ? tableId : undefined}
              onClick={() => {
                const next = view === 'table' ? 'chart' : 'table';
                setView(next);
                announce(next === 'table' ? 'Showing the table' : 'Showing the chart');
              }}
              disabled={!ready && state?.kind !== 'unavailable'}
            >
              {view === 'table' ? 'View as chart' : 'View as table'}
            </button>
            {exportFormats.length > 0 && (
              <>
                <button
                  ref={expRef}
                  type="button"
                  className="mc-tbtn"
                  aria-haspopup="menu"
                  aria-expanded={expOpen}
                  onClick={() => setExpOpen((o) => !o)}
                  disabled={!ready}
                >
                  Export
                  <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
                    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  </svg>
                </button>
                <Popover open={expOpen} onClose={() => setExpOpen(false)} anchorRef={expRef} aria-label={`Export ${title}`} width={220} placement="bottom-end" role="menu">
                  <ul className="mc-menu" role="none">
                    {exportFormats.map((f) => (
                      <li key={f} role="none">
                        <button type="button" role="menuitem" className="mc-menu-i" onClick={() => void doExport(f)}>
                          <span>{EXPORT_LABEL[f]}</span>
                          <span className="mc-menu-m">{f === 'csv' || f === 'xlsx' ? 'Table' : 'Chart'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </Popover>
              </>
            )}
            {actions}
          </div>
        </header>

        {(value || change) && ready && (
          <div className="mc-fig">
            {value && (
              <span className="mc-fig-v tnum">
                {formatValue(value.value, value.unit, { compact: value.unit === 'money' })}
                {value.label && <span className="mc-fig-l">{value.label}</span>}
              </span>
            )}
            {change && <ChangeChip {...change} />}
          </div>
        )}

        <p className="mc-sum" id={summaryId}>
          {summary}
        </p>

        {legend && legend.length > 0 && ready && view === 'chart' && <Legend items={legend} hidden={hidden} onToggle={toggle} />}

        <div className="mc-body" ref={bodyRef} style={{ minHeight: height }}>
          {state ? (
            view === 'table' && state.kind === 'unavailable' ? (
              <ChartTableView table={table} id={tableId} onRowDrill={onRowDrill} />
            ) : (
              <ChartStateView state={state} height={height} />
            )
          ) : view === 'table' ? (
            <ChartTableView table={table} id={tableId} onRowDrill={onRowDrill} />
          ) : (
            children
          )}
        </div>

        {/* The table always prints under the chart (screen: hidden). */}
        {ready && view === 'chart' && <ChartTableView table={table} className="mc-print-only" />}

        {(allNotes.length > 0 || drillHint) && (
          <footer className="mc-foot">
            {allNotes.map((n, i) => (
              <span key={i} className="mc-foot-n">
                {n}
              </span>
            ))}
            {drillHint && ready && (
              <span className="mc-foot-d" data-print="hide">
                {drillHint}
              </span>
            )}
          </footer>
        )}
        <div className="sr" aria-live="polite" aria-atomic="true">
          {live}
        </div>
      </section>
    </ChartCardContext.Provider>
  );
}
