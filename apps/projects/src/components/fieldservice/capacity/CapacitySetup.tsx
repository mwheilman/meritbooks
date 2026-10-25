'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Check, Field, InlineNotice, Input, Select, Tabs, WidgetState, api, count, shortDate, toast } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import type { BookingSetup } from '@/lib/fieldservice/queries';
import type { CapacityLimitRow, OnCallRow, TechEventRow } from '@/lib/fieldservice/types';
import type { EmployeeRow } from '@/lib/pm/ops/types';
import { stamp } from '@/lib/time';

type Tab = 'capacity' | 'zones' | 'windows' | 'techs' | 'blocks' | 'online';
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export interface CapacitySetupProps {
  companyId: string;
  today: string;
  setup: BookingSetup;
  limits: CapacityLimitRow[];
  employees: EmployeeRow[];
  profiles: Array<{ employee_id: string; display_name: string | null; zone_ids: string[]; business_unit_ids: string[]; is_dispatchable: boolean; is_comfort_advisor: boolean }>;
  events: TechEventRow[];
  onCall: OnCallRow[];
  canEdit: boolean;
  canWidgets: boolean;
}

/** Capacity, zones, arrival windows, technician profiles, on-call and blocks, online booking links (FS-09/15/16/18). */
export function CapacitySetup(p: CapacitySetupProps) {
  const { readOnly } = useShell();
  const edit = p.canEdit && !readOnly;
  const [tab, setTab] = useState<Tab>('capacity');
  const items: Array<{ value: Tab; label: string; count?: string }> = [
    { value: 'capacity', label: 'Capacity' }, { value: 'zones', label: 'Zones', count: count(p.setup.zones.length) },
    { value: 'windows', label: 'Arrival windows', count: count(p.setup.windows.length) }, { value: 'techs', label: 'Technicians' },
    { value: 'blocks', label: 'On call and time off' }, ...(p.canWidgets ? [{ value: 'online' as const, label: 'Online booking' }] : []),
  ];
  return (
    <div className="stack">
      <Tabs aria-label="Dispatch setup" items={items} value={tab} onChange={setTab} />
      {!edit && <InlineNotice tone="info" title="Read only.">Changing capacity, zones and windows needs dispatch edit at this company.</InlineNotice>}
      {tab === 'capacity' && <Limits {...p} edit={edit} />}
      {tab === 'zones' && <Zones {...p} edit={edit} />}
      {tab === 'windows' && <Windows {...p} edit={edit} />}
      {tab === 'techs' && <Techs {...p} edit={edit} />}
      {tab === 'blocks' && <Blocks {...p} edit={edit} />}
      {tab === 'online' && <Online {...p} edit={!readOnly} />}
    </div>
  );
}

function useSave() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (url: string, body: unknown, ok: string) => {
    setBusy(true); setErr(null);
    const r = await api.post(url, body);
    setBusy(false);
    if (r.error) { setErr(r.error.error); return false; }
    toast(ok); router.refresh();
    return true;
  };
  return { busy, err, run };
}

function Limits(p: CapacitySetupProps & { edit: boolean }) {
  const [bu, setBu] = useState(p.setup.businessUnits[0]?.id ?? '');
  const windows = p.setup.windows.filter((w) => w.is_active);
  const base = useMemo(() => {
    const m: Record<string, string> = {};
    for (const l of p.limits) if (l.business_unit_id === bu && !l.zone_id && !l.on_date) m[`${l.arrival_window_id}|${l.day_of_week ?? 0}`] = l.max_jobs == null ? '' : String(l.max_jobs);
    return m;
  }, [p.limits, bu]);
  const [vals, setVals] = useState<Record<string, string>>(base);
  const [buShown, setBuShown] = useState(bu);
  if (buShown !== bu) { setBuShown(bu); setVals(base); }
  const [ovDate, setOvDate] = useState(p.today);
  const [ovWin, setOvWin] = useState(windows[0]?.id ?? '');
  const [ovMax, setOvMax] = useState('0');
  const s = useSave();
  const overrides = p.limits.filter((l) => l.business_unit_id === bu && l.on_date).sort((a, b) => (a.on_date! < b.on_date! ? -1 : 1));
  async function save() {
    const limits = Object.entries(vals).filter(([, v]) => v.trim() !== '' && /^\d{1,3}$/.test(v.trim())).map(([k, v]) => {
      const [win, d] = k.split('|');
      return { businessUnitId: bu, arrivalWindowId: win!, dayOfWeek: d === '0' ? null : Number(d), maxJobs: Number(v) };
    });
    if (!limits.length) return;
    await s.run('/api/fieldservice/capacity/limits', { op: 'upsert', companyId: p.companyId, limits }, `Saved ${limits.length} limit(s)`);
  }
  if (!p.setup.businessUnits.length || !windows.length) return <WidgetState state={{ kind: 'empty', title: 'Add business units and arrival windows first', body: 'The starter setup on the price book adds both.' }} />;
  return (
    <div className="stack">
      <div className="fs-toolbar">
        <Field label="Business unit"><Select value={bu} onChange={(e) => setBu(e.target.value)}>{p.setup.businessUnits.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <span className="sp" />
        {p.edit && <Button variant="primary" disabled={s.busy} onClick={() => void save()}>Save capacity</Button>}
      </div>
      <p className="t-cap">Jobs per arrival window. “Every day” applies unless a weekday says otherwise; a date override beats both. Blank = no limit (online booking stays closed for that window).</p>
      <section className="fs-card fs-scroll">
        <table className="fs-table">
          <thead><tr><th>Window</th><th className="n">Every day</th>{DOW.map((d) => <th key={d} className="n">{d}</th>)}</tr></thead>
          <tbody>
            {windows.map((w) => (
              <tr key={w.id}>
                <td>{w.label}{w.is_after_hours ? ' · after hours' : ''}</td>
                {[0, 1, 2, 3, 4, 5, 6, 7].map((d) => (
                  <td key={d} className="n">
                    {d === 0 || w.days_of_week.includes(d) ? (
                      <Input aria-label={`${w.label} ${d === 0 ? 'every day' : DOW[d - 1]}`} inputMode="numeric" style={{ width: 56 }} disabled={!p.edit}
                        value={vals[`${w.id}|${d}`] ?? ''} onChange={(e) => setVals({ ...vals, [`${w.id}|${d}`]: e.target.value.replace(/\D/g, '').slice(0, 3) })} />
                    ) : <span className="fs-muted">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="fs-card">
        <div className="fs-card-h"><h2 className="t-section">Date overrides</h2><span className="sp" /><span className="t-cap">Holidays, storm days, training days</span></div>
        <ul className="fs-list">
          {overrides.length === 0 && <li><span className="t-cap">None.</span></li>}
          {overrides.map((l) => (
            <li key={l.id}>
              <span>{shortDate(l.on_date!, p.today)} · {windows.find((w) => w.id === l.arrival_window_id)?.label ?? 'Window'} · {l.max_jobs == null ? `${l.max_minutes} min` : `${l.max_jobs} job(s)`}</span>
              <span className="sp" />
              {p.edit && <Button variant="quiet" onClick={() => void s.run('/api/fieldservice/capacity/limits', { op: 'delete', companyId: p.companyId, id: l.id }, 'Removed the override')}>Remove</Button>}
            </li>
          ))}
        </ul>
        {p.edit && (
          <div className="fs-card-b row" style={{ gap: 8, alignItems: 'end' }}>
            <Field label="Date"><Input type="date" value={ovDate} min={p.today} onChange={(e) => setOvDate(e.target.value)} /></Field>
            <Field label="Window"><Select value={ovWin} onChange={(e) => setOvWin(e.target.value)}>{windows.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}</Select></Field>
            <Field label="Jobs"><Input inputMode="numeric" style={{ width: 64 }} value={ovMax} onChange={(e) => setOvMax(e.target.value.replace(/\D/g, '').slice(0, 3))} /></Field>
            <Button disabled={s.busy || ovMax === ''} onClick={() => void s.run('/api/fieldservice/capacity/limits', { op: 'upsert', companyId: p.companyId, limits: [{ businessUnitId: bu, arrivalWindowId: ovWin, onDate: ovDate, maxJobs: Number(ovMax) }] }, 'Added the override')}>Add override</Button>
          </div>
        )}
      </section>
      {s.err && <InlineNotice tone="neg" title="Not saved.">{s.err}</InlineNotice>}
    </div>
  );
}

function Zones(p: CapacitySetupProps & { edit: boolean }) {
  const s = useSave();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [zips, setZips] = useState('');
  const parse = (t: string) => [...new Set(t.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
  return (
    <div className="stack">
      {p.setup.zones.length === 0 && <WidgetState state={{ kind: 'empty', title: 'No zones yet', body: 'Zones are lists of zip codes. The call desk finds the zone from the caller’s zip; capacity and technician eligibility can be set per zone.' }} />}
      {p.setup.zones.map((z) => <ZoneRowEdit key={z.id} zone={z} companyId={p.companyId} edit={p.edit} />)}
      {p.edit && (
        <section className="fs-card">
          <div className="fs-card-h"><h2 className="t-section">Add a zone</h2></div>
          <div className="fs-card-b fs-form">
            <Field label="Code"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={24} /></Field>
            <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
            <div className="fs-span"><Field label="Zip codes" help={`${parse(zips).length} zip(s)`}><Input value={zips} onChange={(e) => setZips(e.target.value)} placeholder="50310, 50311, 50312" /></Field></div>
            <Button disabled={s.busy || !code || !name} onClick={() => void s.run('/api/fieldservice/capacity/limits', { op: 'zone', companyId: p.companyId, code, name, zips: parse(zips) }, `Added zone ${code}`).then((ok) => { if (ok) { setCode(''); setName(''); setZips(''); } })}>Add zone</Button>
          </div>
        </section>
      )}
      {s.err && <InlineNotice tone="neg" title="Not saved.">{s.err}</InlineNotice>}
    </div>
  );
}

function ZoneRowEdit({ zone, companyId, edit }: { zone: BookingSetup['zones'][number]; companyId: string; edit: boolean }) {
  const s = useSave();
  const [zips, setZips] = useState(zone.zips.join(', '));
  const parse = (t: string) => [...new Set(t.split(/[\s,;]+/).map((x) => x.trim()).filter((x) => /^\d{5}$/.test(x)))];
  return (
    <section className="fs-card">
      <div className="fs-card-h"><span className="t-head">{zone.name}</span><span className="code">{zone.code}</span><span className="sp" /><span className="t-cap">{count(zone.zips.length)} zip(s)</span></div>
      <div className="fs-card-b row" style={{ gap: 8, alignItems: 'end' }}>
        <Field label="Zip codes"><Input value={zips} onChange={(e) => setZips(e.target.value)} disabled={!edit} style={{ width: 520 }} /></Field>
        {edit && <Button disabled={s.busy} onClick={() => void s.run('/api/fieldservice/capacity/limits', { op: 'zone', companyId, id: zone.id, code: zone.code, name: zone.name, zips: parse(zips) }, `Saved ${zone.name}`)}>Save</Button>}
      </div>
      {s.err && <InlineNotice tone="neg" title="Not saved.">{s.err}</InlineNotice>}
    </section>
  );
}

function Windows(p: CapacitySetupProps & { edit: boolean }) {
  const s = useSave();
  const [label, setLabel] = useState('');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('10:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [after, setAfter] = useState(false);
  return (
    <div className="stack">
      <section className="fs-card">
        <table className="fs-table">
          <thead><tr><th>Window</th><th>Time</th><th>Days</th><th>Online</th></tr></thead>
          <tbody>{p.setup.windows.map((w) => <tr key={w.id}><td>{w.label}{w.is_after_hours ? ' · after hours' : ''}</td><td className="tnum">{w.start_time.slice(0, 5)}–{w.end_time.slice(0, 5)}</td><td>{w.days_of_week.map((d) => DOW[d - 1]).join(' ')}</td><td>{w.online ? 'Yes' : 'No'}</td></tr>)}</tbody>
        </table>
      </section>
      {p.edit && (
        <section className="fs-card">
          <div className="fs-card-h"><h2 className="t-section">Add a window</h2></div>
          <div className="fs-card-b fs-form">
            <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={40} placeholder="8–12 am" /></Field>
            <div className="row" style={{ gap: 8 }}>
              <Field label="Starts"><Input type="time" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
              <Field label="Ends"><Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
            </div>
            <div className="fs-span row" style={{ gap: 12 }}>{DOW.map((d, i) => <Check key={d} label={d} checked={days.includes(i + 1)} onChange={(e) => setDays(e.target.checked ? [...days, i + 1] : days.filter((x) => x !== i + 1))} />)}</div>
            <Check label="After hours (after-hours fee and prices apply)" checked={after} onChange={(e) => setAfter(e.target.checked)} />
            <Button disabled={s.busy || !label || !days.length} onClick={() => void s.run('/api/fieldservice/capacity/limits', { op: 'window', companyId: p.companyId, label, startTime: start, endTime: end, daysOfWeek: days, isAfterHours: after, online: !after }, `Added ${label}`)}>Add window</Button>
          </div>
        </section>
      )}
      {s.err && <InlineNotice tone="neg" title="Not saved.">{s.err}</InlineNotice>}
    </div>
  );
}

function Techs(p: CapacitySetupProps & { edit: boolean }) {
  const prof = new Map(p.profiles.map((x) => [x.employee_id, x]));
  if (!p.employees.length) return <WidgetState state={{ kind: 'empty', title: 'No employees yet', body: 'Employees come from Books payroll / the people list.' }} />;
  return (
    <section className="fs-card fs-scroll">
      <table className="fs-table">
        <thead><tr><th>Technician</th><th>Name in texts</th><th>Zones</th><th>Business units</th><th>Dispatchable</th><th /></tr></thead>
        <tbody>{p.employees.map((e) => <TechRow key={e.id} e={e} profile={prof.get(e.id) ?? null} {...p} />)}</tbody>
      </table>
    </section>
  );
}

function TechRow({ e, profile, setup, companyId, edit }: CapacitySetupProps & { e: EmployeeRow; profile: CapacitySetupProps['profiles'][number] | null; edit: boolean }) {
  const s = useSave();
  const [name, setName] = useState(profile?.display_name ?? e.first_name ?? '');
  const [zones, setZones] = useState<string[]>(profile?.zone_ids ?? []);
  const [bus, setBus] = useState<string[]>(profile?.business_unit_ids ?? []);
  const [disp, setDisp] = useState(profile?.is_dispatchable ?? true);
  return (
    <tr>
      <td>{[e.first_name, e.last_name].filter(Boolean).join(' ')}</td>
      <td><Input aria-label="Name customers see" value={name} onChange={(x) => setName(x.target.value)} disabled={!edit} style={{ width: 120 }} /></td>
      <td>{setup.zones.map((z) => <Check key={z.id} label={z.code} checked={zones.includes(z.id)} disabled={!edit} onChange={(x) => setZones(x.target.checked ? [...zones, z.id] : zones.filter((y) => y !== z.id))} />)}</td>
      <td>{setup.businessUnits.map((b) => <Check key={b.id} label={b.code} checked={bus.includes(b.id)} disabled={!edit} onChange={(x) => setBus(x.target.checked ? [...bus, b.id] : bus.filter((y) => y !== b.id))} />)}</td>
      <td><Check aria-label="Dispatchable" checked={disp} disabled={!edit} onChange={(x) => setDisp(x.target.checked)} /></td>
      <td>{edit && <Button disabled={s.busy} onClick={() => void s.run('/api/fieldservice/dispatch/events', { op: 'profile', companyId, employeeId: e.id, displayName: name || null, zoneIds: zones, businessUnitIds: bus, isDispatchable: disp }, 'Saved the technician')}>Save</Button>}{s.err && <span className="t-cap neg">{s.err}</span>}</td>
    </tr>
  );
}

function Blocks(p: CapacitySetupProps & { edit: boolean }) {
  const s = useSave();
  const [emp, setEmp] = useState(p.employees[0]?.id ?? '');
  const [kind, setKind] = useState<'PTO' | 'TRAINING' | 'MEETING' | 'SHOP' | 'OTHER' | 'ON_CALL'>('PTO');
  const [start, setStart] = useState(`${p.today}T08:00`);
  const [end, setEnd] = useState(`${p.today}T17:00`);
  const name = new Map(p.employees.map((e) => [e.id, [e.first_name, e.last_name].filter(Boolean).join(' ')]));
  const iso = (local: string) => new Date(local).toISOString();
  async function add() {
    if (kind === 'ON_CALL') await s.run('/api/fieldservice/dispatch/events', { op: 'on_call', companyId: p.companyId, employeeId: emp, start: iso(start), end: iso(end) }, 'Added the on-call shift');
    else await s.run('/api/fieldservice/dispatch/events', { op: 'block', companyId: p.companyId, employeeId: emp, kind, start: iso(start), end: iso(end) }, 'Blocked the time');
  }
  return (
    <div className="stack">
      {p.edit && (
        <div className="fs-toolbar">
          <Field label="Technician"><Select value={emp} onChange={(e) => setEmp(e.target.value)}>{p.employees.map((e) => <option key={e.id} value={e.id}>{name.get(e.id)}</option>)}</Select></Field>
          <Field label="What"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}><option value="PTO">Time off</option><option value="TRAINING">Training</option><option value="MEETING">Meeting</option><option value="SHOP">Shop time</option><option value="OTHER">Other block</option><option value="ON_CALL">On call</option></Select></Field>
          <Field label="From"><Input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="To"><Input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
          <Button variant="primary" disabled={s.busy || !emp || end <= start} onClick={() => void add()}>Add</Button>
        </div>
      )}
      {s.err && <InlineNotice tone="neg" title="Not saved.">{s.err}</InlineNotice>}
      <section className="fs-card">
        <div className="fs-card-h"><h2 className="t-section">On call</h2></div>
        <ul className="fs-list">
          {p.onCall.length === 0 && <li><span className="t-cap">Nobody on call in the next two weeks.</span></li>}
          {p.onCall.map((x) => <li key={x.id}><span>{name.get(x.employee_id) ?? 'Technician'} · {x.role === 'PRIMARY' ? 'primary' : 'backup'}</span><span className="sp" /><span className="t-cap">{stamp(x.starts_at)} – {stamp(x.ends_at)}</span>{p.edit && <Button variant="quiet" onClick={() => void s.run('/api/fieldservice/dispatch/events', { op: 'off_call', id: x.id }, 'Removed the shift')}>Remove</Button>}</li>)}
        </ul>
      </section>
      <section className="fs-card">
        <div className="fs-card-h"><h2 className="t-section">Time off and blocks</h2><span className="sp" /><span className="t-cap">Dispatch over a block is refused</span></div>
        <ul className="fs-list">
          {p.events.length === 0 && <li><span className="t-cap">No blocks in the next two weeks.</span></li>}
          {p.events.map((x) => {
            const [a, b] = x.slot.replace(/[[\]()"]/g, '').split(',');
            return <li key={x.id}><span>{name.get(x.employee_id) ?? 'Technician'} · {x.kind.toLowerCase().replace('_', ' ')}</span><span className="sp" /><span className="t-cap">{a ? stamp(a) : ''} – {b ? stamp(b) : ''}</span>{p.edit && <Button variant="quiet" onClick={() => void s.run('/api/fieldservice/dispatch/events', { op: 'unblock', id: x.id }, 'Removed the block')}>Remove</Button>}</li>;
          })}
        </ul>
      </section>
    </div>
  );
}

function Online(p: CapacitySetupProps & { edit: boolean }) {
  const [name, setName] = useState('Website');
  const [campaign, setCampaign] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function create() {
    setBusy(true); setErr(null);
    const r = await api.post<{ token: string; embedPath: string }>('/api/fieldservice/widgets', { op: 'create', companyId: p.companyId, name, campaignId: campaign || null });
    setBusy(false);
    if (r.error) { setErr(r.error.error); return; }
    setLink(`${window.location.origin}${r.data?.embedPath ?? ''}`);
  }
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <p className="t-ui">A booking link lets customers pick a job type and an open arrival window on your website. It books into the same capacity as the call desk and lands in the requests inbox holding the slot; a CSR converts it.</p>
      <div className="fs-form">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
        <Field label="Campaign"><Select value={campaign} onChange={(e) => setCampaign(e.target.value)}><option value="">Website (unattributed)</option>{p.setup.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      </div>
      <Button variant="primary" disabled={busy || !p.edit || !name} onClick={() => void create()}>Create booking link</Button>
      {link && <InlineNotice tone="info" title="Copy this now — it is shown once.">Availability: <code>{link}</code>. POST bookings to the same address. Keep it out of public code repositories.</InlineNotice>}
      {err && <InlineNotice tone="neg" title="Not created.">{err}</InlineNotice>}
    </div>
  );
}
