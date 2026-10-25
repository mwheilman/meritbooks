/** Persona homes per industry (pack manifest v2 `home` + `mobile` slots, UX seat §3b). */
import { describe, expect, it } from 'vitest';
import { CATALOG_KEYS, MODULES, compilePlan, resolveVocabulary, type ModuleKey } from '@meritbooks/industry-packs';
import { packBoards, packFieldActions } from '@/components/home/PackHomeStrip';
import { PERSONA_GROUP, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { canReach } from '@/lib/nav';

const LOC = '00000000-0000-4000-8000-000000000001';
const ctx = (pack: string, p: PersonaKey) => {
  const plan = compilePlan({ pack, locationId: LOC });
  return {
    experience: plan.experience,
    group: PERSONA_GROUP[p],
    access: { group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] },
    companyId: null,
    modules: MODULES.filter((m) => plan.modules[m]) as ModuleKey[],
    isDealer: pack === 'equipment_dealer',
    vocab: resolveVocabulary(plan.vocabulary),
  };
};
const boards = (pack: string, p: PersonaKey) => packBoards(ctx(pack, p)).map((b) => b.title);

describe('industry boards on the home', () => {
  it('each industry puts its signature board in front of the people who run it', () => {
    expect(boards('field_service', 'projects_dispatcher')).toContain('Dispatch board');
    expect(boards('manufacturing_eto', 'projects_pm')).toContain('Production capacity');
    expect(boards('flooring', 'projects_office_manager')).toContain('Install board');
    expect(boards('residential_remodel', 'projects_pm')).toContain('Client decisions');
    expect(boards('interior_design', 'projects_pm')).toContain('Item tracker');
    expect(boards('home_builder', 'projects_pm')).toContain('Draws in flight');
    expect(boards('commercial_gc', 'projects_pm')).toContain('Pay apps due');
    expect(boards('equipment_dealer', 'projects_office_manager')).toContain('Service board');
  });

  it.each([...CATALOG_KEYS])('%s: every board is one the person can open', (pack) => {
    for (const p of Object.keys(PERSONA_GROUP) as PersonaKey[]) {
      const c = ctx(pack, p);
      for (const b of packBoards(c)) expect(canReach(c.access, b.href), `${pack}/${p} ${b.href}`).toBe(true);
      expect(packBoards(c).length).toBeLessThanOrEqual(3);
    }
  });

  it('a dispatcher never sees a money board', () => {
    for (const pack of CATALOG_KEYS) expect(boards(pack, 'projects_dispatcher'), pack).not.toContain('Pay apps due');
  });
});

describe('field buttons for supervisors and crews', () => {
  it('field service techs: on my way first; GC supers: the daily report', () => {
    expect(packFieldActions(ctx('field_service', 'projects_labor'))[0]!.label).toBe('On my way');
    expect(packFieldActions(ctx('commercial_gc', 'projects_supervisor'))[0]!.label).toBe('Daily report');
    expect(packFieldActions(ctx('professional_services', 'projects_labor')).map((a) => a.label)).toContain('Start a timer');
  });
});
