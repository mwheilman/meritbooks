import 'server-only';
/**
 * The server half of matching at the door (SHARED-RECORDS §3). Every create door Merit Projects
 * owns for a customer, contact or vendor calls resolveAtDoor() before it writes:
 *
 *   body.match.useId      → the person chose an existing record: return it (checked reachable)
 *   exact match, no reason → 409 MATCH_FOUND with the candidates; the form shows them
 *   otherwise             → create, and when a second record was created on purpose, note why
 *
 * Doors with no person in front of them (a typed name on a job, the import) call
 * matchOrCreateCustomer(), whose default is the existing record on an exact match.
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError, PmQueryError } from '@/lib/api-errors';
import { isMissingContract, logActivityArgs } from '@/lib/crm/contract';
import {
  NEW_REASON_MIN, matchArgs, matchVerdict, matchWorthAsking, parseCandidates,
  type MatchCandidate, type MatchDecisionInput, type MatchKind, type MatchQueryInput,
} from './match';

export interface DoorIdentity {
  name: string | null;
  email: string | null;
  phone: string | null;
  address?: string | null;
  taxId?: string | null;
}

/** core.match_parties as the caller. A database without the 1111 matcher yet answers [] (logged). */
export async function matchParties(db: SupabaseClient, kind: MatchKind, who: DoorIdentity, limit = 5): Promise<MatchCandidate[]> {
  const q: MatchQueryInput = { op: kind, name: who.name, email: who.email, phone: who.phone, address: who.address ?? null, taxId: who.taxId ?? null, limit };
  if (!matchWorthAsking(q)) return [];
  const res = await db.schema('core').rpc('match_parties', matchArgs(q));
  if (res.error) {
    if (isMissingContract(res.error)) {
      // eslint-disable-next-line no-console
      console.warn('[projects] core.match_parties is not live yet (migration 1111); creating without the door check');
      return [];
    }
    throw new PmQueryError('match parties', res.error);
  }
  return parseCandidates(res.data);
}

export type DoorOutcome =
  | { kind: 'use'; id: string }
  | { kind: 'create'; overrideOf: MatchCandidate | null; reason: string | null }
  | { kind: 'conflict'; candidates: MatchCandidate[] };

const READ_BY_KIND: Readonly<Record<MatchKind, { schema: string; table: string }>> = {
  customer: { schema: 'pm', table: 'v_core_customers_masked' },
  vendor: { schema: 'pm', table: 'v_core_vendors_masked' },
  contact: { schema: 'core', table: 'contacts' },
};

async function reachable(db: SupabaseClient, kind: MatchKind, id: string): Promise<boolean> {
  const t = READ_BY_KIND[kind];
  const res = await db.schema(t.schema).from(t.table).select('id').eq('id', id).maybeSingle();
  if (res.error) throw new PmQueryError(`${kind} lookup`, res.error);
  return !!res.data;
}

/** Decide what a create door does with what the person typed and chose. */
export async function resolveAtDoor(db: SupabaseClient, kind: MatchKind, who: DoorIdentity, decision: MatchDecisionInput): Promise<DoorOutcome> {
  if (decision.useId) {
    if (!(await reachable(db, kind, decision.useId))) throw new HttpError(404, `That ${kind} was not found. Search again.`, 'NOT_FOUND');
    return { kind: 'use', id: decision.useId };
  }
  const cands = await matchParties(db, kind, who);
  const v = matchVerdict(cands);
  if (v.kind === 'exact') {
    if ((decision.newReason?.trim().length ?? 0) < NEW_REASON_MIN) return { kind: 'conflict', candidates: cands };
    return { kind: 'create', overrideOf: v.best, reason: decision.newReason };
  }
  return { kind: 'create', overrideOf: null, reason: decision.newReason };
}

/** The 409 a door returns when an exact match exists and no reason was typed. */
export function matchConflict(kind: MatchKind, candidates: MatchCandidate[], field: string = kind): NextResponse {
  return NextResponse.json(
    { error: `This ${kind} is already in Merit. Use the existing one, or say why this is a different ${kind}.`, code: 'MATCH_FOUND', kind, field, candidates },
    { status: 409 },
  );
}

/** Best effort: record on the new customer why it was created beside an exact match. */
export async function noteOverride(db: SupabaseClient, kind: MatchKind, newId: string, of: MatchCandidate, reason: string): Promise<void> {
  // crm.activities links customers and contacts; a vendor's reason stays in the audit trail of
  // the duplicate review the database files for the pair.
  if (kind === 'vendor') return;
  const res = await db.schema('crm').rpc('log_activity', logActivityArgs({
    kind: 'note', leadId: null, customerId: kind === 'customer' ? newId : null, contactId: kind === 'contact' ? newId : null, jobId: null,
    direction: null, subject: `Added separately from ${of.name}`, body: reason, outcome: null, occurredAt: null,
  }));
  if (res.error && !isMissingContract(res.error)) {
    // eslint-disable-next-line no-console
    console.warn('[projects] could not note the duplicate override', res.error.message);
  }
}

/**
 * A typed customer name with nobody choosing (a job's customer field, a work order, the import):
 * an exact match is used — the door's default — and only otherwise is a customer created.
 */
export async function matchOrCreateCustomer(
  db: SupabaseClient,
  who: DoorIdentity,
  create: () => Promise<string>,
): Promise<{ id: string; existing: boolean }> {
  const v = matchVerdict(await matchParties(db, 'customer', who));
  if (v.kind === 'exact') return { id: v.best.id, existing: true };
  return { id: await create(), existing: false };
}
