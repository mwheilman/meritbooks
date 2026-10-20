/**
 * DL-4 — Aged unit, and DL-12 — Demo / rental on floor plan (FPB §6).
 *
 *   DL-4 age   days in stock passed an edge of the client's `aging_buckets` →
 *              MEDIUM, keyed per unit + the highest edge crossed, so a unit re-fires
 *              only when it crosses the NEXT edge (the prior edge's row expires).
 *   DL-4 term  a live note's maturity within `term_warning_days` (or already past) →
 *              HIGH, keyed per unit + note.
 *   DL-12      a DEMO-condition or RENTAL-status unit carrying a live note whose
 *              program has no demo terms (`curtail_demos = false`, or no program) → LOW.
 */

import { diffDays } from '@/lib/dealer/dates';
import { bucketsFromEdges } from '@/lib/dealer/engine/summary';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dateLabel } from '@/lib/dealer/ui/format';
import { fetchAll } from '@/lib/supabase/fetch-all';
import { DEALER_FEATURES, money, plural, readFail, type ClientScan, type DealerDetectorDef, type DealerFinding } from './shared';

export interface AgingUnitIn {
  unit_id: string;
  serial_number: string;
  condition: string;
  status: string;
  is_consignment: boolean;
  cost_cents: number;
  received_date: string | null;
  note_id: string | null;
  principal_balance_cents: number | null;
  maturity_date: string | null;
}

/** Sorted, de-duplicated positive edges (same rule as D1's bucketsFromEdges). */
export function agingEdges(edges: number[]): number[] {
  return bucketsFromEdges(edges)
    .map((b) => b.maxDays)
    .filter((x): x is number => x != null);
}

/** The highest edge a unit has passed (days > edge), or null. */
export function crossedEdge(days: number, edges: number[]): number | null {
  let hit: number | null = null;
  for (const e of agingEdges(edges)) if (days > e) hit = e;
  return hit;
}

export function agedUnitFindings(input: { asOf: string; edges: number[]; termWarningDays: number; units: AgingUnitIn[] }): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const u of input.units) {
    if (u.is_consignment) continue;
    if (u.received_date) {
      const days = diffDays(u.received_date, input.asOf);
      const edge = days >= 0 ? crossedEdge(days, input.edges) : null;
      if (edge != null) {
        out.push({
          control: 'DL-4',
          kind: 'age',
          dedupKey: `DL-4:${u.unit_id}:age:${edge}`,
          severity: 'MEDIUM',
          amountAtRiskCents: Math.max(0, u.cost_cents),
          title: `Aged unit: serial ${u.serial_number} · ${plural(days, 'day')} in stock (past ${edge}) · ${money(u.cost_cents)}`,
          reason: `Serial ${u.serial_number} has been in stock since ${dateLabel(u.received_date)} — ${plural(days, 'day')}, past the ${edge}-day aging mark. Aged units tie up floor-plan credit and lose value.`,
          question: 'Decide a plan for this unit: price it to move, transfer it, or review its value for a write-down.',
          href: dealerLinks.unit(u.unit_id),
          subjects: { unit_id: u.unit_id, note_id: u.note_id },
          subjectTable: 'dealer_units',
          subjectId: u.unit_id,
          facts: { days_in_stock: days, edge, received_date: u.received_date },
        });
      }
    }
    if (u.note_id && u.maturity_date) {
      const toMaturity = diffDays(input.asOf, u.maturity_date);
      if (toMaturity <= input.termWarningDays) {
        const principal = Math.max(0, u.principal_balance_cents ?? 0);
        out.push({
          control: 'DL-4',
          kind: 'term',
          dedupKey: `DL-4:${u.unit_id}:term:${u.note_id}`,
          severity: 'HIGH',
          amountAtRiskCents: principal,
          title:
            toMaturity >= 0
              ? `Unit nearing its floor-plan term: serial ${u.serial_number} · matures in ${plural(toMaturity, 'day')} · ${money(principal)}`
              : `Unit past its floor-plan term: serial ${u.serial_number} · matured ${plural(-toMaturity, 'day')} ago · ${money(principal)}`,
          reason: `The floor-plan note on serial ${u.serial_number} matures ${dateLabel(u.maturity_date)}. At maturity the lender expects the full ${money(principal)} whether or not the unit has sold.`,
          question: 'Plan the payoff (or ask the lender for an extension) before the note matures.',
          href: dealerLinks.note(u.note_id),
          subjects: { unit_id: u.unit_id, note_id: u.note_id },
          subjectTable: 'floor_plan_notes',
          subjectId: u.note_id,
          facts: { maturity_date: u.maturity_date, days_to_maturity: toMaturity },
        });
      }
    }
  }
  return out;
}

async function loadAging(c: ClientScan): Promise<AgingUnitIn[]> {
  const res = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('v_unit_aging')
        .select('unit_id, serial_number, condition, status, is_consignment, cost_cents, received_date, note_id, principal_balance_cents, maturity_date')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId),
    { label: 'dealer unit aging', orderBy: 'unit_id' },
  );
  if (res.error) readFail('Unit aging lookup failed', res.error);
  return (res.data ?? []).map((r) => ({
    unit_id: r.unit_id as string,
    serial_number: String(r.serial_number ?? ''),
    condition: String(r.condition ?? ''),
    status: String(r.status ?? ''),
    is_consignment: r.is_consignment === true,
    cost_cents: Number(r.cost_cents ?? 0),
    received_date: (r.received_date as string | null) ?? null,
    note_id: (r.note_id as string | null) ?? null,
    principal_balance_cents: r.principal_balance_cents == null ? null : Number(r.principal_balance_cents),
    maturity_date: (r.maturity_date as string | null) ?? null,
  }));
}

export const AGED_UNIT_DETECTOR: DealerDetectorDef = {
  key: 'dealer_aged_unit',
  feature: DEALER_FEATURES.AGED_UNIT,
  control: 'DL-4',
  label: 'Aged unit / nearing floor-plan term',
  collect: async (c) =>
    agedUnitFindings({ asOf: c.asOf, edges: c.settings.aging_buckets, termWarningDays: c.settings.term_warning_days, units: await loadAging(c) }),
};

// ── DL-12 ─────────────────────────────────────────────────────────────────────

export interface DemoUnitIn extends AgingUnitIn {
  program: { id: string; name: string; curtail_demos: boolean } | null;
}

export function demoOnFloorFindings(units: DemoUnitIn[]): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const u of units) {
    if (!u.note_id) continue;
    const demo = u.condition === 'DEMO';
    const rental = u.status === 'RENTAL';
    if (!demo && !rental) continue;
    if (u.program?.curtail_demos) continue;
    const what = demo ? 'Demo' : 'Rental';
    const principal = Math.max(0, u.principal_balance_cents ?? 0);
    out.push({
      control: 'DL-12',
      kind: demo ? 'demo' : 'rental',
      dedupKey: `DL-12:${u.note_id}`,
      severity: 'LOW',
      amountAtRiskCents: principal,
      title: `${what} unit on floor plan without demo terms: serial ${u.serial_number} · ${money(principal)}`,
      reason: `Serial ${u.serial_number} is in ${demo ? 'demo' : 'rental'} use but is floored on ${u.program ? `the "${u.program.name}" program, which has no demo terms` : 'a note with no program'}. Many lenders require demos and rentals to be paid down or moved to a demo program.`,
      question: 'Check the lender agreement: pay the unit down, move it to a demo program, or record the demo terms on the program.',
      href: dealerLinks.unit(u.unit_id),
      subjects: { unit_id: u.unit_id, note_id: u.note_id, program_id: u.program?.id ?? null },
      subjectTable: 'floor_plan_notes',
      subjectId: u.note_id,
    });
  }
  return out;
}

async function collectDemo(c: ClientScan): Promise<DealerFinding[]> {
  const units = (await loadAging(c)).filter((u) => u.note_id && (u.condition === 'DEMO' || u.status === 'RENTAL'));
  if (units.length === 0) return [];
  const noteIds = units.map((u) => u.note_id as string);
  const programOf = new Map<string, string | null>();
  for (let i = 0; i < noteIds.length; i += 200) {
    const res = await c.db.from('floor_plan_notes').select('id, program_id').eq('org_id', c.orgId).in('id', noteIds.slice(i, i + 200));
    if (res.error) readFail('Notes lookup failed', res.error);
    for (const n of (res.data ?? []) as Array<{ id: string; program_id: string | null }>) programOf.set(n.id, n.program_id);
  }
  const programIds = [...new Set([...programOf.values()].filter((x): x is string => !!x))];
  const programs = new Map<string, { id: string; name: string; curtail_demos: boolean }>();
  if (programIds.length) {
    const res = await c.db.from('floor_plan_programs').select('id, name, curtail_demos').eq('org_id', c.orgId).in('id', programIds);
    if (res.error) readFail('Programs lookup failed', res.error);
    for (const p of (res.data ?? []) as Array<{ id: string; name: string; curtail_demos: boolean }>) programs.set(p.id, p);
  }
  return demoOnFloorFindings(
    units.map((u) => {
      const pid = programOf.get(u.note_id as string) ?? null;
      return { ...u, program: pid ? programs.get(pid) ?? null : null };
    }),
  );
}

export const DEMO_ON_FLOOR_DETECTOR: DealerDetectorDef = {
  key: 'dealer_demo_on_floor',
  feature: DEALER_FEATURES.DEMO_ON_FLOOR,
  control: 'DL-12',
  label: 'Demo or rental unit on floor plan',
  collect: collectDemo,
};
