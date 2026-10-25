'use client';

import { useState } from 'react';
import { Button, Check, Field, InlineNotice, Input, Select, Status } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard, useDo } from '@/components/dealer/common/depth';

interface Installer { id: string; name: string; worker_type: 'W2' | '1099'; crew_id: string | null; skills: string[]; coi_expires_on: string | null; workers_comp_expires_on: string | null;
  w9_on_file: boolean; license_expires_on: string | null; status: string; blockers: string[]; expiring_in_30: boolean }
interface PickRow { id: string; label: string }
interface Draft { name: string; type: 'W2' | '1099'; vendorId: string; employeeId: string; crewId: string; skills: string; coi: string; wc: string; license: string; w9: boolean }
const EMPTY: Draft = { name: '', type: '1099', vendorId: '', employeeId: '', crewId: '', skills: '', coi: '', wc: '', license: '', w9: false };

/** Installer roster and compliance (FLR-32): COI, workers' comp, W-9, license; anyone with a blocker cannot be booked. Install confirmations go out from here too (FLR-31). */
export function InstallersView({ companyId, today, vendors, employees, crews }: { companyId: string; today: string; vendors: PickRow[]; employees: PickRow[]; crews: PickRow[] }) {
  const { readOnly } = useShell();
  const url = '/api/flooring/ops';
  const b = useBoard<{ installers: Installer[] }>(`${url}?company=${companyId}&view=installers`);
  const { run, busy, error } = useDo(b.reload);
  const [d, setD] = useState<Draft>(EMPTY);
  const [edit, setEdit] = useState<string | null>(null);
  const linkOk = d.type === '1099' ? !!d.vendorId : !!d.employeeId;
  const save = async () => {
    const fields: Record<string, unknown> = { name: d.name.trim(), worker_type: d.type, crew_id: d.crewId || null,
      skills: d.skills.split(',').map((s) => s.trim()).filter(Boolean), coi_expires_on: d.coi || null, workers_comp_expires_on: d.wc || null, license_expires_on: d.license || null, w9_on_file: d.w9 };
    // the link is only sent when picked, so an edit keeps the vendor / employee already on file
    if (d.type === '1099' && d.vendorId) fields.vendor_id = d.vendorId;
    if (d.type === 'W2' && d.employeeId) fields.employee_id = d.employeeId;
    const r = await run('save', url, { op: 'installer', companyId, installerId: edit, fields }, edit ? 'Saved' : 'Installer added');
    if (r) { setD(EMPTY); setEdit(null); }
  };
  const state = <BoardState b={b} what="Installers" />;
  if (!b.data) return state;
  const blocked = b.data.installers.filter((i) => i.blockers.length > 0);
  const crewName = (id: string | null) => crews.find((c) => c.id === id)?.label ?? '—';
  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {blocked.length > 0 && <InlineNotice tone="warn" title={`${blocked.length} installer(s) cannot be booked.`}>{blocked.map((i) => `${i.name}: ${i.blockers.join(', ')}`).join(' · ')}</InlineNotice>}
      {!readOnly && <span className="btn-row"><Button disabled={busy === 'cf'} onClick={() => run('cf', url, { op: 'confirmations', companyId, daysAhead: 2 }, (r: { sent: number }) => `${r.sent} confirmation(s) queued`)}>Send install confirmations (next 2 days)</Button></span>}
      {b.data.installers.length === 0 ? <Empty title="No installers yet" body="Add each installer with their COI, workers' comp, W-9 and license dates; bookings check them before a crew is scheduled." /> :
        <table className="ops-mini" aria-label="Installers"><thead><tr><th>Installer</th><th>Crew</th><th>COI</th><th>Workers’ comp</th><th>W-9</th><th>License</th><th>Bookable</th><th /></tr></thead>
          <tbody>{b.data.installers.map((i) => <tr key={i.id}><td>{i.name} <span className="l2">{i.worker_type}{i.skills.length ? ` · ${i.skills.join(', ')}` : ''}</span></td><td>{crewName(i.crew_id)}</td>
            <td>{day(i.coi_expires_on, today)}</td><td>{day(i.workers_comp_expires_on, today)}</td><td>{i.w9_on_file ? 'on file' : 'missing'}</td><td>{day(i.license_expires_on, today)}</td>
            <td>{i.blockers.length ? <Status kind="blocked" pip="closed">{i.blockers[0]}</Status> : i.expiring_in_30 ? <Status kind="risk" pip="risk">Expiring</Status> : <Status kind="ready" pip="ready">Yes</Status>}</td>
            <td>{!readOnly && <Button variant="quiet" onClick={() => { setEdit(i.id); setD({ ...EMPTY, name: i.name, type: i.worker_type, crewId: i.crew_id ?? '', skills: i.skills.join(', '), coi: i.coi_expires_on ?? '', wc: i.workers_comp_expires_on ?? '', license: i.license_expires_on ?? '', w9: i.w9_on_file }); }}>Edit</Button>}</td></tr>)}</tbody></table>}
      {!readOnly && (
        <Section title={edit ? 'Edit installer' : 'Add an installer'} actions={edit ? <Button variant="quiet" onClick={() => { setEdit(null); setD(EMPTY); }}>Cancel</Button> : null}>
          <div className="ops-toolbar">
            <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
            <Field label="Type"><Select value={d.type} onChange={(e) => setD({ ...d, type: e.target.value as Draft['type'] })}><option value="1099">1099 (a vendor)</option><option value="W2">W-2 (an employee)</option></Select></Field>
            {d.type === '1099' ? <Field label="Vendor record" error={!d.vendorId && edit == null && d.name ? 'Pick the vendor they are paid as' : undefined}><Select value={d.vendorId} onChange={(e) => setD({ ...d, vendorId: e.target.value })}><option value="">Pick</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></Field>
              : <Field label="Employee"><Select value={d.employeeId} onChange={(e) => setD({ ...d, employeeId: e.target.value })}><option value="">Pick</option>{employees.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}</Select></Field>}
            <Field label="Crew"><Select value={d.crewId} onChange={(e) => setD({ ...d, crewId: e.target.value })}><option value="">None</option>{crews.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
            <Field label="Skills" help="Comma separated"><Input value={d.skills} onChange={(e) => setD({ ...d, skills: e.target.value })} placeholder="carpet, LVP, tile" /></Field>
          </div>
          <div className="ops-toolbar">
            <Field label="COI expires"><Input type="date" value={d.coi} onChange={(e) => setD({ ...d, coi: e.target.value })} /></Field>
            <Field label="Workers’ comp expires"><Input type="date" value={d.wc} onChange={(e) => setD({ ...d, wc: e.target.value })} /></Field>
            <Field label="License expires"><Input type="date" value={d.license} onChange={(e) => setD({ ...d, license: e.target.value })} /></Field>
            <Check checked={d.w9} onChange={(e) => setD({ ...d, w9: e.target.checked })} label="W-9 on file" />
            <Button variant="primary" disabled={!d.name.trim() || (edit == null && !linkOk) || busy === 'save'} onClick={save}>{edit ? 'Save' : 'Add installer'}</Button>
          </div>
        </Section>
      )}
    </div>
  );
}
