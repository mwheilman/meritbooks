import { describe, expect, it } from 'vitest';
import { basisLine, formatKpi, kpiAttention, kpiHref } from '@/lib/pm/ops/kpi';
import { buildSignals } from '@/lib/pm/ops/signals';
import { centerSentence, shopLoad } from '@/lib/pm/ops/shop-math';
import type { KpiDefRow, KpiRow, WorkCenterLoadRow } from '@/lib/pm/ops/types';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const def = (location_id: string, metric: string, label: string, sort: number, good_direction: 'up' | 'down' = 'up'): KpiDefRow => ({ location_id, key: metric, label, metric, good_direction, sort });
const kpi = (location_id: string, metric: string, value: number | null, sample_n: number, job_id: string | null = null): KpiRow => ({ location_id, job_id, metric, value, as_of: '2026-10-20', basis: '', sample_n });

describe('KPI formatting by catalog unit', () => {
  it('formats each unit the views produce', () => {
    expect(formatKpi('first_time_fix_pct', 0.824)).toBe('82.4%');
    expect(formatKpi('avg_ticket_cents', 41_250)).toBe('413');
    expect(formatKpi('ro_days_in_shop', 3.44)).toBe('3.4 days');
    expect(formatKpi('shop_backlog_weeks', 1.6)).toBe('1.6 weeks');
    expect(formatKpi('contingency_burn_ratio', 1.183)).toBe('1.18×');
    expect(formatKpi('installer_sqft_per_day', 640)).toBe('640 sq ft a day');
    expect(formatKpi('agreement_visits_overdue_count', 7)).toBe('7');
    expect(formatKpi('first_time_fix_pct', null)).toBe('—');
  });
  it('states the basis and sends each metric somewhere it can be worked', () => {
    expect(basisLine('first_time_fix_pct', 42)).toBe('42 jobs · last 90 days');
    expect(basisLine('draw_cycle_days', 1)).toBe('1 funded draw · last 12 months');
    expect(basisLine('in_balance_gap_cents', 2)).toBe('2 loans · today');
    expect(kpiHref('in_balance_gap_cents').href).toBe('/draws');
    expect(kpiHref('shop_backlog_weeks').href).toBe('/production');
    expect(kpiHref('warranty_claims_outstanding_cents').href).toBe('/work-orders?view=claims');
  });
  it('flags only the measures with a hard line', () => {
    expect(kpiAttention('in_balance_gap_cents', 1)).toBe(true);
    expect(kpiAttention('in_balance_gap_cents', 0)).toBe(false);
    expect(kpiAttention('interest_reserve_months', 2.5)).toBe(true);
    expect(kpiAttention('contingency_burn_ratio', 0.9)).toBe(false);
    expect(kpiAttention('first_time_fix_pct', 0.1)).toBe(false);
  });
});

describe('Signals', () => {
  it('shows each pack measure the views compute, with a comparison and a destination; skips the rest', () => {
    const s = buildSignals({
      defs: [def(A, 'first_time_fix_pct', 'First-time fix', 1), def(A, 'gross_margin_pct', 'Margin', 0), def(A, 'callback_rate_pct', 'Callbacks', 2, 'down')],
      kpis: [kpi(A, 'first_time_fix_pct', 0.8, 40), kpi(A, 'callback_rate_pct', 0.05, 60)],
      companyIds: [A], companyNames: { [A]: 'Heartland' }, jobLabels: {},
    });
    expect(s.map((x) => x.metric)).toEqual(['first_time_fix_pct', 'callback_rate_pct']);
    expect(s[0]).toMatchObject({ value: '80.0%', vs: ['40 jobs · last 90 days', 'Higher is better'], href: '/work-orders?band=complete', measured: true });
    expect(s[1]!.vs[1]).toBe('Lower is better');
    for (const x of s) expect(x.vs.length).toBeGreaterThan(0);
  });
  it('rolls per-job draw rows up and names the job at the bad end; attention comes first', () => {
    const s = buildSignals({
      defs: [def(A, 'draw_cycle_days', 'Draw cycle', 0, 'down'), def(A, 'in_balance_gap_cents', 'Out of balance', 1, 'down'), def(A, 'interest_reserve_months', 'Reserve runway', 2)],
      kpis: [
        kpi(A, 'draw_cycle_days', 9, 6),
        kpi(A, 'in_balance_gap_cents', 500_000, 1, 'j1'), kpi(A, 'in_balance_gap_cents', -200_000, 1, 'j2'),
        kpi(A, 'interest_reserve_months', 6, 1, 'j1'), kpi(A, 'interest_reserve_months', 2, 1, 'j2'),
      ],
      companyIds: [A], companyNames: {}, jobLabels: { j1: '1042 · Mill Street', j2: '1043 · Elm Lots' },
    });
    expect(s.map((x) => x.metric)).toEqual(['in_balance_gap_cents', 'interest_reserve_months', 'draw_cycle_days']);
    expect(s[0]).toMatchObject({ value: '5,000', attention: true }); // the 2,000 surplus on j2 does not net off j1
    expect(s[0]!.vs).toContain('Highest: 1042 · Mill Street at 5,000');
    expect(s[1]).toMatchObject({ value: '2.0 months', attention: true });
    expect(s[1]!.vs).toContain('Lowest: 1043 · Elm Lots at 2.0 months');
  });
  it('says plainly when nothing is counted yet', () => {
    const s = buildSignals({ defs: [def(A, 'agreement_renewal_pct', 'Renewals', 0)], kpis: [], companyIds: [A], companyNames: {}, jobLabels: {} });
    expect(s[0]).toMatchObject({ value: '—', measured: false });
    expect(s[0]!.vs[0]).toMatch(/^Nothing counted yet/);
  });
  it('in a workspace, leads with the weakest company and lists the others', () => {
    const s = buildSignals({
      defs: [def(A, 'first_time_fix_pct', 'First-time fix', 0), def(B, 'first_time_fix_pct', 'First-time fix', 0)],
      kpis: [kpi(A, 'first_time_fix_pct', 0.9, 10), kpi(B, 'first_time_fix_pct', 0.7, 12)],
      companyIds: [A, B], companyNames: { [A]: 'Heartland', [B]: 'Metro' }, jobLabels: {},
    });
    expect(s[0]).toMatchObject({ value: '70.0%', vs: ['Metro, the lowest of 2', 'Heartland 90.0%'] });
  });
});

describe('shop load statement', () => {
  const wc = (name: string, cap: number, open: number, status: WorkCenterLoadRow['status'] = 'ACTIVE'): WorkCenterLoadRow => ({
    location_id: A, work_center_id: name, code: name, name, status, capacity_minutes_per_week: cap, open_std_minutes: open, backlog_weeks: cap ? open / cap : null,
  });
  it('matches shop_backlog_weeks: Σ open ÷ Σ capacity of active centers, and names a constraint', () => {
    const l = shopLoad([wc('CNC', 2400, 7200), wc('Edge', 2400, 1200), wc('Old saw', 2400, 9999, 'INACTIVE')]);
    expect(l.weeks).toBeCloseTo(8400 / 4800);
    expect(l.constraint?.name).toBe('CNC');
    expect(l.sentence).toBe('The shop holds 1.8 weeks of released and sold work (140 hours against 80 hours a week). CNC is the constraint at 3 weeks.');
  });
  it('reads the empty and unset cases', () => {
    expect(shopLoad([]).sentence).toBe('No work centers are set up yet.');
    expect(shopLoad([wc('CNC', 0, 60)]).sentence).toBe('No running work center has weekly capacity set.');
    expect(shopLoad([wc('CNC', 2400, 0)]).sentence).toBe('The shop is clear: 40 hours of capacity a week and nothing open.');
    expect(centerSentence(wc('Edge', 2400, 2790, 'DOWN'))).toBe('Edge: 46.5 hours open against 40 hours a week, 1.2 weeks of work. It is down for maintenance.');
  });
});
