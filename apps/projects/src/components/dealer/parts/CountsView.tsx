'use client';

import { useMemo, useState } from 'react';
import { Button, ConfirmDialog, Field, Input, Select, WidgetState, count, money, shortDate } from '@meritbooks/merit-ui';
import { COUNT_STATUS } from '@/lib/pm/dealer/labels';
import type { CountList } from '@/lib/pm/dealer/parts-queries';
import type { StockLocationRow } from '@/lib/pm/dealer/types';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, StatusMark, parseNum } from '@/components/ops/common/bits';
import { useStore } from '../common/useStore';

export interface CountsViewProps {
  data: CountList;
  stockLocations: StockLocationRow[];
  canWrite: boolean;
  today: string;
}

/** Physical counts: snapshot a stock location, key what is on the shelf bin by bin, post the variance. */
export function CountsView(p: CountsViewProps) {
  // Count variance valued at cost is financials.
  const mv = useMoneyVis();
  const { readOnly } = useShell();
  const { act, busy, error } = useStore();
  const open = p.data.counts.find((c) => c.status === 'OPEN') ?? null;
  const lines = useMemo(() => p.data.lines.filter((l) => l.count_id === open?.id), [p.data.lines, open?.id]);
  const [keyed, setKeyed] = useState<Record<string, string>>({});
  const [sl, setSl] = useState(p.stockLocations[0]?.id ?? '');
  const [postOpen, setPostOpen] = useState(false);
  const live = !readOnly && p.canWrite;

  const value = (id: string, fallback: number | null) => (keyed[id] !== undefined ? parseNum(keyed[id]!) : fallback);
  const counted = lines.filter((l) => value(l.id, l.counted_qty) != null).length;
  const variance = lines.reduce((s, l) => { const v = value(l.id, l.counted_qty); return v == null ? s : s + (v - l.expected_qty); }, 0);
  const dirty = Object.keys(keyed).filter((id) => { const l = lines.find((x) => x.id === id); return l && parseNum(keyed[id]!) !== l.counted_qty; });

  const save = async () => {
    const batch = dirty.map((id) => ({ lineId: id, counted: parseNum(keyed[id]!) }));
    if (!batch.length || !open) return;
    const r = await act('save', 'post', `/api/dealer/counts/${open.id}`, { op: 'set', lines: batch }, `Saved ${batch.length} count${batch.length === 1 ? '' : 's'}`);
    if (r.data) setKeyed({});
  };

  if (!open) {
    return (
      <div className="stack">
        {live && (
          <form className="ops-toolbar" onSubmit={(e) => { e.preventDefault(); if (sl) void act('start', 'post', '/api/dealer/counts', { stockLocationId: sl }, 'Started the count'); }}>
            <Field label="Count at"><Select value={sl} onChange={(e) => setSl(e.target.value)}>{p.stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
            <Button type="submit" variant="primary" disabled={!sl || busy === 'start'}>Start a count</Button>
            <span className="t-cap">Snapshots on-hand for every stocked part there. Sales keep working while you count.</span>
          </form>
        )}
        {error && <Failure text={error} />}
        {p.data.counts.length === 0 ? (
          <WidgetState state={{ kind: 'empty', title: 'No counts yet', body: 'Start a count to check the shelf against the books: key what you find, and the difference posts as a stock adjustment. Merit Books revalues the inventory.' }} />
        ) : (
          <div className="mp-table">
            <table className="dl-tbl">
              <thead><tr><th>Count</th><th>Location</th><th>Status</th><th className="n">Lines</th><th className="n">Lines off</th><th className="n">Net units</th>{mv.cost && <th className="n">Variance at cost</th>}</tr></thead>
              <tbody>
                {p.data.counts.map((c) => (
                  <tr key={c.id}>
                    <td><span className="l1 code">{c.number}</span><span className="l2">{shortDate(c.started_at.slice(0, 10), p.today)}{c.posted_at ? ` · posted ${shortDate(c.posted_at.slice(0, 10), p.today)}` : ''}</span></td>
                    <td>{p.stockLocations.find((s) => s.id === c.stock_location_id)?.name ?? 'Stock'}</td>
                    <td><StatusMark mark={COUNT_STATUS[c.status]} /></td>
                    <td className="n">{count(c.variance_summary?.lines ?? 0)}</td>
                    <td className="n">{count(c.variance_summary?.variance_lines ?? 0)}</td>
                    <td className="n">{c.variance_summary?.net_variance_qty == null ? '—' : count(Number(c.variance_summary.net_variance_qty))}</td>
                    {mv.cost && <td className="n">{c.variance_summary?.variance_cost_cents == null ? '—' : money(Number(c.variance_summary.variance_cost_cents))}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <span className="t-section">{open.number}</span>
        <span className="t-cap">{p.stockLocations.find((s) => s.id === open.stock_location_id)?.name ?? 'Stock'} · started {shortDate(open.started_at.slice(0, 10), p.today)} · {count(counted)} of {count(lines.length)} counted · net {variance > 0 ? '+' : ''}{count(variance)} units</span>
        <span className="sp" />
        {live && <Button disabled={!dirty.length || busy === 'save'} onClick={() => void save()}>Save counts</Button>}
        {live && <Button variant="primary" disabled={counted < lines.length || dirty.length > 0 || busy === 'post'} onClick={() => setPostOpen(true)}>Post the count</Button>}
      </div>
      {error && <Failure text={error} />}
      <div className="mp-table">
        <table className="dl-lines" aria-label="Count sheet">
          <thead><tr><th>Bin</th><th>Part</th><th className="n">Expected</th><th className="n">Counted</th><th className="n">Variance</th></tr></thead>
          <tbody>
            {lines.map((l, i) => {
              const v = value(l.id, l.counted_qty);
              const vr = v == null ? null : v - l.expected_qty;
              return (
                <tr key={l.id}>
                  <td>{l.bin ?? '—'}</td>
                  <td><span className="l1 b">{l.part_number}</span><span className="l2">{l.description}</span></td>
                  <td className="n">{count(l.expected_qty)}</td>
                  <td className="n">{live ? <Input aria-label={`Counted for ${l.part_number}`} inputMode="decimal" value={keyed[l.id] ?? (l.counted_qty == null ? '' : String(l.counted_qty))} onChange={(e) => setKeyed({ ...keyed, [l.id]: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const next = document.querySelectorAll<HTMLInputElement>('.dl-lines tbody input')[i + 1]; next?.focus(); } }} /> : l.counted_qty ?? '—'}</td>
                  <td className="n">{vr == null ? '—' : <span className={vr !== 0 ? 'neg b' : undefined}>{vr > 0 ? `+${count(vr)}` : count(vr)}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="t-cap">Enter moves to the next line. Save as you go; post once every line is counted.</p>
      <ConfirmDialog open={postOpen} onClose={() => setPostOpen(false)} title={`Post ${open.number}`} confirmLabel="Post the count" cancelLabel="Keep counting"
        onConfirm={async () => { const r = await act('post', 'post', `/api/dealer/counts/${open.id}`, { op: 'post' }, `Posted ${open.number}`); if (r.error) throw new Error(r.error.error); }}>
        {count(lines.filter((l) => (l.counted_qty ?? l.expected_qty) !== l.expected_qty).length)} lines differ, net {variance > 0 ? '+' : ''}{count(variance)} units. Each difference posts as a stock adjustment; Merit Books revalues the inventory.
      </ConfirmDialog>
    </div>
  );
}
