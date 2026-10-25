'use client';

import { useState } from 'react';
import { Field, Figure, InlineNotice, Input, count, money } from '@meritbooks/merit-ui';
import { Section } from '@/components/ops/common/bits';
import { BoardState, pctText, qty, useBoard } from '../common/depth';

interface Kpis {
  from: string; to: string; amounts_visible: boolean;
  counter: { tickets: number; median_seconds: number | null; pct_under_60s: number | null; fill_rate: number | null; lost_sales: number; parts_sales_cents: number | null; parts_gm_pct: number | null };
  service: { open_ros: number; wip_aging: { d0_7: number; d8_14: number; d15_30: number; d30_plus: number }; efficiency: number | null; productivity: number | null; techs: number };
  warranty: { outstanding: number; outstanding_cents: number | null; rejection_rate: number | null; near_deadline: number };
  units: { in_stock: number; aging: { d0_90: number; d91_180: number; d181_365: number; d365_plus: number }; sold_unpaid: number; turns_365: number | null };
  rental: { time_utilization: number | null; dollar_utilization: number | null };
  absorption: { available: boolean; needs: string };
}

/** The dealer scorecard: counter, service, warranty, units, rentals; every figure drills to its screen. */
export function KpiBoard({ companyId, today }: { companyId: string; today: string }) {
  const [range, setRange] = useState({ from: `${today.slice(0, 7)}-01`, to: today });
  const b = useBoard<Kpis>(`/api/dealer/kpis?company=${companyId}&from=${range.from}&to=${range.to}`);
  const state = <BoardState b={b} what="The scorecard" />;
  const d = b.data;
  return (
    <div className="stack">
      <div className="ops-toolbar">
        <Field label="From"><Input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></Field>
        <Field label="To"><Input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></Field>
      </div>
      {state}
      {d && (
        <>
          <Section title="Parts counter">
            <div className="dl-strip">
              <Figure dense label="Fill rate" value={pctText(d.counter.fill_rate)} vs={[`${count(d.counter.tickets)} tickets`, `${count(d.counter.lost_sales)} lost sales`]} href="/parts/counter" linkLabel="Counter" />
              <Figure dense label="Median ticket" value={`${qty(d.counter.median_seconds)} s`} vs={[`${pctText(d.counter.pct_under_60s, 0)} under a minute`, 'open to close']} href="/parts/counter" linkLabel="Counter speed" />
              {d.counter.parts_sales_cents != null && <Figure dense label="Parts sales" value={money(d.counter.parts_sales_cents, { decimals: 0 })} vs={[d.counter.parts_gm_pct != null ? `${pctText(d.counter.parts_gm_pct)} gross margin` : 'margin hidden', 'closed tickets']} href="/parts" linkLabel="Parts" />}
            </div>
          </Section>
          <Section title="Service">
            <div className="dl-strip">
              <Figure dense label="Open repair orders" value={count(d.service.open_ros)} vs={[`${count(d.service.wip_aging.d15_30 + d.service.wip_aging.d30_plus)} older than 14 days`, `${count(d.service.wip_aging.d30_plus)} over 30`]} href="/work-orders" linkLabel="Repair orders" />
              <Figure dense label="Tech efficiency" value={pctText(d.service.efficiency, 0)} vs={[`productivity ${pctText(d.service.productivity, 0)}`, `${count(d.service.techs)} techs`]} href="/work-orders/tech-board" linkLabel="Tech board" />
            </div>
          </Section>
          <Section title="Warranty">
            <div className="dl-strip">
              <Figure dense label="Claims outstanding" value={count(d.warranty.outstanding)} vs={[d.warranty.outstanding_cents != null ? money(d.warranty.outstanding_cents, { decimals: 0 }) : 'amount hidden', `${count(d.warranty.near_deadline)} near the filing deadline`]} href="/warranty/credits" linkLabel="Deadlines" />
              <Figure dense label="Rejection rate" value={pctText(d.warranty.rejection_rate)} vs={['of claims decided', 'in the period']} href="/warranty?band=SETTLED" linkLabel="Settled claims" />
            </div>
          </Section>
          <Section title="Units">
            <div className="dl-strip">
              <Figure dense label="In stock" value={count(d.units.in_stock)} vs={[`${count(d.units.aging.d181_365 + d.units.aging.d365_plus)} over 180 days`, `turns ${qty(d.units.turns_365)} a year`]} href="/stock" linkLabel="Stock" />
              <Figure dense label="Sold, not paid off" value={count(d.units.sold_unpaid)} vs={['floor-plan payoff open', 'sold-out-of-trust watch']} href="/stock?age=all" linkLabel="Units" />
            </div>
          </Section>
          <Section title="Rentals">
            <div className="dl-strip">
              <Figure dense label="Time utilization" value={pctText(d.rental.time_utilization)} vs={['days on rent ÷ days available', d.rental.dollar_utilization != null ? `dollar utilization ${pctText(d.rental.dollar_utilization)}` : 'dollar utilization hidden']} href="/rentals" linkLabel="Rentals" />
            </div>
          </Section>
          {!d.absorption.available && <InlineNotice tone="info" title="Service absorption needs Merit Books.">Absorption compares parts, service and rental gross profit with the store’s fixed expense, which Merit Books has not exposed yet.</InlineNotice>}
        </>
      )}
    </div>
  );
}
