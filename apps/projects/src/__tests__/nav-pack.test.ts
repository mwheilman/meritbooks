/**
 * Pack manifest v2 rails: per persona, per industry (UX seat §3a/§3b; Wave 0a spec §5).
 * The pack's rail leads in its order and words; the persona's other destinations fold behind More;
 * nothing the caller can't reach renders.
 */
import { describe, expect, it } from 'vitest';
import { CATALOG_KEYS, MODULES, compilePlan, navFor, resolveVocabulary, type ModuleKey, type PlanExperience } from '@meritbooks/industry-packs';
import { canReach, railNav, type NavAccess, type NavInput } from '@/lib/nav';
import { PERSONA_GROUP, PERSONAS, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { PERSONA_TEMPLATES } from '@meritbooks/industry-packs';

const LOC = '00000000-0000-4000-8000-000000000001';
const as = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });

interface PackCtx { exp: PlanExperience; input: NavInput }
const ctx = new Map<string, PackCtx>();
for (const key of CATALOG_KEYS) {
  const plan = compilePlan({ pack: key, locationId: LOC });
  const modules = MODULES.filter((m) => plan.modules[m]) as ModuleKey[];
  ctx.set(key, {
    exp: plan.experience,
    input: {
      context: 'client', vocab: resolveVocabulary(plan.vocabulary), modules, booksPresent: true, companyCount: 1,
      packKeys: [key], archetypes: plan.job_types.map((j) => j.archetype), experience: plan.experience,
    },
  });
}

const rail = (pack: string, p: PersonaKey, extra: Partial<NavInput> = {}) => railNav({ ...ctx.get(pack)!.input, ...extra, access: as(p) });
const lead = (pack: string, p: PersonaKey) => rail(pack, p)[0]!.items.map((x) => x.label);

describe('the persona template list matches the pack contract', () => {
  it('apps/projects PERSONAS = industry-packs PERSONA_TEMPLATES', () => {
    expect([...PERSONAS].sort()).toEqual([...PERSONA_TEMPLATES].sort());
  });
});

describe.each([...CATALOG_KEYS])('%s rails', (pack) => {
  it.each([...PERSONAS])('%s: pack order first, every item reachable, no duplicate pages or chords', (p) => {
    const groups = rail(pack, p);
    expect(groups.length).toBeGreaterThan(0);
    const all = groups.flatMap((g) => [...g.items, ...g.more]);
    for (const it of all) expect(canReach(as(p), it.href), `${pack}/${p} → ${it.href}`).toBe(true);
    expect(new Set(all.map((x) => x.href)).size).toBe(all.length);
    const chords = groups.flatMap((g) => g.items.map((i) => i.keys).filter(Boolean));
    expect(new Set(chords).size).toBe(chords.length);

    // The lead group follows the pack's order for this persona group (minus what can't be reached
    // or isn't switched on for the company).
    const entries = navFor(ctx.get(pack)!.exp, PERSONA_GROUP[p])!;
    const order = entries.map((e) => `pack:${e.item}`);
    const ids = groups[0]!.items.map((x) => x.id!);
    expect(ids.every((id) => order.includes(id))).toBe(true);
    expect([...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b))).toEqual(ids);
    // Everything else is folded.
    for (const g of groups.slice(1)) expect(g.items.every((x) => typeof x.count === 'number' && x.count > 0)).toBe(true);
  });
});

describe('industry differences people see', () => {
  it('commercial GC PM: pay apps and change events in the pack words', () => {
    expect(lead('commercial_gc', 'projects_pm')).toEqual(expect.arrayContaining(['Home', 'My projects', 'Bids', 'Schedule', 'Change events', 'Pay apps']));
  });

  it('field service dispatcher: calls, dispatch and visits lead; no money pages', () => {
    const l = lead('field_service', 'projects_dispatcher');
    expect(l.slice(0, 5)).toEqual(['Home', 'Inbox', 'Calls', 'Dispatch', 'Visits']);
    const hrefs = rail('field_service', 'projects_dispatcher').flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
    for (const m of ['/billing', '/job-cost', '/commitments']) expect(hrefs).not.toContain(m);
  });

  it('equipment dealer office: the Service board, units and the parts counter', () => {
    expect(lead('equipment_dealer', 'projects_office_manager')).toEqual(expect.arrayContaining(['Service', 'Units', 'Parts counter']));
    expect(lead('equipment_dealer', 'projects_pm')).toEqual(expect.arrayContaining(['Home', 'Service']));
  });

  it('flooring office: measures, install schedule, special orders', () => {
    expect(lead('flooring', 'projects_office_manager')).toEqual(expect.arrayContaining(['Measures', 'Install schedule', 'Install tickets']));
  });

  it('labor is the same four screens in every industry', () => {
    for (const pack of CATALOG_KEYS) {
      const l = rail(pack, 'projects_labor').flatMap((g) => [...g.items, ...g.more].map((x) => x.label));
      const time = ctx.get(pack)!.input.modules.includes('time') ? ['Time'] : [];
      expect(l, pack).toEqual(['Today', ...time, ctx.get(pack)!.input.vocab.jobs, 'Me']);
    }
  });

  it('the PM lead rail differs across the twelve packs', () => {
    const seen = new Set(CATALOG_KEYS.map((k) => lead(k, 'projects_pm').join('|')));
    expect(seen.size).toBe(12);
  });

  it('Approvals and Documents point at the Wave A routes', () => {
    const hrefs = rail('commercial_gc', 'projects_owner').flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
    expect(hrefs).toEqual(expect.arrayContaining(['/approvals', '/inbox', '/documents']));
  });
});

describe('roll-up views and missing experience keep the built-in rails', () => {
  it('workspace context ignores the pack rail', () => {
    const groups = rail('field_service', 'projects_owner', { context: 'workspace' });
    expect(groups.some((g) => g.id === 'pack')).toBe(false);
  });

  it('no experience: the built-in persona rail', () => {
    const groups = rail('field_service', 'projects_pm', { experience: null });
    expect(groups.some((g) => g.id === 'pack')).toBe(false);
    expect(groups[0]!.items.map((x) => x.label)).toContain('Home');
  });
});
