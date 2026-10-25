'use client';

import Link from 'next/link';
import { KV, Status, money } from '@meritbooks/merit-ui';
import { Section } from '@/components/ops/common/bits';
import { BoardState, Empty, day, useBoard } from '../common/depth';

interface Ev { at: string; kind: string; title: string; detail: Record<string, unknown> | null; ref_table: string | null; ref_id: string | null }
interface Data { unit: { id: string; serial_number: string | null; make: string | null; model: string | null; model_year: number | null; customer_id: string | null; status?: string | null; stock_number?: string | null }; events: Ev[] }

const KIND_WORD: Record<string, string> = { received: 'Received', cost: 'Cost added', deal: 'Deal', trade: 'Traded in', work_order: 'Repair order', warranty: 'Warranty claim', rental: 'Rental', activity: 'Activity', delivered: 'Delivered', meter: 'Meter' };

function hrefOf(e: Ev): string | null {
  if (!e.ref_id) return null;
  switch (e.ref_table) {
    case 'work_orders': return `/work-orders?wo=${e.ref_id}`;
    case 'warranty_claims': return `/warranty/${e.ref_id}`;
    case 'dealer_deals': return `/deals/${e.ref_id}`;
    case 'rental_contracts': return `/rentals/${e.ref_id}/inspection`;
    default: return null;
  }
}

function detailText(d: Record<string, unknown> | null): string {
  if (!d) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null || v === '') continue;
    if (k.endsWith('_cents') && typeof v === 'number') parts.push(`${k.replace(/_cents$/, '').replace(/_/g, ' ')} ${money(v)}`);
    else if (typeof v === 'string' || typeof v === 'number') parts.push(`${k.replace(/_/g, ' ')} ${v}`);
  }
  return parts.join(' · ');
}

/** One unit's whole life, newest first; each event opens its record. */
export function UnitTimeline({ unitId, today }: { unitId: string; today: string }) {
  const b = useBoard<Data>(`/api/dealer/timeline/${unitId}`);
  const state = <BoardState b={b} what="The unit timeline" />;
  if (!b.data) return state;
  const { unit, events } = b.data;
  return (
    <div className="stack">
      <KV items={[
        { term: 'Unit', value: [unit.model_year, unit.make, unit.model].filter(Boolean).join(' ') || '—' },
        { term: 'Serial', value: unit.serial_number ?? '—' },
        ...(unit.stock_number ? [{ term: 'Stock number', value: unit.stock_number }] : []),
        ...(unit.status ? [{ term: 'Status', value: <Status kind="track" pip="open">{unit.status.replace(/_/g, ' ').toLowerCase()}</Status> }] : []),
      ]} />
      <Section title="Timeline" meta={`${events.length} events`}>
        {events.length === 0 ? <Empty title="Nothing recorded yet" body="Receiving, deals, repair orders, claims, rentals and meter readings for this unit show here as they happen." /> : (
          <ol className="ops-agenda" aria-label="Unit events">
            {[...events].sort((a, b2) => b2.at.localeCompare(a.at)).map((e, i) => {
              const href = hrefOf(e);
              return (
                <li key={`${e.at}${i}`}>
                  <span className="d">{day(e.at, today)}</span>
                  <span>{href ? <Link className="nlink" href={href}>{e.title}</Link> : e.title}<span className="l2"> · {KIND_WORD[e.kind] ?? e.kind}{detailText(e.detail) ? ` · ${detailText(e.detail)}` : ''}</span></span>
                </li>
              );
            })}
          </ol>
        )}
      </Section>
    </div>
  );
}
