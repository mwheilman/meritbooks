'use client';

import { useState } from 'react';
import { Button, ButtonRow, Check, Field, InlineNotice, Input, Select, Seg, Textarea, money } from '@meritbooks/merit-ui';
import { useShell } from '@/components/shell/ShellContext';
import { Failure, Section } from '@/components/ops/common/bits';
import { BoardState, centsFrom, day, useBoard, useDo } from '../common/depth';

type Cond = 'OK' | 'SCRATCH' | 'DENT' | 'CRACK' | 'BROKEN' | 'MISSING';
const CONDS: Cond[] = ['OK', 'SCRATCH', 'DENT', 'CRACK', 'BROKEN', 'MISSING'];
const ZONES = ['Hood / engine cover', 'Left side', 'Right side', 'Front', 'Rear', 'Seat / cab', 'Attachment / deck', 'Tires / tracks', 'Glass', 'Controls'];

interface Inspection { id: string; phase: 'OUT' | 'IN'; meter: number; fuel_eighths: number; clean: boolean; zones: Array<{ zone: string; condition: Cond; note?: string | null }>; notes: string | null; inspected_at: string }
interface Compare { ready: boolean; reason?: string; has_out: boolean; new_damage?: Array<{ zone: string; out: string; in: string; note: string | null; charge_cents: number | null }>; damage_cents?: number; fuel_short_eighths?: number; fuel_cents?: number; cleaning_cents?: number; overtime_hours?: number; overtime_cents?: number; suggested_total_cents?: number }

/** Check-out and check-in walk-arounds, the side-by-side compare, and the charges it suggests. */
export function InspectionView({ contractId, today }: { contractId: string; today: string }) {
  const { readOnly } = useShell();
  const b = useBoard<{ inspections: Inspection[]; compare: Compare }>(`/api/dealer/inspection/${contractId}`);
  const { run, busy, error } = useDo(b.reload);
  const [phase, setPhase] = useState<'OUT' | 'IN'>('OUT');
  const [meter, setMeter] = useState('');
  const [fuel, setFuel] = useState('8');
  const [clean, setClean] = useState(true);
  const [zones, setZones] = useState<Record<string, Cond>>({});
  const [notes, setNotes] = useState('');
  const [charges, setCharges] = useState<{ damage: string; fuel: string; cleaning: string } | null>(null);

  const state = <BoardState b={b} what="The inspection" />;
  if (!b.data) return state;
  const { inspections, compare: c } = b.data;
  const hasOut = inspections.some((i) => i.phase === 'OUT');
  const ch = charges ?? { damage: c.damage_cents != null ? (c.damage_cents / 100).toFixed(2) : '0', fuel: c.fuel_cents != null ? (c.fuel_cents / 100).toFixed(2) : '0', cleaning: c.cleaning_cents != null ? (c.cleaning_cents / 100).toFixed(2) : '0' };

  return (
    <div className="stack">
      {error && <Failure text={error} />}
      {!readOnly && (
        <Section title="Walk-around" meta="Mark only what is not OK">
          <Seg<'OUT' | 'IN'> aria-label="Inspection" value={hasOut ? 'IN' : phase} onChange={setPhase} items={[{ value: 'OUT', label: 'Check-out' }, { value: 'IN', label: 'Check-in' }]} />
          <div className="ops-toolbar" style={{ marginTop: 8 }}>
            <Field label="Hour meter"><Input inputMode="decimal" value={meter} onChange={(e) => setMeter(e.target.value)} style={{ width: 110 }} /></Field>
            <Field label="Fuel (eighths)"><Select value={fuel} onChange={(e) => setFuel(e.target.value)}>{Array.from({ length: 9 }, (_, i) => <option key={i} value={String(i)}>{i}/8</option>)}</Select></Field>
            <Check label="Clean" checked={clean} onChange={(e) => setClean(e.target.checked)} />
          </div>
          <table className="ops-mini" aria-label="Zones">
            <tbody>{ZONES.map((z) => (
              <tr key={z}><td>{z}</td><td><Select aria-label={`${z} condition`} value={zones[z] ?? 'OK'} onChange={(e) => setZones({ ...zones, [z]: e.target.value as Cond })}>{CONDS.map((x) => <option key={x} value={x}>{x.toLowerCase()}</option>)}</Select></td></tr>
            ))}</tbody>
          </table>
          <Field label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <ButtonRow>
            <Button variant="primary" disabled={!meter.trim() || !Number.isFinite(Number(meter)) || busy === 'rec'} onClick={async () => {
              const ph = hasOut ? 'IN' : phase;
              if (await run('rec', `/api/dealer/inspection/${contractId}`, { op: 'record', phase: ph, meter: Number(meter), fuelEighths: Number(fuel), clean, zones: Object.entries(zones).filter(([, v]) => v !== 'OK').map(([zone, condition]) => ({ zone, condition })), notes: notes || null }, ph === 'OUT' ? 'Recorded the check-out' : 'Recorded the check-in')) { setZones({}); setNotes(''); setMeter(''); setCharges(null); }
            }}>Record {hasOut ? 'check-in' : phase === 'OUT' ? 'check-out' : 'check-in'}</Button>
          </ButtonRow>
        </Section>
      )}
      <Section title="Out vs in" meta={c.ready ? 'Compared' : c.reason ?? ''}>
        {!c.ready ? <p className="t-cap">{c.has_out ? 'Record the check-in to compare.' : 'Record the check-out when the unit leaves.'}</p> : (
          <>
            {(c.new_damage ?? []).length === 0 ? <p className="t-cap">No new damage.</p> : (
              <table className="ops-mini" aria-label="New damage">
                <thead><tr><th>Zone</th><th>Out</th><th>In</th><th className="n">Charge</th></tr></thead>
                <tbody>{(c.new_damage ?? []).map((x) => <tr key={x.zone}><td>{x.zone}</td><td>{x.out.toLowerCase()}</td><td className="neg">{x.in.toLowerCase()}</td><td className="n">{x.charge_cents == null ? '—' : money(x.charge_cents)}</td></tr>)}</tbody>
              </table>
            )}
            <p className="t-cap">Fuel short {c.fuel_short_eighths ?? 0}/8 · overtime {c.overtime_hours ?? 0} h · suggested {money(c.suggested_total_cents ?? 0)}</p>
            {!readOnly && (
              <div className="ops-toolbar">
                <Field label="Damage"><Input inputMode="decimal" value={ch.damage} onChange={(e) => setCharges({ ...ch, damage: e.target.value })} style={{ width: 110 }} /></Field>
                <Field label="Fuel"><Input inputMode="decimal" value={ch.fuel} onChange={(e) => setCharges({ ...ch, fuel: e.target.value })} style={{ width: 100 }} /></Field>
                <Field label="Cleaning"><Input inputMode="decimal" value={ch.cleaning} onChange={(e) => setCharges({ ...ch, cleaning: e.target.value })} style={{ width: 100 }} /></Field>
                <Button variant="primary" disabled={busy === 'chg' || [ch.damage, ch.fuel, ch.cleaning].some((x) => centsFrom(x) == null)} onClick={() => void run('chg', `/api/dealer/inspection/${contractId}`, { op: 'charges', damageCents: centsFrom(ch.damage), fuelCents: centsFrom(ch.fuel), cleaningCents: centsFrom(ch.cleaning) }, 'Added the charges to the rental')}>Add charges to the rental</Button>
              </div>
            )}
          </>
        )}
      </Section>
      <Section title="Inspections" meta={`${inspections.length} recorded`}>
        {inspections.length === 0 ? <InlineNotice tone="info" title="No inspections yet.">Walk the unit with the customer at check-out.</InlineNotice> : (
          <table className="ops-mini" aria-label="Inspections">
            <thead><tr><th>When</th><th>Phase</th><th className="n">Meter</th><th className="n">Fuel</th><th>Clean</th><th>Marked</th></tr></thead>
            <tbody>{inspections.map((i) => <tr key={i.id}><td>{day(i.inspected_at, today)}</td><td>{i.phase === 'OUT' ? 'Check-out' : 'Check-in'}</td><td className="n">{i.meter}</td><td className="n">{i.fuel_eighths}/8</td><td>{i.clean ? 'Yes' : 'No'}</td><td>{i.zones.filter((z) => z.condition !== 'OK').map((z) => `${z.zone}: ${z.condition.toLowerCase()}`).join(' · ') || 'All OK'}</td></tr>)}</tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
