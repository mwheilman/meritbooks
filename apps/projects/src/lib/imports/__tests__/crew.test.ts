import { describe, expect, it } from 'vitest';
import { commercialGcExperience, fieldServiceExperience } from '@meritbooks/industry-packs/src/packs/experience';
import { crewList, roleChips, suggestRole } from '../crew';
import { preview } from './helpers';

describe('crew step: pack titles → Projects roles + Projects-only', () => {
  const fs = roleChips(fieldServiceExperience.roles?.map((r) => ({ title: r.title, template: r.template })));
  it('chips are the pack’s titles (owner excluded), field roles Projects-only', () => {
    expect(fs.some((c) => c.roleKey === 'projects_owner')).toBe(false);
    const tech = fs.find((c) => c.roleKey === 'projects_labor')!;
    expect(tech.projectsOnly).toBe(true);
    expect(fieldServiceExperience.roles!.some((r) => r.title === tech.title)).toBe(true);
    expect(fs.find((c) => c.roleKey === 'projects_dispatcher')!.projectsOnly).toBe(false);
    for (const k of ['projects_gm', 'projects_pm', 'projects_supervisor', 'projects_labor', 'projects_dispatcher', 'projects_sales']) expect(fs.some((c) => c.roleKey === k), k).toBe(true);
  });
  it('a title or team picks the chip', () => {
    const gc = roleChips(commercialGcExperience.roles?.map((r) => ({ title: r.title, template: r.template })));
    expect(suggestRole('Superintendent', null, gc)?.roleKey).toBe('projects_supervisor');
    expect(suggestRole('Service Technician', null, fs)?.roleKey).toBe('projects_labor');
    expect(suggestRole('Dispatcher', 'Office', fs)?.roleKey).toBe('projects_dispatcher');
    expect(suggestRole(null, 'HVAC Service', fs)).toBeNull();
    expect(suggestRole('Project Manager', null, gc)?.roleKey).toBe('projects_pm');
  });
  it('imported technicians and Books’ team merge into one list', () => {
    const roster = preview('servicetitan-technicians.csv').rows.map((r, i) => ({ id: `r${i}`, data: r.data }));
    const people = crewList({ roster, team: [{ id: 'e1', name: 'Lee Ortiz', email: 'lee.ortiz@example.com', title: null, role: null }], chips: fs });
    expect(people).toHaveLength(3);
    const lee = people.find((p) => p.name === 'Lee Ortiz')!;
    expect(lee).toMatchObject({ source: 'books_team', phone: '515-555-0801', title: 'Service Technician' });
    const pat = people.find((p) => p.name === 'Pat Kim')!;
    expect(pat).toMatchObject({ roleKey: 'projects_supervisor', projectsOnly: true, source: 'import' });
  });
});
