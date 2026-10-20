'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Button, ButtonLink, Field, Input, KV, Panel, PanelSection, QueueTable, Search, Seg, Select, Tag, Textarea, WidgetState, count, shortDate,
  useEscapeKey, type QueueColumn, type QueueGroup,
} from '@meritbooks/merit-ui';
import { ASSET_KIND_WORDS, ASSET_STATUS, HISTORY_WORDS, WO_STATUS, woKindLabel } from '@/lib/pm/ops/labels';
import type { AssetHistoryRow, AssetKind, AssetRow, HistoryKind, LookupItem, WorkOrderRow } from '@/lib/pm/ops/types';
import { useShell, useVocab } from '@/components/shell/ShellContext';
import { DetailState, Failure, StatusMark, parseNum } from '../common/bits';
import { Lookup } from '../common/Lookup';
import { useDetail, useOps } from '../common/useOps';

export interface AssetsViewProps {
  assets: AssetRow[];
  customers: Record<string, string>;
  companies: Array<{ id: string; name: string }>;
  defaultCompanyId: string | null;
  today: string;
  focusId: string | null;
  dealer: boolean;
}

const SERVICE_KINDS: HistoryKind[] = ['MAINTENANCE', 'REPAIR', 'INSPECTION', 'WARRANTY', 'INSTALL', 'PDI', 'METER_READING', 'NOTE'];

export function assetLabel(a: Pick<AssetRow, 'make' | 'model' | 'description'>): string {
  return [a.make, a.model].filter(Boolean).join(' ') || a.description || 'Equipment';
}

export function AssetsView(p: AssetsViewProps) {
  const { readOnly } = useShell();
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'all'>('active');
  const [cursor, setCursor] = useState<string | null>(p.focusId);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return p.assets.filter((a) => (show === 'all' || a.status === 'ACTIVE') && (!t || [a.serial_number, a.make, a.model, a.description, a.site_label, a.site_address_line1, a.customer_id ? p.customers[a.customer_id] : null].filter(Boolean).join(' ').toLowerCase().includes(t)));
  }, [p.assets, q, show, p.customers]);

  const groups: QueueGroup<AssetRow>[] = useMemo(() => {
    const m = new Map<string, AssetRow[]>();
    for (const a of filtered) {
      const k = a.customer_id ?? '';
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return [...m.entries()]
      .map(([k, rs]) => ({ id: k || 'none', title: k ? p.customers[k] ?? 'Customer' : p.dealer ? 'In inventory or unassigned' : 'No customer', rows: rs }))
      .sort((a, b) => (a.id === 'none' ? 1 : b.id === 'none' ? -1 : String(a.title).localeCompare(String(b.title))));
  }, [filtered, p.customers, p.dealer]);

  const warrantySoon = (a: AssetRow) => !!a.warranty_expires_on && a.warranty_expires_on >= p.today && a.warranty_expires_on <= shiftDays(p.today, 90);
  const columns: QueueColumn<AssetRow>[] = [
    { id: 'eq', header: 'Equipment', cell: (a) => <><span className="l1">{assetLabel(a)}{a.model_year ? ` · ${a.model_year}` : ''}</span><span className="l2">{[a.serial_number ? `Serial ${a.serial_number}` : 'No serial', ASSET_KIND_WORDS[a.kind]].join(' · ')}</span></> },
    { id: 'site', header: 'Site', width: 220, cell: (a) => <span className="l2">{[a.site_label, a.site_address_line1, a.site_city].filter(Boolean).join(', ') || '—'}</span> },
    { id: 'in', header: 'Installed', width: 104, cell: (a) => (a.installed_on ? shortDate(a.installed_on, p.today) : '—') },
    { id: 'w', header: 'Warranty to', width: 120, cell: (a) => (a.warranty_expires_on ? <span className={a.warranty_expires_on < p.today ? 'l2' : warrantySoon(a) ? 'b' : undefined}>{shortDate(a.warranty_expires_on, p.today)}{a.warranty_expires_on < p.today ? ' (expired)' : ''}</span> : '—') },
    { id: 'last', header: 'Last service', width: 116, cell: (a) => (a.last_service_on ? shortDate(a.last_service_on, p.today) : <span className="l2">Never</span>) },
    { id: 'st', header: 'Status', width: 112, cell: (a) => <StatusMark mark={ASSET_STATUS[a.status]} /> },
  ];

  return (
    <div className="stack">
      <div className="ops-toolbar">
        <div style={{ width: 320 }}><Search aria-label="Find equipment" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Serial, make, model, customer or address" slashToFocus /></div>
        <Seg<'active' | 'all'> aria-label="Show" value={show} onChange={setShow} items={[{ value: 'active', label: 'In service' }, { value: 'all', label: 'All', count: p.assets.length }]} />
        <span className="sp" />
        {!readOnly && <Button variant="primary" icon="plus" chord="n" bindChord={!creating} onClick={() => { setCreating(true); setCursor(null); }}>Add equipment</Button>}
      </div>
      <div className={creating || cursor ? 'ops-split has-panel' : 'ops-split'}>
        <div className="mp-table" style={{ minWidth: 0 }}>
          {filtered.length === 0 ? (
            <WidgetState state={p.assets.length === 0
              ? { kind: 'empty', title: 'No equipment on file yet', body: 'Add what you service: make, model, serial, install date and warranty. Completed visits on it build the service history by themselves.', action: readOnly ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>Add equipment</Button> }
              : { kind: 'done', title: q ? `Nothing matches “${q}”` : 'Nothing in service', body: 'Search covers serial, make, model, customer and address.' }} />
          ) : (
            <QueueTable aria-label="Equipment" columns={columns} groups={groups} getRowId={(a) => a.id} cursorId={cursor} onCursorChange={(id) => { setCursor(id); setCreating(false); }} onOpen={(a) => setCursor(a.id)}
              rowState={(a) => ({ done: a.status !== 'ACTIVE', attn: warrantySoon(a) })} />
          )}
        </div>
        {creating ? (
          <NewAssetPanel companies={p.companies} defaultCompanyId={p.defaultCompanyId} dealer={p.dealer} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setCursor(id); }} />
        ) : cursor ? (
          <AssetPanel key={cursor} asset={p.assets.find((a) => a.id === cursor) ?? null} id={cursor} customer={(() => { const a = p.assets.find((x) => x.id === cursor); return a?.customer_id ? p.customers[a.customer_id] ?? null : null; })()} assets={p.assets} today={p.today} onClose={() => setCursor(null)} />
        ) : null}
      </div>
    </div>
  );
}

function shiftDays(iso: string, d: number): string {
  const x = new Date(`${iso}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + d);
  return x.toISOString().slice(0, 10);
}

function AssetPanel({ asset, id, customer, assets, today, onClose }: { asset: AssetRow | null; id: string; customer: string | null; assets: AssetRow[]; today: string; onClose: () => void }) {
  const v = useVocab();
  const { readOnly } = useShell();
  const { act, busy, version, error } = useOps();
  const { data, error: loadError, isLoading, refetch } = useDetail<{ history: AssetHistoryRow[]; open: WorkOrderRow[] }>(`/api/ops/assets/${id}`, version);
  const [kind, setKind] = useState<HistoryKind>('MAINTENANCE');
  const [summary, setSummary] = useState('');
  const [on, setOn] = useState(today);
  const [meter, setMeter] = useState('');
  const [retire, setRetire] = useState<'' | 'RETIRED' | 'SOLD' | 'REPLACED'>('');
  const [replacedBy, setReplacedBy] = useState('');
  const url = `/api/ops/assets/${id}`;
  if (!asset) return <Panel title="Equipment" onClose={onClose}><PanelSection><p className="t-cap">That equipment is not in this view.</p></PanelSection></Panel>;
  return (
    <Panel eyebrow={[ASSET_KIND_WORDS[asset.kind], ASSET_STATUS[asset.status].word]} title={assetLabel(asset)} meta={[asset.serial_number ? `Serial ${asset.serial_number}` : null, customer].filter(Boolean).join(' · ')} onClose={onClose}
      foot={readOnly || asset.status !== 'ACTIVE' ? undefined : <div className="btn-row" style={{ width: '100%' }}><ButtonLink href="/work-orders?new=1">New work on it</ButtonLink><span className="sp" /></div>}>
      <PanelSection>
        <KV items={[
          ...(asset.model_year ? [{ term: 'Year', value: String(asset.model_year) }] : []),
          ...(asset.installed_on ? [{ term: 'Installed', value: shortDate(asset.installed_on, today) }] : []),
          ...(asset.warranty_expires_on ? [{ term: 'Warranty to', value: `${shortDate(asset.warranty_expires_on, today)}${asset.warranty_expires_on < today ? ' (expired)' : ''}` }] : []),
          ...(asset.meter_reading != null ? [{ term: 'Meter', value: `${asset.meter_reading}${asset.meter_read_on ? ` on ${shortDate(asset.meter_read_on, today)}` : ''}` }] : []),
          ...(asset.site_label || asset.site_address_line1 ? [{ term: 'Site', value: [asset.site_label, asset.site_address_line1, asset.site_city, asset.site_state].filter(Boolean).join(', ') }] : []),
          { term: 'Last service', value: asset.last_service_on ? shortDate(asset.last_service_on, today) : 'Never' },
        ]} />
        {error && <div style={{ marginTop: 8 }}><Failure text={error} /></div>}
      </PanelSection>
      {data?.open && data.open.length > 0 && (
        <PanelSection title="Open work on it">
          <ul className="feed feed--flush">
            {data.open.map((w) => (
              <li key={w.id}><span><Link className="l1 nlink" href={`/work-orders?wo=${w.id}`}>{w.number} {w.summary}</Link><span className="l2">{woKindLabel(w.kind, v)}</span></span><span className="t">{WO_STATUS[w.status].word}</span></li>
            ))}
          </ul>
        </PanelSection>
      )}
      <PanelSection title="Service history" meta={data ? `${count(data.history.length)} events` : undefined}>
        {!data ? <DetailState loading={isLoading} error={loadError} onRetry={() => void refetch()} what="Service history" /> : data.history.length === 0 ? (
          <p className="t-cap">Nothing yet. Completing a visit on this equipment records it here, newest first.</p>
        ) : (
          <ul className="feed feed--flush">
            {data.history.map((h) => (
              <li key={h.history_id}>
                <span>
                  <span className="l1" style={{ fontWeight: 400 }}>{HISTORY_WORDS[h.kind]}{h.summary ? `: ${h.summary}` : ''}</span>
                  <span className="l2">{[h.work_order_number, h.meter_reading != null ? `meter ${h.meter_reading}` : null].filter(Boolean).join(' · ') || ' '}</span>
                </span>
                <span className="t">{shortDate(h.performed_on, today)}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
      {!readOnly && asset.status === 'ACTIVE' && (
        <PanelSection title="Record service done elsewhere">
          <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void act('svc', 'post', url, { op: 'service', kind, summary: summary.trim() || null, performedOn: on || null, meter: parseNum(meter) }, `Recorded ${HISTORY_WORDS[kind].toLowerCase()}`).then((r) => { if (r) { setSummary(''); setMeter(''); } }); }}>
            <div className="mp-form-2">
              <Field label="What"><Select value={kind} onChange={(e) => setKind(e.target.value as HistoryKind)}>{SERVICE_KINDS.map((k) => <option key={k} value={k}>{HISTORY_WORDS[k]}</option>)}</Select></Field>
              <Field label="On"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} max={today} /></Field>
            </div>
            <Field label="Notes"><Textarea value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={2000} /></Field>
            <Field label="Meter reading"><Input inputMode="decimal" value={meter} onChange={(e) => setMeter(e.target.value)} style={{ width: 140 }} /></Field>
            <div><Button type="submit" disabled={busy === 'svc'}>Record</Button></div>
          </form>
        </PanelSection>
      )}
      {!readOnly && (
        <PanelSection title={asset.status === 'ACTIVE' ? 'Take out of service' : 'Status'}>
          {asset.status !== 'ACTIVE' ? (
            <Button disabled={busy === 'ret'} onClick={() => void act('ret', 'post', url, { op: 'retire', status: 'ACTIVE' }, 'Back in service')}>Put back in service</Button>
          ) : (
            <form className="mp-form" onSubmit={(e) => { e.preventDefault(); if (retire) void act('ret', 'post', url, { op: 'retire', status: retire, replacedBy: retire === 'REPLACED' ? replacedBy || null : null }, `Marked ${ASSET_STATUS[retire].word.toLowerCase()}`); }}>
              <Field label="Because it was">
                <Select value={retire} onChange={(e) => setRetire(e.target.value as typeof retire)}>
                  <option value="">Choose…</option><option value="REPLACED">Replaced</option><option value="RETIRED">Retired</option><option value="SOLD">Sold</option>
                </Select>
              </Field>
              {retire === 'REPLACED' && (
                <Field label="Replaced by">
                  <Select value={replacedBy} onChange={(e) => setReplacedBy(e.target.value)}>
                    <option value="">Pick the new equipment</option>
                    {assets.filter((a) => a.id !== asset.id && a.status === 'ACTIVE' && a.customer_id === asset.customer_id).map((a) => <option key={a.id} value={a.id}>{assetLabel(a)}{a.serial_number ? ` · ${a.serial_number}` : ''}</option>)}
                  </Select>
                </Field>
              )}
              <div><Button type="submit" disabled={!retire || (retire === 'REPLACED' && !replacedBy) || busy === 'ret'}>Save</Button></div>
            </form>
          )}
        </PanelSection>
      )}
      {asset.status !== 'ACTIVE' && asset.retired_on && <PanelSection><Tag>{ASSET_STATUS[asset.status].word} {shortDate(asset.retired_on, today)}</Tag></PanelSection>}
    </Panel>
  );
}

function NewAssetPanel({ companies, defaultCompanyId, dealer, onClose, onCreated }: { companies: Array<{ id: string; name: string }>; defaultCompanyId: string | null; dealer: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const v = useVocab();
  const { act, busy, error } = useOps();
  const [companyId, setCompanyId] = useState(defaultCompanyId ?? companies[0]?.id ?? '');
  const [kind, setKind] = useState<AssetKind>(dealer ? 'CUSTOMER_EQUIPMENT' : 'CUSTOMER_EQUIPMENT');
  const [customer, setCustomer] = useState<LookupItem | null>(null);
  const [f, setF] = useState({ serialNumber: '', make: '', model: '', modelYear: '', description: '', siteLabel: '', siteAddress: '', siteCity: '', siteState: '', siteZip: '', installedOn: '', warrantyExpiresOn: '' });
  const [err, setErr] = useState<string | null>(null);
  useEscapeKey(onClose, busy !== 'create', 'Add equipment');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const submit = async () => {
    if (!f.serialNumber.trim() && !f.make.trim() && !f.model.trim() && !f.description.trim()) return setErr('Give the serial, make and model, or a description.');
    const year = f.modelYear ? parseNum(f.modelYear) : null;
    if (f.modelYear && (year == null || year < 1900 || year > 2200)) return setErr('Year like 2019.');
    setErr(null);
    const r = await act<{ assetId: string }>('create', 'post', '/api/ops/assets', {
      companyId, kind, customerId: customer?.id ?? null, serialNumber: f.serialNumber.trim() || null, make: f.make.trim() || null, model: f.model.trim() || null,
      modelYear: year, description: f.description.trim() || null, siteLabel: f.siteLabel.trim() || null, siteAddress: f.siteAddress.trim() || null,
      siteCity: f.siteCity.trim() || null, siteState: f.siteState.trim() || null, siteZip: f.siteZip.trim() || null, installedOn: f.installedOn || null, warrantyExpiresOn: f.warrantyExpiresOn || null,
    }, 'Added the equipment');
    if (r) onCreated(r.assetId);
  };
  return (
    <Panel eyebrow={['New', 'Equipment']} title={[f.make, f.model].filter((x) => x.trim()).join(' ') || 'Add equipment'} meta="Make plus serial must be unique" onClose={onClose}
      foot={<div className="btn-row" style={{ justifyContent: 'flex-end', width: '100%' }}><Button onClick={onClose}>Cancel</Button><Button variant="primary" chord="mod+enter" bindChord disabled={busy === 'create'} onClick={() => void submit()}>Add</Button></div>}>
      <PanelSection>
        <form className="mp-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {companies.length > 1 && <Field label="Company"><Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
          <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as AssetKind)}>{(Object.keys(ASSET_KIND_WORDS) as AssetKind[]).map((k) => <option key={k} value={k}>{ASSET_KIND_WORDS[k]}</option>)}</Select></Field>
          <Field label={v.customer} help="Optional for dealer stock"><Lookup kind="customers" companyId={companyId} value={customer ? { id: customer.id, label: customer.label } : null} onChange={setCustomer} placeholder="Search your customer list" /></Field>
          <div className="mp-form-2">
            <Field label="Make" error={err ?? undefined}><Input autoFocus value={f.make} onChange={set('make')} placeholder="Trane" maxLength={80} /></Field>
            <Field label="Model"><Input value={f.model} onChange={set('model')} placeholder="XR16" maxLength={80} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Serial"><Input value={f.serialNumber} onChange={set('serialNumber')} maxLength={80} /></Field>
            <Field label="Year"><Input inputMode="numeric" value={f.modelYear} onChange={set('modelYear')} placeholder="2019" /></Field>
          </div>
          <Field label="Description"><Input value={f.description} onChange={set('description')} placeholder="3-ton condenser, R-410A" maxLength={300} /></Field>
          <div className="mp-form-2">
            <Field label="Site label"><Input value={f.siteLabel} onChange={set('siteLabel')} placeholder="Attic, upstairs zone" maxLength={120} /></Field>
            <Field label="Address"><Input value={f.siteAddress} onChange={set('siteAddress')} maxLength={200} /></Field>
          </div>
          <div className="mp-form-2">
            <Field label="City"><Input value={f.siteCity} onChange={set('siteCity')} maxLength={80} /></Field>
            <Field label="State and ZIP"><div className="row" style={{ gap: 8 }}><Input aria-label="State" value={f.siteState} onChange={set('siteState')} maxLength={40} style={{ width: 72 }} /><Input aria-label="ZIP" value={f.siteZip} onChange={set('siteZip')} maxLength={20} /></div></Field>
          </div>
          <div className="mp-form-2">
            <Field label="Installed"><Input type="date" value={f.installedOn} onChange={set('installedOn')} /></Field>
            <Field label="Warranty to"><Input type="date" value={f.warrantyExpiresOn} onChange={set('warrantyExpiresOn')} /></Field>
          </div>
          <Failure text={error} />
          <button type="submit" hidden />
        </form>
      </PanelSection>
    </Panel>
  );
}
