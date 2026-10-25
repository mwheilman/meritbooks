'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, Field, Figure, InlineNotice, Input, KV, QueueTable, Status, money, type QueueColumn } from '@meritbooks/merit-ui';
import { useMoneyVis, useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, pctText, useBoard, useDo } from '../common/depth';

interface Scenario { kind: string; code: string; name: string; program_id?: string; apr?: number; term_months?: number; amount_financed_cents?: number | null; monthly_cents?: number | null; total_of_payments_cents?: number | null; rebate_cents?: number; cash_due_cents?: number; amount_due_cents?: number; subvention_cents?: number | null; dealer_net_front_cents?: number | null }
interface Worksheet {
  deal_id: string; number: string; stage: string; finance_type: string | null; totals: Record<string, number | null>; margin_floor_pct: number | null; below_floor: boolean;
  commission_base_cents: number | null; over_allowance_cents: number | null; amounts_visible: boolean;
  approval: { status?: string; request_status?: string; waiting_on?: string | null } | null;
  delivery: { can_deliver: boolean; blockers: Blocker[]; warnings: Blocker[]; payoff_guard: string };
}
interface Blocker { code: string; message?: string; items?: Array<string | { key?: string; label?: string }>; units?: Array<{ stock_number?: string | null; serial_number?: string | null }> }

const BLOCK_WORDS: Record<string, string> = {
  NOT_FUNDED: 'The deal is not funded yet.',
  CHECKLIST: 'Delivery checklist items are open',
  UNIT_NOT_SOLD: 'A unit on the deal is not marked sold',
  PAYOFF_NOT_SCHEDULED: 'Merit Books has not scheduled the floor-plan payoff',
};

function blockerText(x: Blocker): string {
  const base = x.message ?? BLOCK_WORDS[x.code] ?? x.code.replace(/_/g, ' ').toLowerCase();
  const items = (x.items ?? []).map((i) => (typeof i === 'string' ? i : i.label ?? i.key ?? '')).filter(Boolean);
  const units = (x.units ?? []).map((u) => u.stock_number ?? u.serial_number ?? '').filter(Boolean);
  const more = [...items, ...units];
  return more.length ? `${base.replace(/\.$/, '')}: ${more.join(', ')}.` : base;
}

interface Data { worksheet: Worksheet; payments: { balance_due_cents: number; down_cents: number; scenarios: Scenario[]; amounts_visible: boolean } }

/** The desk: gross with over-allowance, the margin floor and its approval, payment options side by side, delivery blockers. */
export function DeskWorksheet({ dealId }: { dealId: string }) {
  const { readOnly } = useShell();
  const mv = useMoneyVis();
  const [down, setDown] = useState('');
  const downCents = centsFrom(down) ?? 0;
  const b = useBoard<Data>(`/api/dealer/desk/${dealId}?down=${downCents}`);
  const { run, busy, error } = useDo(b.reload);
  const state = <BoardState b={b} what="The deal desk" />;
  if (!b.data) return state;
  const { worksheet: w, payments: p } = b.data;
  const t = w.totals;
  const cols: QueueColumn<Scenario>[] = [
    { id: 'n', header: 'Option', cell: (s) => <><span className="l1">{s.name}</span><span className="l2">{s.kind === 'CASH' ? 'Pay in full' : s.kind === 'CASH_REBATE' ? `Rebate ${money(s.rebate_cents ?? 0)}` : `${pctText(s.apr ?? 0, 2)} for ${s.term_months} months`}</span></> },
    { id: 'f', header: 'Financed', numeric: true, width: 120, cell: (s) => (s.amount_financed_cents == null ? '—' : money(s.amount_financed_cents)) },
    { id: 'm', header: 'Monthly', numeric: true, width: 110, cell: (s) => (s.monthly_cents == null ? '—' : <b>{money(s.monthly_cents)}</b>) },
    { id: 'c', header: 'Cash due', numeric: true, width: 120, cell: (s) => money(s.cash_due_cents ?? s.amount_due_cents ?? p.balance_due_cents) },
    ...(p.amounts_visible ? [{ id: 's', header: 'Dealer buy-down', numeric: true, width: 130, cell: (s: Scenario) => (s.subvention_cents == null ? '—' : money(s.subvention_cents)) } satisfies QueueColumn<Scenario>] : []),
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Apply</span>, width: 110, cell: (s: Scenario) => (s.program_id ? <Button disabled={busy === s.code || !['QUOTE', 'WRITTEN'].includes(w.stage)} onClick={() => void run(s.code, `/api/dealer/desk/${dealId}`, { op: 'apply_program', programId: s.program_id, downCents }, `Put ${s.name} on the deal`)}>Use</Button> : null) } satisfies QueueColumn<Scenario>]),
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {w.amounts_visible && (
        <div className="dl-strip">
          <Figure dense label="Front gross" value={t.front_gross_cents == null ? '—' : money(t.front_gross_cents)} vs={[w.below_floor ? `below the ${pctText(w.margin_floor_pct ?? 0)} floor` : `floor ${pctText(w.margin_floor_pct ?? 0)}`, w.over_allowance_cents ? `${money(w.over_allowance_cents)} over-allowance on the trade` : 'no over-allowance']} href={`/deals/${dealId}`} linkLabel="Deal" />
          <Figure dense label="Back gross" value={t.back_gross_cents == null ? '—' : money(t.back_gross_cents)} vs={['F&I products and reserve', `total ${t.total_gross_cents == null ? '—' : money(t.total_gross_cents)}`]} href={`/deals/${dealId}`} linkLabel="Deal" />
          <Figure dense label="Commission base" value={w.commission_base_cents == null ? '—' : money(w.commission_base_cents)} vs={['total gross after over-allowance', 'per store plan']} href={`/deals/${dealId}`} linkLabel="Deal" />
        </div>
      )}
      {w.below_floor && <InlineNotice tone="warn" title="This deal is under the margin floor.">It goes through Approvals before it can be approved{w.approval?.waiting_on ? `; waiting on ${w.approval.waiting_on}` : ''}. <Link className="link" href="/approvals">Approvals</Link></InlineNotice>}
      <KV items={[
        { term: 'Deal', value: <Link className="nlink" href={`/deals/${dealId}`}>{w.number}</Link> },
        { term: 'Stage', value: <Status kind="track" pip="open">{w.stage.toLowerCase()}</Status> },
        { term: 'Balance due', value: money(p.balance_due_cents) },
        { term: 'Approval', value: w.approval?.request_status ? w.approval.request_status.toLowerCase() : 'not needed' },
      ]} />
      <Section title="Payment options" meta="Every program the unit qualifies for today" actions={
        <Field label="Down payment"><Input inputMode="decimal" value={down} onChange={(e) => setDown(e.target.value)} placeholder="0.00" style={{ width: 120 }} /></Field>
      }>
        <div className="mp-table"><QueueTable aria-label="Payment options" columns={cols} rows={p.scenarios} getRowId={(s) => s.code} /></div>
        {!readOnly && <p style={{ marginTop: 8 }}><Button variant="quiet" disabled={busy === 'fees'} onClick={() => void run('fees', `/api/dealer/desk/${dealId}`, { op: 'standard_fees' }, (r: { added: number }) => `Added ${r.added} standard fees`)}>Add the store’s standard fees</Button></p>}
      </Section>
      <Section title="Delivery" meta={w.delivery.payoff_guard === 'BLOCK' ? 'Floor-plan payoff required before delivery' : 'Floor-plan payoff warned'}>
        {w.delivery.can_deliver && w.delivery.warnings.length === 0
          ? <p className="t-cap">Nothing blocks delivery.</p>
          : (
            <ul className="ops-checks">
              {w.delivery.blockers.map((x) => <li key={`b${x.code}`}><span className="no">Blocks</span> {blockerText(x)}</li>)}
              {w.delivery.warnings.map((x) => <li key={`w${x.code}`}><span className="no">Check</span> {blockerText(x)}</li>)}
            </ul>
          )}
        {!mv.cost && <p className="t-cap">Gross and cost are hidden for your role.</p>}
      </Section>
    </div>
  );
}
