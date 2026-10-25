'use client';

import { useState } from 'react';
import { Button, Check, Field, Input, KV, Select, Tag, Textarea, shortDate } from '@meritbooks/merit-ui';
import type { HomeWorkspace } from '@/lib/residential/queries';
import type { InspectionRow, PermitRow, ProtectionCheckRow } from '@/lib/residential/types';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { useOps } from '@/components/ops/common/useOps';

const PROFILE_FIELDS = [
  ['lockboxCode', 'lockbox_code', 'Lockbox code'], ['alarmCode', 'alarm_code', 'Alarm code'], ['garageCode', 'garage_code', 'Garage code'], ['gateCode', 'gate_code', 'Gate code'],
  ['pets', 'pets', 'Pets'], ['children', 'children', 'Children at home'], ['workHours', 'work_hours', 'Allowed work hours'], ['parking', 'parking', 'Parking'],
  ['offLimits', 'off_limits', 'Off-limits rooms'], ['utilityNotice', 'utility_notice', 'Utility shut-off notice'], ['tempKitchen', 'temp_kitchen', 'Temporary kitchen'],
  ['bathroomForCrew', 'bathroom_for_crew', 'Bathroom for the crew'],
] as const;

export function HomeProfilePanel({ bundle: b, canEdit }: { bundle: HomeWorkspace; canEdit: boolean }) {
  const { readOnly } = useShell();
  const edit = canEdit && !readOnly;
  const { act, busy, error } = useOps();
  const jobUrl = `/api/residential/jobs/${b.job!.id}`;
  const p = b.profile;
  const [f, setF] = useState<Record<string, string>>(() => Object.fromEntries(PROFILE_FIELDS.map(([k, col]) => [k, (p?.[col] as string | null) ?? ''])));
  const [occupied, setOccupied] = useState(p?.occupied ?? true);
  const [year, setYear] = useState(p?.year_built ? String(p.year_built) : '');
  const [notes, setNotes] = useState(p?.notes ?? '');
  const saveProfile = () => void act('profile', 'post', jobUrl, {
    op: 'profile', occupied, yearBuilt: /^\d{4}$/.test(year) ? Number(year) : null, notes: notes.trim() || null,
    ...Object.fromEntries(PROFILE_FIELDS.map(([k]) => [k, f[k]?.trim() || null])),
  }, 'Home profile saved');
  const r = b.rrp;
  const [renovator, setRenovator] = useState(r?.renovator_name ?? '');
  const [cert, setCert] = useState(r?.renovator_cert_number ?? '');
  const [certExp, setCertExp] = useState(r?.renovator_cert_expires_on ?? '');
  const [ack, setAck] = useState(r?.pamphlet_ack_name ?? '');
  const [card, setCard] = useState<'' | 'PASS' | 'FAIL' | 'RECLEAN_PASS'>(r?.cleaning_card_result ?? '');
  const saveRrp = (extra: Record<string, unknown> = {}) => void act('rrp', 'post', jobUrl, {
    op: 'rrp', renovatorName: renovator.trim() || null, renovatorCertNumber: cert.trim() || null, renovatorCertExpiresOn: certExp || null, pamphletAckName: ack.trim() || null,
    cleaningCardResult: card || null, ...extra,
  }, 'RRP record saved');
  const [member, setMember] = useState({ name: '', email: '', phone: '', relation: 'SPOUSE', canSign: true, canPay: true });

  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Living in the home" meta="Shown to the crew on site; codes are hidden from the homeowner portal" actions={edit ? <Button variant="primary" disabled={busy === 'profile'} onClick={saveProfile}>Save</Button> : undefined}>
        <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0 }} className="mp-form">
          <div className="mp-form-2">
            <Check checked={occupied} onChange={(e) => setOccupied(e.target.checked)} label="The family lives here during the work" />
            <Field label="Year built" help="Before 1978 needs a lead-safe (RRP) record"><Input inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value)} maxLength={4} /></Field>
          </div>
          <div className="mp-form-2">
            {PROFILE_FIELDS.map(([k, , label]) => <Field key={k} label={label}><Input value={f[k] ?? ''} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} maxLength={k.endsWith('Code') ? 40 : 500} /></Field>)}
          </div>
          <Field label="Notes"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={4000} /></Field>
        </fieldset>
      </Section>

      {r && r.status !== 'NOT_REQUIRED' && (
        <Section title="Lead-safe work (EPA RRP)" meta={r.status === 'COMPLETE' ? `Complete · keep until ${r.retain_until ? shortDate(r.retain_until) : '3 years'}` : 'Built before 1978: certified renovator, pamphlet, containment, cleaning verification'}
          actions={edit ? <Button variant="primary" disabled={busy === 'rrp'} onClick={() => saveRrp()}>Save</Button> : undefined}>
          <fieldset disabled={!edit} style={{ border: 0, padding: 0, margin: 0 }} className="mp-form">
            <div className="mp-form-2">
              <Field label="Certified renovator"><Input value={renovator} onChange={(e) => setRenovator(e.target.value)} maxLength={200} /></Field>
              <Field label="Certificate number"><Input value={cert} onChange={(e) => setCert(e.target.value)} maxLength={60} /></Field>
              <Field label="Certificate expires"><Input type="date" value={certExp} onChange={(e) => setCertExp(e.target.value)} /></Field>
              <Field label="Pamphlet received by"><Input value={ack} onChange={(e) => setAck(e.target.value)} maxLength={200} /></Field>
            </div>
            <KV items={[
              { term: 'Pamphlet acknowledged', value: r.pamphlet_ack_at ? shortDate(r.pamphlet_ack_at.slice(0, 10)) : '—' },
              { term: 'Containment verified', value: r.containment_verified_at ? shortDate(r.containment_verified_at.slice(0, 10)) : '—' },
              { term: 'Cleaning verified', value: r.cleaning_verified_at ? shortDate(r.cleaning_verified_at.slice(0, 10)) : '—' },
            ]} />
            {edit && (
              <div className="btn-row">
                {!r.pamphlet_ack_at && <Button disabled={!ack.trim()} onClick={() => saveRrp({ pamphletAck: true })}>Pamphlet acknowledged now</Button>}
                {!r.containment_verified_at && <Button onClick={() => saveRrp({ containmentVerified: true })}>Containment verified now</Button>}
                {!r.cleaning_verified_at && <Button onClick={() => saveRrp({ cleaningVerified: true })}>Cleaning verified now</Button>}
              </div>
            )}
            <Field label="Cleaning verification card">
              <Select value={card} onChange={(e) => setCard(e.target.value as typeof card)}><option value="">Not done</option><option value="PASS">Passed</option><option value="FAIL">Failed</option><option value="RECLEAN_PASS">Passed after re-cleaning</option></Select>
            </Field>
          </fieldset>
        </Section>
      )}

      <Section title="Household" meta="Who signs, who pays, who gets the portal">
        {b.household.length === 0 ? <p className="t-cap">No one yet — the customer’s contacts are added on acceptance.</p> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Name</th><th>Relation</th><th>Reach</th><th>Signs</th><th>Pays</th><th>Portal</th></tr></thead>
              <tbody>
                {b.household.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td><td>{m.relation.toLowerCase().replace(/_/g, ' ')}</td><td>{[m.email, m.phone].filter(Boolean).join(' · ') || '—'}</td>
                    <td>{m.can_sign ? 'Yes' : '—'}</td><td>{m.can_pay ? 'Yes' : '—'}</td>
                    <td>{m.portal_status === 'INVITED' || m.portal_status === 'ACTIVE' ? <Tag tone="pos">{m.portal_status === 'ACTIVE' ? 'Active' : 'Invited'}</Tag> : m.portal_status === 'PENDING_INVITE' ? <Tag tone="warn">Invite pending</Tag> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {edit && (
          <form className="mp-form" style={{ marginTop: 12 }} onSubmit={(e) => {
            e.preventDefault();
            if (!member.name.trim()) return;
            void act('member', 'post', jobUrl, { op: 'household', name: member.name.trim(), email: member.email.trim() || null, phone: member.phone.trim() || null, relation: member.relation, canSign: member.canSign, canPay: member.canPay }, `Added ${member.name.trim()}`)
              .then((x) => { if (x) setMember({ name: '', email: '', phone: '', relation: 'SPOUSE', canSign: true, canPay: true }); });
          }}>
            <div className="mp-form-2">
              <Field label="Add someone"><Input value={member.name} onChange={(e) => setMember({ ...member, name: e.target.value })} placeholder="Name" maxLength={200} /></Field>
              <Field label="Relation">
                <Select value={member.relation} onChange={(e) => setMember({ ...member, relation: e.target.value })}>
                  {['OWNER', 'SPOUSE', 'FAMILY', 'ARCHITECT', 'DESIGNER', 'REALTOR', 'LENDER', 'PROPERTY_MANAGER', 'OTHER'].map((k) => <option key={k} value={k}>{k.toLowerCase().replace(/_/g, ' ')}</option>)}
                </Select>
              </Field>
              <Field label="Email"><Input type="email" value={member.email} onChange={(e) => setMember({ ...member, email: e.target.value })} maxLength={254} /></Field>
              <Field label="Mobile"><Input type="tel" value={member.phone} onChange={(e) => setMember({ ...member, phone: e.target.value })} maxLength={40} /></Field>
            </div>
            <div className="row" style={{ gap: 16 }}>
              <Check checked={member.canSign} onChange={(e) => setMember({ ...member, canSign: e.target.checked })} label="Can sign" />
              <Check checked={member.canPay} onChange={(e) => setMember({ ...member, canPay: e.target.checked })} label="Can pay" />
              <span className="sp" />
              <Button type="submit" disabled={!member.name.trim() || busy === 'member'}>Add</Button>
            </div>
          </form>
        )}
      </Section>
    </div>
  );
}

const CHECK_WORDS: Record<ProtectionCheckRow['kind'], string> = { DAY1_CONTAINMENT: 'Day-one dust and floor protection', DAILY_CLEANUP: 'End-of-day cleanup', PROTECTION_REMOVAL: 'Protection removal' };
const PERMIT_KINDS = ['BUILDING', 'ELECTRICAL', 'PLUMBING', 'MECHANICAL', 'DEMOLITION', 'HOA', 'ARCHITECTURAL', 'ZONING', 'NEIGHBOR_NOTICE', 'DUMPSTER', 'PORTABLE_TOILET', 'OTHER'] as const;
const INSPECTION_KINDS = ['FOOTING', 'FOUNDATION', 'FRAMING', 'MEP_ROUGH', 'INSULATION', 'DRYWALL', 'FINAL', 'OTHER'] as const;
const words = (s: string) => s.toLowerCase().replace(/_/g, ' ');

export function HomeSite({ bundle: b, today, canEdit }: { bundle: HomeWorkspace; today: string; canEdit: boolean }) {
  const { readOnly } = useShell();
  const edit = canEdit && !readOnly;
  const { act, busy, error } = useOps();
  const jobUrl = `/api/residential/jobs/${b.job!.id}`;
  return (
    <div className="stack">
      <Failure text={error} />
      <Section title="Protection and cleanup" meta="Photo required to pass; a failed check is visible to the PM"
        actions={edit ? (
          <div className="btn-row">
            {(['DAY1_CONTAINMENT', 'DAILY_CLEANUP', 'PROTECTION_REMOVAL'] as const).map((k) => (
              <Button key={k} disabled={busy === k} onClick={() => void act(k, 'post', jobUrl, { op: 'protection_start', kind: k, date: today }, `Started: ${CHECK_WORDS[k]}`)}>{k === 'DAILY_CLEANUP' ? 'Today’s cleanup' : CHECK_WORDS[k]}</Button>
            ))}
          </div>
        ) : undefined}>
        {b.checks.length === 0 ? <p className="t-cap">No checks yet.</p> : b.checks.map((c) => <ProtectionCheck key={c.id} check={c} jobUrl={jobUrl} edit={edit} today={today} />)}
      </Section>
      <Section title="Permits, HOA and site services">
        {b.permits.length === 0 ? <p className="t-cap">Nothing tracked yet.</p> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Kind</th><th>Number</th><th>Status</th><th>Dates</th></tr></thead>
              <tbody>
                {b.permits.map((p) => (
                  <tr key={p.id} className={p.expires_on && p.expires_on < today && p.status !== 'CLOSED' ? 'attn' : undefined}>
                    <td>{words(p.kind)}{p.authority && <span className="l2">{p.authority}</span>}</td><td>{p.number ?? '—'}</td><td>{words(p.status)}</td>
                    <td>{[p.applied_on && `applied ${shortDate(p.applied_on, today)}`, p.issued_on && `issued ${shortDate(p.issued_on, today)}`, p.expires_on && `expires ${shortDate(p.expires_on, today)}`, p.delivered_on && `delivered ${shortDate(p.delivered_on, today)}`, p.removal_on && `removal ${shortDate(p.removal_on, today)}`].filter(Boolean).join(' · ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {edit && <PermitAdd jobUrl={jobUrl} />}
      </Section>
      <Section title="Inspections" meta="A failed inspection blocks its task and books the re-inspection">
        {b.inspections.length === 0 ? <p className="t-cap">No inspections yet.</p> : (
          <div className="mp-table">
            <table className="tbl tbl-q tbl-q--compact">
              <thead><tr><th>Inspection</th><th>Scheduled</th><th>Result</th><th aria-label="Record" /></tr></thead>
              <tbody>{b.inspections.map((i) => <InspectionLine key={i.id} i={i} permits={b.permits} jobUrl={jobUrl} edit={edit} today={today} />)}</tbody>
            </table>
          </div>
        )}
        {edit && <InspectionAdd jobUrl={jobUrl} permits={b.permits} />}
      </Section>
    </div>
  );
}

function ProtectionCheck({ check: c, jobUrl, edit, today }: { check: ProtectionCheckRow; jobUrl: string; edit: boolean; today: string }) {
  const { act, busy } = useOps();
  const [done, setDone] = useState<Set<string>>(() => new Set(c.items.filter((i) => i.done).map((i) => i.key)));
  const open = c.status === 'OPEN' || c.status === 'FAILED';
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '8px 0' }}>
      <div className="row" style={{ gap: 8 }}>
        <span className="b">{CHECK_WORDS[c.kind]}</span><span className="t-cap">{shortDate(c.check_date, today)}</span>
        <Tag tone={c.status === 'PASSED' ? 'pos' : c.status === 'FAILED' ? 'neg' : 'warn'}>{c.status === 'PASSED' ? 'Passed' : c.status === 'FAILED' ? 'Failed — fix and re-check' : 'Open'}</Tag>
        {c.photo_document_ids.length > 0 && <span className="t-cap">{c.photo_document_ids.length} photo{c.photo_document_ids.length === 1 ? '' : 's'}</span>}
      </div>
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
        {c.items.map((i) => (
          <Check key={i.key} checked={done.has(i.key)} disabled={!edit || !open} label={i.label}
            onChange={(e) => setDone((s) => { const n = new Set(s); if (e.target.checked) n.add(i.key); else n.delete(i.key); return n; })} />
        ))}
      </div>
      {edit && open && (
        <div className="btn-row" style={{ marginTop: 6 }}>
          <span className="t-cap">Add the photo in Documents (tag the job) — a check without one fails.</span>
          <span className="sp" />
          <Button disabled={busy === c.id} onClick={() => void act<{ status: string }>(c.id, 'post', jobUrl, { op: 'protection_complete', checkId: c.id, doneKeys: [...done], photoDocumentIds: c.photo_document_ids }, (d) => (d.status === 'PASSED' ? 'Check passed' : 'Check failed — missing items or photo'))}>Complete check</Button>
        </div>
      )}
    </div>
  );
}

function PermitAdd({ jobUrl }: { jobUrl: string }) {
  const { act, busy } = useOps();
  const [kind, setKind] = useState<(typeof PERMIT_KINDS)[number]>('BUILDING');
  const [number, setNumber] = useState('');
  const [status, setStatus] = useState('APPLIED');
  const [expires, setExpires] = useState('');
  return (
    <form className="mp-form-2" style={{ marginTop: 12, gridTemplateColumns: '1fr 1fr 1fr 1fr auto', alignItems: 'end' }} onSubmit={(e) => {
      e.preventDefault();
      void act('permit', 'post', jobUrl, { op: 'permit', kind, number: number.trim() || null, status, expiresOn: expires || null, appliedOn: status === 'APPLIED' ? new Date().toISOString().slice(0, 10) : null }, 'Tracked').then((r) => { if (r) setNumber(''); });
    }}>
      <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{PERMIT_KINDS.map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
      <Field label="Number"><Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={60} /></Field>
      <Field label="Status"><Select value={status} onChange={(e) => setStatus(e.target.value)}>{['NOT_STARTED', 'APPLIED', 'ISSUED', 'APPROVED', 'ORDERED', 'DELIVERED', 'SENT'].map((s) => <option key={s} value={s}>{words(s)}</option>)}</Select></Field>
      <Field label="Expires"><Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} /></Field>
      <Button type="submit" disabled={busy === 'permit'}>Track</Button>
    </form>
  );
}

function InspectionAdd({ jobUrl, permits }: { jobUrl: string; permits: PermitRow[] }) {
  const { act, busy } = useOps();
  const [kind, setKind] = useState<(typeof INSPECTION_KINDS)[number]>('FRAMING');
  const [permitId, setPermitId] = useState('');
  const [on, setOn] = useState('');
  return (
    <form className="mp-form-2" style={{ marginTop: 12, gridTemplateColumns: '1fr 1fr 1fr auto', alignItems: 'end' }} onSubmit={(e) => {
      e.preventDefault();
      void act('insp', 'post', jobUrl, { op: 'inspection', kind, permitId: permitId || null, scheduledOn: on || null }, 'Inspection requested');
    }}>
      <Field label="Inspection"><Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{INSPECTION_KINDS.map((k) => <option key={k} value={k}>{words(k)}</option>)}</Select></Field>
      <Field label="Permit"><Select value={permitId} onChange={(e) => setPermitId(e.target.value)}><option value="">—</option>{permits.map((p) => <option key={p.id} value={p.id}>{words(p.kind)}{p.number ? ` ${p.number}` : ''}</option>)}</Select></Field>
      <Field label="Scheduled"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></Field>
      <Button type="submit" disabled={busy === 'insp'}>Request</Button>
    </form>
  );
}

function InspectionLine({ i, permits, jobUrl, edit, today }: { i: InspectionRow; permits: PermitRow[]; jobUrl: string; edit: boolean; today: string }) {
  const { act, busy } = useOps();
  const [notes, setNotes] = useState('');
  const permit = permits.find((p) => p.id === i.permit_id);
  const record = (result: 'PASS' | 'FAIL') => void act(`${i.id}-${result}`, 'post', jobUrl, { op: 'inspection_result', inspectionId: i.id, result, on: today, notes: notes.trim() || null },
    result === 'PASS' ? 'Passed — the task is complete' : 'Failed — the task is blocked and a re-inspection is booked');
  return (
    <tr className={i.result === 'FAIL' ? 'attn' : undefined}>
      <td>{words(i.kind)}{permit && <span className="l2">{words(permit.kind)}{permit.number ? ` ${permit.number}` : ''}</span>}{i.reinspect_of && <span className="l2">Re-inspection</span>}</td>
      <td>{i.scheduled_on ? shortDate(i.scheduled_on, today) : '—'}</td>
      <td>{i.result === 'PENDING' ? 'Pending' : `${words(i.result)}${i.result_on ? ` · ${shortDate(i.result_on, today)}` : ''}`}{i.notes && <span className="l2">{i.notes}</span>}</td>
      <td className="n">
        {edit && i.result === 'PENDING' && (
          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
            <Input aria-label="Inspector notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Notes" style={{ width: 160 }} />
            <Button disabled={busy === `${i.id}-PASS`} onClick={() => record('PASS')}>Passed</Button>
            <Button variant="danger" disabled={busy === `${i.id}-FAIL`} onClick={() => record('FAIL')}>Failed</Button>
          </div>
        )}
      </td>
    </tr>
  );
}
