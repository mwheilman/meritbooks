'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Bands, Button, Field, Keybar, Panel, PanelSection, QueueTable, Search, Select, Switch, WidgetState, count, money, pct, type QueueColumn,
} from '@meritbooks/merit-ui';
import { DEAL_BANDS, DEAL_NEXT_WORDS, DEAL_STAGE, FINANCE_WORDS, unitTitle } from '@/lib/pm/dealer/labels';
import type { DealPipelineRow, DealStage, FinanceType, UnitInventoryRow } from '@/lib/pm/dealer/types';
import { useShell } from '@/components/shell/ShellContext';
import { CustomerPicker, customerPending, customerPendingMessage, type CustomerValue } from '@/components/jobs/CustomerPicker';
import { Failure, StatusMark } from '@/components/ops/common/bits';
import { PickStoreNote } from '../common/StoreOff';
import { useStore } from '../common/useStore';

type Band = Exclude<DealStage, 'LOST'>;

export interface DealsPipelineProps {
  deals: DealPipelineRow[];
  units: UnitInventoryRow[];
  companies: Array<{ id: string; name: string }>;
  writeCompanyId: string | null;
  multi: boolean;
  initialBand: Band | null;
  openNew: boolean;
}

function Gross({ cents }: { cents: number | null }) {
  if (cents == null) return <>—</>;
  return <span className={cents < 0 ? 'neg' : undefined}>{money(cents)}</span>;
}

/** The sales desk pipeline: Quote → Written → Approved → Funded → Delivered (→ Unwound), gross on every deal. */
export function DealsPipeline(p: DealsPipelineProps) {
  const router = useRouter();
  const { readOnly } = useShell();
  const open = p.deals.filter((d) => d.stage !== 'LOST');
  const firstBusy = (['WRITTEN', 'FUNDED', 'APPROVED', 'QUOTE'] as Band[]).find((b) => open.some((d) => d.stage === b)) ?? 'QUOTE';
  const [band, setBand] = useState<Band>(p.initialBand ?? firstBusy);
  const [showLost, setShowLost] = useState(false);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [creating, setCreating] = useState(p.openNew && !!p.writeCompanyId && !readOnly);
  const names = useMemo(() => Object.fromEntries(p.companies.map((c) => [c.id, c.name])), [p.companies]);

  const searched = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? p.deals.filter((d) => [d.number, d.customer_name].filter(Boolean).join(' ').toLowerCase().includes(t)) : p.deals;
  }, [p.deals, q]);
  const inBand = (b: Band) => searched.filter((d) => d.stage === b);
  const visible = showLost ? searched.filter((d) => d.stage === 'LOST') : inBand(band);
  const gross = (xs: DealPipelineRow[]) => xs.reduce((s, d) => s + (d.total_gross_cents ?? 0), 0);

  const columns: QueueColumn<DealPipelineRow>[] = [
    { id: 'n', header: 'Deal', width: 132, cell: (d) => <><span className="l1 code">{d.number}</span><span className="l2">{FINANCE_WORDS[d.finance_type]}{d.is_sample ? ' · sample' : ''}</span></> },
    { id: 'c', header: 'Customer', cell: (d) => <><span className="l1">{d.customer_name ?? 'No customer yet'}</span><span className="l2">{[`${count(d.unit_count ?? 0)} unit${d.unit_count === 1 ? '' : 's'}`, p.multi ? names[d.location_id] : null].filter(Boolean).join(' · ')}</span></> },
    { id: 'sale', header: 'Sale price', numeric: true, width: 124, cell: (d) => (d.sale_price_cents == null ? '—' : money(d.sale_price_cents)) },
    { id: 'front', header: 'Front gross', numeric: true, width: 132, cell: (d) => <><span className="l1"><Gross cents={d.front_gross_cents} /></span><span className="l2">{d.front_gross_pct == null ? ' ' : pct(d.front_gross_pct)}</span></> },
    { id: 'back', header: 'Back gross', numeric: true, width: 116, cell: (d) => <Gross cents={d.back_gross_cents} /> },
    { id: 'total', header: 'Total gross', numeric: true, width: 124, cell: (d) => <b><Gross cents={d.total_gross_cents} /></b> },
    { id: 'st', header: 'Stage', width: 190, cell: (d) => <><StatusMark mark={DEAL_STAGE[d.stage]} /><span className="l2">{d.sold_out_of_trust ? 'Sold out of trust' : `${count(Math.max(0, Math.floor((Date.now() - Date.parse(d.stage_entered_at)) / 86_400_000)))} days here · ${DEAL_NEXT_WORDS[d.stage].toLowerCase()}`}</span></> },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div style={{ width: 300 }}><Search aria-label="Find a deal" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Deal number or customer" slashToFocus /></div>
        <Switch label={`Show lost (${count(p.deals.filter((d) => d.stage === 'LOST').length)})`} checked={showLost} onChange={(e) => setShowLost(e.target.checked)} />
        <span className="sp" />
        {!readOnly && p.writeCompanyId && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => setCreating(true)}>New deal</Button>}
      </div>
      {!readOnly && !p.writeCompanyId && <PickStoreNote what="Deals" />}
      {!showLost && (
        <Bands<Band>
          aria-label="Deals by stage"
          value={band}
          onChange={setBand}
          items={DEAL_BANDS.map((b) => ({ value: b.value, label: b.label, count: count(inBand(b.value).length), caption: inBand(b.value).length ? `${money(gross(inBand(b.value)), { decimals: 0 })} gross · ${b.caption.toLowerCase()}` : b.caption }))}
        />
      )}
      <div className={creating ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {visible.length === 0 ? (
            <WidgetState
              state={p.deals.length === 0
                ? { kind: 'empty', title: 'No deals yet', body: 'Start one from a unit in stock or for a walk-in: pick the customer, add the unit, price the trade. The desk approves it against your margin floor.', action: readOnly || !p.writeCompanyId ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>New deal</Button> }
                : q ? { kind: 'done', title: `Nothing matches “${q}”`, body: 'Search covers deal number and customer.' }
                : { kind: 'done', title: showLost ? 'No lost deals in the last 180 days' : `Nothing in ${DEAL_BANDS.find((b) => b.value === band)?.label.toLowerCase()}`, body: 'Pick another stage above.' }}
            />
          ) : (
            <QueueTable
              aria-label="Deals"
              columns={columns}
              rows={visible}
              getRowId={(d) => d.deal_id}
              cursorId={cursor}
              onCursorChange={(id) => setCursor(id)}
              onOpen={(d) => router.push(`/deals/${d.deal_id}`)}
              rowState={(d) => ({ attn: d.sold_out_of_trust || (d.front_gross_cents ?? 0) < 0, done: d.stage === 'DELIVERED' || d.stage === 'LOST' })}
            />
          )}
        </div>
        {creating && p.writeCompanyId && <NewDealPanel companyId={p.writeCompanyId} units={p.units.filter((u) => u.location_id === p.writeCompanyId)} onClose={() => setCreating(false)} onCreated={(id) => router.push(`/deals/${id}`)} />}
      </div>
      {visible.length > 0 && <Keybar hints={[{ chord: 'j k', label: 'move' }, { chord: 'enter', label: 'open the desk' }, ...(readOnly || !p.writeCompanyId ? [] : [{ chord: 'n', label: 'new deal' }])]} note="Gross is operational; Merit Books books the deal, the tax and the trade" />}
    </div>
  );
}

function NewDealPanel({ companyId, units, onClose, onCreated }: { companyId: string; units: UnitInventoryRow[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { act, busy, error } = useStore();
  const [customer, setCustomer] = useState<CustomerValue>({ id: null, name: '' });
  const [unitId, setUnitId] = useState('');
  const [finance, setFinance] = useState<FinanceType>('CASH');
  const [err, setErr] = useState<string | null>(null);
  const available = units.filter((u) => !u.deal_id && ['ON_ORDER', 'IN_TRANSIT', 'IN_STOCK', 'PDI', 'DEMO'].includes(u.unit_status));
  const submit = async () => {
    if (customerPending(customer)) return setErr(customerPendingMessage(customer));
    setErr(null);
    const r = await act<{ dealId: string; number: string | null }>('create', 'post', '/api/dealer/deals', { companyId, customerId: customer.id, financeType: finance, unitId: unitId || null }, (d) => `Started deal ${d.number ?? ''}`.trim());
    if (r.data) onCreated(r.data.dealId);
  };
  return (
    <Panel eyebrow={['Sales desk', 'New deal']} title="New deal" meta="The customer and the unit; trades and F&I on the desk" onClose={onClose}
      foot={<div className="btn-row" style={{ width: '100%' }}><Button onClick={onClose}>Cancel</Button><span className="sp" /><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Start the deal</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <Field label="Customer" error={err ?? undefined}><CustomerPicker value={customer} onChange={setCustomer} companyId={companyId} invalid={!!err} /></Field>
          <Field label="Unit from stock" help={available.length ? 'Optional; add more units on the desk' : 'No free units in stock. Add one on the desk once it is received or ordered.'}>
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
              <option value="">Pick later</option>
              {available.map((u) => <option key={u.unit_id} value={u.unit_id}>{u.stock_number} · {unitTitle(u)}{u.advertised_price_cents ?? u.retail_price_cents ? ` · ${money((u.advertised_price_cents ?? u.retail_price_cents)!)}` : ''}</option>)}
            </Select>
          </Field>
          <Field label="How they pay">
            <Select value={finance} onChange={(e) => setFinance(e.target.value as FinanceType)}>
              {(Object.keys(FINANCE_WORDS) as FinanceType[]).map((f) => <option key={f} value={f}>{FINANCE_WORDS[f]}</option>)}
            </Select>
          </Field>
          {error && <Failure text={error} title="Not started." />}
        </form>
      </PanelSection>
    </Panel>
  );
}
