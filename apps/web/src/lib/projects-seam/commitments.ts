/**
 * JOB_COMMITMENT consumer (Projects → Books, schema_version 1, migration 194).
 *
 * Projects owns job purchase orders / subcontracts (owner decision 2026-10-21). Every
 * approve / change / hold / receipt / close / void emits a FULL snapshot (pm.commitment_snapshot,
 * 1102 §10):
 *   { commitment_id, version, commitment_type PO|SUBCONTRACT, vendor_id, number, status,
 *     retainage_pct 0..1, payment_hold, hold_reason, executed_on, total_amount_cents, memo,
 *     source_ref 'pm:commit:{id}:v{version}', lines[{ commitment_line_id, line_no, cost_code_id,
 *     cost_code, cost_type, account_hint, description, amount_cents, received_to_date_cents }] }
 *
 * Books keeps an AP MATCH TARGET (public.ap_commitments + lines + version history). It is
 * NON-POSTING and never creates purchase_orders rows (one master). Rules:
 *   - a HIGHER version replaces the target; an equal or lower one is acknowledged as superseded
 *     (nothing changes — snapshots are full, so the newest one is the truth);
 *   - lines absent from the new version are kept (bills may be matched to them) but marked removed;
 *   - CLOSED / VOID retire the target (no new matches); existing matches stay;
 *   - payment_hold is honoured like ON_HOLD: matched open bills go ON_HOLD with the hold reason,
 *     and go back to their prior status when Projects releases the hold;
 *   - received_to_date changes re-score the 3-way status of the matched bill lines.
 *
 * Exactly-once: claim + lease (167); the target is keyed (org, pm_commitment_id) and the version
 * guard is in the UPDATE itself (`version < new`), so two drains can never apply an older snapshot
 * over a newer one. Ack (event row): status processed, ack_meta { commitment_id, version,
 * superseded?, retired?, bills_held, bills_released }; error + error_code on rejection.
 *
 * Gate: entitlements.projects = true only (others are released untouched); an unsupported
 * schema_version is rejected regardless.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { claimPendingEvents, releaseEventClaims, renewEventClaim, isUniqueViolation, type ClaimedEvent } from '@/lib/events/claim';
import {
  ackClaimedNonInvoiceEvent,
  projectsEntitlementCache,
  rejectClaimedEvent,
  SeamRejection,
  versionRejection,
} from '@/lib/events/seam';
import { writerFor } from '@/lib/db/scoped-writer';
import { applyCommitmentHold, rescoreCommitmentLines } from './commitment-match';

type DB = SupabaseClient;

export const COMMITMENT_STATUSES = ['APPROVED', 'EXECUTED', 'CLOSED', 'VOID'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];
const COST_TYPES = ['LABOR', 'MATERIALS', 'SUBCONTRACTOR', 'EQUIPMENT', 'OTHER'] as const;

export interface CommitmentLinePayload {
  commitment_line_id: string;
  line_no?: number | null;
  cost_code_id?: string | null;
  cost_code?: string | null;
  cost_type?: string | null;
  account_hint?: string | null;
  description?: string | null;
  amount_cents: number;
  received_to_date_cents?: number | null;
}

export interface CommitmentPayload {
  event_id: string;
  job_id: string;
  location_id: string;
  commitment_id: string;
  version: number;
  commitment_type?: string | null;
  vendor_id?: string | null;
  number: string;
  status: string;
  retainage_pct?: number | string | null;
  payment_hold?: boolean | null;
  hold_reason?: string | null;
  executed_on?: string | null;
  total_amount_cents?: number | null;
  memo?: string | null;
  source_ref: string;
  trigger?: string | null;
  occurred_on?: string;
  schema_version?: number;
  lines?: CommitmentLinePayload[];
}

export interface CommitmentDrainResult {
  processed: number;
  rejected: number;
  skipped: number;
  results: { event_id: string; status: 'processed' | 'rejected' | 'skipped'; commitment_id?: string; error?: string; error_code?: string }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ValidCommitment {
  pmCommitmentId: string;
  version: number;
  status: CommitmentStatus;
  type: 'PO' | 'SUBCONTRACT';
  retainagePct: number;
  hold: boolean;
  holdReason: string | null;
  lines: Array<Required<Pick<CommitmentLinePayload, 'commitment_line_id' | 'amount_cents'>> & {
    line_no: number; cost_code_id: string | null; cost_code: string | null; cost_type: string | null;
    account_hint: string | null; description: string; received_to_date_cents: number;
  }>;
}

/** PURE: validate + normalize a snapshot. Throws SeamRejection. */
export function validateCommitmentPayload(p: CommitmentPayload | null | undefined): ValidCommitment {
  const bad = (msg: string) => new SeamRejection('INVALID_PAYLOAD', msg);
  if (!p) throw bad('Empty JOB_COMMITMENT payload');
  if (!p.source_ref) throw new SeamRejection('MISSING_SOURCE_REF', 'The commitment snapshot has no source_ref');
  if (!p.commitment_id || !UUID_RE.test(p.commitment_id)) throw bad('commitment_id must be a uuid');
  const version = Number(p.version);
  if (!Number.isInteger(version) || version < 1) throw bad('version must be a positive integer');
  if (!COMMITMENT_STATUSES.includes(p.status as CommitmentStatus)) throw bad(`Unknown commitment status ${String(p.status)}`);
  const type = (p.commitment_type ?? 'PO') === 'SUBCONTRACT' ? 'SUBCONTRACT' : 'PO';
  if (p.commitment_type && !['PO', 'SUBCONTRACT'].includes(p.commitment_type)) throw bad(`Unknown commitment_type ${p.commitment_type}`);
  const rp = p.retainage_pct == null ? 0 : Number(p.retainage_pct);
  if (!Number.isFinite(rp) || rp < 0 || rp > 1) throw bad('retainage_pct must be a fraction between 0 and 1');
  if (!p.number || typeof p.number !== 'string') throw bad('number is required');
  if (p.lines != null && !Array.isArray(p.lines)) throw bad('lines must be an array');
  const seen = new Set<string>();
  const lines = (p.lines ?? []).map((l, i) => {
    if (!l?.commitment_line_id || !UUID_RE.test(l.commitment_line_id)) throw bad(`line ${i + 1}: commitment_line_id must be a uuid`);
    if (seen.has(l.commitment_line_id)) throw bad(`line ${i + 1}: duplicate commitment_line_id`);
    seen.add(l.commitment_line_id);
    const amt = Number(l.amount_cents);
    if (!Number.isInteger(amt) || amt < 0) throw new SeamRejection('INVALID_AMOUNT', `line ${i + 1}: amount_cents must be a non-negative whole number of cents`);
    const rec = l.received_to_date_cents == null ? 0 : Number(l.received_to_date_cents);
    if (!Number.isInteger(rec) || rec < 0) throw new SeamRejection('INVALID_AMOUNT', `line ${i + 1}: received_to_date_cents must be a non-negative whole number of cents`);
    const ct = l.cost_type && (COST_TYPES as readonly string[]).includes(l.cost_type) ? l.cost_type : null;
    return {
      commitment_line_id: l.commitment_line_id,
      line_no: Number.isInteger(Number(l.line_no)) ? Number(l.line_no) : i + 1,
      cost_code_id: l.cost_code_id && UUID_RE.test(l.cost_code_id) ? l.cost_code_id : null,
      cost_code: l.cost_code ?? null,
      cost_type: ct,
      account_hint: l.account_hint ?? null,
      description: l.description ?? '',
      amount_cents: amt,
      received_to_date_cents: rec,
    };
  });
  return {
    pmCommitmentId: p.commitment_id,
    version,
    status: p.status as CommitmentStatus,
    type,
    retainagePct: rp,
    hold: p.payment_hold === true,
    holdReason: p.hold_reason ?? null,
    lines,
  };
}

interface CommitmentRow {
  id: string;
  version: number;
  payment_hold: boolean;
  hold_reason: string | null;
  active: boolean;
  number: string;
}

export interface ApplyCommitmentResult {
  commitmentId: string;
  version: number;
  superseded: boolean;
  retired: boolean;
  billsHeld: number;
  billsReleased: number;
}

/** Apply one validated snapshot to the match target (service-role `db`). */
export async function applyCommitmentSnapshot(
  db: DB,
  ev: Pick<ClaimedEvent<CommitmentPayload>, 'id' | 'org_id' | 'payload'>,
  v: ValidCommitment,
): Promise<ApplyCommitmentResult> {
  const orgId = ev.org_id;
  const p = ev.payload;
  const w = writerFor(db);
  const now = new Date().toISOString();
  const active = v.status === 'APPROVED' || v.status === 'EXECUTED';

  const header = {
    location_id: p.location_id,
    job_id: p.job_id,
    vendor_id: p.vendor_id ?? null,
    version: v.version,
    number: p.number,
    commitment_type: v.type,
    status: v.status,
    active,
    retainage_pct: v.retainagePct,
    payment_hold: v.hold,
    hold_reason: v.hold ? v.holdReason ?? 'Payment hold in Merit Projects' : null,
    total_amount_cents: Math.round(Number(p.total_amount_cents ?? v.lines.reduce((s, l) => s + l.amount_cents, 0))),
    executed_on: p.executed_on ?? null,
    memo: p.memo ?? null,
    source_ref: p.source_ref,
    source_event_id: ev.id,
    retired_at: active ? null : now,
    updated_at: now,
  };

  const readExisting = async (): Promise<CommitmentRow | null> => {
    const { data, error } = await db.from('ap_commitments').select('id, version, payment_hold, hold_reason, active, number')
      .eq('org_id', orgId).eq('pm_commitment_id', v.pmCommitmentId).maybeSingle();
    if (error) throw new Error(`read commitment: ${error.message}`);
    return (data as CommitmentRow | null) ?? null;
  };

  let prior = await readExisting();
  if (prior && prior.version >= v.version) {
    return { commitmentId: prior.id, version: prior.version, superseded: true, retired: !prior.active, billsHeld: 0, billsReleased: 0 };
  }

  let commitmentId: string | null = null;
  if (!prior) {
    const { data, error } = await w.from('ap_commitments')
      .insert({ org_id: orgId, pm_commitment_id: v.pmCommitmentId, ...header })
      .select('id').single();
    if (error) {
      if (!isUniqueViolation(error)) throw new Error(`insert commitment: ${error.message}`);
      prior = await readExisting(); // a concurrent drain created it — fall through to the version-guarded update
      if (!prior) throw new Error('insert commitment: unique violation but no row');
      if (prior.version >= v.version) {
        return { commitmentId: prior.id, version: prior.version, superseded: true, retired: !prior.active, billsHeld: 0, billsReleased: 0 };
      }
    } else {
      commitmentId = (data as { id: string }).id;
    }
  }
  if (prior) {
    const { data, error } = await w.from('ap_commitments').update(header)
      .eq('org_id', orgId).eq('id', prior.id).lt('version', v.version).select('id');
    if (error) throw new Error(`update commitment: ${error.message}`);
    if (!Array.isArray(data) || data.length === 0) {
      const now2 = await readExisting();
      return { commitmentId: prior.id, version: now2?.version ?? prior.version, superseded: true, retired: !(now2?.active ?? prior.active), billsHeld: 0, billsReleased: 0 };
    }
    commitmentId = prior.id;
  }
  if (!commitmentId) throw new Error('commitment target could not be written');

  // Version history (idempotent on (commitment, version)).
  {
    const { error } = await w.from('ap_commitment_versions').insert({
      org_id: orgId, location_id: p.location_id, commitment_id: commitmentId, version: v.version, status: v.status,
      payment_hold: v.hold, total_amount_cents: header.total_amount_cents, trigger_name: p.trigger ?? null,
      source_event_id: ev.id, payload: p,
    });
    if (error && !isUniqueViolation(error)) throw new Error(`commitment version: ${error.message}`);
  }

  // Lines: update the known ones, insert the new ones, mark the absent ones removed.
  const { data: existingLines, error: elErr } = await db.from('ap_commitment_lines')
    .select('id, pm_commitment_line_id, received_to_date_cents, amount_cents').eq('org_id', orgId).eq('commitment_id', commitmentId);
  if (elErr) throw new Error(`read commitment lines: ${elErr.message}`);
  const byPm = new Map(((existingLines ?? []) as { id: string; pm_commitment_line_id: string }[]).map((l) => [l.pm_commitment_line_id, l.id]));
  const keep = new Set<string>();
  const touched: string[] = [];
  for (const l of v.lines) {
    const row = {
      location_id: p.location_id,
      line_no: l.line_no,
      cost_code_id: l.cost_code_id,
      cost_code: l.cost_code,
      cost_type: l.cost_type,
      account_hint: l.account_hint,
      description: l.description,
      amount_cents: l.amount_cents,
      received_to_date_cents: l.received_to_date_cents,
      removed: false,
      updated_at: now,
    };
    const id = byPm.get(l.commitment_line_id);
    if (id) {
      const { error } = await w.from('ap_commitment_lines').update(row).eq('org_id', orgId).eq('id', id);
      if (error) throw new Error(`update commitment line: ${error.message}`);
      keep.add(id);
      touched.push(id);
    } else {
      const { data, error } = await w.from('ap_commitment_lines')
        .insert({ org_id: orgId, commitment_id: commitmentId, pm_commitment_line_id: l.commitment_line_id, ...row })
        .select('id').single();
      if (error) throw new Error(`insert commitment line: ${error.message}`);
      keep.add((data as { id: string }).id);
    }
  }
  const gone = [...byPm.values()].filter((id) => !keep.has(id));
  if (gone.length > 0) {
    const { error } = await w.from('ap_commitment_lines').update({ removed: true, updated_at: now }).eq('org_id', orgId).in('id', gone);
    if (error) throw new Error(`retire commitment lines: ${error.message}`);
  }

  // Received-to-date / amounts moved → re-score the 3-way status of matched bill lines.
  if (touched.length + gone.length > 0) await rescoreCommitmentLines(db, orgId, [...touched, ...gone]);

  // Payment hold: honoured like ON_HOLD on every open bill matched to this commitment.
  let billsHeld = 0;
  let billsReleased = 0;
  const holdNow = v.hold && v.status !== 'VOID';
  const holdBefore = prior?.payment_hold ?? false;
  if (holdNow || holdBefore) {
    const r = await applyCommitmentHold(db, orgId, commitmentId, { hold: holdNow, number: p.number, reason: header.hold_reason });
    billsHeld = r.held;
    billsReleased = r.released;
  }

  return { commitmentId, version: v.version, superseded: false, retired: !active, billsHeld, billsReleased };
}

/** Drain pending JOB_COMMITMENT events (orgFilter null = every tenant). `db` is the service role. */
export async function processCommitmentEvents(
  db: DB,
  orgFilter?: string | null,
  opts: { claimed?: { token: string; rows: ClaimedEvent<CommitmentPayload>[] } } = {},
): Promise<CommitmentDrainResult> {
  const claim = opts.claimed ?? (await claimPendingEvents<CommitmentPayload>(db, { eventType: 'JOB_COMMITMENT', orgId: orgFilter ?? null }));
  const projectsOn = projectsEntitlementCache(db);
  const out: CommitmentDrainResult = { processed: 0, rejected: 0, skipped: 0, results: [] };

  const skip = (ev: ClaimedEvent<CommitmentPayload>, why: string) => {
    out.skipped++;
    out.results.push({ event_id: ev.event_id, status: 'skipped', error: why });
  };
  const reject = async (ev: ClaimedEvent<CommitmentPayload>, r: SeamRejection) => {
    if (!(await rejectClaimedEvent(db, ev.id, claim.token, r))) { skip(ev, 'Claimed by another drain'); return; }
    out.rejected++;
    out.results.push({ event_id: ev.event_id, status: 'rejected', error: r.message, error_code: r.code });
  };

  try {
    for (const ev of claim.rows) {
      const orgId = ev.org_id;
      const p = ev.payload;
      try {
        if (!(await renewEventClaim(db, ev.id, claim.token))) { skip(ev, 'Claimed by another drain'); continue; }
        const vr = versionRejection('JOB_COMMITMENT', p);
        if (vr) { await reject(ev, vr); continue; }
        if (!(await projectsOn(orgId))) {
          await releaseEventClaims(db, claim.token, [ev.id]).catch(() => 0);
          skip(ev, 'Projects is not enabled for this organization');
          continue;
        }
        const v = validateCommitmentPayload(p);

        const { data: job } = await db.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).eq('id', p.job_id).maybeSingle();
        if (!job) { await reject(ev, new SeamRejection('JOB_NOT_FOUND', 'Job not found in this organization')); continue; }
        if ((job as { location_id: string }).location_id !== p.location_id) {
          await reject(ev, new SeamRejection('COMPANY_NOT_FOUND', 'The commitment company does not match the job company'));
          continue;
        }
        if (p.vendor_id) {
          const { data: ven } = await db.schema('core').from('vendors').select('id').eq('org_id', orgId).eq('id', p.vendor_id).maybeSingle();
          if (!ven) { await reject(ev, new SeamRejection('VENDOR_NOT_FOUND', 'Vendor not found in this organization')); continue; }
        }

        const r = await applyCommitmentSnapshot(db, ev, v);
        const ok = await ackClaimedNonInvoiceEvent(db, ev.id, claim.token, {
          commitment_id: r.commitmentId,
          version: r.version,
          ...(r.superseded ? { superseded: true } : {}),
          ...(r.retired ? { retired: true } : {}),
          bills_held: r.billsHeld,
          bills_released: r.billsReleased,
        });
        if (!ok) { skip(ev, 'Applied; finalized by the drain that now holds the event'); continue; }
        out.processed++;
        out.results.push({ event_id: ev.event_id, status: 'processed', commitment_id: r.commitmentId });
      } catch (e) {
        await reject(ev, e instanceof SeamRejection ? e : new SeamRejection('COMMITMENT_FAILED', e instanceof Error ? e.message : 'commitment consumer error'));
      }
    }
  } finally {
    await releaseEventClaims(db, claim.token).catch(() => 0);
  }
  return out;
}
