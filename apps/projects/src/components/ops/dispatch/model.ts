/**
 * Dispatch board model: technician rows, their blocks for the day, capacity and the
 * suggested slot for a visit. Pure (unit-tested through dispatch-math and here).
 */
import {
  GRID_END_MIN, GRID_START_MIN, bookedMinutes, capacityOf, findOverlap, missingSkills, parseSlot, slotOnDay,
  type Block, type Capacity,
} from '@/lib/pm/ops/dispatch-math';
import { personName } from '@/lib/pm/ops/labels';
import type {
  AssignmentRow, CrewMemberRow, CrewRow, DispatchBoardRow, EmployeeRow, EmployeeSkillRow, SkillRow, WorkOrderRow,
} from '@/lib/pm/ops/types';

export interface TechRow {
  key: string;
  employeeId: string | null;
  crewId: string | null;
  name: string;
  crewName: string | null;
  skills: string[];
  capacityMinutes: number;
  blocks: Array<Block & { assignment: AssignmentRow; order: WorkOrderRow | null }>;
  capacity: Capacity;
}

export interface BoardInput {
  day: string;
  tz: string;
  assignments: ReadonlyArray<AssignmentRow>;
  orders: ReadonlyArray<WorkOrderRow>;
  crews: ReadonlyArray<CrewRow>;
  members: ReadonlyArray<CrewMemberRow>;
  employees: ReadonlyArray<EmployeeRow>;
  skills: ReadonlyArray<SkillRow>;
  employeeSkills: ReadonlyArray<EmployeeSkillRow>;
  board: ReadonlyArray<DispatchBoardRow>;
}

/** Skill codes an employee holds on `day` (expired certifications drop off, as in schedule_work_order). */
export function skillsOf(employeeId: string, day: string, skills: ReadonlyArray<SkillRow>, held: ReadonlyArray<EmployeeSkillRow>): string[] {
  const byId = new Map(skills.filter((s) => s.is_active).map((s) => [s.id, s.code]));
  return held
    .filter((h) => h.employee_id === employeeId && (!h.expires_on || h.expires_on >= day))
    .map((h) => byId.get(h.skill_id))
    .filter((c): c is string => !!c);
}

export function buildRows(i: BoardInput): TechRow[] {
  const activeCrews = new Map(i.crews.filter((c) => c.is_active).map((c) => [c.id, c]));
  const emp = new Map(i.employees.map((e) => [e.id, e]));
  const orders = new Map(i.orders.map((o) => [o.id, o]));
  const primary = new Map<string, CrewRow>();
  for (const m of i.members) {
    const c = activeCrews.get(m.crew_id);
    if (c && c.kind !== 'SUBCONTRACT' && (m.is_primary || !primary.has(m.employee_id))) primary.set(m.employee_id, c);
  }
  const people = new Set<string>([...primary.keys(), ...i.assignments.map((a) => a.employee_id).filter((x): x is string => !!x)]);
  const viewCap = new Map(i.board.filter((b) => b.employee_id).map((b) => [b.employee_id!, b.capacity_minutes]));

  const blocksFor = (match: (a: AssignmentRow) => boolean) =>
    i.assignments
      .filter(match)
      .map((a) => {
        const s = parseSlot(a.slot);
        const iv = s ? slotOnDay(s, i.day, i.tz) : null;
        if (!iv) return null;
        const o = orders.get(a.work_order_id) ?? null;
        return { id: a.id, label: o?.number ?? 'Visit', start: iv.start, end: iv.end, assignment: a, order: o };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .sort((a, b) => a.start - b.start);

  const rows: TechRow[] = [...people].map((id) => {
    const e = emp.get(id);
    const crew = primary.get(id) ?? null;
    const cap = viewCap.get(id) ?? crew?.capacity_minutes_per_day ?? 480;
    const blocks = blocksFor((a) => a.employee_id === id);
    return {
      key: `emp:${id}`, employeeId: id, crewId: crew?.id ?? null, name: e ? personName(e) : 'Former employee', crewName: crew?.name ?? null,
      skills: skillsOf(id, i.day, i.skills, i.employeeSkills), capacityMinutes: cap, blocks,
      capacity: capacityOf(bookedMinutes(blocks), cap),
    };
  });

  // subcontract crews book as the crew (no employees on the slot)
  for (const c of activeCrews.values()) {
    if (c.kind !== 'SUBCONTRACT') continue;
    const blocks = blocksFor((a) => !a.employee_id && a.crew_id === c.id);
    rows.push({
      key: `crew:${c.id}`, employeeId: null, crewId: c.id, name: c.name, crewName: 'Subcontract crew', skills: [],
      capacityMinutes: c.capacity_minutes_per_day, blocks, capacity: capacityOf(bookedMinutes(blocks), c.capacity_minutes_per_day),
    });
  }
  return rows.sort((a, b) => (a.crewName ?? '').localeCompare(b.crewName ?? '') || a.name.localeCompare(b.name));
}

export interface Suggestion {
  techKey: string;
  start: number;
}

/**
 * The earliest free slot (15-minute steps, inside the visible day) on a technician who holds the
 * required skills; ties go to the least-booked technician. `notBefore` keeps today's suggestions
 * in the future and honours the customer's arrival window.
 */
export function suggestSlot(rows: ReadonlyArray<TechRow>, duration: number, required: ReadonlyArray<string>, notBefore: number, ignoreWo?: string): Suggestion | null {
  let best: { s: Suggestion; booked: number } | null = null;
  const from = Math.max(GRID_START_MIN, Math.ceil(notBefore / 15) * 15);
  for (const r of rows) {
    if (required.length && r.employeeId && missingSkills(required, r.skills).length) continue;
    const blocks = r.blocks.filter((b) => b.assignment.work_order_id !== ignoreWo);
    for (let m = from; m + duration <= GRID_END_MIN; m += 15) {
      if (!findOverlap(blocks, { start: m, end: m + duration })) {
        if (!best || m < best.s.start || (m === best.s.start && r.capacity.booked < best.booked)) best = { s: { techKey: r.key, start: m }, booked: r.capacity.booked };
        break;
      }
    }
  }
  return best?.s ?? null;
}
