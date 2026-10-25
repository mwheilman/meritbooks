'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Field, Input, KV, Select, Textarea, count, type KVItem } from '@meritbooks/merit-ui';
import { cleanScan, parsePickList } from '@/lib/dealer/catalog';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, pctText, qty, useBoard, useDo } from '../common/depth';

interface ScanHit {
  kind: 'unit' | 'part' | 'work_order' | 'ticket' | 'deal' | 'rental' | 'none';
  id?: string;
  label?: string;
  status?: string;
  description?: string;
  code?: string;
}

interface SpeedBoard {
  speed: Array<{ day: string; tickets: number; medianSeconds: number | null; avgSeconds: number | null; pctUnder60: number | null }>;
  lost: Array<{ id: string; part_number: string; description: string | null; qty: number; reason: string | null; created_at: string }>;
}

const HREF: Record<Exclude<ScanHit['kind'], 'none'>, (id: string) => string> = {
  unit: (id) => `/stock/units/${id}/timeline`,
  part: () => '/parts?tab=catalog',
  work_order: (id) => `/work-orders?wo=${id}`,
  ticket: (id) => `/parts?ticket=${id}`,
  deal: (id) => `/deals/${id}`,
  rental: (id) => `/rentals/${id}/inspection`,
};

const KIND_WORD: Record<ScanHit['kind'], string> = { unit: 'Unit', part: 'Part', work_order: 'Repair order', ticket: 'Counter ticket', deal: 'Deal', rental: 'Rental', none: 'Nothing found' };

/**
 * The fast counter (DLR counter speed, under a minute per ticket): one scan box that answers on
 * Enter (scanner or keyboard; / focuses it), a catalog pick list dropped onto the open ticket, a
 * one-line lost sale, and how fast tickets closed by day.
 */
export function CounterTools({ companyId, today }: { companyId: string; today: string }) {
  const { readOnly } = useShell();
  const board = useBoard<SpeedBoard>(`/api/dealer/counter?company=${companyId}`);
  const { run, busy, error } = useDo(board.reload);
  const scanRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [hit, setHit] = useState<ScanHit | null>(null);
  const [ticket, setTicket] = useState<{ id: string; label: string } | null>(null);
  const [pick, setPick] = useState('');
  const [lost, setLost] = useState({ part: '', qty: '1', reason: 'NOT_STOCKED' });
  const pickLines = parsePickList(pick);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') { e.preventDefault(); scanRef.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const scan = async () => {
    const c = cleanScan(code);
    if (!c) return;
    const r = await run<ScanHit>('scan', '/api/dealer/counter', { op: 'scan', companyId, code: c }, null);
    setCode('');
    if (!r) return;
    setHit(r);
    if (r.kind === 'ticket' && r.id && r.status === 'OPEN') setTicket({ id: r.id, label: r.label ?? 'Ticket' });
    if (r.kind === 'none') setLost((l) => ({ ...l, part: c }));
  };

  const facts: KVItem[] = hit && hit.kind !== 'none' ? [
    { term: KIND_WORD[hit.kind], value: hit.id ? <Link className="nlink" href={HREF[hit.kind](hit.id)}>{hit.label ?? 'Open'}</Link> : hit.label ?? '—' },
    ...(hit.status ? [{ term: 'Status', value: hit.status.replace(/_/g, ' ').toLowerCase() }] : []),
    ...(hit.description ? [{ term: 'Description', value: hit.description }] : []),
  ] : [];
  const todayRow = board.data?.speed.find((s) => s.day === today) ?? null;

  return (
    <div className="stack">
      <Section title="Scan or key" meta="/ to focus · Enter to look up">
        <div className="ops-toolbar">
          <div style={{ width: 360 }}>
            <Input ref={scanRef} aria-label="Scan a part, serial, stock number, RO, ticket or deal" value={code} autoFocus placeholder="Part number, UPC, serial, stock #, RO, ticket"
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void scan(); } }} />
          </div>
          <Button variant="primary" disabled={busy === 'scan' || !code.trim()} onClick={() => void scan()}>Look up</Button>
          <span className="sp" />
          {todayRow && <span className="t-cap">Today {count(todayRow.tickets)} tickets · median {qty(todayRow.medianSeconds)} s · {pctText(todayRow.pctUnder60, 0)} under a minute</span>}
        </div>
        {hit && (hit.kind === 'none'
          ? <p className="t-cap" style={{ marginTop: 8 }}>No part, unit or record matches {hit.code}. Log it as a lost sale below, or add it to the catalog.</p>
          : <div style={{ marginTop: 8 }}><KV items={facts} /></div>)}
      </Section>
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Catalog pick list" meta={ticket ? `Onto ${ticket.label}` : 'Scan an open counter ticket first'}>
          <Field label="Paste the pick list, the cart export, or the cart link" help={pickLines.length ? `${count(pickLines.length)} parts read` : 'One part per line: “K1234 2” or “2 x K1234”.'}>
            <Textarea rows={4} value={pick} onChange={(e) => setPick(e.target.value)} />
          </Field>
          <ButtonRow>
            <Button variant="primary" disabled={!ticket || !pickLines.length || busy === 'pick'} onClick={async () => {
              const r = await run<{ added: unknown[]; unknown: Array<{ part_number: string }> }>('pick', '/api/dealer/counter', { op: 'pick_list', ticketId: ticket!.id, text: pick }, (d) => `Added ${count(d.added.length)} lines`);
              if (r) setPick(r.unknown.map((u) => u.part_number).join('\n'));
            }}>Add to ticket</Button>
            {ticket && <Link className="link" href={`/parts?ticket=${ticket.id}`}>Open {ticket.label}</Link>}
          </ButtonRow>
        </Section>
      )}
      {!readOnly && (
        <Section title="Lost sale" meta="A part asked for and not sold">
          <div className="ops-toolbar">
            <Field label="Part number"><Input value={lost.part} onChange={(e) => setLost({ ...lost, part: e.target.value.toUpperCase() })} style={{ width: 160 }} /></Field>
            <Field label="Qty"><Input inputMode="decimal" value={lost.qty} onChange={(e) => setLost({ ...lost, qty: e.target.value })} style={{ width: 70 }} /></Field>
            <Field label="Why"><Select value={lost.reason} onChange={(e) => setLost({ ...lost, reason: e.target.value })}>
              <option value="NOT_STOCKED">Not stocked</option><option value="OUT_OF_STOCK">Out of stock</option><option value="PRICE">Price</option><option value="SUPERSEDED_UNKNOWN">Supersession not found</option><option value="OTHER">Other</option>
            </Select></Field>
            <Button disabled={!lost.part.trim() || busy === 'lost'} onClick={async () => {
              const q = Number(lost.qty);
              const r = await run('lost', '/api/dealer/counter', { op: 'lost_sale', companyId, partNumber: lost.part.trim(), qty: Number.isFinite(q) && q > 0 ? q : 1, reason: lost.reason, ticketId: ticket?.id ?? null }, `Logged ${lost.part.trim()} as a lost sale`);
              if (r) setLost({ part: '', qty: '1', reason: lost.reason });
            }}>Log lost sale</Button>
          </div>
        </Section>
      )}
      <Section title="Counter speed" meta="Closed tickets, last 30 days">
        <BoardState b={board} what="Counter speed" />
        {board.data && (board.data.speed.length === 0
          ? <Empty title="No closed tickets in 30 days" body="Each closed counter ticket is timed from open to close; the median and the share under a minute show here by day." />
          : (
            <table className="ops-mini" aria-label="Counter speed by day">
              <thead><tr><th>Day</th><th className="n">Tickets</th><th className="n">Median</th><th className="n">Average</th><th className="n">Under 60 s</th></tr></thead>
              <tbody>{board.data.speed.map((s) => (
                <tr key={s.day}><td>{day(s.day, today)}</td><td className="n">{count(s.tickets)}</td><td className="n">{qty(s.medianSeconds)} s</td><td className="n">{qty(s.avgSeconds)} s</td><td className="n">{pctText(s.pctUnder60, 0)}</td></tr>
              ))}</tbody>
            </table>
          ))}
        {board.data && board.data.lost.length > 0 && (
          <table className="ops-mini" aria-label="Lost sales" style={{ marginTop: 16 }}>
            <thead><tr><th>Part</th><th className="n">Qty</th><th>Why</th><th>When</th></tr></thead>
            <tbody>{board.data.lost.slice(0, 50).map((l) => <tr key={l.id}><td className="code">{l.part_number}</td><td className="n">{qty(l.qty)}</td><td>{(l.reason ?? '—').replace(/_/g, ' ').toLowerCase()}</td><td>{day(l.created_at, today)}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
