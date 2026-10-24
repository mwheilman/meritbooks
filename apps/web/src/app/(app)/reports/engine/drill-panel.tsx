'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, Drawer, InlineNotice } from '@meritbooks/merit-ui';
import { formatAmount } from '@/lib/reports/engine/format';
import { rangeLabel } from '@/lib/reports/engine/periods';
import type { DrillResult, ReportResult } from '@/lib/reports/engine/types';
import { toCsv, downloadBlob } from '@/lib/reports/export/csv';
import { buildExportFilename } from '@/lib/reports/export/statement-model';
import { fetchDrill } from './use-engine';
import type { CellDrill } from './statement-grid';
import s from './engine.module.css';

const PAGE = 100;

/**
 * The lines behind one figure (statement → account → GL lines → journal entry → source
 * document). Read from the ledger itself, so the panel proves the figure: it states the
 * line count and whether the lines sum to the cell, to the cent.
 */
export function DrillPanel({ drill, result, companyNames, onClose }: {
  drill: CellDrill | null;
  result: ReportResult;
  companyNames: Map<string, string>;
  onClose: () => void;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<DrillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => setPage(0), [drill]);

  useEffect(() => {
    if (!drill) return;
    let live = true;
    setLoading(true);
    setError(null);
    void fetchDrill({
      accountIds: drill.row.accountIds ?? [],
      companyIds: drill.scope.companyIds,
      range: drill.scope.range,
      dims: drill.scope.dims,
      kinds: drill.scope.kinds,
      windows: drill.scope.windows,
      limit: PAGE,
      offset: page * PAGE,
    }).then((r) => {
      if (!live) return;
      setData(r.data);
      setError(r.error);
      setLoading(false);
    });
    return () => { live = false; };
  }, [drill, page]);

  const sign = drill?.row.drillSign ?? 1;
  const ties = data && drill ? sign * data.netCents === drill.value : null;
  const pages = data ? Math.max(1, Math.ceil(data.totalCount / PAGE)) : 1;

  const exportCsv = async () => {
    if (!drill) return;
    setExporting(true);
    const all: DrillResult['lines'] = [];
    for (let off = 0; ; off += 1000) {
      const r = await fetchDrill({ accountIds: drill.row.accountIds ?? [], companyIds: drill.scope.companyIds, range: drill.scope.range, dims: drill.scope.dims, kinds: drill.scope.kinds, windows: drill.scope.windows, limit: 1000, offset: off });
      if (!r.data) break;
      all.push(...r.data.lines);
      if (r.data.lines.length < 1000) break;
    }
    const csv = toCsv({
      title: `${drill.row.label} — lines`,
      entityLabel: drill.scope.companyIds.map((id) => companyNames.get(id) ?? id).join(', ') || 'All companies',
      periodLabel: rangeLabel(drill.scope.range),
      basisLabel: 'Accrual basis (ledger)',
      generatedAt: new Date().toISOString(),
      columns: [
        { key: 'date', label: 'Date' }, { key: 'entry', label: 'Entry' }, { key: 'company', label: 'Company' },
        { key: 'memo', label: 'Memo' }, { key: 'dr', label: 'Debit', money: true }, { key: 'cr', label: 'Credit', money: true },
        { key: 'bal', label: 'Running balance', money: true },
      ],
      rows: all.map((l) => ({ kind: 'account' as const, label: l.entryNumber, values: [l.entryDate, l.entryNumber, companyNames.get(l.companyId) ?? '', l.memo ?? '', l.debitCents, l.creditCents, l.runningNetCents] })),
    });
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), buildExportFilename(`${drill.row.label} lines`, 'csv'));
    setExporting(false);
  };

  const crumbs = useMemo(() => (drill ? [result.title, drill.row.label, [drill.column.label, drill.column.sublabel].filter(Boolean).join(' · ')] : []), [drill, result.title]);

  return (
    <Drawer
      open={!!drill}
      onClose={onClose}
      width={720}
      eyebrow={['Drill', 'GL lines']}
      title={drill?.row.label ?? ''}
      meta={drill ? `${rangeLabel(drill.scope.range)} · ${drill.scope.companyIds.length === 1 ? companyNames.get(drill.scope.companyIds[0]) ?? '1 company' : `${drill.scope.companyIds.length || 'all'} companies`}` : undefined}
      figure={drill ? formatAmount(drill.value, 'cents') : undefined}
      foot={
        <div className={s.pager}>
          <Button variant="quiet" icon="left" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="t-cap">Page {page + 1} of {pages}</span>
          <Button variant="quiet" iconAfter="right" disabled={page + 1 >= pages || loading} onClick={() => setPage((p) => p + 1)}>Next</Button>
          <Button icon="upload" disabled={!data?.totalCount || exporting} onClick={() => void exportCsv()}>{exporting ? 'Exporting…' : 'Export lines'}</Button>
        </div>
      }
    >
      <div className={s.drillCrumbs}>{crumbs.map((c, i) => <span key={i}>{c}</span>)}</div>
      {error ? (
        <InlineNotice tone="neg" title="Couldn't load the lines.">{error}</InlineNotice>
      ) : loading && !data ? (
        <div className={s.skeleton} aria-busy="true">{[0, 1, 2, 3, 4].map((i) => <div key={i} className={s.skRow} style={{ width: `${90 - i * 9}%` }} />)}</div>
      ) : data && data.totalCount === 0 ? (
        <p className={s.empty}>No posted lines for this figure.</p>
      ) : data ? (
        <>
          <div className={s.drillSum} role="status">
            <span><b>{data.totalCount.toLocaleString('en-US')}</b> line{data.totalCount === 1 ? '' : 's'}</span>
            <span>Debits {formatAmount(data.debitCents, 'cents')}</span>
            <span>Credits {formatAmount(data.creditCents, 'cents')}</span>
            <span className={ties ? s.checkOk : s.checkBad}>
              {ties ? 'Lines sum to the figure' : `Lines sum to ${formatAmount(sign * data.netCents, 'cents')} — the figure includes basis or consolidation adjustments`}
            </span>
          </div>
          <table className={s.drillTbl}>
            <thead>
              <tr><th>Date</th><th>Entry</th><th>Memo</th><th className="n">Debit</th><th className="n">Credit</th><th className="n">Balance</th></tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.lineId}>
                  <td>{l.entryDate}</td>
                  <td className={s.drillLinks}>
                    <Link href={l.entryHref}>{l.entryNumber}</Link>
                    {l.sourceHref && <Link href={l.sourceHref}>{l.sourceLabel}</Link>}
                    {l.entryType !== 'STANDARD' && <span className="t-cap"> {l.entryType.toLowerCase()}</span>}
                  </td>
                  <td className={s.drillMemo}>{l.memo}{drill && drill.scope.companyIds.length !== 1 && <div>{companyNames.get(l.companyId)}</div>}</td>
                  <td className="n">{l.debitCents ? formatAmount(l.debitCents, 'cents') : ''}</td>
                  <td className="n">{l.creditCents ? formatAmount(l.creditCents, 'cents') : ''}</td>
                  <td className="n">{formatAmount(l.runningNetCents, 'cents')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Drawer>
  );
}
