/**
 * Wave C integration: page rules and rail items for the commercial screens, field-service
 * completion (1123), residential / RE / flooring / design (1124) and dealer / manufacturing (1125);
 * the new job tabs; page guards that match their own rule; public routes in middleware; the cron;
 * money keys; and the pending notification recipes for the 1124 event types.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG_KEYS, MODULES, compilePlan, resolveVocabulary, type ModuleKey } from '@meritbooks/industry-packs';
import { canReach, railNav, type NavAccess } from '@/lib/nav';
import { PERSONA_GROUP, type AccessRow, type PersonaKey } from '@/lib/access/types';
import { PERSONA_TEMPLATE_GRANTS } from '@/lib/access/templates';
import { buildAccess } from '@/lib/access/derive';
import { maskMoney } from '@/lib/access/mask';
import { resolveJobTabs } from '@/lib/pm/job-tabs';
import { CUSTOMER_EVENTS, EVENT_INFO, INTERNAL_EVENTS, RECIPE_CODES, RECIPE_PERSONAS, recipeDefaults, type InternalEvent } from '@/lib/notify/recipes';

const LOC = '00000000-0000-4000-8000-000000000001';
const SRC = join(__dirname, '..');
const APP = join(SRC, 'app', '(app)');
const MIGRATIONS = join(SRC, '..', '..', '..', 'packages', 'supabase', 'migrations');
const as = (p: PersonaKey): NavAccess => ({ group: PERSONA_GROUP[p], grants: PERSONA_TEMPLATE_GRANTS[p] });

const plans = new Map(CATALOG_KEYS.map((k) => [k, compilePlan({ pack: k, locationId: LOC })]));
function hrefs(pack: string, p: PersonaKey = 'projects_owner'): string[] {
  const plan = plans.get(pack)!;
  return railNav({
    context: 'client', vocab: resolveVocabulary(plan.vocabulary), modules: MODULES.filter((m) => plan.modules[m]) as ModuleKey[],
    booksPresent: true, companyCount: 1, packKeys: [pack], experience: plan.experience, access: as(p),
  }).flatMap((g) => [...g.items, ...g.more].map((x) => x.href));
}
function tabValues(pack: string, jobType?: string): string[] {
  const plan = plans.get(pack)!;
  const jt = jobType ? plan.job_types.find((j) => j.key === jobType)! : plan.job_types[0]!;
  const r = resolveJobTabs({ experience: plan.experience, jobTypeKey: jt.key, modules: new Set(MODULES.filter((m) => jt.modules[m]) as ModuleKey[]), vocab: resolveVocabulary(plan.vocabulary) });
  return [...r.visible, ...r.more].filter((t) => !t.later).map((t) => t.value);
}

describe('page rules for the Wave C screens', () => {
  it('commercial: contract money for pay apps, cost for buyout and review, the job record for field QA', () => {
    expect(canReach(as('projects_sales'), '/pay-apps')).toBe(false);          // contract value, but no billing
    expect(canReach(as('projects_office_manager'), '/pay-apps')).toBe(true);
    expect(canReach(as('projects_office_manager'), '/buyout')).toBe(false);   // cost
    expect(canReach(as('projects_office_manager'), '/project-review')).toBe(false);
    expect(canReach(as('projects_labor'), '/safety')).toBe(true);
    expect(canReach(as('projects_labor'), '/workforce')).toBe(false);
    expect(canReach(as('projects_supervisor'), '/workforce')).toBe(true);
    expect(canReach(as('projects_dispatcher'), '/trade-proposals')).toBe(false);
    expect(canReach(as('projects_supervisor'), '/project-templates')).toBe(false);
  });
  it('field service: each page’s any-of grants', () => {
    expect(canReach(as('projects_dispatcher'), '/calls/log')).toBe(true);
    expect(canReach(as('projects_supervisor'), '/calls')).toBe(false);       // the call screen still needs dispatch:edit
    expect(canReach(as('projects_labor'), '/calls/log')).toBe(false);
    expect(canReach(as('projects_supervisor'), '/dispatch/timesheets')).toBe(true);
    expect(canReach(as('projects_office_manager'), '/dispatch/timesheets')).toBe(false);
    expect(canReach(as('projects_dispatcher'), '/dispatch/go-live')).toBe(false);
    expect(canReach(as('projects_labor'), '/pricebook/forms')).toBe(true);
  });
  it('residential: a home’s money tab needs cost ("*" matches the job id)', () => {
    expect(canReach(as('projects_office_manager'), '/homes/abc')).toBe(true);
    expect(canReach(as('projects_office_manager'), '/homes/abc/money')).toBe(false);
    expect(canReach(as('projects_pm'), '/homes/abc/money')).toBe(true);
    expect(canReach(as('projects_labor'), '/homes/setup')).toBe(false);
    expect(canReach(as('projects_owner'), '/homes//money')).toBe(true); // no job id: falls back to /homes
  });
  it('dealer and shop: cash needs billing, service WIP and shop money need cost, bids need estimates', () => {
    expect(canReach(as('projects_office_manager'), '/stock/drawer')).toBe(true);
    expect(canReach(as('projects_purchasing'), '/stock/drawer')).toBe(false);
    expect(canReach(as('projects_office_manager'), '/work-orders/wip')).toBe(false);
    expect(canReach(as('projects_purchasing'), '/work-orders/wip')).toBe(true);
    expect(canReach(as('projects_dispatcher'), '/production/money')).toBe(false);
    expect(canReach(as('projects_dispatcher'), '/production/shop')).toBe(true);
    expect(canReach(as('projects_dispatcher'), '/production/bids')).toBe(false);
    expect(canReach(as('projects_owner'), '/stock/settings/completion')).toBe(true);
    expect(canReach(as('projects_office_manager'), '/stock/settings/completion')).toBe(false);
  });
});

describe('the rail shows each industry its own Wave C screens', () => {
  it('commercial GC: pay apps, buyout, monthly review, the job record; no field-service or store screens', () => {
    const h = hrefs('commercial_gc');
    expect(h).toEqual(expect.arrayContaining(['/pay-apps', '/buyout', '/project-review', '/directory', '/specifications', '/correspondence',
      '/safety', '/closeout', '/retainage-ledger', '/billing-calendar', '/project-templates', '/workforce', '/productivity']));
    for (const x of ['/calls/log', '/installs', '/stock/yard', '/production/bids', '/homes/appointments']) expect(h).not.toContain(x);
  });
  it('specialty trade: trade proposals and the foreman’s daily plan', () => {
    expect(hrefs('specialty_trade')).toContain('/trade-proposals');
    expect(hrefs('specialty_trade', 'projects_supervisor')).toContain('/foreman');
  });
  it('field service: call log, messages, installs, invoice review, timesheets, go-live', () => {
    const h = hrefs('field_service');
    expect(h).toEqual(expect.arrayContaining(['/calls/log', '/calls/messages', '/installs', '/invoice-review', '/dispatch/timesheets',
      '/dispatch/dashboard', '/dispatch/go-live', '/pricebook/forms', '/calls/sales']));
    for (const x of ['/pay-apps', '/retainage-ledger', '/homes/setup', '/stock/drawer']) expect(h).not.toContain(x); // folded items stay module-gated
  });
  it('residential, development, flooring and design', () => {
    expect(hrefs('residential_remodel')).toEqual(expect.arrayContaining(['/homes/appointments', '/homes/receipts', '/homes/dashboard', '/homes/setup']));
    expect(hrefs('home_builder')).toEqual(expect.arrayContaining(['/homes/appointments', '/homes/capacity']));
    expect(hrefs('real_estate_development')).toEqual(expect.arrayContaining(['/development/pursuits', '/development/calendar', '/development/inbox']));
    expect(hrefs('flooring')).toEqual(expect.arrayContaining(['/flooring/orders', '/flooring/installers', '/flooring/reports', '/flooring/setup']));
    expect(hrefs('interior_design')).toEqual(expect.arrayContaining(['/design/library', '/design/setup']));
    expect(hrefs('field_service')).not.toContain('/development/pursuits');
  });
  it('dealer and manufacturing', () => {
    expect(hrefs('equipment_dealer')).toEqual(expect.arrayContaining(['/stock/yard', '/stock/incentives', '/stock/customers', '/stock/drawer',
      '/stock/pricing', '/stock/close', '/stock/settings/completion', '/deals/funding', '/parts/ordering', '/parts/transfers',
      '/work-orders/service', '/work-orders/routes', '/work-orders/wip', '/rentals/fleet']));
    expect(hrefs('manufacturing_eto')).toEqual(expect.arrayContaining(['/production/bids', '/production/products', '/production/takeoff',
      '/production/proposals', '/production/engineering', '/production/shop', '/production/shipping', '/production/money', '/production/installer']));
    expect(hrefs('equipment_dealer')).not.toContain('/production/bids');
  });
  it('labor keeps four screens everywhere', () => {
    for (const pack of CATALOG_KEYS) expect(hrefs(pack, 'projects_labor').length, pack).toBeLessThanOrEqual(4);
  });
});

describe('job tabs: the commercial screens narrowed to the job', () => {
  it('GC lump sum has pay apps, directory, specs, correspondence and the monthly review, all live', () => {
    expect(tabValues('commercial_gc', 'lump_sum')).toEqual(expect.arrayContaining(['pay-apps', 'directory', 'specs', 'correspondence', 'review', 'billing']));
  });
  it('specialty trade bills through pay apps too', () => {
    expect(tabValues('specialty_trade')).toEqual(expect.arrayContaining(['pay-apps', 'directory', 'correspondence']));
  });
});

describe('page guards match their own rule', () => {
  const read = (rel: string) => readFileSync(join(APP, rel, 'page.tsx'), 'utf8');
  it.each([
    'billing-calendar', 'buyout', 'closeout', 'correspondence', 'cost-detail', 'directory', 'foreman', 'inspections', 'observations',
    'safety', 'productivity', 'pay-apps', 'project-review', 'project-templates', 'retainage-ledger', 'specifications', 'trade-proposals', 'workforce',
  ])('/%s', (rel) => {
    expect(read(rel)).toContain(`guardPage('/${rel}')`);
  });
  it.each([
    ['stock/drawer', '/stock/drawer'], ['stock/close', '/stock/close'], ['stock/pricing', '/stock/pricing'], ['stock/incentives', '/stock/incentives'],
    ['deals/funding', '/deals/funding'], ['work-orders/wip', '/work-orders/wip'], ['work-orders/service', '/work-orders/service'],
    ['stock/settings/completion', '/stock/settings'], ['production/money', '/production/money'], ['production/bids', '/production/bids'],
  ])('/%s guards %s', (rel, guard) => {
    expect(read(rel)).toContain(`guard="${guard}"`);
  });
});

describe('public routes, cron', () => {
  it('middleware lets the field-service public routes and homeowner booking through', () => {
    const list = readFileSync(join(SRC, 'lib', 'public-routes.ts'), 'utf8');
    expect(list).toContain("'/api/fieldservice/public/(.*)'");
    expect(list).toContain("'/api/residential/public-book/(.*)'");
  });
  it('vercel.json schedules the field-service automations and the notification worker', () => {
    const v = JSON.parse(readFileSync(join(SRC, '..', 'vercel.json'), 'utf8')) as { crons: Array<{ path: string; schedule: string }> };
    expect(v.crons.map((c) => c.path)).toEqual(expect.arrayContaining(['/api/fieldservice/public/cron', '/api/webhooks/notifications/dispatch']));
  });
});

describe('money keys for the Wave C screens', () => {
  const rows = (persona: PersonaKey): AccessRow[] => {
    const byCap = new Map<string, string[]>();
    for (const g of PERSONA_TEMPLATE_GRANTS[persona]) {
      const [cap, action] = g.split(':') as [string, string];
      byCap.set(cap, [...(byCap.get(cap) ?? []), action]);
    }
    return [...byCap].map(([capability, actions]) => ({ location_id: LOC, capability, actions, role_key: persona, role_name: null }));
  };
  it('retainage ledger: the office sees what the owner holds, not what we hold from subs', () => {
    const office = buildAccess(rows('projects_office_manager'));
    const out = maskMoney({ receivable_held_cents: 700, payable_held_cents: 500, held_cents: 500 }, office, LOC, ['retainage_ledger']);
    expect(out).toEqual({ receivable_held_cents: 700, payable_held_cents: null, held_cents: null });
  });
  it('trade proposals: the bid is contract value', () => {
    const office = buildAccess(rows('projects_office_manager'));
    const labor = buildAccess(rows('projects_labor'));
    const bid = { base_bid_cents: 125000, alternates: [{ label: 'Alt 1', amount_cents: 5000 }] };
    expect(maskMoney(bid, office, LOC, ['estimate', 'trade_proposal'])).toEqual(bid);
    expect(maskMoney(bid, labor, LOC, ['estimate', 'trade_proposal'])).toEqual({ base_bid_cents: null, alternates: [{ label: 'Alt 1', amount_cents: null }] });
  });
  it('a design deposit is contract, the trade cost is cost', () => {
    const office = buildAccess(rows('projects_office_manager'));
    expect(maskMoney({ deposit_cents: 100, trade_cost_cents: 60 }, office, LOC, ['selection', 'procurement'])).toEqual({ deposit_cents: 100, trade_cost_cents: null });
  });
});

describe('Wave C notification recipes (1124 W1b; the DB half is parity-tested in projects-access)', () => {
  const sql = readFileSync(join(MIGRATIONS, '1124_pm_res_dev_design_flooring.sql'), 'utf8');
  const WAVE_C: InternalEvent[] = ['sales.appointment_booked', 'job.margin_fade', 'job.cash_negative', 'client_update.ready',
    'development.key_date_due', 'flooring.goods_received', 'design.room_over_budget'];
  /** The (event, array[codes]) rows of W1b. */
  const w1b = new Map([...sql.matchAll(/\('([a-z_]+\.[a-z_]+)',\s*array\[([^\]]*)\]\)/g)].map((m) => [m[1]!, m[2]!.replace(/[\s']/g, '').split(',')]));

  it('the seven internal events are in the parity set, mandatory, with the codes 1124 seeds', () => {
    for (const e of WAVE_C) {
      expect(sql, e).toContain(`('${e}',`);
      expect((INTERNAL_EVENTS as readonly string[]).includes(e), e).toBe(true);
      expect(EVENT_INFO[e].mandatory, e).toBe(true);
      expect(RECIPE_CODES[e]).toHaveLength(RECIPE_PERSONAS.length);
      expect(RECIPE_CODES[e]).not.toContain('-');
      expect([...RECIPE_CODES[e]], e).toEqual(w1b.get(e));
    }
    expect(recipeDefaults()).toHaveLength(INTERNAL_EVENTS.length * RECIPE_PERSONAS.length);
  });
  it('the outbound customer events are known to the app', () => {
    for (const e of ['customer.appointment_booked', 'customer.order_update', 'customer.install_confirmation']) {
      expect(sql).toContain(`('${e}',`);
      expect((CUSTOMER_EVENTS as readonly string[]).includes(e), e).toBe(true);
    }
  });
});
