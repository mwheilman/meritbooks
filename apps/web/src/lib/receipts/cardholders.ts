/**
 * Card assignments (public.card_assignments, migration 181): which person holds which
 * card, their contact details, their manager, and the chase opt-out.
 *
 * Writes go through the service role AFTER the route has (1) checked the caller's
 * permission and (2) proven the company is in their org / client scope
 * (lib/db/scoped-writer.ts). Every referenced id (bank account, membership, employee) is
 * re-checked here against the org — a foreign key never checks the tenant.
 *
 * Opt-out (FPB §15.1): anyone who may edit cardholders can REQUEST it (with a reason); a
 * DIFFERENT person with receipts:approve decides. An approved opt-out pauses the
 * cardholder's live receipt requests.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { ASSIGNMENT_COLUMNS, pauseChase } from './chase';
import type { CardAssignmentRow, HolderType } from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class CardholderError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'CardholderError';
  }
}

export interface CardholderInput {
  locationId: string;
  bankAccountId?: string | null;
  cardLast4?: string | null;
  cardLabel?: string | null;
  holderType: HolderType;
  membershipId?: string | null;
  employeeId?: string | null;
  holderName: string;
  holderEmail?: string | null;
  holderPhone?: string | null;
  holderTimezone?: string | null;
  managerMembershipId?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

/** Validate + normalize. Pure (exported for tests). */
export function normalizeCardholder(i: CardholderInput): Record<string, unknown> {
  const name = i.holderName?.trim();
  if (!name) throw new CardholderError('Add the cardholder’s name.');
  if (name.length > 200) throw new CardholderError('Keep the name under 200 characters.');
  const last4 = i.cardLast4?.replace(/\D/g, '') || null;
  if (last4 && last4.length !== 4) throw new CardholderError('The card’s last 4 must be exactly four digits.');
  if (!i.bankAccountId && !last4) throw new CardholderError('Pick the card feed account or enter the card’s last 4.');
  const email = i.holderEmail?.trim().toLowerCase() || null;
  if (email && !EMAIL_RE.test(email)) throw new CardholderError('That email address does not look right.');
  const phone = i.holderPhone?.trim() || null;
  if (phone && !/^\+?[0-9 ().-]{7,32}$/.test(phone)) throw new CardholderError('That phone number does not look right.');
  if (i.holderType === 'member' && !i.membershipId) throw new CardholderError('Pick the team member.');
  if (i.holderType === 'employee' && !i.employeeId) throw new CardholderError('Pick the employee.');
  if (!email && i.holderType !== 'member') throw new CardholderError('Add an email so the reminders can reach them.');
  for (const d of [i.startsOn, i.endsOn]) if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new CardholderError('Dates must be YYYY-MM-DD.');
  if (i.startsOn && i.endsOn && i.endsOn < i.startsOn) throw new CardholderError('The end date is before the start date.');
  if (i.cardLabel && i.cardLabel.length > 80) throw new CardholderError('Keep the card label under 80 characters.');
  return {
    location_id: i.locationId,
    bank_account_id: i.bankAccountId ?? null,
    card_last4: last4,
    card_label: i.cardLabel?.trim() || null,
    holder_type: i.holderType,
    membership_id: i.holderType === 'member' ? i.membershipId ?? null : i.membershipId ?? null,
    employee_id: i.employeeId ?? null,
    holder_name: name,
    holder_email: email,
    holder_phone: phone,
    holder_timezone: i.holderTimezone?.trim() || null,
    manager_membership_id: i.managerMembershipId ?? null,
    starts_on: i.startsOn ?? null,
    ends_on: i.endsOn ?? null,
  };
}

/** Every referenced id must belong to the org (service-role reads). */
async function assertRefs(db: SupabaseClient, orgId: string, row: Record<string, unknown>): Promise<void> {
  const acct = row.bank_account_id as string | null;
  if (acct) {
    const { data } = await db.from('bank_accounts').select('id, location_id').eq('org_id', orgId).eq('id', acct).maybeSingle();
    const a = data as { id: string; location_id: string } | null;
    if (!a) throw new CardholderError('That card account is not part of this organization.', 404);
    if (a.location_id !== row.location_id) throw new CardholderError('That card account belongs to another company.', 409);
  }
  for (const col of ['membership_id', 'manager_membership_id'] as const) {
    const id = row[col] as string | null;
    if (!id) continue;
    const { data } = await db.schema('core').from('memberships').select('id').eq('org_id', orgId).eq('id', id).maybeSingle();
    if (!data) throw new CardholderError('That team member is not part of this organization.', 404);
  }
  const emp = row.employee_id as string | null;
  if (emp) {
    const { data } = await db.schema('core').from('employees').select('id').eq('org_id', orgId).eq('id', emp).maybeSingle();
    if (!data) throw new CardholderError('That employee is not part of this organization.', 404);
  }
}

function uniqueMsg(e: { message: string; code?: string }): boolean {
  return e.code === '23505' || /duplicate|unique/i.test(e.message);
}

export async function createCardholder(db: SupabaseClient, orgId: string, input: CardholderInput, actor: string): Promise<CardAssignmentRow> {
  const row = normalizeCardholder(input);
  await assertRefs(db, orgId, row);
  const { data, error } = await db
    .from('card_assignments')
    .insert({ ...row, org_id: orgId, active: true, created_by: actor, updated_by: actor })
    .select(ASSIGNMENT_COLUMNS)
    .single();
  if (error) {
    if (uniqueMsg(error)) throw new CardholderError('That card already has an active cardholder. End that assignment first.', 409);
    throw new CardholderError(`Could not save the cardholder: ${error.message}`, 500);
  }
  return data as CardAssignmentRow;
}

export async function getCardholder(db: SupabaseClient, orgId: string, id: string): Promise<CardAssignmentRow | null> {
  const { data, error } = await db.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId).eq('id', id).maybeSingle();
  if (error) throw new CardholderError(`Could not read the cardholder: ${error.message}`, 500);
  return (data as CardAssignmentRow | null) ?? null;
}

export async function updateCardholder(db: SupabaseClient, orgId: string, id: string, input: CardholderInput, actor: string): Promise<CardAssignmentRow> {
  const current = await getCardholder(db, orgId, id);
  if (!current) throw new CardholderError('That cardholder was not found.', 404);
  if (current.location_id !== input.locationId) throw new CardholderError('A cardholder cannot move to another company; end it and add a new one.', 409);
  const row = normalizeCardholder(input);
  await assertRefs(db, orgId, row);
  const { data, error } = await db
    .from('card_assignments')
    .update({ ...row, updated_by: actor, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('id', id)
    .select(ASSIGNMENT_COLUMNS);
  if (error) {
    if (uniqueMsg(error)) throw new CardholderError('That card already has an active cardholder.', 409);
    throw new CardholderError(`Could not save the cardholder: ${error.message}`, 500);
  }
  return (Array.isArray(data) ? data[0] : data) as CardAssignmentRow;
}

/** End an assignment (kept for history). Its magic links die; the next sync stops chasing. */
export async function endCardholder(db: SupabaseClient, orgId: string, id: string, actor: string, now: Date): Promise<void> {
  const iso = now.toISOString();
  const { error } = await db
    .from('card_assignments')
    .update({ active: false, ends_on: iso.slice(0, 10), updated_by: actor, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', id);
  if (error) throw new CardholderError(`Could not end the assignment: ${error.message}`, 500);
  await db.from('workforce_links').update({ revoked_at: iso }).eq('org_id', orgId).eq('card_assignment_id', id).is('revoked_at', null);
}

export async function requestOptOut(db: SupabaseClient, orgId: string, id: string, actor: string, reason: string, now: Date): Promise<CardAssignmentRow> {
  const why = reason.trim();
  if (why.length < 5) throw new CardholderError('Say why this cardholder should not be chased (at least a few words).');
  const current = await getCardholder(db, orgId, id);
  if (!current) throw new CardholderError('That cardholder was not found.', 404);
  if (current.chase_opt_out) throw new CardholderError('This cardholder is already opted out.', 409);
  if (current.opt_out_status === 'pending') throw new CardholderError('An opt-out is already waiting for approval.', 409);
  const iso = now.toISOString();
  const { data, error } = await db
    .from('card_assignments')
    .update({
      opt_out_status: 'pending',
      opt_out_reason: why.slice(0, 500),
      opt_out_requested_by: actor,
      opt_out_requested_at: iso,
      opt_out_decided_by: null,
      opt_out_decided_at: null,
      updated_by: actor,
      updated_at: iso,
    })
    .eq('org_id', orgId)
    .eq('id', id)
    .select(ASSIGNMENT_COLUMNS);
  if (error) throw new CardholderError(`Could not request the opt-out: ${error.message}`, 500);
  return (Array.isArray(data) ? data[0] : data) as CardAssignmentRow;
}

/** Approve / reject a pending opt-out. Separation of duties: the requester cannot decide. */
export async function decideOptOut(
  db: SupabaseClient,
  orgId: string,
  id: string,
  actor: string,
  approve: boolean,
  now: Date,
): Promise<{ assignment: CardAssignmentRow; paused: number }> {
  const current = await getCardholder(db, orgId, id);
  if (!current) throw new CardholderError('That cardholder was not found.', 404);
  if (current.opt_out_status !== 'pending') throw new CardholderError('There is no opt-out waiting for a decision.', 409);
  if (current.opt_out_requested_by === actor) throw new CardholderError('Someone other than the requester has to approve this opt-out.', 403);
  const iso = now.toISOString();
  const { data, error } = await db
    .from('card_assignments')
    .update({
      opt_out_status: approve ? 'approved' : 'rejected',
      chase_opt_out: approve,
      opt_out_decided_by: actor,
      opt_out_decided_at: iso,
      updated_by: actor,
      updated_at: iso,
    })
    .eq('org_id', orgId)
    .eq('id', id)
    .eq('opt_out_status', 'pending')
    .select(ASSIGNMENT_COLUMNS);
  if (error) throw new CardholderError(`Could not record the decision: ${error.message}`, 500);
  const row = (Array.isArray(data) ? data[0] : data) as CardAssignmentRow | undefined;
  if (!row) throw new CardholderError('The opt-out was decided by someone else just now.', 409);
  const paused = approve ? await pauseChase(db, orgId, { cardAssignmentId: id }, 'opted_out', actor, now) : 0;
  return { assignment: row, paused };
}

/** Turn chase back on for an opted-out cardholder (no approval needed to resume chasing). */
export async function clearOptOut(db: SupabaseClient, orgId: string, id: string, actor: string, now: Date): Promise<CardAssignmentRow> {
  const iso = now.toISOString();
  const { data, error } = await db
    .from('card_assignments')
    .update({ chase_opt_out: false, opt_out_status: 'none', opt_out_reason: null, opt_out_decided_by: actor, opt_out_decided_at: iso, updated_by: actor, updated_at: iso })
    .eq('org_id', orgId)
    .eq('id', id)
    .select(ASSIGNMENT_COLUMNS);
  if (error) throw new CardholderError(`Could not turn chase back on: ${error.message}`, 500);
  const row = (Array.isArray(data) ? data[0] : data) as CardAssignmentRow | undefined;
  if (!row) throw new CardholderError('That cardholder was not found.', 404);
  return row;
}

/** Card assignments a signed-in person holds (via membership or their employee record). */
export async function assignmentsForUser(db: SupabaseClient, orgId: string, clerkUserId: string): Promise<CardAssignmentRow[]> {
  const { data: u } = await db.schema('core').from('users').select('id').eq('clerk_user_id', clerkUserId).maybeSingle();
  const userId = (u as { id?: string } | null)?.id ?? null;
  const memberIds: string[] = [];
  if (userId) {
    const { data: ms } = await db.schema('core').from('memberships').select('id').eq('org_id', orgId).eq('user_id', userId).eq('status', 'active');
    for (const m of (ms ?? []) as Array<{ id: string }>) memberIds.push(m.id);
  }
  const { data: emps } = await db.schema('core').from('employees').select('id').eq('org_id', orgId).eq('clerk_user_id', clerkUserId).eq('is_active', true);
  const empIds = ((emps ?? []) as Array<{ id: string }>).map((e) => e.id);
  const out = new Map<string, CardAssignmentRow>();
  if (memberIds.length) {
    const { data } = await db.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId).eq('active', true).in('membership_id', memberIds);
    for (const a of (data ?? []) as CardAssignmentRow[]) out.set(a.id, a);
  }
  if (empIds.length) {
    const { data } = await db.from('card_assignments').select(ASSIGNMENT_COLUMNS).eq('org_id', orgId).eq('active', true).in('employee_id', empIds);
    for (const a of (data ?? []) as CardAssignmentRow[]) out.set(a.id, a);
  }
  return Array.from(out.values());
}
