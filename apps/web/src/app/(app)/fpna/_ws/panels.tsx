'use client';

/**
 * Table-type panels: the sortable league table with sparklines (stale flags, sticky first
 * column, totals recomputed not averaged), the YoY table (margins in points), the CAGR
 * ladder, the seasonality index, and figure tiles. Tabular figures, right-aligned, gaps as "—".
 */
import { useMemo, useState } from 'react';
import { Sparkline, formatValue } from '@/components/charts';
import type { WsCagrBlock, WsLeagueBlock, WsSeasonalityBlock, WsTilesBlock, WsYoyBlock, WsYoyCell } from '@/lib/fpna/workspace/types';
import { monthName } from './format';
import s from './fpna.module.css';

export function LeagueTable({ block, onRow }: { block: WsLeagueBlock; onRow?: (key: string) => void }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 }>({ col: 0, dir: -1 });
  const rows = useMemo(() => {
    const out = [...block.rows];
    out.sort((a, b) => {
      const x = a.values[sort.col];
      const y = b.values[sort.col];
      if (x === null && y === null) return a.label.localeCompare(b.label);
      if (x === null) return 1; // missing values always last, never as zero
      if (y === null) return -1;
      return (x - y) * sort.dir;
    });
    return out;
  }, [block.rows, sort]);
  const head = (i: number, label: string, dir: string) => (
    <th key={i} aria-sort={sort.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={s.sortBtn} onClick={() => setSort((p) => ({ col: i, dir: p.col === i ? (p.dir === 1 ? -1 : 1) : -1 }))}>
        {label} {dir}
        {sort.col === i ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr">{block.title}. Click a column heading to sort.</caption>
        <thead>
          <tr>
            <th scope="col">{block.rowHeading}</th>
            {block.columns.map((c, i) => head(i, c.label, c.direction === 'higher_is_better' ? '↑' : c.direction === 'lower_is_better' ? '↓' : ''))}
            <th scope="col">{block.sparkLabel}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.href ? (
                  <a className={s.rowLink} href={r.href}>{r.label}</a>
                ) : onRow ? (
                  <button type="button" className={`${s.sortBtn} ${s.rowLink}`} onClick={() => onRow(r.key)}>{r.label}</button>
                ) : (
                  r.label
                )}
                {r.sub && <span className={s.sub}>{r.sub}</span>}
              </td>
              {r.values.map((v, i) => (
                <td key={i} title={v === null ? r.reasons[i] ?? 'Not available' : undefined}>
                  {formatValue(v, block.columns[i].unit, { compact: block.columns[i].unit === 'money' })}
                </td>
              ))}
              <td>
                <Sparkline values={r.spark} unit={block.sparkUnit} metric={`${r.label} ${block.sparkLabel}`} labels={block.sparkPeriods} statuses={r.sparkStatuses} width={120} height={22} />
              </td>
            </tr>
          ))}
        </tbody>
        {block.total && (
          <tfoot>
            <tr>
              <td>{block.total.label}</td>
              {block.total.values.map((v, i) => (
                <td key={i}>{formatValue(v, block.columns[i].unit, { compact: block.columns[i].unit === 'money' })}</td>
              ))}
              <td />
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function yoyCell(c: WsYoyCell, unit: 'money' | 'percent') {
  const chg = unit === 'percent' ? (c.points === null ? 'n/m' : `${c.points > 0 ? '+' : ''}${c.points.toFixed(1)} pts`) : c.pct === null ? (c.change === null ? '—' : 'n/m') : `${c.pct > 0 ? '+' : ''}${c.pct.toFixed(1)}%`;
  return [formatValue(c.current, unit, { compact: unit === 'money' }), formatValue(c.prior, unit, { compact: unit === 'money' }), chg];
}

export function YoyTable({ block }: { block: WsYoyBlock }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr">{block.title}</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            {[block.headings.month, block.headings.fytd, block.headings.ttm].map((h) => (
              <th key={h} scope="colgroup" colSpan={3}>{h}</th>
            ))}
          </tr>
          <tr>
            <th />
            {[0, 1, 2].map((i) => [<th key={`a${i}`}>This year</th>, <th key={`b${i}`}>Last year</th>, <th key={`c${i}`}>Change</th>])}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              {[r.month, r.fytd, r.ttm].flatMap((c, k) => yoyCell(c, r.unit).map((t, j) => <td key={`${k}${j}`}>{t}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CagrLadder({ block }: { block: WsCagrBlock }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.table}>
        <caption className="sr">{block.title}</caption>
        <thead>
          <tr>
            <th scope="col">Line</th>
            <th>1 year</th>
            <th>3 years</th>
            <th>5 years</th>
          </tr>
        </thead>
        <tbody>
          {block.rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              {r.rungs.map((g) => (
                <td key={g.years} title={g.unavailable?.message}>
                  {g.value === null ? <span className={s.muted}>{g.unavailable?.title ?? '—'}</span> : formatValue(g.value, 'percent')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SeasonalityChart({ block }: { block: WsSeasonalityBlock }) {
  const max = Math.max(1.2, ...block.months.map((m) => Math.max(m.index ?? 0, m.current ?? 0)));
  return (
    <div>
      <div className={s.season} role="img" aria-label={block.summary}>
        {block.months.map((m) => (
          <div key={m.key} className={s.seasonCol} title={`${m.label}: index ${m.index === null ? '—' : m.index.toFixed(2)}${m.current !== null ? `, this year ${m.current.toFixed(2)}` : ''}`}>
            <div style={{ position: 'relative', flex: '1 1 auto', width: '100%' }}>
              <div className={s.seasonBar} style={{ position: 'absolute', bottom: 0, left: '15%', height: `${((m.index ?? 0) / max) * 100}%` }} />
              {m.current !== null && <span className={s.seasonCur} style={{ bottom: `${(m.current / max) * 100}%`, left: '5%', width: '90%' }} />}
            </div>
            <span className={s.seasonLbl}>{m.label}</span>
          </div>
        ))}
      </div>
      <p className={s.muted} style={{ margin: '8px 0 0' }}>
        Bars: the seasonal index (1.00 = an average month). Blue rule: this fiscal year so far.
        {block.quarterShares.some((q) => q !== null) && ` Quarter shares of the year: ${block.quarterShares.map((q, i) => `Q${i + 1} ${q === null ? '—' : formatValue(q, 'percent')}`).join(' · ')}.`}
        {block.best && block.worst && ` Best month this year ${monthName(block.best.month)}, weakest ${monthName(block.worst.month)}.`}
      </p>
    </div>
  );
}

export function Tiles({ block }: { block: WsTilesBlock }) {
  return (
    <div className={s.tiles} role="list">
      {block.tiles.map((t) => (
        <div key={t.key} className={s.tile} role="listitem">
          <div className={s.tileL}>{t.label}</div>
          <div className={s.tileV}>{formatValue(t.value, t.unit, { compact: t.unit === 'money' })}</div>
          <div className={s.tileS}>{t.sub}</div>
        </div>
      ))}
    </div>
  );
}
