/**
 * DL-2 — Curtailment due / missed, and DL-10 — Floor-plan line utilization /
 * credit hold (FPB §6). Pure scorers + RLS collectors.
 *
 *   DL-2  DUE within `curtailment_warn_days`           → MEDIUM  key DL-2:<curtailment>:due
 *         MISSED, or DUE with the date already passed   → HIGH    key DL-2:<curtailment>:missed
 *         (the due row expires when the missed row takes over; paying / waiving
 *          clears both). Only curtailments on a LIVE note count.
 *   DL-10 principal ≥ `line_utilization_warn_bps` of the limit → MEDIUM
 *         line status CREDIT_HOLD                              → HIGH
 *         keyed per line + month so a dismissed warning can recur next month.
 */

import { addDays, diffDays } from '@/lib/dealer/dates';
import { LIVE_NOTE_STATUSES, type NoteStatus } from '@/lib/dealer/types';
import { dealerLinks } from '@/lib/dealer/ui/links';
import { dateLabel, bpsToPct } from '@/lib/dealer/ui/format';
import { fetchAll } from '@/lib/supabase/fetch-all';
import {
  DEALER_FEATURES,
  money,
  monthKey,
  plural,
  readFail,
  subjectLabel,
  type ClientScan,
  type DealerDetectorDef,
  type DealerFinding,
} from './shared';

// ── DL-2 ──────────────────────────────────────────────────────────────────────

export interface CurtailmentIn {
  id: string;
  note_id: string;
  sequence: number;
  due_date: string;
  amount_cents: number;
  status: 'DUE' | 'PAID' | 'WAIVED' | 'MISSED';
}

export interface CurtailmentNote {
  id: string;
  status: NoteStatus;
  lender_invoice_number: string;
  unit_id: string | null;
  serial_number: string | null;
}

export function curtailmentFindings(input: {
  asOf: string;
  warnDays: number;
  curtailments: CurtailmentIn[];
  notes: Map<string, CurtailmentNote>;
}): DealerFinding[] {
  const out: DealerFinding[] = [];
  for (const c of input.curtailments) {
    const note = input.notes.get(c.note_id);
    if (!note || !LIVE_NOTE_STATUSES.includes(note.status)) continue;
    if (c.status !== 'DUE' && c.status !== 'MISSED') continue;
    const daysToDue = diffDays(input.asOf, c.due_date);
    const subject = subjectLabel(note.serial_number, note.lender_invoice_number);
    const base = {
      control: 'DL-2',
      amountAtRiskCents: c.amount_cents,
      href: dealerLinks.note(note.id),
      subjects: { curtailment_id: c.id, note_id: note.id, unit_id: note.unit_id },
      subjectTable: 'floor_plan_curtailments',
      subjectId: c.id,
      facts: { due_date: c.due_date, sequence: c.sequence, days_to_due: daysToDue },
    };
    if (c.status === 'MISSED' || daysToDue < 0) {
      const late = Math.max(0, -daysToDue);
      out.push({
        ...base,
        kind: 'missed',
        dedupKey: `DL-2:${c.id}:missed`,
        severity: 'HIGH',
        title: `Curtailment missed: ${subject} · ${money(c.amount_cents)} was due ${dateLabel(c.due_date)}`,
        reason: `Curtailment payment ${c.sequence} of ${money(c.amount_cents)} on the floor-plan note for ${subject} was due ${dateLabel(c.due_date)}${late > 0 ? ` (${plural(late, 'day')} ago)` : ''} and has not been paid. Lenders can charge penalty interest or call the note.`,
        question: 'Pay the curtailment now (or record that it was paid), or ask an approver to waive it with a reason.',
      });
      continue;
    }
    if (daysToDue <= input.warnDays) {
      out.push({
        ...base,
        kind: 'due',
        dedupKey: `DL-2:${c.id}:due`,
        severity: 'MEDIUM',
        title: `Curtailment due: ${subject} · ${money(c.amount_cents)} due ${daysToDue === 0 ? 'today' : `in ${plural(daysToDue, 'day')}`}`,
        reason: `Curtailment payment ${c.sequence} of ${money(c.amount_cents)} on the floor-plan note for ${subject} is due ${dateLabel(c.due_date)}.`,
        question: 'Schedule the curtailment payment before the due date.',
      });
    }
  }
  return out;
}

async function collectCurtailments(c: ClientScan): Promise<DealerFinding[]> {
  const horizon = addDays(c.asOf, Math.max(0, c.settings.curtailment_warn_days));
  const { data, error } = await fetchAll<Record<string, unknown>>(
    () =>
      c.db
        .from('floor_plan_curtailments')
        .select('id, note_id, sequence, due_date, amount_cents, status')
        .eq('org_id', c.orgId)
        .eq('location_id', c.locationId)
        .in('status', ['DUE', 'MISSED'])
        .lte('due_date', horizon),
    { label: 'DL-2 curtailments' },
  );
  if (error) readFail('Curtailments lookup failed', error);
  const curtailments = (data ?? []).map((r) => ({
    id: r.id as string,
    note_id: r.note_id as string,
    sequence: Number(r.sequence),
    due_date: r.due_date as string,
    amount_cents: Number(r.amount_cents),
    status: r.status as CurtailmentIn['status'],
  }));
  if (curtailments.length === 0) return [];
  const noteIds = [...new Set(curtailments.map((x) => x.note_id))];
  const notes = new Map<string, CurtailmentNote>();
  for (let i = 0; i < noteIds.length; i += 200) {
    const res = await c.db
      .from('floor_plan_notes')
      .select('id, status, lender_invoice_number, unit_id')
      .eq('org_id', c.orgId)
      .in('id', noteIds.slice(i, i + 200));
    if (res.error) readFail('Notes lookup failed', res.error);
    for (const n of (res.data ?? []) as Array<{ id: string; status: NoteStatus; lender_invoice_number: string; unit_id: string | null }>) {
      notes.set(n.id, { ...n, serial_number: null });
    }
  }
  const unitIds = [...new Set([...notes.values()].map((n) => n.unit_id).filter((x): x is string => !!x))];
  if (unitIds.length) {
    const serials = new Map<string, string>();
    for (let i = 0; i < unitIds.length; i += 200) {
      const res = await c.db.from('dealer_units').select('id, serial_number').eq('org_id', c.orgId).in('id', unitIds.slice(i, i + 200));
      if (res.error) readFail('Units lookup failed', res.error);
      for (const u of (res.data ?? []) as Array<{ id: string; serial_number: string }>) serials.set(u.id, u.serial_number);
    }
    for (const n of notes.values()) if (n.unit_id) n.serial_number = serials.get(n.unit_id) ?? null;
  }
  return curtailmentFindings({ asOf: c.asOf, warnDays: c.settings.curtailment_warn_days, curtailments, notes });
}

export const CURTAILMENT_DETECTOR: DealerDetectorDef = {
  key: 'dealer_curtailment',
  feature: DEALER_FEATURES.CURTAILMENT,
  control: 'DL-2',
  label: 'Curtailment due or missed',
  collect: collectCurtailments,
};

// ── DL-10 ─────────────────────────────────────────────────────────────────────

export interface LineIn {
  lineId: string;
  lineName: string;
  lineStatus: string;
  creditLimitCents: number;
  principalCents: number;
}

export function lineUtilizationFindings(input: { asOf: string; warnBps: number; lines: LineIn[] }): DealerFinding[] {
  const out: DealerFinding[] = [];
  const month = monthKey(input.asOf);
  for (const l of input.lines) {
    if (l.lineStatus === 'CLOSED') continue;
    const base = {
      control: 'DL-10',
      href: dealerLinks.floorPlan('positions', { lineId: l.lineId }),
      subjects: { line_id: l.lineId },
      subjectTable: 'floor_plan_lines',
      subjectId: l.lineId,
    };
    if (l.lineStatus === 'CREDIT_HOLD') {
      out.push({
        ...base,
        kind: 'credit_hold',
        dedupKey: `DL-10:${l.lineId}:credit_hold:${month}`,
        severity: 'HIGH',
        amountAtRiskCents: l.principalCents,
        title: `Floor-plan line on credit hold: ${l.lineName} · ${money(l.principalCents)} outstanding`,
        reason: `The lender has put the line "${l.lineName}" on credit hold. New units can't be floored on it until the hold is lifted, and ${money(l.principalCents)} is outstanding.`,
        question: 'Contact the lender to find out why the line is on hold (often a sold-unpaid unit or a missed curtailment) and clear the cause.',
        facts: { credit_limit_cents: l.creditLimitCents, principal_cents: l.principalCents },
      });
    }
    if (l.creditLimitCents > 0) {
      const bps = Math.floor((l.principalCents * 10_000) / l.creditLimitCents);
      if (bps >= input.warnBps) {
        out.push({
          ...base,
          kind: 'utilization',
          dedupKey: `DL-10:${l.lineId}:utilization:${month}`,
          severity: 'MEDIUM',
          amountAtRiskCents: Math.max(0, l.principalCents - Math.floor((l.creditLimitCents * input.warnBps) / 10_000)),
          title: `Floor-plan line near its limit: ${l.lineName} · ${bpsToPct(bps, 1)} used`,
          reason: `${money(l.principalCents)} is outstanding on a ${money(l.creditLimitCents)} line (${bpsToPct(bps, 1)} used; the warning level is ${bpsToPct(input.warnBps, 0)}). New flooring may be refused.`,
          question: 'Pay down sold units or curtailments, or ask the lender for a temporary limit increase before the next order.',
          facts: { utilization_bps: bps, credit_limit_cents: l.creditLimitCents, principal_cents: l.principalCents },
        });
      }
    }
  }
  return out;
}

async function collectLines(c: ClientScan): Promise<DealerFinding[]> {
  const { data, error } = await c.db
    .from('v_floor_plan_position')
    .select('line_id, line_name, line_status, credit_limit_cents, principal_cents')
    .eq('org_id', c.orgId)
    .eq('location_id', c.locationId);
  if (error) readFail('Floor-plan positions lookup failed', error);
  const lines = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    lineId: r.line_id as string,
    lineName: String(r.line_name ?? 'Floor-plan line'),
    lineStatus: String(r.line_status ?? 'ACTIVE'),
    creditLimitCents: Number(r.credit_limit_cents ?? 0),
    principalCents: Number(r.principal_cents ?? 0),
  }));
  return lineUtilizationFindings({ asOf: c.asOf, warnBps: c.settings.line_utilization_warn_bps, lines });
}

export const LINE_UTILIZATION_DETECTOR: DealerDetectorDef = {
  key: 'dealer_line_utilization',
  feature: DEALER_FEATURES.LINE_UTILIZATION,
  control: 'DL-10',
  label: 'Floor-plan line utilization and credit hold',
  collect: collectLines,
};
