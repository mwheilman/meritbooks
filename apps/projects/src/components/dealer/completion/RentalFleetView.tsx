'use client';

import { useState } from 'react';
import { Button, ButtonRow, Drawer, Field, InlineNotice, Input, QueueTable, Select, Status, Tabs, Textarea, count, type QueueColumn } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, centsFrom, day, pctText, qty, useBoard, useDo } from '@/components/dealer/common/depth';
import { PhotoButton, SignaturePad, m, type Opt } from './kit';

interface AvUnit { unit_id: string; unit: string; category: string | null; model: string | null; store: string; location_id: string; meter: number | null; free: boolean; contracts: Array<{ number: string; status: string; from: string; to: string }>; blocks: Array<{ kind: string; from: string; to: string; reason: string | null }>; re_rent_hold: boolean }
interface Due { unit_id: string; unit: string; rule_id: string; rule: string; every_hours: number | null; every_days: number | null; meter: number | null; last_done: string | null; hours_since: number | null; days_rented_since: number; due_pct: number; due: boolean; est_hours: number; next_gap: { from: string; to: string } | null; blocked: boolean }
interface OutCheck { contract_id: string; required: string[]; missing: string[]; re_rent_hold: boolean; ready: boolean; paperwork: Record<string, unknown> | null }
interface Rate { id: string; label: string | null; model: string | null; category: string | null; day_cents: number | null; week_cents: number | null; month_cents: number | null; ext: { hour_cents: number | null; half_day_cents: number | null; min_hours: number | null; min_charge_cents: number | null; accessories: Array<{ code: string; label: string; day_cents: number }> } | null }
export interface ContractOpt { id: string; number: string; status: string; unit: string; customer: string | null }

const API = '/api/dealer/rental-desk';
const PAPER: Record<string, string> = { license: "Driver's license", coi: 'Insurance certificate', card_hold: 'Card hold', waiver: 'Damage waiver choice', safety_briefing: 'Safety briefing', signature: 'Signed contract' };
const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const iso = (local16: string) => new Date(local16).toISOString();
type Tab = 'out' | 'availability' | 'fleet' | 'rates';

/** Contract-out paperwork, availability across stores, fleet PM into the gaps between rentals, and short-rental rates. */
export function RentalFleetView({ companyId, today, contracts, returned }: { companyId: string; today: string; contracts: ContractOpt[]; returned: ContractOpt[] }) {
  const { readOnly } = useShell();
  const [tab, setTab] = useState<Tab>('out');
  return (
    <div className="stack">
      <Tabs aria-label="Rental fleet" value={tab} onChange={setTab} items={[{ value: 'out', label: 'Contract out', count: count(contracts.length) }, { value: 'availability', label: 'Availability' }, { value: 'fleet', label: 'Fleet service' }, { value: 'rates', label: 'Short-rental rates' }]} />
      {tab === 'out' && <ContractOut contracts={contracts} returned={returned} readOnly={readOnly} companyId={companyId} />}
      {tab === 'availability' && <Availability companyId={companyId} today={today} readOnly={readOnly} />}
      {tab === 'fleet' && <FleetService companyId={companyId} today={today} readOnly={readOnly} />}
      {tab === 'rates' && <Rates companyId={companyId} readOnly={readOnly} />}
    </div>
  );
}

function ContractOut({ contracts, returned, readOnly, companyId }: { contracts: ContractOpt[]; returned: ContractOpt[]; readOnly: boolean; companyId: string }) {
  const [cid, setCid] = useState(contracts[0]?.id ?? '');
  const c = useBoard<OutCheck>(cid ? `${API}?view=out_check&contract=${cid}` : null);
  const { run, busy, error } = useDo(c.reload);
  const [p, setP] = useState({ last4: '', state: '', exp: '', coi: '', coiExp: '', hold: '', holdAmt: '', waiver: '', briefed: false, signer: '', sigDoc: '' as string, meter: '' });
  const [dmg, setDmg] = useState({ contractId: returned[0]?.id ?? '', line: '', price: '', renter: true });
  const missing = c.data?.missing ?? [];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {contracts.length === 0 ? <Empty title="No reservations to send out" body="Reserve a unit on Rentals; its paperwork and check-out happen here." /> : (
        <Section title="Contract out" meta="The store chooses which paperwork is required; the database refuses a check-out without it">
          <Field label="Reservation"><Select value={cid} onChange={(e) => setCid(e.target.value)}>{contracts.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.unit} · {x.customer ?? ''}</option>)}</Select></Field>
          <BoardState b={c} what="The checklist" />
          {c.data && (
            <>
              {c.data.re_rent_hold && <InlineNotice tone="warn" title="This unit waits for its re-rent inspection.">Clear it on Fleet service before it goes out again.</InlineNotice>}
              <ul className="t-cap">{c.data.required.length === 0 ? <li>This store requires no paperwork before check-out.</li> : c.data.required.map((k) => <li key={k}>{missing.includes(k) ? '○' : '●'} {PAPER[k] ?? k}</li>)}</ul>
              {!readOnly && (
                <div className="stack">
                  <div className="ops-toolbar">
                    <Field label="License last 4"><Input value={p.last4} maxLength={4} onChange={(e) => setP({ ...p, last4: e.target.value })} style={{ width: 80 }} /></Field>
                    <Field label="State"><Input value={p.state} maxLength={2} onChange={(e) => setP({ ...p, state: e.target.value.toUpperCase() })} style={{ width: 60 }} /></Field>
                    <Field label="Expires"><Input type="date" value={p.exp} onChange={(e) => setP({ ...p, exp: e.target.value })} /></Field>
                    <PhotoButton url="/api/dealer/uploads" label={p.coi ? 'COI filed' : 'Insurance certificate'} onFiled={(id) => setP({ ...p, coi: id })} />
                    <Field label="COI expires"><Input type="date" value={p.coiExp} onChange={(e) => setP({ ...p, coiExp: e.target.value })} /></Field>
                  </div>
                  <div className="ops-toolbar">
                    <Field label="Card hold reference"><Input value={p.hold} onChange={(e) => setP({ ...p, hold: e.target.value })} style={{ width: 160 }} /></Field>
                    <Field label="Hold ($)"><Input inputMode="decimal" value={p.holdAmt} onChange={(e) => setP({ ...p, holdAmt: e.target.value })} style={{ width: 90 }} /></Field>
                    <Field label="Damage waiver"><Select value={p.waiver} onChange={(e) => setP({ ...p, waiver: e.target.value })}><option value="">Not asked</option><option value="ACCEPTED">Accepted</option><option value="DECLINED">Declined</option></Select></Field>
                    <Field label="Safety briefing"><Select value={p.briefed ? 'y' : 'n'} onChange={(e) => setP({ ...p, briefed: e.target.value === 'y' })}><option value="n">Not yet</option><option value="y">Given</option></Select></Field>
                  </div>
                  <Field label="Renter name"><Input value={p.signer} onChange={(e) => setP({ ...p, signer: e.target.value })} /></Field>
                  <SignaturePad url="/api/dealer/uploads" onFiled={(id) => setP({ ...p, sigDoc: id })} />
                  <ButtonRow>
                    <Button disabled={busy === 'paper'} onClick={() => void run('paper', API, { op: 'paperwork', contractId: cid, licenseLast4: p.last4 || null, licenseState: p.state || null, licenseExpiresOn: p.exp || null,
                      coiDocumentId: p.coi || null, coiExpiresOn: p.coiExp || null, cardHoldRef: p.hold || null, cardHoldCents: centsFrom(p.holdAmt), waiverChoice: p.waiver || null, safetyBriefed: p.briefed || null,
                      signerName: p.signer || null, signatureDocumentId: p.sigDoc || null }, 'Paperwork saved')}>Save the paperwork</Button>
                    <Field label="Meter out"><Input inputMode="decimal" value={p.meter} onChange={(e) => setP({ ...p, meter: e.target.value })} style={{ width: 90 }} /></Field>
                    <Button variant="primary" disabled={!c.data.ready || p.meter === '' || busy === 'out'} onClick={() => void run('out', API, { op: 'check_out', contractId: cid, meterOut: Number(p.meter) }, 'Checked out')}>Check it out</Button>
                  </ButtonRow>
                  {!c.data.ready && <p className="t-cap">Still needed: {missing.map((k) => PAPER[k] ?? k).join(', ') || (c.data.re_rent_hold ? 're-rent inspection' : '')}</p>}
                </div>
              )}
            </>
          )}
        </Section>
      )}
      {!readOnly && returned.length > 0 && (
        <Section title="Damage repair from a return" meta="Opens an RO on the unit: the renter pays, or the rental department does">
          <div className="ops-toolbar">
            <Field label="Returned contract"><Select value={dmg.contractId} onChange={(e) => setDmg({ ...dmg, contractId: e.target.value })}>{returned.map((x) => <option key={x.id} value={x.id}>{x.number} · {x.unit}</option>)}</Select></Field>
            <Field label="Repair"><Input value={dmg.line} onChange={(e) => setDmg({ ...dmg, line: e.target.value })} /></Field>
            <Field label="Price ($)"><Input inputMode="decimal" value={dmg.price} onChange={(e) => setDmg({ ...dmg, price: e.target.value })} style={{ width: 90 }} /></Field>
            <Field label="Who pays"><Select value={dmg.renter ? 'r' : 'i'} onChange={(e) => setDmg({ ...dmg, renter: e.target.value === 'r' })}><option value="r">The renter</option><option value="i">Rental department</option></Select></Field>
          </div>
          <Button disabled={!dmg.contractId || busy === 'dmg'} onClick={() => void run<{ work_order_id: string }>('dmg', API, { op: 'damage_ro', contractId: dmg.contractId, chargeRenter: dmg.renter, lines: dmg.line ? [{ description: dmg.line, unit_price_cents: centsFrom(dmg.price) }] : [] }, 'Damage RO opened').then((r) => { if (r) window.location.assign(`/work-orders/service?wo=${r.work_order_id}`); })}>Open the damage RO</Button>
        </Section>
      )}
      {!readOnly && (
        <Section title="Cycle billing" meta="Long-term rentals bill every store cycle (28 days by default) while they are out">
          <Button disabled={busy === 'cyc'} onClick={() => void run<{ billed: Array<{ number: string; error?: string }> }>('cyc', API, { op: 'cycle_billing', companyId }, (r) => r.billed.length ? `${r.billed.filter((x) => !x.error).length} contract(s) billed${r.billed.some((x) => x.error) ? `, ${r.billed.filter((x) => x.error).length} need attention` : ''}` : 'Nothing is due')}>Run cycle billing</Button>
        </Section>
      )}
    </div>
  );
}

function Availability({ companyId, today, readOnly }: { companyId: string; today: string; readOnly: boolean }) {
  const now = new Date();
  const [q, setQ] = useState({ category: '', from: local(now), to: local(new Date(now.getTime() + 86400000)), all: false });
  const a = useBoard<{ units: AvUnit[]; free: number; total: number }>(`${API}?view=availability&company=${companyId}&start=${encodeURIComponent(iso(q.from))}&end=${encodeURIComponent(iso(q.to))}${q.category ? `&category=${encodeURIComponent(q.category)}` : ''}${q.all ? '&allStores=1' : ''}`);
  const { run, busy, error } = useDo(a.reload);
  const [blk, setBlk] = useState<{ unit: AvUnit; kind: string; from: string; to: string; reason: string } | null>(null);
  const cols: QueueColumn<AvUnit>[] = [
    { id: 'u', header: 'Unit', cell: (r) => <><span className="l1">{r.unit}</span><span className="l2">{[r.category, r.store, r.meter != null && `${qty(r.meter)} h`].filter(Boolean).join(' · ')}</span></> },
    { id: 'f', header: 'In the window', width: 260, cell: (r) => r.free ? <Status kind="ready" pip="open">free</Status> : <span className="l2">{[...r.contracts.map((c) => `${c.number} ${c.status.toLowerCase()}`), ...r.blocks.map((b) => `${b.kind.toLowerCase()}${b.reason ? `: ${b.reason}` : ''}`), r.re_rent_hold ? 're-rent inspection' : null].filter(Boolean).join(' · ')}</span> },
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <div className="ops-toolbar">
        <Field label="Class"><Input value={q.category} onChange={(e) => setQ({ ...q, category: e.target.value })} placeholder="EXCAVATOR" style={{ width: 140 }} /></Field>
        <Field label="From"><Input type="datetime-local" value={q.from} onChange={(e) => setQ({ ...q, from: e.target.value })} /></Field>
        <Field label="To"><Input type="datetime-local" value={q.to} onChange={(e) => setQ({ ...q, to: e.target.value })} /></Field>
        <Field label="Stores"><Select value={q.all ? 'a' : 't'} onChange={(e) => setQ({ ...q, all: e.target.value === 'a' })}><option value="t">This store</option><option value="a">Every store I can see</option></Select></Field>
      </div>
      <BoardState b={a} what="Availability" />
      {a.data && (a.data.units.length === 0 ? <Empty title="No fleet units" body="Units in the rental fleet (condition rental) show here with what books them in the window." /> : (
        <Section title={`${count(a.data.free)} of ${count(a.data.total)} free`} meta={a.data.free === 0 ? 'Fully booked: substitute from another store or block-move a reservation' : undefined}>
          <div className="mp-table"><QueueTable aria-label="Fleet availability" columns={cols} rows={a.data.units} getRowId={(r) => r.unit_id} onOpen={(r) => !readOnly && setBlk({ unit: r, kind: 'MAINTENANCE', from: q.from, to: q.to, reason: '' })} openOnClick rowState={(r) => ({ attn: !r.free })} /></div>
          <p className="t-cap">Open a unit to block it for maintenance or mark it down; a block refuses any booking that overlaps it.</p>
        </Section>
      ))}
      {blk && (
        <Drawer open onClose={() => setBlk(null)} title={`Block ${blk.unit.unit}`}>
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Why"><Select value={blk.kind} onChange={(e) => setBlk({ ...blk, kind: e.target.value })}><option value="MAINTENANCE">Maintenance</option><option value="DOWN">Down for repair</option><option value="HOLD">Hold</option></Select></Field>
            <Field label="From"><Input type="datetime-local" value={blk.from} onChange={(e) => setBlk({ ...blk, from: e.target.value })} /></Field>
            <Field label="To"><Input type="datetime-local" value={blk.to} onChange={(e) => setBlk({ ...blk, to: e.target.value })} /></Field>
            <Field label="Note"><Textarea rows={2} value={blk.reason} onChange={(e) => setBlk({ ...blk, reason: e.target.value })} /></Field>
            <Button variant="primary" disabled={busy === 'blk'} onClick={() => void run('blk', API, { op: 'block', unitId: blk.unit.unit_id, kind: blk.kind, from: iso(blk.from), to: iso(blk.to), reason: blk.reason || null }, 'Unit blocked').then((r) => { if (r) setBlk(null); })}>Block the unit</Button>
            <p className="t-cap">{day(today, today)}: blocks are released from Fleet service when the work is done.</p>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function FleetService({ companyId, today, readOnly }: { companyId: string; today: string; readOnly: boolean }) {
  const due = useBoard<Due[]>(`${API}?view=fleet_due&company=${companyId}`);
  const yard = useBoard<{ rerent_holds: Array<{ id: string; unit: string; since: string }> }>(`/api/dealer/yard?view=board&company=${companyId}`);
  const { run, busy, error } = useDo(() => { due.reload(); yard.reload(); });
  const [rule, setRule] = useState({ label: '', model: '', category: '', hours: '', days: '', est: '2', checklist: '' });
  const [hold, setHold] = useState<{ id: string; unit: string; items: string } | null>(null);
  const cols: QueueColumn<Due>[] = [
    { id: 'u', header: 'Unit', cell: (r) => <><span className="l1">{r.unit}</span><span className="l2">{r.rule}{r.last_done ? ` · last ${day(r.last_done, today)}` : ' · never done'}</span></> },
    { id: 'p', header: 'Used since', numeric: true, width: 150, cell: (r) => <Status kind={Number(r.due_pct) >= 1 ? 'overdue' : r.due ? 'risk' : 'track'} pip="open">{pctText(r.due_pct, 0)}{r.hours_since != null ? ` · ${qty(r.hours_since)} h` : ''}</Status> },
    { id: 'g', header: 'Next gap', width: 170, cell: (r) => r.blocked ? 'Scheduled' : r.next_gap ? day(r.next_gap.from, today) : '—' },
    ...(readOnly ? [] : [{ id: 'a', header: <span className="sr">Schedule</span>, width: 220, cell: (r: Due) => (
      <ButtonRow>
        {!r.blocked && r.next_gap && <Button disabled={busy === r.unit_id + r.rule_id} onClick={() => void run(r.unit_id + r.rule_id, API, { op: 'schedule_pm', unitId: r.unit_id, ruleId: r.rule_id, from: r.next_gap!.from, to: r.next_gap!.to }, 'Scheduled; the unit is blocked and an internal RO is open')}>Schedule</Button>}
        <Button variant="quiet" disabled={busy === r.unit_id + r.rule_id} onClick={() => void run(r.unit_id + r.rule_id, API, { op: 'complete_pm', unitId: r.unit_id, ruleId: r.rule_id, meter: r.meter }, 'Service recorded')}>Done</Button>
      </ButtonRow>) } satisfies QueueColumn<Due>]),
  ];
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {yard.data && yard.data.rerent_holds.length > 0 && (
        <Section title="Waiting for the re-rent inspection" meta="Returned units the store inspects before they go out again">
          {yard.data.rerent_holds.map((h) => <ButtonRow key={h.id}><span className="l1" style={{ minWidth: 260 }}>{h.unit}</span><span className="t-cap">since {day(h.since, today)}</span>{!readOnly && <Button onClick={() => setHold({ id: h.id, unit: h.unit, items: 'Walk-around\nFluids\nGrease\nSafety decals' })}>Inspect</Button>}</ButtonRow>)}
        </Section>
      )}
      <BoardState b={due} what="Fleet service" />
      {due.data && (
        <Section title="Service due" meta="By meter hours since the last service, or days on rent; scheduled into the next gap between bookings">
          {due.data.length === 0 ? <Empty title="No service rules" body="Add a rule below (every 250 hours, every 90 days) for a model or class of fleet units." /> :
            <div className="mp-table"><QueueTable aria-label="Fleet service due" columns={cols} rows={due.data} getRowId={(r) => `${r.unit_id}:${r.rule_id}`} onOpen={() => undefined} rowState={(r) => ({ attn: r.due && !r.blocked })} /></div>}
        </Section>
      )}
      {!readOnly && (
        <Section title="Add a service rule">
          <div className="ops-toolbar">
            <Field label="Service"><Input value={rule.label} onChange={(e) => setRule({ ...rule, label: e.target.value })} placeholder="250-hour service" /></Field>
            <Field label="Model"><Input value={rule.model} onChange={(e) => setRule({ ...rule, model: e.target.value })} style={{ width: 100 }} /></Field>
            <Field label="Class"><Input value={rule.category} onChange={(e) => setRule({ ...rule, category: e.target.value })} style={{ width: 120 }} /></Field>
            <Field label="Every hours"><Input inputMode="decimal" value={rule.hours} onChange={(e) => setRule({ ...rule, hours: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Every days"><Input inputMode="numeric" value={rule.days} onChange={(e) => setRule({ ...rule, days: e.target.value })} style={{ width: 80 }} /></Field>
            <Field label="Takes (h)"><Input inputMode="decimal" value={rule.est} onChange={(e) => setRule({ ...rule, est: e.target.value })} style={{ width: 70 }} /></Field>
          </div>
          <Field label="Checklist (one per line)"><Textarea rows={2} value={rule.checklist} onChange={(e) => setRule({ ...rule, checklist: e.target.value })} /></Field>
          <Button disabled={!rule.label.trim() || (!rule.hours && !rule.days) || busy === 'rule'} onClick={() => void run('rule', API, { op: 'pm_rule', companyId, label: rule.label.trim(), model: rule.model || null, category: rule.category || null, everyHours: rule.hours ? Number(rule.hours) : null, everyDays: rule.days ? Number(rule.days) : null, estHours: Number(rule.est) || 2, checklist: rule.checklist.split('\n').map((s) => s.trim()).filter(Boolean) }, 'Rule saved')}>Save the rule</Button>
        </Section>
      )}
      {hold && (
        <Drawer open onClose={() => setHold(null)} title={`Re-rent inspection: ${hold.unit}`}>
          <div className="stack" style={{ padding: 16 }}>
            <Field label="Checked (one per line)"><Textarea rows={5} value={hold.items} onChange={(e) => setHold({ ...hold, items: e.target.value })} /></Field>
            <Button variant="primary" disabled={busy === 'hold'} onClick={() => void run('hold', API, { op: 'clear_rerent', holdId: hold.id, checklist: hold.items.split('\n').map((s) => s.trim()).filter(Boolean).map((item) => ({ item, ok: true })) }, 'Cleared for re-rent').then((r) => { if (r) setHold(null); })}>Everything passed</Button>
          </div>
        </Drawer>
      )}
    </div>
  );
}

function Rates({ companyId, readOnly }: { companyId: string; readOnly: boolean }) {
  const cfg = useBoard<{ rental_rates: Rate[] }>(`/api/dealer/store-desk?view=config&company=${companyId}`);
  const { run, busy, error } = useDo(cfg.reload);
  const [ed, setEd] = useState<Record<string, { hour: string; half: string; minH: string; minC: string; acc: string }>>({});
  const v = (r: Rate) => ed[r.id] ?? { hour: r.ext?.hour_cents != null ? (r.ext.hour_cents / 100).toFixed(2) : '', half: r.ext?.half_day_cents != null ? (r.ext.half_day_cents / 100).toFixed(2) : '', minH: r.ext?.min_hours != null ? String(r.ext.min_hours) : '', minC: r.ext?.min_charge_cents != null ? (r.ext.min_charge_cents / 100).toFixed(2) : '', acc: (r.ext?.accessories ?? []).map((a) => `${a.code} ${a.label} ${(a.day_cents / 100).toFixed(2)}`).join('\n') };
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      <BoardState b={cfg} what="Rates" />
      {cfg.data && (cfg.data.rental_rates.length === 0 ? <Empty title="No rental rates" body="Add day / week / month rates on Rentals; hour, half-day, minimums and accessories are added here." /> : cfg.data.rental_rates.map((r) => (
        <Section key={r.id} title={r.label ?? r.model ?? r.category ?? 'Rate'} meta={`${m(r.day_cents)} day · ${m(r.week_cents)} week · ${m(r.month_cents)} 4 weeks`}>
          <div className="ops-toolbar">
            <Field label="Hour ($)"><Input inputMode="decimal" disabled={readOnly} value={v(r).hour} onChange={(e) => setEd({ ...ed, [r.id]: { ...v(r), hour: e.target.value } })} style={{ width: 90 }} /></Field>
            <Field label="Half day ($)"><Input inputMode="decimal" disabled={readOnly} value={v(r).half} onChange={(e) => setEd({ ...ed, [r.id]: { ...v(r), half: e.target.value } })} style={{ width: 90 }} /></Field>
            <Field label="Minimum hours"><Input inputMode="decimal" disabled={readOnly} value={v(r).minH} onChange={(e) => setEd({ ...ed, [r.id]: { ...v(r), minH: e.target.value } })} style={{ width: 80 }} /></Field>
            <Field label="Minimum charge ($)"><Input inputMode="decimal" disabled={readOnly} value={v(r).minC} onChange={(e) => setEd({ ...ed, [r.id]: { ...v(r), minC: e.target.value } })} style={{ width: 100 }} /></Field>
          </div>
          <Field label="Accessories (CODE label price-per-day, one per line)"><Textarea rows={2} disabled={readOnly} value={v(r).acc} onChange={(e) => setEd({ ...ed, [r.id]: { ...v(r), acc: e.target.value } })} placeholder="BKT Ditch bucket 25.00" /></Field>
          {!readOnly && <Button disabled={busy === r.id} onClick={() => {
            const accessories = v(r).acc.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const parts = l.split(/\s+/); const price = parts.pop() ?? '0'; const code = (parts.shift() ?? '').toUpperCase(); return { code, label: parts.join(' ') || code, day_cents: centsFrom(price) ?? 0 }; }).filter((a) => /^[A-Z0-9_-]{1,16}$/.test(a.code));
            void run(r.id, API, { op: 'rate_ext', rateId: r.id, hourCents: centsFrom(v(r).hour), halfDayCents: centsFrom(v(r).half), minHours: v(r).minH ? Number(v(r).minH) : null, minChargeCents: centsFrom(v(r).minC), accessories }, 'Rates saved');
          }}>Save</Button>}
        </Section>
      )))}
    </div>
  );
}

