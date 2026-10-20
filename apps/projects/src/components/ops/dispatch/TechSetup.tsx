'use client';

import { useMemo, useState } from 'react';
import { Button, Check, Drawer, Field, Input, PanelSection, Select, Tag } from '@meritbooks/merit-ui';
import { durationText } from '@/lib/pm/ops/dispatch-math';
import { personName } from '@/lib/pm/ops/labels';
import type { CrewMemberRow, CrewRow, EmployeeRow, EmployeeSkillRow, SkillRow } from '@/lib/pm/ops/types';
import { Failure } from '../common/bits';
import { useOps } from '../common/useOps';

export interface TechSetupProps {
  open: boolean;
  onClose: () => void;
  crews: ReadonlyArray<CrewRow>;
  members: ReadonlyArray<CrewMemberRow>;
  employees: ReadonlyArray<EmployeeRow>;
  skills: ReadonlyArray<SkillRow>;
  employeeSkills: ReadonlyArray<EmployeeSkillRow>;
  companies: ReadonlyArray<{ id: string; name: string }>;
  activeCompanyId: string | null;
}

export function slugCode(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's_$1');
  return (s.length >= 2 ? s : `${s}_skill`).slice(0, 48);
}

/** Crews, daily capacity, members and skills — what the board needs to know about people. */
export function TechSetup(p: TechSetupProps) {
  const { act, busy, error } = useOps();
  const url = '/api/ops/dispatch/setup';
  const [companyId, setCompanyId] = useState(p.activeCompanyId ?? p.companies[0]?.id ?? '');
  const [crewName, setCrewName] = useState('');
  const [crewHours, setCrewHours] = useState('8');
  const [skillName, setSkillName] = useState('');
  const [adding, setAdding] = useState<Record<string, string>>({});
  const emp = useMemo(() => new Map(p.employees.map((e) => [e.id, e])), [p.employees]);
  const techIds = useMemo(() => [...new Set(p.members.map((m) => m.employee_id))], [p.members]);
  const held = useMemo(() => new Set(p.employeeSkills.map((h) => `${h.employee_id}:${h.skill_id}`)), [p.employeeSkills]);
  const activeSkills = p.skills.filter((s) => s.is_active);

  const addCrew = async () => {
    const hours = Number(crewHours);
    if (!crewName.trim() || !companyId || !Number.isFinite(hours) || hours < 0 || hours > 24) return;
    const ok = await act('crew', 'post', url, { op: 'add_crew', companyId, name: crewName.trim(), kind: 'TECH', capacityMinutes: Math.round(hours * 60) }, `Added ${crewName.trim()}`);
    if (ok) setCrewName('');
  };

  return (
    <Drawer open={p.open} onClose={p.onClose} width={600} eyebrow="Dispatch board" title="Technicians and skills" meta="Who is on the board, their hours a day, and what they are qualified for">
      {error && <PanelSection><Failure text={error} /></PanelSection>}
      <PanelSection title="Crews">
        {p.crews.length === 0 ? (
          <p className="t-cap">No crews yet. Each technician belongs to a crew; the crew sets their working hours a day.</p>
        ) : (
          <ul className="ops-checks">
            {p.crews.map((c) => {
              const people = p.members.filter((m) => m.crew_id === c.id);
              const candidates = p.employees.filter((e) => !people.some((m) => m.employee_id === e.id));
              return (
                <li key={c.id} style={{ gridTemplateColumns: 'minmax(0,1fr)' }}>
                  <div className="row row--between">
                    <span className="b">{c.name} {!c.is_active && <Tag>Inactive</Tag>}</span>
                    <span className="t-cap">{durationText(c.capacity_minutes_per_day)} a day</span>
                  </div>
                  <div className="ops-chips" style={{ marginTop: 6 }}>
                    {people.length === 0 && <span className="t-cap">No technicians yet</span>}
                    {people.map((m) => (
                      <span key={m.employee_id} className="tag" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {personName(emp.get(m.employee_id))}{m.role === 'LEAD' ? ' · lead' : ''}
                        <button type="button" className="btn btn--quiet btn--icon" aria-label={`Remove ${personName(emp.get(m.employee_id))} from ${c.name}`} disabled={busy === 'member'} onClick={() => void act('member', 'post', url, { op: 'remove_member', crewId: c.id, employeeId: m.employee_id }, 'Removed from the crew')}>×</button>
                      </span>
                    ))}
                  </div>
                  <form className="row" style={{ marginTop: 8, gap: 8 }} onSubmit={(e) => { e.preventDefault(); const id = adding[c.id]; if (id) void act('member', 'post', url, { op: 'add_member', crewId: c.id, employeeId: id }, `Added ${personName(emp.get(id))} to ${c.name}`).then(() => setAdding((a) => ({ ...a, [c.id]: '' }))); }}>
                    <Select aria-label={`Add a technician to ${c.name}`} value={adding[c.id] ?? ''} onChange={(e) => setAdding((a) => ({ ...a, [c.id]: e.target.value }))} style={{ flex: 1 }}>
                      <option value="">Add a technician…</option>
                      {candidates.map((e) => <option key={e.id} value={e.id}>{personName(e)}{e.title ? ` · ${e.title}` : ''}</option>)}
                    </Select>
                    <Button type="submit" disabled={!adding[c.id] || busy === 'member'}>Add</Button>
                    <Input aria-label={`Hours a day for ${c.name}`} inputMode="decimal" defaultValue={String(c.capacity_minutes_per_day / 60)} style={{ width: 72 }}
                      onBlur={(e) => { const h = Number(e.target.value); if (Number.isFinite(h) && h >= 0 && h <= 24 && Math.round(h * 60) !== c.capacity_minutes_per_day) void act('crew', 'post', url, { op: 'update_crew', crewId: c.id, capacityMinutes: Math.round(h * 60) }, `${c.name}: ${h} hours a day`); }} />
                  </form>
                </li>
              );
            })}
          </ul>
        )}
        <form className="mp-add" style={{ marginTop: 12, padding: 12 }} onSubmit={(e) => { e.preventDefault(); void addCrew(); }}>
          {p.companies.length > 1 && (
            <Field label="Company">
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
                {p.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          )}
          <Field label="New crew"><Input value={crewName} onChange={(e) => setCrewName(e.target.value)} placeholder="Service techs" maxLength={80} /></Field>
          <Field label="Hours a day"><Input inputMode="decimal" value={crewHours} onChange={(e) => setCrewHours(e.target.value)} style={{ width: 80 }} /></Field>
          <Button type="submit" icon="plus" disabled={!crewName.trim() || busy === 'crew'}>Add crew</Button>
        </form>
      </PanelSection>

      <PanelSection title="Skills, licenses and brands">
        <div className="ops-chips">
          {activeSkills.length === 0 && <span className="t-cap">No skills yet. Add the ones a visit can require (EPA 608, journeyman, a brand you are certified on).</span>}
          {activeSkills.map((s) => <Tag key={s.id}>{s.name}</Tag>)}
        </div>
        <form className="row" style={{ marginTop: 8, gap: 8 }} onSubmit={(e) => { e.preventDefault(); if (skillName.trim()) void act('skill', 'post', url, { op: 'add_skill', code: slugCode(skillName), name: skillName.trim() }, `Added ${skillName.trim()}`).then((ok) => { if (ok) setSkillName(''); }); }}>
          <Input aria-label="New skill" value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="EPA 608 universal" maxLength={80} style={{ flex: 1 }} />
          <Button type="submit" icon="plus" disabled={!skillName.trim() || busy === 'skill'}>Add skill</Button>
        </form>
      </PanelSection>

      {techIds.length > 0 && activeSkills.length > 0 && (
        <PanelSection title="Who holds what" meta="The board warns before assigning someone without a required skill">
          <table className="ops-mini">
            <thead><tr><th>Technician</th>{activeSkills.map((s) => <th key={s.id} style={{ textAlign: 'center' }}>{s.name}</th>)}</tr></thead>
            <tbody>
              {techIds.map((id) => (
                <tr key={id}>
                  <td>{personName(emp.get(id))}</td>
                  {activeSkills.map((s) => {
                    const on = held.has(`${id}:${s.id}`);
                    return (
                      <td key={s.id} style={{ textAlign: 'center' }}>
                        <Check
                          aria-label={`${personName(emp.get(id))} holds ${s.name}`}
                          checked={on}
                          disabled={busy === 'grant'}
                          onChange={() => void act('grant', 'post', url, { op: on ? 'revoke_skill' : 'grant_skill', employeeId: id, skillId: s.id }, `${personName(emp.get(id))}: ${s.name} ${on ? 'removed' : 'added'}`)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </PanelSection>
      )}
    </Drawer>
  );
}
