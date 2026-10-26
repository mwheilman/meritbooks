/**
 * Bills ↔ Projects commitments (migration 194) — the AP side of JOB_COMMITMENT.
 *
 *   planCommitmentMatches   before a bill is written: resolve / auto-pick the commitment line for
 *                           every job-tagged line, the default retainage % and any payment hold.
 *                           A no-op (empty plan) unless the org uses Projects.
 *   recordCommitmentMatches after the bill lines exist: write bill_commitment_matches, score the
 *                           3-way status, remember the hold.
 *   matchBillLine           match (or re-match) an existing bill line after the fact (intake, review).
 *   listCommitmentOptions   the open commitments for a vendor (+ job) with remaining amounts — what
 *                           bill entry / intake shows as suggestions.
 *   applyCommitmentHold     honour payment_hold like ON_HOLD on matched open bills, and give the
 *                           bills back their prior status when Projects releases it.
 *   rescoreCommitmentLines  3-way status: OVER_COMMITTED (billed > committed), BILLED_OVER_RECEIVED
 *                           (a PO line billed beyond what was received), NO_RECEIPT (receiving is in
 *                           use on the PO but this line has none), else OK. Warnings, never blocks.
 *
 * Writes go through writerFor(db) (bills / bill_lines are member-read-only, 171); route callers
 * hand in serviceWriter() after their permission check.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { scopedWriter, writerFor } from '@/lib/db/scoped-writer';
import { hasModule } from '@/lib/services/entitlements';

type DB = SupabaseClient;

export const COMMITMENT_HOLD_PREFIX = 'Projects commitment';
const HOLDABLE_BILL_STATUSES = ['PENDING', 'APPROVED', 'SCHEDULED', 'PARTIALLY_PAID'] as const;

export function commitmentHoldText(number: string, reason: string | null | undefined): string {
  return `${COMMITMENT_HOLD_PREFIX} ${number} is on payment hold${reason ? `: ${reason}` : ''}`.slice(0, 500);
}

export type ThreeWayStatus = 'OK' | 'BILLED_OVER_RECEIVED' | 'NO_RECEIPT' | 'OVER_COMMITTED';

/** PURE: 3-way status of one commitment line given what is billed against it. */
export function scoreThreeWay(args: {
  commitmentType: 'PO' | 'SUBCONTRACT';
  amountCents: number;
  receivedCents: number;
  billedCents: number;
  receivingInUse: boolean;
}): { status: ThreeWayStatus; varianceCents: number } {
  const { amountCents, receivedCents, billedCents } = args;
  if (billedCents > amountCents) return { status: 'OVER_COMMITTED', varianceCents: billedCents - amountCents };
  if (args.commitmentType === 'PO' && args.receivingInUse) {
    if (receivedCents === 0 && billedCents > 0) return { status: 'NO_RECEIPT', varianceCents: billedCents };
    if (billedCents > receivedCents) return { status: 'BILLED_OVER_RECEIVED', varianceCents: billedCents - receivedCents };
  }
  return { status: 'OK', varianceCents: 0 };
}

interface CommitmentHeader {
  id: string;
  location_id: string;
  job_id: string;
  vendor_id: string | null;
  number: string;
  commitment_type: 'PO' | 'SUBCONTRACT';
  status: string;
  active: boolean;
  retainage_pct: number | string;
  payment_hold: boolean;
  hold_reason: string | null;
  pm_commitment_id: string;
}

interface CommitmentLineRow {
  id: string;
  commitment_id: string;
  pm_commitment_line_id: string;
  line_no: number;
  cost_code_id: string | null;
  cost_code: string | null;
  cost_type: string | null;
  description: string;
  amount_cents: number | string;
  received_to_date_cents: number | string;
  removed: boolean;
}

const n = (v: unknown) => {
  const x = Number(v ?? 0);
  return Number.isFinite(x) ? x : 0;
};

/** Σ matched amount per commitment line over bills that are not voided. */
async function billedByLine(db: DB, orgId: string, lineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (lineIds.length === 0) return out;
  const { data, error } = await db.from('bill_commitment_matches').select('commitment_line_id, bill_id, amount_cents')
    .eq('org_id', orgId).in('commitment_line_id', lineIds);
  if (error) throw new Error(`read matches: ${error.message}`);
  const rows = (data ?? []) as { commitment_line_id: string; bill_id: string; amount_cents: number | string }[];
  const billIds = [...new Set(rows.map((r) => r.bill_id))];
  const voided = new Set<string>();
  if (billIds.length > 0) {
    const { data: bills } = await db.from('bills').select('id, status').eq('org_id', orgId).in('id', billIds);
    for (const b of (bills ?? []) as { id: string; status: string }[]) if (b.status === 'VOIDED') voided.add(b.id);
  }
  for (const r of rows) {
    if (voided.has(r.bill_id)) continue;
    out.set(r.commitment_line_id, (out.get(r.commitment_line_id) ?? 0) + n(r.amount_cents));
  }
  return out;
}

/** Re-score the 3-way status of every match on these commitment lines. */
export async function rescoreCommitmentLines(db: DB, orgId: string, lineIds: string[]): Promise<void> {
  if (lineIds.length === 0) return;
  const w = writerFor(db);
  const { data: lines, error } = await db.from('ap_commitment_lines')
    .select('id, commitment_id, amount_cents, received_to_date_cents').eq('org_id', orgId).in('id', lineIds);
  if (error) throw new Error(`read commitment lines: ${error.message}`);
  const ls = (lines ?? []) as { id: string; commitment_id: string; amount_cents: number | string; received_to_date_cents: number | string }[];
  if (ls.length === 0) return;
  const cmtIds = [...new Set(ls.map((l) => l.commitment_id))];
  const { data: heads } = await db.from('ap_commitments').select('id, commitment_type').eq('org_id', orgId).in('id', cmtIds);
  const typeOf = new Map(((heads ?? []) as { id: string; commitment_type: 'PO' | 'SUBCONTRACT' }[]).map((h) => [h.id, h.commitment_type]));
  const { data: allLines } = await db.from('ap_commitment_lines').select('commitment_id, received_to_date_cents').eq('org_id', orgId).in('commitment_id', cmtIds);
  const receivingInUse = new Set<string>();
  for (const l of (allLines ?? []) as { commitment_id: string; received_to_date_cents: number | string }[]) {
    if (n(l.received_to_date_cents) > 0) receivingInUse.add(l.commitment_id);
  }
  const billed = await billedByLine(db, orgId, ls.map((l) => l.id));
  for (const l of ls) {
    const s = scoreThreeWay({
      commitmentType: typeOf.get(l.commitment_id) ?? 'PO',
      amountCents: n(l.amount_cents),
      receivedCents: n(l.received_to_date_cents),
      billedCents: billed.get(l.id) ?? 0,
      receivingInUse: receivingInUse.has(l.commitment_id),
    });
    const { error: uErr } = await w.from('bill_commitment_matches')
      .update({ three_way_status: s.status, variance_cents: s.varianceCents, updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('commitment_line_id', l.id);
    if (uErr) throw new Error(`score matches: ${uErr.message}`);
  }
}

/**
 * Honour (or release) a commitment's payment hold on its matched open bills. A bill already
 * ON_HOLD for another reason is left alone; a release restores only bills this commitment held,
 * and only when no other commitment matched to the same bill is still on hold.
 */
export async function applyCommitmentHold(
  db: DB,
  orgId: string,
  commitmentId: string,
  args: { hold: boolean; number: string; reason: string | null },
): Promise<{ held: number; released: number }> {
  const w = writerFor(db);
  const now = new Date().toISOString();
  const { data: ms, error } = await db.from('bill_commitment_matches')
    .select('id, bill_id, held_by_commitment, status_before_hold').eq('org_id', orgId).eq('commitment_id', commitmentId);
  if (error) throw new Error(`read matches: ${error.message}`);
  const matches = (ms ?? []) as { id: string; bill_id: string; held_by_commitment: boolean; status_before_hold: string | null }[];
  const billIds = [...new Set(matches.map((m) => m.bill_id))];
  if (billIds.length === 0) return { held: 0, released: 0 };
  const { data: bs } = await db.from('bills').select('id, status, payment_hold_reason').eq('org_id', orgId).in('id', billIds);
  const bills = (bs ?? []) as { id: string; status: string; payment_hold_reason: string | null }[];
  const text = commitmentHoldText(args.number, args.reason);
  let held = 0;
  let released = 0;

  for (const b of bills) {
    const mine = matches.filter((m) => m.bill_id === b.id);
    if (args.hold) {
      if ((HOLDABLE_BILL_STATUSES as readonly string[]).includes(b.status)) {
        const { data: upd } = await w.from('bills')
          .update({ status: 'ON_HOLD', payment_hold_reason: text, updated_at: now })
          .eq('org_id', orgId).eq('id', b.id).eq('status', b.status).select('id');
        if (Array.isArray(upd) && upd.length > 0) {
          held++;
          await w.from('bill_commitment_matches').update({ held_by_commitment: true, status_before_hold: b.status, updated_at: now })
            .eq('org_id', orgId).eq('bill_id', b.id).eq('commitment_id', commitmentId);
        }
      } else if (b.status === 'ON_HOLD' && mine.some((m) => m.held_by_commitment) && b.payment_hold_reason?.startsWith(COMMITMENT_HOLD_PREFIX)) {
        await w.from('bills').update({ payment_hold_reason: text, updated_at: now }).eq('org_id', orgId).eq('id', b.id).eq('status', 'ON_HOLD');
      }
      continue;
    }
    // release
    const heldByMe = mine.filter((m) => m.held_by_commitment);
    if (heldByMe.length === 0) continue;
    await w.from('bill_commitment_matches').update({ held_by_commitment: false, updated_at: now })
      .eq('org_id', orgId).eq('bill_id', b.id).eq('commitment_id', commitmentId);
    if (b.status !== 'ON_HOLD' || !b.payment_hold_reason?.startsWith(COMMITMENT_HOLD_PREFIX)) continue;
    // Another commitment on this bill still holding it?
    const { data: others } = await db.from('bill_commitment_matches').select('commitment_id').eq('org_id', orgId).eq('bill_id', b.id).eq('held_by_commitment', true);
    if (Array.isArray(others) && others.length > 0) continue;
    const restore = heldByMe[0].status_before_hold && heldByMe[0].status_before_hold !== 'ON_HOLD' ? heldByMe[0].status_before_hold : 'PENDING';
    const { data: upd } = await w.from('bills').update({ status: restore, payment_hold_reason: null, updated_at: now })
      .eq('org_id', orgId).eq('id', b.id).eq('status', 'ON_HOLD').select('id');
    if (Array.isArray(upd) && upd.length > 0) released++;
  }
  return { held, released };
}

// ─────────────────────────────────────────────────────────────────────────────
// Options / planning
// ─────────────────────────────────────────────────────────────────────────────

export interface CommitmentOptionLine {
  id: string;
  lineNo: number;
  costCode: string | null;
  costType: string | null;
  description: string;
  amountCents: number;
  receivedCents: number;
  billedCents: number;
  remainingCents: number;
}

export interface CommitmentOption {
  id: string;
  number: string;
  jobId: string;
  vendorId: string | null;
  commitmentType: 'PO' | 'SUBCONTRACT';
  retainagePct: number;
  paymentHold: boolean;
  holdReason: string | null;
  lines: CommitmentOptionLine[];
}

/** Open (active) commitments for a vendor, optionally one job, with what remains to bill. */
export async function listCommitmentOptions(
  db: DB,
  orgId: string,
  args: { vendorId: string; jobId?: string | null; locationId?: string | null },
): Promise<CommitmentOption[]> {
  let q = db.from('ap_commitments')
    .select('id, location_id, job_id, vendor_id, number, commitment_type, status, active, retainage_pct, payment_hold, hold_reason, pm_commitment_id')
    .eq('org_id', orgId).eq('vendor_id', args.vendorId).eq('active', true);
  if (args.jobId) q = q.eq('job_id', args.jobId);
  if (args.locationId) q = q.eq('location_id', args.locationId);
  const { data, error } = await q.order('number', { ascending: true }).limit(200);
  if (error) throw new Error(`read commitments: ${error.message}`);
  const heads = (data ?? []) as CommitmentHeader[];
  if (heads.length === 0) return [];
  const { data: ls, error: lErr } = await db.from('ap_commitment_lines')
    .select('id, commitment_id, pm_commitment_line_id, line_no, cost_code_id, cost_code, cost_type, description, amount_cents, received_to_date_cents, removed')
    .eq('org_id', orgId).in('commitment_id', heads.map((h) => h.id)).eq('removed', false).order('line_no', { ascending: true });
  if (lErr) throw new Error(`read commitment lines: ${lErr.message}`);
  const lines = (ls ?? []) as CommitmentLineRow[];
  const billed = await billedByLine(db, orgId, lines.map((l) => l.id));
  return heads.map((h) => ({
    id: h.id,
    number: h.number,
    jobId: h.job_id,
    vendorId: h.vendor_id,
    commitmentType: h.commitment_type,
    retainagePct: n(h.retainage_pct),
    paymentHold: h.payment_hold,
    holdReason: h.hold_reason,
    lines: lines.filter((l) => l.commitment_id === h.id).map((l) => {
      const amount = n(l.amount_cents);
      const b = billed.get(l.id) ?? 0;
      return {
        id: l.id, lineNo: l.line_no, costCode: l.cost_code, costType: l.cost_type, description: l.description,
        amountCents: amount, receivedCents: n(l.received_to_date_cents), billedCents: b, remainingCents: Math.max(0, amount - b),
      };
    }),
  }));
}

export interface PlanLineInput {
  /** Position in the bill's line list (0-based). */
  index: number;
  jobId: string | null;
  amountCents: number;
  costType?: string | null;
  /** Explicit choice (ap_commitment_lines.id). */
  commitmentLineId?: string | null;
}

export interface PlannedMatch {
  index: number;
  commitmentId: string;
  commitmentLineId: string;
  pmCommitmentLineId: string;
  costCodeRef: string | null;
  source: 'USER' | 'AUTO';
}

export interface CommitmentPlan {
  /** False when the org does not use Projects — nothing below applies. */
  applies: boolean;
  matches: PlannedMatch[];
  /** Job lines left unmatched that DO have open commitments for this vendor (show the picker). */
  unmatchedWithOptions: number[];
  /** Default bill retainage % (0..100) from the matched commitments, when they agree. */
  defaultRetainagePct: number | null;
  /** A matched commitment is on payment hold → the bill lands ON_HOLD with this reason. */
  holdReason: string | null;
  errors: string[];
}

export class CommitmentMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitmentMatchError';
  }
}

/**
 * Plan the commitment matches for a bill being entered. Explicit picks are validated (same org,
 * vendor and job; active; not a removed line). A job line with no pick is AUTO-matched only when
 * exactly one open commitment line exists for that vendor + job (and, when several, exactly one
 * whose cost type matches the bill line); otherwise it is left for a person (suggestions).
 */
export async function planCommitmentMatches(
  db: DB,
  orgId: string,
  args: { vendorId: string; locationId: string; lines: PlanLineInput[] },
): Promise<CommitmentPlan> {
  const empty: CommitmentPlan = { applies: false, matches: [], unmatchedWithOptions: [], defaultRetainagePct: null, holdReason: null, errors: [] };
  const jobLines = args.lines.filter((l) => l.jobId);
  if (jobLines.length === 0 && !args.lines.some((l) => l.commitmentLineId)) return empty;
  if (!(await hasModule(db, orgId, 'projects').catch(() => false))) return empty;

  const opts = await listCommitmentOptions(db, orgId, { vendorId: args.vendorId, locationId: args.locationId });
  const lineIndex = new Map<string, { c: CommitmentOption; l: CommitmentOptionLine }>();
  for (const c of opts) for (const l of c.lines) lineIndex.set(l.id, { c, l });
  const { data: pmIds } = opts.length
    ? await db.from('ap_commitment_lines').select('id, pm_commitment_line_id, cost_code_id, cost_code').eq('org_id', orgId).in('id', [...lineIndex.keys()])
    : { data: [] };
  const pmOf = new Map(((pmIds ?? []) as { id: string; pm_commitment_line_id: string; cost_code_id: string | null; cost_code: string | null }[])
    .map((r) => [r.id, r]));

  const plan: CommitmentPlan = { ...empty, applies: true };
  for (const line of args.lines) {
    if (line.commitmentLineId) {
      const hit = lineIndex.get(line.commitmentLineId);
      if (!hit) { plan.errors.push(`Line ${line.index + 1}: that commitment line is not an open commitment for this vendor`); continue; }
      if (line.jobId && hit.c.jobId !== line.jobId) { plan.errors.push(`Line ${line.index + 1}: commitment ${hit.c.number} belongs to a different job`); continue; }
      const pm = pmOf.get(hit.l.id);
      plan.matches.push({ index: line.index, commitmentId: hit.c.id, commitmentLineId: hit.l.id, pmCommitmentLineId: pm?.pm_commitment_line_id ?? '',
        costCodeRef: pm?.cost_code_id ?? pm?.cost_code ?? null, source: 'USER' });
      continue;
    }
    if (!line.jobId) continue;
    const candidates = opts.filter((c) => c.jobId === line.jobId).flatMap((c) => c.lines.map((l) => ({ c, l })));
    if (candidates.length === 0) continue;
    let pick = candidates.length === 1 ? candidates[0] : null;
    if (!pick && line.costType) {
      const typed = candidates.filter((x) => x.l.costType === line.costType);
      if (typed.length === 1) pick = typed[0];
    }
    if (!pick) {
      // Security review LOW: a held commitment can't be sidestepped by leaving the line unmatched —
      // the line must be matched (the bill then lands ON_HOLD and is released with the commitment).
      const held = candidates.find((x) => x.c.paymentHold);
      if (held) {
        plan.errors.push(`Line ${line.index + 1}: commitment ${held.c.number} for this job is on payment hold — match the line to its commitment line (the bill is held until Projects releases it)`);
        continue;
      }
      plan.unmatchedWithOptions.push(line.index);
      continue;
    }
    const pm = pmOf.get(pick.l.id);
    plan.matches.push({ index: line.index, commitmentId: pick.c.id, commitmentLineId: pick.l.id, pmCommitmentLineId: pm?.pm_commitment_line_id ?? '',
      costCodeRef: pm?.cost_code_id ?? pm?.cost_code ?? null, source: 'AUTO' });
  }

  const matched = [...new Set(plan.matches.map((m) => m.commitmentId))].map((id) => opts.find((c) => c.id === id)!).filter(Boolean);
  const pcts = [...new Set(matched.map((c) => c.retainagePct))];
  if (pcts.length === 1 && pcts[0] > 0) plan.defaultRetainagePct = Math.round(pcts[0] * 10000) / 100;
  const holding = matched.find((c) => c.paymentHold);
  if (holding) plan.holdReason = commitmentHoldText(holding.number, holding.holdReason);
  return plan;
}

/** Write the planned matches for a freshly inserted bill (line ids by position) and score them. */
export async function recordCommitmentMatches(
  db: DB,
  orgId: string,
  args: {
    billId: string;
    locationId: string;
    lines: Array<{ id: string; amount_cents: number }>;
    plan: CommitmentPlan;
    matchedBy: string | null;
    source?: 'USER' | 'AUTO' | 'INTAKE';
    heldStatusBefore?: string | null;
  },
): Promise<number> {
  if (!args.plan.applies || args.plan.matches.length === 0) return 0;
  const w = writerFor(db);
  const rows = args.plan.matches
    .filter((m) => args.lines[m.index])
    .map((m) => ({
      org_id: orgId,
      location_id: args.locationId,
      bill_id: args.billId,
      bill_line_id: args.lines[m.index].id,
      commitment_id: m.commitmentId,
      commitment_line_id: m.commitmentLineId,
      amount_cents: args.lines[m.index].amount_cents,
      match_source: args.source ?? m.source,
      held_by_commitment: !!args.plan.holdReason,
      status_before_hold: args.plan.holdReason ? args.heldStatusBefore ?? 'PENDING' : null,
      matched_by: args.matchedBy,
    }));
  if (rows.length === 0) return 0;
  const { error } = await w.from('bill_commitment_matches').insert(rows);
  if (error) throw new Error(`record commitment matches: ${error.message}`);
  await rescoreCommitmentLines(db, orgId, [...new Set(rows.map((r) => r.commitment_line_id))]);
  return rows.length;
}

/**
 * Match one existing bill line to a commitment line (or clear it with commitmentLineId = null).
 * Applies the commitment's hold to the bill if it is on hold. Returns the 3-way status.
 */
export async function matchBillLine(
  db: DB,
  orgId: string,
  args: { billLineId: string; commitmentLineId: string | null; matchedBy: string | null },
): Promise<{ status: ThreeWayStatus | null; held: boolean }> {
  const { data: bl } = await db.from('bill_lines').select('id, bill_id, amount_cents, job_id').eq('org_id', orgId).eq('id', args.billLineId).maybeSingle();
  const line = bl as { id: string; bill_id: string; amount_cents: number | string; job_id: string | null } | null;
  if (!line) throw new CommitmentMatchError('Bill line not found');
  const { data: bh } = await db.from('bills').select('id, vendor_id, location_id, status').eq('org_id', orgId).eq('id', line.bill_id).maybeSingle();
  const bill = bh as { id: string; vendor_id: string; location_id: string; status: string } | null;
  if (!bill) throw new CommitmentMatchError('Bill not found');
  if (bill.status === 'VOIDED' || bill.status === 'PAID') throw new CommitmentMatchError(`A ${bill.status.toLowerCase()} bill cannot be re-matched`);
  // Security review LOW: the service-role writer only after the bill's company is checked against
  // the caller's org + client scope (a member client escalates here; a service caller passes as-is).
  const w = await scopedWriter(db, orgId, [bill.location_id]);
  // …and a held commitment can't be sidestepped by clearing the match.
  if (!args.commitmentLineId && line.job_id) {
    const { data: heldRows } = await db.from('ap_commitments').select('number')
      .eq('org_id', orgId).eq('vendor_id', bill.vendor_id).eq('job_id', line.job_id).eq('active', true).eq('payment_hold', true).limit(1);
    const held = ((heldRows ?? []) as Array<{ number: string }>)[0];
    if (held) throw new CommitmentMatchError(`Commitment ${held.number} for this job is on payment hold — the line can be moved to another commitment line, but not left unmatched`);
  }

  const { data: prior } = await db.from('bill_commitment_matches').select('id, commitment_line_id').eq('org_id', orgId).eq('bill_line_id', line.id).maybeSingle();
  const priorRow = prior as { id: string; commitment_line_id: string } | null;
  if (priorRow) {
    await w.from('bill_commitment_matches').delete().eq('org_id', orgId).eq('id', priorRow.id);
    await rescoreCommitmentLines(db, orgId, [priorRow.commitment_line_id]);
  }
  if (!args.commitmentLineId) return { status: null, held: false };

  const plan = await planCommitmentMatches(db, orgId, {
    vendorId: bill.vendor_id, locationId: bill.location_id,
    lines: [{ index: 0, jobId: line.job_id, amountCents: n(line.amount_cents), commitmentLineId: args.commitmentLineId }],
  });
  if (!plan.applies) throw new CommitmentMatchError('This organization does not use Merit Projects commitments');
  if (plan.errors.length > 0) throw new CommitmentMatchError(plan.errors[0]);
  const willHold = !!plan.holdReason && (HOLDABLE_BILL_STATUSES as readonly string[]).includes(bill.status);
  await recordCommitmentMatches(db, orgId, {
    billId: bill.id, locationId: bill.location_id, lines: [{ id: line.id, amount_cents: n(line.amount_cents) }],
    plan: willHold ? plan : { ...plan, holdReason: null }, matchedBy: args.matchedBy, source: 'USER', heldStatusBefore: bill.status,
  });
  if (willHold) {
    await w.from('bills').update({ status: 'ON_HOLD', payment_hold_reason: plan.holdReason, updated_at: new Date().toISOString() })
      .eq('org_id', orgId).eq('id', bill.id).eq('status', bill.status);
  }
  // Enrich the line's open JOB_COST attribution so the next lifecycle event carries the commitment line.
  const m = plan.matches[0];
  await w.from('job_cost_attributions')
    .update({ commitment_line_ref: m.pmCommitmentLineId || null, cost_code_ref: m.costCodeRef, vendor_id: bill.vendor_id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId).eq('source_ref', line.id);
  const { data: after } = await db.from('bill_commitment_matches').select('three_way_status').eq('org_id', orgId).eq('bill_line_id', line.id).maybeSingle();
  return { status: ((after as { three_way_status: ThreeWayStatus } | null)?.three_way_status) ?? 'OK', held: willHold };
}
