'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button, Field, Input, Tag, WidgetState, count } from '@meritbooks/merit-ui';
import { durationText } from '@/lib/pm/ops/dispatch-math';
import { OP_STATUS } from '@/lib/pm/ops/labels';
import type { OperationRow, ProductionStatusRow, WorkCenterRow } from '@/lib/pm/ops/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, StatusMark, parseNum } from '../common/bits';
import { useOps } from '../common/useOps';

/**
 * The shop tablet: pick a work center, see what is ready and running there, start it, and
 * report minutes and good / scrap quantities when done. Big square targets, palette only.
 */
export function ShopFloor({ ops, orders, centers, jobLabels }: { ops: OperationRow[]; orders: ProductionStatusRow[]; centers: WorkCenterRow[]; jobLabels: Record<string, string> }) {
  const { readOnly } = useShell();
  const { act, busy, error } = useOps();
  const [wc, setWc] = useState<string>('all');
  const [finishing, setFinishing] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const orderOf = useMemo(() => new Map(orders.map((o) => [o.work_order_id, o])), [orders]);
  const [now, setNow] = useState(0); // set after mount so server and browser render the same text
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const live = ops.filter((o) => o.status === 'READY' || o.status === 'IN_PROGRESS');
  const shown = live.filter((o) => wc === 'all' || o.work_center_id === wc).sort((a, b) => (a.status === 'IN_PROGRESS' ? -1 : 1) - (b.status === 'IN_PROGRESS' ? -1 : 1) || (orderOf.get(a.work_order_id)?.promised_on ?? '9999').localeCompare(orderOf.get(b.work_order_id)?.promised_on ?? '9999'));
  const countAt = (id: string) => live.filter((o) => o.work_center_id === id).length;

  return (
    <div className="stack">
      <div className="shop-wc" role="group" aria-label="Work center">
        <Button variant={wc === 'all' ? 'primary' : 'default'} aria-pressed={wc === 'all'} onClick={() => setWc('all')}>All · {count(live.length)}</Button>
        {centers.filter((c) => c.status !== 'INACTIVE').map((c) => (
          <Button key={c.id} variant={wc === c.id ? 'primary' : 'default'} aria-pressed={wc === c.id} onClick={() => setWc(c.id)}>{c.name} · {count(countAt(c.id))}{c.status === 'DOWN' ? ' · down' : ''}</Button>
        ))}
      </div>
      <Failure text={error} />
      {shown.length === 0 ? (
        <div className="surface">
          <WidgetState state={centers.length === 0
            ? { kind: 'empty', title: 'Set up your work centers first', body: 'Add the stations work moves through (saw, CNC, edgebander, assembly, finish), then routings that use them.' }
            : { kind: 'done', title: wc === 'all' ? 'Nothing is ready in the shop' : 'Nothing is ready at this station', body: 'Operations show here once their order is released and the step before them is done.' }} />
        </div>
      ) : (
        <div className="shop">
          {shown.map((op) => {
            const ord = orderOf.get(op.work_order_id);
            const running = op.status === 'IN_PROGRESS';
            const elapsed = running && op.started_at && now ? Math.max(0, Math.round((now - Date.parse(op.started_at)) / 60_000)) : 0;
            return (
              <article key={op.id} className={running ? 'shop-card run' : 'shop-card'} aria-label={`${ord?.number ?? ''} operation ${op.seq} ${op.name}`}>
                <div className="row row--between">
                  <span className="code">{ord?.number}</span>
                  <StatusMark mark={OP_STATUS[op.status]} />
                </div>
                <div>
                  <div className="t">{op.seq}. {op.name}</div>
                  <div className="t-cap">{ord?.summary}{ord ? ` · qty ${ord.quantity}` : ''}</div>
                  <div className="t-cap">{jobLabels[op.job_id] ?? ''}</div>
                </div>
                <div className="ops-facts">
                  <span>Standard <b>{durationText(op.std_minutes)}</b></span>
                  {running && <span>Running <b>{durationText(elapsed + op.actual_minutes)}</b></span>}
                  {ord?.is_late && <Tag tone="neg">Late</Tag>}
                  {op.is_rework && <Tag tone="warn">Rework</Tag>}
                </div>
                {!readOnly && (finishing === op.id ? (
                  <FinishForm op={op} qty={ord?.quantity ?? 1} suggested={elapsed} busy={busy === `op:${op.id}`} onCancel={() => setFinishing(null)}
                    onSubmit={async (b) => { const r = await act<{ work_order_status: string }>(`op:${op.id}`, 'post', `/api/ops/operations/${op.id}`, { op: 'complete', ...b }, (d) => (d.work_order_status === 'COMPLETE' ? `${ord?.number ?? 'Order'} is complete` : `${op.name} done`)); if (r) setFinishing(null); }} />
                ) : skipping === op.id ? (
                  <SkipForm busy={busy === `op:${op.id}`} onCancel={() => setSkipping(null)} onSubmit={async (reason) => { const r = await act(`op:${op.id}`, 'post', `/api/ops/operations/${op.id}`, { op: 'skip', reason }, `${op.name} skipped`); if (r) setSkipping(null); }} />
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: running ? '1fr' : '1fr 1fr', gap: 8 }}>
                    {!running && <Button disabled={busy === `op:${op.id}`} onClick={() => void act(`op:${op.id}`, 'post', `/api/ops/operations/${op.id}`, { op: 'start' }, `Started ${op.name}`)}>Start</Button>}
                    <Button variant="primary" onClick={() => setFinishing(op.id)}>Done</Button>
                    <Button variant="quiet" onClick={() => setSkipping(op.id)}>Skip this step</Button>
                  </div>
                ))}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FinishForm({ op, qty, suggested, busy, onCancel, onSubmit }: { op: OperationRow; qty: number; suggested: number; busy: boolean; onCancel: () => void; onSubmit: (b: { actualMinutes: number; qtyGood: number | null; qtyScrap: number; notes: string | null }) => void }) {
  const [mins, setMins] = useState(String(suggested || op.std_minutes));
  const [good, setGood] = useState(String(qty));
  const [scrap, setScrap] = useState('0');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="mp-form" onSubmit={(e) => {
      e.preventDefault();
      const m = parseNum(mins);
      const g = parseNum(good);
      const s = parseNum(scrap) ?? 0;
      if (m == null || m < 0) return setErr('Minutes worked, like 45.');
      if (g == null || g < 0 || s < 0) return setErr('Quantities are 0 or more.');
      onSubmit({ actualMinutes: Math.round(m), qtyGood: g, qtyScrap: s, notes: notes.trim() || null });
    }}>
      <Field label={op.actual_minutes ? `Minutes this session (adds to ${op.actual_minutes})` : 'Minutes worked'} error={err ?? undefined}><Input autoFocus inputMode="numeric" value={mins} onChange={(e) => setMins(e.target.value)} /></Field>
      <div className="mp-form-2">
        <Field label="Good"><Input inputMode="decimal" value={good} onChange={(e) => setGood(e.target.value)} /></Field>
        <Field label="Scrap"><Input inputMode="decimal" value={scrap} onChange={(e) => setScrap(e.target.value)} /></Field>
      </div>
      <Field label="Note"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" maxLength={2000} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button onClick={onCancel}>Back</Button>
        <Button type="submit" variant="primary" disabled={busy}>Report done</Button>
      </div>
    </form>
  );
}

function SkipForm({ busy, onCancel, onSubmit }: { busy: boolean; onCancel: () => void; onSubmit: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); }}>
      <Field label="Why skip it"><Input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Done at the previous station" maxLength={300} /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Button onClick={onCancel}>Back</Button>
        <Button type="submit" variant="primary" disabled={busy || !reason.trim()}>Skip</Button>
      </div>
    </form>
  );
}
