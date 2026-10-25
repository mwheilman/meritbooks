/**
 * Portal UI (1118): EN/ES copy parity, money / deadline / $ impact text, queue order and links
 * (Books pay link where it exists), the pay-application math the database repeats, and SSR of the
 * frame, queue, job sections, decision states and the staff "Invite to portal" panel.
 */
import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {} }),
  usePathname: () => '/portal',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next/link', () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a> }));

import { MeritProvider } from '@meritbooks/merit-ui';
import { DICTIONARIES, t } from '@/lib/portal/i18n';
import { deadlineText, impactText, money } from '@/lib/portal/format';
import { itemHref, sortQueue, urgency } from '@/lib/portal/queue';
import type { QueueItem } from '@/lib/portal/types';
import { QueueList } from '@/components/portal/QueueList';
import { PortalFrame } from '@/components/portal/PortalFrame';
import { Household, MilestoneList } from '@/components/portal/JobSections';
import { DecisionPanel } from '@/components/portal/DecisionPanel';
import { PayAppForm, payAppMath } from '@/components/portal/PayAppForm';
import { SignInForm } from '@/components/portal/SignInForm';
import { SwitchOrg } from '@/components/portal/SwitchOrg';
import { PortalAccessPanel } from '@/components/portal/staff/PortalAccessPanel';

const wrap = (el: ReactElement) => renderToString(<MeritProvider>{el}</MeritProvider>).replace(/<!-- -->/g, '');
const ORG = 'a0000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-10-25T12:00:00');
const job = { id: 'j1', name: 'Smith kitchen', number: 'J-1001', company: 'Heritage Interiors', status: 'ACTIVE', stage: 'build' };
const q = (o: Partial<QueueItem>): QueueItem => ({ kind: 'estimate', id: 'e1', job, title: 'Kitchen proposal', state: 'waiting', action: 'approve', can_act: true, grant_id: 'g1', ...o });

describe('copy', () => {
  it('every key exists in English and Spanish with the same placeholders', () => {
    const en = DICTIONARIES.en; const es = DICTIONARIES.es;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(es[k].trim().length, k).toBeGreaterThan(0);
      expect(ph(es[k]), k).toEqual(ph(en[k]));
    }
  });
  it('fills placeholders', () => {
    expect(t('es', 'due.in', { n: 3 })).toBe('Vence en 3 días');
  });
});

describe('format', () => {
  it('money from integer cents; negatives in parentheses', () => {
    expect(money(184000)).toBe('$1,840.00');
    expect(money(-5)).toBe('($0.05)');
    expect(money(null)).toBe('—');
  });
  it('$ impact sentences', () => {
    expect(impactText({ amount_cents: 184000, amount_kind: 'vs_allowance' }, 'en')).toBe('Adds $1,840.00 over the allowance');
    expect(impactText({ amount_cents: -10000, amount_kind: 'vs_allowance' }, 'es')).toBe('$100.00 bajo la asignación');
    expect(impactText({ amount_cents: 100000, amount_kind: 'change', schedule_days: 3 }, 'en')).toBe('Adds $1,000.00 and 3 days');
    expect(impactText({ amount_cents: 52000, amount_kind: 'balance' }, 'en')).toBe('$520.00 due');
  });
  it('deadlines', () => {
    expect(deadlineText('2026-10-25', 'en', NOW)).toBe('Due today');
    expect(deadlineText('2026-10-28', 'en', NOW)).toBe('Due in 3 days');
    expect(deadlineText('2026-10-20', 'es', NOW)).toBe('5 días de retraso');
  });
});

describe('queue', () => {
  it('overdue first, then by deadline; answered items last', () => {
    const items = [q({ id: 'a', deadline: '2026-11-20' }), q({ id: 'b', deadline: '2026-10-20' }), q({ id: 'c', state: 'sent' }), q({ id: 'd', deadline: '2026-10-26' })];
    expect(sortQueue(items, NOW).map((i) => i.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(urgency(items[1], NOW)).toBe('overdue');
  });
  it('links: decisions in the portal, invoices to the Books pay page when payable', () => {
    expect(itemHref(ORG, q({}))).toBe(`/portal/o/${ORG}/items/estimate/e1`);
    expect(itemHref(ORG, q({ kind: 'draw', id: 'd1' }))).toBe(`/portal/o/${ORG}/draws/d1`);
    expect(itemHref(ORG, q({ kind: 'invoice', id: 'i1', pay_token: 'tok-1' }))).toMatch(/\/pay\/tok-1$/);
    expect(itemHref(ORG, q({ kind: 'invoice', id: 'i1', pay_token: null }))).toBe(`/portal/o/${ORG}/invoices`);
  });
});

describe('pay application math (same rule as portal.submit_pay_app)', () => {
  it('this period = round(amount × % to date) − billed; retainage at the contract rate', () => {
    const lines = [{ id: 'l1', line_no: 1, description: 'Tile', qty: null, uom: null, amount_cents: 1000000, billed_cents: 200000 },
                   { id: 'l2', line_no: 2, description: 'Grout', qty: null, uom: null, amount_cents: 33333, billed_cents: 0 }];
    const m = payAppMath(lines, { l1: 0.5, l2: 1 }, 0.1);
    expect(m.rows.map((r) => r.thisPeriod)).toEqual([300000, 33333]);
    expect(m).toMatchObject({ gross: 333333, retainage: 33333, net: 300000 });
    expect(payAppMath(lines, { l1: 0.1 }, 0.1).rows[0].thisPeriod).toBe(0); // never negative
  });
});

describe('render', () => {
  it('frame: brand, tabs by audience, language switch', () => {
    const html = wrap(<PortalFrame locale="en" brand={{ company_name: 'Heritage Interiors', org_name: null, logo_url: null, primary_color: '#2563EB' }} orgId={ORG} audiences={['customer']} active="home" signedIn><p>x</p></PortalFrame>);
    expect(html).toContain('Heritage Interiors');
    expect(html).toContain('Invoices');
    expect(html).not.toContain('My work');
    expect(html).toContain('Español');
    const vendor = wrap(<PortalFrame locale="es" orgId={ORG} audiences={['vendor']} signedIn><p>x</p></PortalFrame>);
    expect(vendor).toContain('Mi trabajo');
    expect(vendor).toContain('lang="es"');
  });

  it('queue: populated (deadline + $ impact + action), Spanish, empty', () => {
    const items = [q({ kind: 'selection', id: 's1', title: 'Tile: Backsplash', deadline: '2026-10-27', amount_cents: 184000, amount_kind: 'vs_allowance', action: 'choose' }),
                   q({ kind: 'invoice', id: 'i1', title: 'Invoice 1042', deadline: '2026-10-20', amount_cents: 52000, amount_kind: 'balance', action: 'pay', pay_token: 'tok' })];
    const html = wrap(<QueueList orgId={ORG} items={items} locale="en" now={NOW} />);
    expect(html).toContain('Adds $1,840.00 over the allowance');
    expect(html).toContain('Due in 2 days');
    expect(html).toContain('5 days late');
    expect(html).toContain('Choose →');
    expect(html).toContain('target="_blank"');
    expect(html.indexOf('Invoice 1042')).toBeLessThan(html.indexOf('Tile: Backsplash')); // overdue first
    expect(wrap(<QueueList orgId={ORG} items={items} locale="es" now={NOW} />)).toContain('Suma $1,840.00 sobre la asignación');
    expect(wrap(<QueueList orgId={ORG} items={[]} locale="en" now={NOW} />)).toContain('Nothing is waiting on you');
  });

  it('job sections: milestones; household shows who can sign / pay', () => {
    const ms = wrap(<MilestoneList locale="en" items={[{ id: 't1', title: 'Cabinets set', milestone: true, status: 'DONE', start: '2026-10-01', finish: '2026-10-03', pct: 1 }]} />);
    expect(ms).toContain('Cabinets set');
    expect(ms).toContain('Done');
    expect(wrap(<MilestoneList locale="en" items={[]} />)).toContain('once the team shares it');
    const hh = wrap(<Household locale="en" people={[{ name: 'Pat Smith', role: 'approver', can_sign: true, can_pay: true, you: true }, { name: 'Sam Smith', role: 'viewer', can_sign: false, can_pay: false, you: false }]} />);
    expect(hh).toContain('Pat Smith (you)');
    expect(hh).toContain('can sign · can pay');
    expect(hh).toContain('can view');
  });

  it('decision states: answered, viewer, phone step-up, e-sign hand-off, selection options with allowance deltas', () => {
    const base = { orgId: ORG, kind: 'change_order' as const, id: 'c1', locale: 'en' as const, company: 'Heritage', canAct: true, verified: 'sms' as const, phoneHint: '•••0101' };
    expect(wrap(<DecisionPanel {...base} decided="approved" />)).toContain('Your answer was sent');
    expect(wrap(<DecisionPanel {...base} canAct={false} />)).toContain('Someone else on your account approves it');
    expect(wrap(<DecisionPanel {...base} verified={null} />)).toContain('ending •••0101');
    expect(wrap(<DecisionPanel {...base} signerId="s1" />)).toContain('Review and sign');
    const sel = wrap(<DecisionPanel {...base} kind="selection" options={[
      { id: 'o1', label: 'Subway', description: null, qty: 1, uom: 'EA', amount_cents: 140000, recommended: false, lead_time_days: null, delta_cents: -10000 },
      { id: 'o2', label: 'Zellige', description: null, qty: 1, uom: 'EA', amount_cents: 334000, recommended: true, lead_time_days: 21, delta_cents: 184000 }]} />);
    expect(sel).toContain('Adds $1,840.00 over the allowance');
    expect(sel).toContain('$100.00 under the allowance');
    expect(sel).toContain('21-day lead time');
    expect(sel).toContain('I agree that typing my name here is my electronic signature');
  });

  it('pay application form totals tie; sign-in form; the staff invite panel loads', () => {
    const html = wrap(<PayAppForm orgId={ORG} commitmentId="c1" locale="en" retainagePct={0.1}
      lines={[{ id: 'l1', line_no: 1, description: 'Tile install', qty: null, uom: null, amount_cents: 1000000, billed_cents: 500000 }]} />);
    expect(html).toContain('Retainage (10%)');
    expect(html).toContain('Tile install');
    expect(wrap(<SignInForm locale="es" reason="other_device" />)).toContain('Abra el enlace en el mismo dispositivo');
    expect(wrap(<SwitchOrg orgId={ORG} name="Dorrian HVAC" locale="en" />)).toContain('Send me a code from this company');
    expect(wrap(<PortalAccessPanel companyId={ORG} audience="customer" customerId="c1" jobId="j1" />)).toContain('Loading portal access');
  });
});
