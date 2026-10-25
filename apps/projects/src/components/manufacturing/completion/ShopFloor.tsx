'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { PhotoButton, SignaturePad, m, type Opt } from '@/components/dealer/completion/kit';

const SHOP = '/api/mfg/shop-floor';

interface SheetSpec { spec_id: string; material_key: string; material: string; kind: string; thickness_mm: number | null; size: string | null; grain: string | null; finish: string | null; core: string | null; uom: string; item_id: string | null; by_location: Array<{ stock_location_id: string; stock_location: string; on_hand: number; allocated: number }>; on_hand: number; allocated: number }
interface Outside { id: string; status: string; job: string; job_id: string; work_order_id: string; order: string; operation: string; vendor: string; sent_on: string | null; due_back_on: string | null; back_on: string | null; po_number: string | null; install_on: string | null; late: boolean; breaks_install: boolean }
type Tab = 'sheets' | 'issue' | 'outside';

/** Sheet goods by spec and location (allocated vs free), cycle counts, issue to an order from its nest, and outside processing. */
export function ShopFloorView({ companyId, today, stockLocations, orders, jobs, vendors, operations }: { companyId: string; today: string; stockLocations: Opt[]; orders: Opt[]; jobs: Opt[]; vendors: Opt[]; operations: Array<Opt & { woId: string }> }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('sheets');
  const inv = useBoard<SheetSpec[]>(`${SHOP}?view=sheets&company=${companyId}`);
  const out = useBoard<Outside[]>(tab === 'outside' ? `${SHOP}?view=outside&company=${companyId}` : null);
  const { run, busy, error } = useDo(() => { inv.reload(); out.reload(); });
  const [spec, setSpec] = useState({ material: '', thickness: '18', grain: 'LENGTH', core: '', finish: '' });
  const [alloc, setAlloc] = useState<{ spec: SheetSpec; jobId: string; sl: string; qty: string } | null>(null);
  const [count1, setCount1] = useState<{ id: string; sl: string; values: Record<string, string> } | null>(null);
  const [issue, setIssue] = useState({ woId: orders[0]?.id ?? '', sl: stockLocations[0]?.id ?? '', lines: '', reason: '' });
  const [os, setOs] = useState({ operationId: '', vendorId: '', amount: '', due: '' });
  const invCols: QueueColumn<SheetSpec>[] = [
    { id: 'm', header: 'Material', cell: (r) => <><span className="l1">{r.material}{r.thickness_mm ? ` ${qty(r.thickness_mm)} mm` : ''}</span><span className="l2">{[r.size, r.grain && `grain ${r.grain.toLowerCase()}`, r.core, r.finish].filter(Boolean).join(' · ')}</span></> },
    { id: 'h', header: 'On hand', numeric: true, width: 100, cell: (r) => qty(r.on_hand, r.uom.toLowerCase()) },
    { id: 'a', header: 'Allocated', numeric: true, width: 100, cell: (r) => qty(r.allocated) },
    { id: 'f', header: 'Free', numeric: true, width: 90, cell: (r) => <Status kind={Number(r.on_hand) - Number(r.allocated) <= 0 ? 'overdue' : 'track'} pip="open">{qty(Number(r.on_hand) - Number(r.allocated))}</Status> },
  ];
  const outCols: QueueColumn<Outside>[] = [
    { id: 'o', header: 'Send-out', cell: (r) => <><span className="l1">{r.operation} · {r.vendor}</span><span className="l2">{r.job} · {r.order}{r.po_number ? ` · PO ${r.po_number}` : ''}</span></> },
    { id: 'd', header: 'Due back', width: 120, cell: (r) => r.due_back_on ? <Status kind={r.late ? 'overdue' : r.breaks_install ? 'risk' : 'track'} pip="open">{day(r.due_back_on, today)}</Status> : '—' },
    { id: 'i', header: 'Install', width: 110, cell: (r) => day(r.install_on, today) },
    { id: 's', header: 'Status', width: 120, cell: (r) => r.status.toLowerCase() },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <Tabs aria-label="Shop floor" value={tab} onChange={setTab} items={[{ value: 'sheets', label: 'Sheet goods' }, { value: 'issue', label: 'Issue to an order' }, { value: 'outside', label: 'Outside processing' }]} />
      {tab === 'sheets' && (
        <>
          <BoardState b={inv} what="Sheet goods" />
          {inv.data && (inv.data.length === 0 ? <Empty title="No sheet specs" body="Add each sheet good (material, thickness, size, grain, core) below; receipts and issues track by spec." /> :
            <div className="mp-table"><QueueTable aria-label="Sheet goods" columns={invCols} rows={inv.data} getRowId={(r) => r.spec_id} onOpen={(r) => !readOnly && setAlloc({ spec: r, jobId: jobs[0]?.id ?? '', sl: r.by_location[0]?.stock_location_id ?? stockLocations[0]?.id ?? '', qty: '' })} openOnClick rowState={(r) => ({ attn: Number(r.on_hand) - Number(r.allocated) <= 0 })} /></div>)}
          {!readOnly && (
            <Section title="Count and specs">
              <ButtonRow>
                <Select aria-label="Stock location" value={count1?.sl ?? stockLocations[0]?.id ?? ''} onChange={(e) => setCount1(count1 ? { ...count1, sl: e.target.value } : null)}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>
                <Button disabled={busy === 'cnt'} onClick={() => { const sl = count1?.sl ?? stockLocations[0]?.id ?? ''; void run<string>('cnt', SHOP, { op: 'start_count', stockLocationId: sl }, 'Count started').then((id) => { if (id) setCount1({ id, sl, values: {} }); }); }}>Start a cycle count</Button>
              </ButtonRow>
              <div className="ops-toolbar">
                <Field label="Material"><Input value={spec.material} onChange={(e) => setSpec({ ...spec, material: e.target.value })} placeholder="Maple ply" /></Field>
                <Field label="Thickness (mm)"><Input inputMode="decimal" value={spec.thickness} onChange={(e) => setSpec({ ...spec, thickness: e.target.value })} style={{ width: 80 }} /></Field>
                <Field label="Grain"><Select value={spec.grain} onChange={(e) => setSpec({ ...spec, grain: e.target.value })}><option value="LENGTH">Length</option><option value="WIDTH">Width</option><option value="NONE">None</option></Select></Field>
                <Field label="Core"><Input value={spec.core} onChange={(e) => setSpec({ ...spec, core: e.target.value })} style={{ width: 90 }} /></Field>
                <Field label="Finish"><Input value={spec.finish} onChange={(e) => setSpec({ ...spec, finish: e.target.value })} style={{ width: 110 }} /></Field>
                <Button disabled={!spec.material.trim() || busy === 'spec'} onClick={() => void run('spec', SHOP, { op: 'sheet_spec', companyId, material: spec.material.trim(), thicknessMm: Number(spec.thickness) || null, grain: spec.grain, core: spec.core || null, finish: spec.finish || null }, 'Spec saved')}>Add the spec</Button>
              </div>
            </Section>
          )}
        </>
      )}
      {tab === 'issue' && !readOnly && (
        <Section title="Issue sheets to a production order" meta="The nest from the CAD import is the quantity; more than 5% over needs a reason and is flagged">
          <div className="ops-toolbar">
            <Field label="Order"><Select value={issue.woId} onChange={(e) => setIssue({ ...issue, woId: e.target.value })}>{orders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>
            <Field label="From"><Select value={issue.sl} onChange={(e) => setIssue({ ...issue, sl: e.target.value })}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
          </div>
          <Field label="Different quantities (material key | qty, one per line; blank = the nest)"><Textarea rows={2} value={issue.lines} onChange={(e) => setIssue({ ...issue, lines: e.target.value })} placeholder="MAPLE PLY|18.0 | 14" /></Field>
          <Field label="Reason (over the nest)"><Input value={issue.reason} onChange={(e) => setIssue({ ...issue, reason: e.target.value })} /></Field>
          <ButtonRow>
            <Button variant="primary" disabled={!issue.woId || !issue.sl || busy === 'iss'} onClick={() => {
              const lines = issue.lines.split('\n').map((l) => { const i = l.lastIndexOf('|'); return i > 0 ? { material_key: l.slice(0, i).trim(), qty: Number(l.slice(i + 1)) || 0 } : null; }).filter((x): x is { material_key: string; qty: number } => !!x && !!x.material_key);
              void run<{ issued: Array<{ material_key: string; issued_qty: number; flagged?: boolean }> }>('iss', SHOP, { op: 'issue_nest', woId: issue.woId, stockLocationId: issue.sl, lines: lines.length ? lines : null, reason: issue.reason || null },
                (r) => `${r.issued.map((x) => `${qty(x.issued_qty)} × ${x.material_key}${x.flagged ? ' (flagged)' : ''}`).join(', ')} issued`);
            }}>Issue</Button>
            {issue.woId && <Link className="nlink" href={`/production/cut-list/${issue.woId}`}>Cut list</Link>}
          </ButtonRow>
        </Section>
      )}
      {tab === 'outside' && (
        <>
          <BoardState b={out} what="Outside processing" />
          {out.data && (out.data.length === 0 ? <Empty title="Nothing out" body="Send an operation (finishing, stone, powder coat) out below; its PO and due-back date track against the install." /> :
            <div className="mp-table"><QueueTable aria-label="Outside processing" columns={[...outCols, ...(readOnly ? [] : [{ id: 'b', header: <span className="sr">Back</span>, width: 100, cell: (r: Outside) => r.status === 'BACK' ? day(r.back_on, today) : <Button disabled={busy === r.id} onClick={() => void run(r.id, SHOP, { op: 'receive_outside', outsideId: r.id }, 'Back in the shop')}>Back</Button> } satisfies QueueColumn<Outside>])]}
              rows={out.data} getRowId={(r) => r.id} onOpen={(r) => window.location.assign(`/production?wo=${r.work_order_id}`)} openOnClick rowState={(r) => ({ attn: r.late || r.breaks_install, done: r.status === 'BACK' })} /></div>)}
          {!readOnly && (
            <Section title="Send an operation out">
              <div className="ops-toolbar">
                <Field label="Operation"><Select value={os.operationId} onChange={(e) => setOs({ ...os, operationId: e.target.value })}><option value="">Pick the operation</option>{operations.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select></Field>
                <Field label="Vendor"><Select value={os.vendorId} onChange={(e) => setOs({ ...os, vendorId: e.target.value })}><option value="">Pick the vendor</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></Field>
                <Field label="PO amount ($)"><Input inputMode="decimal" value={os.amount} onChange={(e) => setOs({ ...os, amount: e.target.value })} style={{ width: 110 }} /></Field>
                <Field label="Due back"><Input type="date" value={os.due} onChange={(e) => setOs({ ...os, due: e.target.value })} /></Field>
              </div>
              <Button disabled={!os.operationId || !os.vendorId || busy === 'os'} onClick={() => void run('os', SHOP, { op: 'send_outside', operationId: os.operationId, vendorId: os.vendorId, amountCents: centsFrom(os.amount) ?? 0, dueBackOn: os.due || null }, 'Sent out; a draft PO is on the job')}>Send it out</Button>
            </Section>
          )}
        </>
      )}
      {alloc && (
        <Drawer open onClose={() => setAlloc(null)} title={`${alloc.spec.material}${alloc.spec.thickness_mm ? ` ${qty(alloc.spec.thickness_mm)} mm` : ''}`} meta={alloc.spec.by_location.map((l) => `${l.stock_location}: ${qty(l.on_hand)} on hand, ${qty(l.allocated)} allocated`).join(' · ')}>
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Job"><Select value={alloc.jobId} onChange={(e) => setAlloc({ ...alloc, jobId: e.target.value })}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
            <Field label="From"><Select value={alloc.sl} onChange={(e) => setAlloc({ ...alloc, sl: e.target.value })}>{stockLocations.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
            <Field label="Sheets to hold"><Input inputMode="decimal" value={alloc.qty} onChange={(e) => setAlloc({ ...alloc, qty: e.target.value })} /></Field>
            <ButtonRow>
              <Button variant="primary" disabled={!alloc.spec.item_id || !(Number(alloc.qty) > 0) || busy === 'al'} onClick={() => void run('al', SHOP, { op: 'allocate', jobId: alloc.jobId, itemId: alloc.spec.item_id, stockLocationId: alloc.sl, qty: Number(alloc.qty) }, 'Held for the job').then((r) => { if (r) setAlloc(null); })}>Hold for the job</Button>
              <Button variant="quiet" disabled={!alloc.spec.item_id || busy === 'al'} onClick={() => void run('al', SHOP, { op: 'allocate', jobId: alloc.jobId, itemId: alloc.spec.item_id, stockLocationId: alloc.sl, release: true }, 'Released').then(() => setAlloc(null))}>Release the job&apos;s hold</Button>
            </ButtonRow>
          </div>
        </Drawer>
      )}
      {count1 && inv.data && (
        <Drawer open onClose={() => setCount1(null)} title="Cycle count" meta="Count what is on the rack; posting adjusts the variance (Books values it)">
          <div className="stack" style={{ padding: 16 }}>
            {inv.data.filter((x) => x.item_id).map((x) => <Field key={x.spec_id} label={`${x.material}${x.thickness_mm ? ` ${qty(x.thickness_mm)} mm` : ''} (system ${qty(x.by_location.find((l) => l.stock_location_id === count1.sl)?.on_hand ?? 0)})`}>
              <Input inputMode="decimal" value={count1.values[x.item_id!] ?? ''} onChange={(e) => setCount1({ ...count1, values: { ...count1.values, [x.item_id!]: e.target.value } })} style={{ width: 100 }} /></Field>)}
            <Button variant="primary" disabled={busy === 'post'} onClick={async () => {
              for (const [item, v] of Object.entries(count1.values)) if (v.trim() !== '') await run('post', SHOP, { op: 'record_count', countId: count1.id, itemId: item, qty: Number(v) }, null);
              await run<{ adjustments: number }>('post', SHOP, { op: 'post_count', countId: count1.id }, (r) => `Count posted: ${r.adjustments} adjustment(s)`);
              setCount1(null);
            }}>Post the count</Button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

// ── shipping + proof of delivery (MFG-44) ─────────────────────────────────────────────────────────
interface ShipRow { id: string; number: string; status: string; job_id: string; job: string; job_name: string; ship_on: string | null; promised_on: string | null; delivered_at: string | null; signer_name: string | null; truck: string | null; items: number; loaded: number; exceptions: number; on_time: boolean | null; billing_request_id: string | null }
interface ShipDetail { shipment: { id: string; number: string; status: string; load_check: { ok?: boolean; not_loaded?: number; orders_not_complete?: number }; signer_name: string | null; billing_request_id: string | null }; items: Array<{ id: string; label: string; description: string | null; room: string | null; seq: number; loaded: boolean; delivered: boolean; exception: string | null }> }

export function ShippingView({ companyId, today, jobs, areas }: { companyId: string; today: string; jobs: Opt[]; areas: Array<Opt & { jobId: string }> }) {
  const { readOnly } = useShell();
  const b = useBoard<ShipRow[]>(`${SHOP}?view=shipments&company=${companyId}`);
  const { run, busy, error } = useDo(b.reload);
  const [open, setOpen] = useState<string | null>(null);
  const [nw, setNw] = useState({ jobId: jobs[0]?.id ?? '', wbs: [] as string[], shipOn: today, promisedOn: '', truck: '' });
  const cols: QueueColumn<ShipRow>[] = [
    { id: 'n', header: 'Delivery', cell: (r) => <><span className="l1">{r.number}</span><span className="l2">{r.job} · {r.job_name}{r.truck ? ` · ${r.truck}` : ''}</span></> },
    { id: 'l', header: 'Loaded', numeric: true, width: 100, cell: (r) => `${count(r.loaded)} / ${count(r.items)}` },
    { id: 'd', header: 'Ship / promised', width: 160, cell: (r) => `${day(r.ship_on, today)} / ${day(r.promised_on, today)}` },
    { id: 's', header: 'Status', width: 170, cell: (r) => <Status kind={r.status === 'DELIVERED' ? (r.on_time === false ? 'risk' : 'ready') : r.exceptions ? 'risk' : 'track'} pip="open">{r.status.toLowerCase()}{r.exceptions ? ` · ${r.exceptions} exception(s)` : ''}</Status> },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={b} what="Deliveries" />
      {b.data && (b.data.length === 0 ? <Empty title="No deliveries" body="Build a packing list from an area's cabinets below; the crew checks the load and the site signs for it." /> :
        <div className="mp-table"><QueueTable aria-label="Deliveries" columns={cols} rows={b.data} getRowId={(r) => r.id} onOpen={(r) => setOpen(r.id)} openOnClick rowState={(r) => ({ attn: r.exceptions > 0, done: r.status === 'DELIVERED' })} /></div>)}
      {!readOnly && (
        <Section title="New delivery">
          <div className="ops-toolbar">
            <Field label="Job"><Select value={nw.jobId} onChange={(e) => setNw({ ...nw, jobId: e.target.value, wbs: [] })}>{jobs.map((j) => <option key={j.id} value={j.id}>{j.label}</option>)}</Select></Field>
            <Field label="Ship"><Input type="date" value={nw.shipOn} onChange={(e) => setNw({ ...nw, shipOn: e.target.value })} /></Field>
            <Field label="Promised"><Input type="date" value={nw.promisedOn} onChange={(e) => setNw({ ...nw, promisedOn: e.target.value })} /></Field>
            <Field label="Truck"><Input value={nw.truck} onChange={(e) => setNw({ ...nw, truck: e.target.value })} style={{ width: 120 }} /></Field>
          </div>
          <ButtonRow>{areas.filter((a) => a.jobId === nw.jobId).map((a) => <Button key={a.id} variant={nw.wbs.includes(a.id) ? 'primary' : 'quiet'} onClick={() => setNw({ ...nw, wbs: nw.wbs.includes(a.id) ? nw.wbs.filter((x) => x !== a.id) : [...nw.wbs, a.id] })}>{a.label}</Button>)}</ButtonRow>
          <Button disabled={!nw.jobId || busy === 'nw'} onClick={() => void run<{ shipment_id: string; items: number }>('nw', SHOP, { op: 'create_shipment', jobId: nw.jobId, wbsIds: nw.wbs, shipOn: nw.shipOn || null, promisedOn: nw.promisedOn || null, truck: nw.truck || null }, (r) => `${r.items} cabinet(s) on the packing list`).then((r) => { if (r) setOpen(r.shipment_id); })}>Build the packing list</Button>
        </Section>
      )}
      {open && <ShipDrawer id={open} onClose={() => { setOpen(null); b.reload(); }} readOnly={readOnly} />}
    </div>
  );
}

function ShipDrawer({ id, onClose, readOnly }: { id: string; onClose: () => void; readOnly: boolean }) {
  const d = useBoard<ShipDetail>(`${SHOP}?view=shipment&id=${id}`);
  const { run, busy, error } = useDo(d.reload);
  const [pod, setPod] = useState({ signer: '', sig: '', photos: [] as string[], notes: '' });
  const x = d.data;
  const open = x && x.shipment.status !== 'DELIVERED';
  const mark = (ids: string[], field: string, value = true, exception: string | null = null) => run('mk', SHOP, { op: 'mark_items', shipmentId: id, itemIds: ids, field, value, exception }, null);
  return (
    <Drawer open onClose={onClose} width={620} title={x ? `Delivery ${x.shipment.number}` : 'Delivery'} meta={x?.shipment.status.toLowerCase()}>
      <div className="stack" style={{ padding: 16 }}>
        {error && <Failure text={error} />}
        <BoardState b={d} what="The delivery" />
        {x && (
          <>
            {x.shipment.load_check && x.shipment.load_check.ok === false && <InlineNotice tone="warn" title="The load check found gaps.">{x.shipment.load_check.not_loaded ? `${x.shipment.load_check.not_loaded} not loaded. ` : ''}{x.shipment.load_check.orders_not_complete ? `${x.shipment.load_check.orders_not_complete} production order(s) not complete.` : ''}</InlineNotice>}
            <table className="ops-mini" aria-label="Packing list"><thead><tr><th>#</th><th>Cabinet</th><th>Room</th><th>Loaded</th><th>Exception</th></tr></thead>
              <tbody>{x.items.map((i) => <tr key={i.id}><td>{i.seq}</td><td>{i.label}<div className="t-cap">{i.description}</div></td><td>{i.room ?? '—'}</td>
                <td>{open && !readOnly ? <Button variant={i.loaded ? 'quiet' : 'default'} onClick={() => void mark([i.id], 'loaded', !i.loaded)}>{i.loaded ? 'Loaded' : 'Load'}</Button> : i.loaded ? 'yes' : 'no'}</td>
                <td>{open && !readOnly ? <Select aria-label={`Exception for ${i.label}`} value={i.exception ?? ''} onChange={(e) => void mark([i.id], 'exception', true, e.target.value || null)}><option value="">None</option><option value="MISSING">Missing</option><option value="DAMAGED">Damaged</option><option value="SHORT">Short</option></Select> : i.exception?.toLowerCase() ?? '—'}</td></tr>)}</tbody></table>
            {open && !readOnly && (
              <>
                <ButtonRow>
                  <Button onClick={() => void mark(x.items.filter((i) => !i.loaded).map((i) => i.id), 'loaded')} disabled={x.items.every((i) => i.loaded)}>Load all</Button>
                  <Button variant="quiet" disabled={busy === 'chk'} onClick={() => void run<{ ok: boolean; not_loaded: number }>('chk', SHOP, { op: 'check_load', shipmentId: id }, (r) => r.ok ? 'Load checks out' : `${r.not_loaded} not loaded`)}>Check the load</Button>
                </ButtonRow>
                <Section title="Proof of delivery">
                  <Field label="Received by"><Input value={pod.signer} onChange={(e) => setPod({ ...pod, signer: e.target.value })} /></Field>
                  <SignaturePad url="/api/mfg/uploads" onFiled={(sig) => setPod({ ...pod, sig })} />
                  <PhotoButton url="/api/mfg/uploads" label={`Delivery photo${pod.photos.length ? ` (${pod.photos.length})` : ''}`} onFiled={(p) => setPod({ ...pod, photos: [...pod.photos, p] })} />
                  <Field label="Notes"><Textarea rows={2} value={pod.notes} onChange={(e) => setPod({ ...pod, notes: e.target.value })} /></Field>
                  <Button variant="primary" disabled={!pod.signer.trim() || busy === 'del'} onClick={() => void run<{ remakes: number }>('del', SHOP, { op: 'deliver', shipmentId: id, signer: pod.signer.trim(), signatureDocumentId: pod.sig || null, photoIds: pod.photos, notes: pod.notes || null }, (r) => `Delivered${r.remakes ? `; ${r.remakes} remake(s) requested` : ''}`)}>Delivered</Button>
                </Section>
              </>
            )}
            {!open && !readOnly && !x.shipment.billing_request_id && <Button variant="primary" disabled={busy === 'bill'} onClick={() => void run<{ amount_cents: number }>('bill', '/api/mfg/money', { op: 'bill_shipment', shipmentId: id }, (r) => `Billing ${m(r.amount_cents)} drafted for Books`)}>Bill this delivery</Button>}
            {x.shipment.billing_request_id && <p className="t-cap">Billed (request drafted for Books).</p>}
            <p className="t-cap">{pctText(x.items.length ? x.items.filter((i) => i.loaded).length / x.items.length : 0, 0)} loaded.</p>
          </>
        )}
      </div>
    </Drawer>
  );
}
