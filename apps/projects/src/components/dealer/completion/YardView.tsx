'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, FilePick, day, useBoard, useDo } from '@/components/dealer/common/depth';
import { parseShipmentFile, type ParsedShipment } from '@/lib/dealer/oem-shipment';
import { PhotoButton, ScanBox, m, usePosition } from './kit';

interface ShipmentRow { id: string; number: string; status: string; vendor: string | null; invoice_ref: string | null; ship_ref: string | null; source: string; expected_on: string | null; received_at: string | null; summary: Record<string, number>; lines: number; scanned: number }
interface Recon { recon_id: string; status: string; unit_id: string; unit: string; work_order_id: string | null; ro_number: string | null; ro_status: string | null; days_open: number; waive_reason: string | null }
interface Yard { shipments: ShipmentRow[]; lot_audit: { id: string; number: string; purpose: string; started_at: string; scans: number } | null; past_audits: Array<{ id: string; number: string; closed_at: string; summary: Record<string, number> }>; recons: Recon[]; rerent_holds: Array<{ id: string; unit: string; since: string }> }
interface Line { id: string; line_no: number; make: string | null; model: string | null; serial_number: string | null; status: string; damage_note: string | null; error: string | null; unit_id: string | null; cost_cents: number | null; photos: number }
interface Detail { shipment: ShipmentRow & { lender: string | null }; lines: Line[]; amounts_visible: boolean }
interface AuditReport { expected: number; found: number; missing: Array<{ unit_id: string; stock_number: string | null; serial_number: string | null; make: string | null; model: string | null; unit_status: string; payoff_cents: number | null }>; sold_not_paid: Array<{ unit_id: string; stock_number: string | null; model: string | null; sold_on: string | null; payoff_cents: number | null }>; gps_flags: Array<{ code: string; distance_m: number }>; exceptions: Array<{ code: string; result: string }>; scans: number }

const LINE_KIND: Record<string, 'ready' | 'track' | 'risk' | 'overdue' | 'blocked'> = { EXPECTED: 'track', SCANNED: 'ready', RECEIVED: 'ready', DAMAGED: 'risk', EXTRA: 'risk', SHORT: 'overdue', FAILED: 'blocked' };
const SCAN_WORDS: Record<string, string> = { MATCHED: 'Matched the notice', DAMAGED: 'Matched, marked damaged', FILLED: 'Serial added to an expected unit', EXTRA: 'Not on the notice: recorded as extra', DUPLICATE: 'Already scanned', FOUND: 'On the lot', UNKNOWN: 'Not in the system', WRONG_STORE: 'Belongs to another store', NOT_IN_STOCK: 'Not in stock (sold, transferred or on order)' };

type Tab = 'receive' | 'lot' | 'recon';

/** The yard on a phone or the desk: receive OEM shipments by serial, count the lot, finish recon. */
export function YardView({ companyId, today, vendors, stockLocations }: { companyId: string; today: string; vendors: Array<{ id: string; name: string }>; stockLocations: Array<{ id: string; code: string; name: string }> }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('receive');
  const b = useBoard<Yard>(`/api/dealer/yard?view=board&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [open, setOpen] = useState<string | null>(null);
  const [parsed, setParsed] = useState<(ParsedShipment & { fileName: string }) | null>(null);
  const [hdr, setHdr] = useState({ vendorId: '', lenderId: '', floorProgram: '', stockLocationId: stockLocations[0]?.id ?? '' });

  const shipCols: QueueColumn<ShipmentRow>[] = [
    { id: 'n', header: 'Shipment', cell: (r) => <><span className="l1">{r.number}</span><span className="l2">{[r.vendor, r.invoice_ref && `Invoice ${r.invoice_ref}`, r.source.replace('_', ' ')].filter(Boolean).join(' · ')}</span></> },
    { id: 'p', header: 'Scanned', numeric: true, width: 110, cell: (r) => `${count(r.scanned)} / ${count(r.lines)}` },
    { id: 's', header: 'Status', width: 170, cell: (r) => r.status === 'RECEIVED'
      ? <Status kind={(r.summary.short ?? 0) + (r.summary.failed ?? 0) > 0 ? 'risk' : 'ready'} pip="open">{`received${r.summary.short ? `, ${r.summary.short} short` : ''}`}</Status>
      : <Status kind="track" pip="open">{r.status.toLowerCase()}</Status> },
    { id: 'd', header: 'When', width: 100, cell: (r) => day(r.received_at ?? r.expected_on, today) },
  ];

  const reconCols: QueueColumn<Recon>[] = [
    { id: 'u', header: 'Unit', cell: (r) => <><span className="l1">{r.unit}</span><span className="l2">{r.status === 'OPEN' ? `${count(r.days_open)} days in recon` : r.waive_reason ? `Waived: ${r.waive_reason}` : 'Done'}</span></> },
    { id: 'ro', header: 'Recon RO', width: 160, cell: (r) => r.work_order_id ? <Link className="nlink" href={`/work-orders/service?wo=${r.work_order_id}`}>{r.ro_number ?? 'RO'} · {(r.ro_status ?? '').toLowerCase()}</Link> : <span className="l2">No RO yet</span> },
    { id: 's', header: 'Status', width: 110, cell: (r) => <Status kind={r.status === 'OPEN' ? 'track' : 'ready'} pip="open">{r.status.toLowerCase()}</Status> },
  ];

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Tabs aria-label="Yard" value={tab} onChange={setTab} items={[
        { value: 'receive', label: 'Receive shipments', count: b.data ? count(b.data.shipments.filter((s) => s.status === 'OPEN').length) : undefined },
        { value: 'lot', label: 'Lot count', count: b.data?.lot_audit ? '1 open' : undefined },
        { value: 'recon', label: 'Recon', count: b.data ? count(b.data.recons.filter((r) => r.status === 'OPEN').length) : undefined },
      ]} />
      <BoardState b={b} what="The yard" />
      {b.data && tab === 'receive' && (
        <>
          {!readOnly && (
            <Section title="New OEM shipment" meta="Load the advance ship notice (EDI 856) or the invoice CSV, check the units, then scan serials as they come off the truck">
              <ButtonRow>
                <FilePick label="Load 856 / CSV" accept=".edi,.x12,.txt,.856,.csv" onText={(name, text) => setParsed({ ...parseShipmentFile(text), fileName: name })} />
              </ButtonRow>
              {parsed && (
                <div className="stack">
                  {parsed.warnings.map((w) => <InlineNotice key={w} tone="warn" title="Check the file.">{w}</InlineNotice>)}
                  <div className="ops-toolbar">
                    <Field label="Manufacturer"><Select value={hdr.vendorId} onChange={(e) => setHdr({ ...hdr, vendorId: e.target.value })}><option value="">Pick the OEM</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
                    <Field label="Floor-plan lender"><Select value={hdr.lenderId} onChange={(e) => setHdr({ ...hdr, lenderId: e.target.value })}><option value="">Not floored</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</Select></Field>
                    <Field label="Program"><Input value={hdr.floorProgram} onChange={(e) => setHdr({ ...hdr, floorProgram: e.target.value })} placeholder="180-day free" style={{ width: 150 }} /></Field>
                    <Field label="Yard"><Select value={hdr.stockLocationId} onChange={(e) => setHdr({ ...hdr, stockLocationId: e.target.value })}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.code} · {s.name}</option>)}</Select></Field>
                  </div>
                  <table className="ops-mini" aria-label="Units on the notice">
                    <thead><tr><th>#</th><th>Make / model</th><th>Serial</th><th>Year</th><th className="n">Invoice cost</th></tr></thead>
                    <tbody>{parsed.lines.map((l, i) => <tr key={i}><td>{i + 1}</td><td>{[l.make, l.model].filter(Boolean).join(' ') || '—'}</td><td>{l.serial_number ?? <span className="t-cap">scan in the yard</span>}</td><td>{l.model_year ?? '—'}</td><td className="n">{m(l.cost_cents)}</td></tr>)}</tbody>
                  </table>
                  <ButtonRow>
                    <Button variant="primary" disabled={!parsed.lines.length || busy === 'create'} onClick={async () => {
                      const r = await run<{ shipment_id: string }>('create', '/api/dealer/yard', {
                        op: 'create_shipment', companyId, vendorId: hdr.vendorId || null, lenderId: hdr.lenderId || null, floorProgram: hdr.floorProgram || null, stockLocationId: hdr.stockLocationId || null,
                        invoiceRef: parsed.invoice_ref, shipRef: parsed.ship_ref, source: parsed.source, fileName: parsed.fileName, lines: parsed.lines,
                      }, (d) => `Shipment ready to scan`);
                      if (r) { setParsed(null); setOpen(r.shipment_id); }
                    }}>Create the shipment ({count(parsed.lines.length)} units)</Button>
                    <Button variant="quiet" onClick={() => setParsed(null)}>Discard</Button>
                  </ButtonRow>
                </div>
              )}
            </Section>
          )}
          <Section title="Shipments" meta="Open a shipment to scan serials and receive">
            {b.data.shipments.length === 0 ? <Empty title="No OEM shipments" body="Load the ship notice or invoice file above; each serial you scan is checked against it." /> :
              <div className="mp-table"><QueueTable aria-label="OEM shipments" columns={shipCols} rows={b.data.shipments} getRowId={(r) => r.id} onOpen={(r) => setOpen(r.id)} openOnClick rowState={(r) => ({ attn: r.status === 'OPEN', done: r.status === 'RECEIVED' })} /></div>}
          </Section>
        </>
      )}
      {b.data && tab === 'lot' && <LotCount companyId={companyId} audit={b.data.lot_audit} past={b.data.past_audits} today={today} reload={b.reload} readOnly={readOnly} />}
      {b.data && tab === 'recon' && (
        <Section title="Used units in recon" meta="A received trade opens recon; the unit is listed and goes on a deal once its recon RO is complete (or a manager waives it)">
          {b.data.recons.length === 0 ? <Empty title="Nothing in recon" body="Trade-ins received on a deal and used units you send to recon show here." /> :
            <div className="mp-table"><QueueTable aria-label="Recon" columns={[...reconCols, ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Finish</span>, width: 260, cell: (r: Recon) => r.status !== 'OPEN' ? null : (
              <ButtonRow>
                <Button disabled={busy === r.recon_id} onClick={() => void run(r.recon_id, '/api/dealer/yard', { op: 'complete_recon', reconId: r.recon_id }, 'Recon finished; the unit can be listed')}>Finish</Button>
                <Button variant="quiet" disabled={busy === r.recon_id} onClick={() => { const why = window.prompt('Why list it without recon? (manager)'); if (why) void run(r.recon_id, '/api/dealer/yard', { op: 'complete_recon', reconId: r.recon_id, waiveReason: why }, 'Recon waived'); }}>Waive</Button>
              </ButtonRow>) } satisfies QueueColumn<Recon>])]} rows={b.data.recons} getRowId={(r) => r.recon_id}
              onOpen={(r) => { if (r.work_order_id) window.location.assign(`/work-orders/service?wo=${r.work_order_id}`); }} openOnClick rowState={(r) => ({ attn: r.status === 'OPEN' && r.days_open > 7 })} /></div>}
          {b.data.rerent_holds.length > 0 && <InlineNotice tone="warn" title={`${count(b.data.rerent_holds.length)} rental unit(s) wait for the re-rent inspection.`}>Clear them on <Link className="nlink" href="/rentals/fleet">Rental fleet</Link>.</InlineNotice>}
        </Section>
      )}
      {open && <ShipmentDrawer id={open} onClose={() => { setOpen(null); b.reload(); }} today={today} readOnly={readOnly} />}
    </div>
  );
}

function ShipmentDrawer({ id, onClose, today, readOnly }: { id: string; onClose: () => void; today: string; readOnly: boolean }) {
  const d = useBoard<Detail>(`/api/dealer/yard?view=shipment&id=${id}`);
  const { run, busy, error } = useDo(d.reload);
  const [last, setLast] = useState<{ result: string; serial: string } | null>(null);
  const [damage, setDamage] = useState<{ on: boolean; note: string; photos: string[] }>({ on: false, note: '', photos: [] });
  const [model, setModel] = useState('');
  const s = d.data?.shipment;
  const left = useMemo(() => (d.data?.lines ?? []).filter((l) => l.status === 'EXPECTED'), [d.data]);
  return (
    <Drawer open onClose={onClose} width={640} title={s ? `Shipment ${s.number}` : 'Shipment'} meta={s ? [s.vendor, s.lender && `Floored with ${s.lender}`].filter(Boolean).join(' · ') : undefined}>
      <div className="stack" style={{ padding: 16 }}>
        {error && <Failure text={error} />}
        <BoardState b={d} what="The shipment" />
        {s && d.data && (
          <>
            {s.status === 'OPEN' && !readOnly && (
              <Section title="Scan serials" meta={`${count(left.length)} still expected`}>
                <ScanBox label="Serial number" disabled={busy === 'scan'} onScan={async (code) => {
                  const r = await run<{ result: string; serial_number: string }>('scan', '/api/dealer/yard', { op: 'scan', shipmentId: id, code, model: model || null, damaged: damage.on, damageNote: damage.on ? damage.note || 'Damaged on receipt' : null, photoIds: damage.photos }, null);
                  if (r) { setLast({ result: r.result, serial: r.serial_number }); setDamage({ on: false, note: '', photos: [] }); }
                }} />
                <div className="ops-toolbar">
                  <Field label="Model (for units without a serial on the notice)"><Input value={model} onChange={(e) => setModel(e.target.value)} style={{ width: 160 }} /></Field>
                  <Field label="Damaged"><Select value={damage.on ? 'y' : 'n'} onChange={(e) => setDamage({ ...damage, on: e.target.value === 'y' })}><option value="n">No</option><option value="y">Yes</option></Select></Field>
                  {damage.on && <Field label="What is damaged"><Input value={damage.note} onChange={(e) => setDamage({ ...damage, note: e.target.value })} style={{ width: 200 }} /></Field>}
                  {damage.on && <PhotoButton url="/api/dealer/uploads" label={`Photo${damage.photos.length ? ` (${damage.photos.length})` : ''}`} onFiled={(pid) => setDamage({ ...damage, photos: [...damage.photos, pid] })} />}
                </div>
                {last && <InlineNotice tone={last.result === 'MATCHED' || last.result === 'FILLED' ? 'info' : 'warn'} title={last.serial}>{SCAN_WORDS[last.result] ?? last.result}</InlineNotice>}
              </Section>
            )}
            <table className="ops-mini" aria-label="Units">
              <thead><tr><th>#</th><th>Unit</th><th>Serial</th><th>Status</th>{d.data.amounts_visible && <th className="n">Cost</th>}{s.status === 'OPEN' && !readOnly && <th><span className="sr">Mark</span></th>}</tr></thead>
              <tbody>{d.data.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.line_no}</td>
                  <td>{[l.make, l.model].filter(Boolean).join(' ') || '—'}{l.damage_note && <div className="t-cap">{l.damage_note}</div>}{l.error && <div className="neg t-cap">{l.error}</div>}</td>
                  <td>{l.unit_id ? <Link className="nlink" href={`/stock/units/${l.unit_id}/timeline`}>{l.serial_number}</Link> : l.serial_number ?? '—'}</td>
                  <td><Status kind={LINE_KIND[l.status] ?? 'track'} pip="open">{l.status.toLowerCase()}</Status></td>
                  {d.data!.amounts_visible && <td className="n">{m(l.cost_cents)}</td>}
                  {s.status === 'OPEN' && !readOnly && <td>{l.status === 'EXPECTED' ? <Button variant="quiet" onClick={() => void run(l.id, '/api/dealer/yard', { op: 'mark_line', lineId: l.id, status: 'SHORT' }, 'Marked short')}>Short</Button> : null}</td>}
                </tr>))}</tbody>
            </table>
            {s.status === 'OPEN' && !readOnly && (
              <ButtonRow>
                <Button variant="primary" disabled={busy === 'recv'} onClick={async () => {
                  if (left.length && !window.confirm(`${left.length} unit(s) were not scanned and will be recorded short. Receive the rest?`)) return;
                  await run<{ received: number; short: number; failed: number }>('recv', '/api/dealer/yard', { op: 'receive', shipmentId: id }, (r) => `${r.received} in stock${r.short ? `, ${r.short} short` : ''}${r.failed ? `, ${r.failed} failed` : ''}`);
                }}>Receive into stock</Button>
              </ButtonRow>
            )}
            {s.status === 'RECEIVED' && <p className="t-cap">Received {day(s.received_at, today)}. Damaged units are on hold; the OEM claim and the floor-plan note are Books&apos; once the units post.</p>}
          </>
        )}
      </div>
    </Drawer>
  );
}

function LotCount({ companyId, audit, past, today, reload, readOnly }: { companyId: string; audit: Yard['lot_audit']; past: Yard['past_audits']; today: string; reload: () => void; readOnly: boolean }) {
  const { run, busy, error } = useDo(reload);
  const { pos, ask, note } = usePosition();
  const [last, setLast] = useState<{ result: string; gps: boolean; code: string } | null>(null);
  const [report, setReport] = useState<AuditReport | null>(null);
  const r = useBoard<AuditReport>(audit ? `/api/dealer/yard?view=audit&id=${audit.id}` : null);
  const rep = report ?? r.data;
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!audit && !readOnly && (
        <Section title="Start a lot count" meta="Walk the lot with a phone; every unit you scan is checked against stock and the store's GPS radius">
          <ButtonRow>
            <Button variant="primary" disabled={busy === 'start'} onClick={() => { ask(); void run('start', '/api/dealer/yard', { op: 'start_audit', companyId, purpose: 'ROUTINE' }, 'Lot count started'); }}>Start a lot count</Button>
            <Button disabled={busy === 'start'} onClick={() => { ask(); void run('start', '/api/dealer/yard', { op: 'start_audit', companyId, purpose: 'LENDER_AUDIT' }, 'Floor-plan audit started'); }}>Start a floor-plan audit</Button>
          </ButtonRow>
        </Section>
      )}
      {audit && (
        <Section title={`${audit.purpose === 'LENDER_AUDIT' ? 'Floor-plan audit' : 'Lot count'} ${audit.number}`} meta={`${count(audit.scans)} scans since ${day(audit.started_at, today)}`}>
          {!readOnly && (
            <>
              <ScanBox label="Stock number, serial or VIN" placeholder="Scan the decal or type the stock number" disabled={busy === 'lot'} onScan={async (code) => {
                const x = await run<{ result: string; gps_flag: boolean }>('lot', '/api/dealer/yard', { op: 'lot_scan', auditId: audit.id, code, lat: pos?.lat ?? null, lng: pos?.lng ?? null }, null);
                if (x) { setLast({ result: x.result, gps: x.gps_flag, code }); r.reload(); }
              }} />
              <p className="t-cap">{pos ? `Location on (${pos.lat}, ${pos.lng}).` : note ?? 'Location is asked for once, to flag units scanned off the lot.'} {!pos && <Button variant="quiet" onClick={ask}>Use my location</Button>}</p>
              {last && <InlineNotice tone={last.result === 'FOUND' && !last.gps ? 'info' : 'warn'} title={last.code}>{SCAN_WORDS[last.result] ?? last.result}{last.gps ? ' · scanned away from the lot' : ''}</InlineNotice>}
            </>
          )}
          {rep && (
            <div className="stack">
              <p className="t-cap">{count(rep.found)} of {count(rep.expected)} expected units found · {count(rep.missing.length)} missing · {count(rep.sold_not_paid.length)} sold and not paid off</p>
              {rep.missing.length > 0 && (
                <table className="ops-mini" aria-label="Missing units">
                  <thead><tr><th>Missing</th><th>Status</th><th className="n">Payoff</th></tr></thead>
                  <tbody>{rep.missing.map((u) => <tr key={u.unit_id}><td><Link className="nlink" href={`/stock/units/${u.unit_id}/timeline`}>{[u.stock_number, u.make, u.model].filter(Boolean).join(' ')}</Link><div className="t-cap">{u.serial_number}</div></td><td>{u.unit_status.toLowerCase().replace('_', ' ')}</td><td className="n">{m(u.payoff_cents)}</td></tr>)}</tbody>
                </table>
              )}
              {rep.sold_not_paid.length > 0 && (
                <table className="ops-mini" aria-label="Sold not paid">
                  <thead><tr><th>Sold, not paid off</th><th>Sold</th><th className="n">Payoff</th></tr></thead>
                  <tbody>{rep.sold_not_paid.map((u) => <tr key={u.unit_id}><td>{[u.stock_number, u.model].filter(Boolean).join(' ')}</td><td>{day(u.sold_on, today)}</td><td className="n">{m(u.payoff_cents)}</td></tr>)}</tbody>
                </table>
              )}
            </div>
          )}
          {!readOnly && (
            <ButtonRow>
              <Button variant="primary" disabled={busy === 'close'} onClick={async () => { const x = await run<AuditReport>('close', '/api/dealer/yard', { op: 'close_audit', auditId: audit.id }, 'Lot count closed'); if (x) setReport(x); }}>Close the count</Button>
              <Button variant="quiet" disabled={busy === 'close'} onClick={() => { if (window.confirm('Cancel this count? Its scans are kept but it is not a finished count.')) void run('close', '/api/dealer/yard', { op: 'close_audit', auditId: audit.id, cancel: true }, 'Count cancelled'); }}>Cancel</Button>
            </ButtonRow>
          )}
        </Section>
      )}
      <Section title="Past counts">
        {past.length === 0 ? <Empty title="No finished counts" body="Closed lot counts and floor-plan audits keep their found / missing totals here." /> : (
          <table className="ops-mini" aria-label="Past counts">
            <thead><tr><th>Count</th><th>Closed</th><th className="n">Found</th><th className="n">Missing</th><th className="n">Off the lot</th></tr></thead>
            <tbody>{past.map((a) => <tr key={a.id}><td>{a.number}</td><td>{day(a.closed_at, today)}</td><td className="n">{count(Number(a.summary.found ?? 0))} / {count(Number(a.summary.expected ?? 0))}</td><td className="n">{count(Number(a.summary.missing ?? 0))}</td><td className="n">{count(Number(a.summary.gps_flags ?? 0))}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
