/**
 * Equity / cap-table onboarding — COMMIT (persistence + consolidation wiring).
 *
 * The I/O boundary between the RLS-scoped Supabase client and the pure cap-table
 * logic. It:
 *   1. Persists the confirmed owners to `core.equity_holders` (the cap-table home).
 *      DEGRADE-SAFE: if that table has not been applied yet (see the REPORTED DDL
 *      below), it returns `{ tableMissing: true }` without throwing, so the section
 *      works the moment the migration lands — no code change needed.
 *   2. Wires ownership into CONSOLIDATION where the engine already reads it:
 *      `public.entity_ownership` (migration 076). For any owner the human links to
 *      ANOTHER company in the tenant (a parent holdco), it upserts the ownership
 *      edge parent→child with the derived consolidation method, so the consolidated
 *      statements carry the right NCI on day one.
 *   3. Best-effort reads the opening-TB owners'-capital balance so the caller can
 *      reconcile per-owner capital to the opening equity (report a variance).
 *
 * ── REPORTED MIGRATION (for the lead — this module lights up the moment it lands) ─
 *   create table if not exists core.equity_holders (
 *     id uuid primary key default uuid_generate_v4(),
 *     org_id uuid not null references core.organizations(id) on delete cascade,
 *     entity_id uuid not null references core.locations(id) on delete cascade,
 *     name text not null,
 *     ownership_pct numeric(9,6),                 -- 0..100 (null when units-based)
 *     units numeric(20,4),                        -- null when percent-based
 *     capital_contributed_cents bigint not null default 0,
 *     equity_class text not null default 'COMMON'
 *       check (equity_class in ('COMMON','PREFERRED','LLC_UNIT','PARTNER','OTHER')),
 *     is_preferred boolean not null default false,
 *     preferred_terms jsonb,
 *     owner_entity_id uuid references core.locations(id) on delete set null,
 *     created_by uuid,                            -- nullable; never a Clerk id (see 018)
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   );
 *   create index if not exists idx_equity_holders_entity
 *     on core.equity_holders(org_id, entity_id);
 *   alter table core.equity_holders enable row level security;
 *   create policy "org_isolation" on core.equity_holders
 *     for all using (org_id = public.get_org_id());
 *   grant select, insert, update, delete on core.equity_holders
 *     to anon, authenticated, service_role;
 *   -- (optional) before-update trigger public.set_updated_at() to keep updated_at fresh.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { deriveConsolidationMethod, ownershipSumCheck } from './normalize';
import type { OwnershipBasis, ProposedOwner } from './types';

/** True when a PostgREST error means the relation simply isn't there yet. */
function isMissingRelation(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();
  return (
    code === '42P01' || // undefined_table
    code === 'PGRST205' || // PostgREST: relation not found in schema cache
    msg.includes('does not exist') ||
    msg.includes('could not find the table') ||
    msg.includes('schema cache')
  );
}

export interface CommitCapTableInput {
  entityId: string;
  owners: ProposedOwner[];
  ownershipBasis: OwnershipBasis;
  /** Effective date for the consolidation ownership edge (default today). */
  effectiveDate?: string;
}

export interface CommitCapTableResult {
  /** True when holders were written to core.equity_holders. */
  persisted: boolean;
  /** True when core.equity_holders is not yet applied (degrade path). */
  tableMissing: boolean;
  /** Number of holder rows written. */
  holdersWritten: number;
  /** Number of consolidation ownership edges upserted (owners linked to an entity). */
  consolidationEdgesWired: number;
  /** True when the consolidation table (entity_ownership) was reachable. */
  consolidationTableAvailable: boolean;
  /** Non-fatal warnings surfaced to the caller (never thrown). */
  warnings: string[];
}

/** Effective ownership percent per owner (derived from units when basis is UNITS). */
function effectivePercents(owners: ReadonlyArray<ProposedOwner>, basis: OwnershipBasis): number[] {
  return ownershipSumCheck(owners, basis).effectivePercents;
}

/**
 * Persist the confirmed cap table for one entity and wire the consolidation
 * ownership edges. RLS-scoped — pass the user-scoped client. Never throws for the
 * expected degrade case (table not yet applied); surfaces it via `tableMissing`.
 *
 * Semantics are REPLACE-per-entity: existing holders for the entity are cleared and
 * re-inserted, so a re-confirm is idempotent rather than duplicating the cap table.
 */
export async function commitCapTable(
  supabase: SupabaseClient,
  orgId: string,
  userId: string | null,
  input: CommitCapTableInput,
): Promise<CommitCapTableResult> {
  const warnings: string[] = [];
  const effDate = input.effectiveDate ?? new Date().toISOString().slice(0, 10);
  const pcts = effectivePercents(input.owners, input.ownershipBasis);

  // ── 1. Persist holders (degrade-safe) ────────────────────────────────────────
  let persisted = false;
  let tableMissing = false;
  let holdersWritten = 0;

  // Probe/clear existing rows for this entity. A missing relation is detected here.
  const del = await supabase
    .schema('core')
    .from('equity_holders')
    .delete()
    .eq('org_id', orgId)
    .eq('entity_id', input.entityId);

  if (del.error && isMissingRelation(del.error)) {
    tableMissing = true;
  } else if (del.error) {
    warnings.push(`Could not clear prior cap table: ${del.error.message}`);
  }

  if (!tableMissing) {
    const rows = input.owners.map((o, i) => ({
      org_id: orgId,
      entity_id: input.entityId,
      name: o.name,
      ownership_pct: o.ownership_pct ?? (input.ownershipBasis === 'UNITS' ? round6(pcts[i]) : null),
      units: o.units,
      capital_contributed_cents: o.capital_contributed_cents ?? 0,
      equity_class: o.equity_class,
      is_preferred: o.is_preferred,
      preferred_terms: o.preferred_terms,
      owner_entity_id: o.owner_entity_id,
      created_by: null as string | null,
    }));
    // created_by is a UUID column and Clerk ids are strings — never write one (see 018).
    void userId;

    const ins = await supabase.schema('core').from('equity_holders').insert(rows);
    if (ins.error && isMissingRelation(ins.error)) {
      tableMissing = true;
    } else if (ins.error) {
      warnings.push(`Could not save cap table: ${ins.error.message}`);
    } else {
      persisted = true;
      holdersWritten = rows.length;
    }
  }

  // ── 2. Wire consolidation ownership (public.entity_ownership, migration 076) ──
  // Only owners the human linked to another company in this tenant become an edge.
  let consolidationTableAvailable = true;
  let consolidationEdgesWired = 0;

  const linked = input.owners
    .map((o, i) => ({ owner: o, pct: o.ownership_pct ?? pcts[i] }))
    .filter((x) => x.owner.owner_entity_id && x.owner.owner_entity_id !== input.entityId);

  for (const { owner, pct } of linked) {
    const edge = {
      org_id: orgId,
      parent_entity_id: owner.owner_entity_id as string,
      child_entity_id: input.entityId,
      ownership_percent: round4(pct),
      consolidation_method: deriveConsolidationMethod(pct),
      effective_start: effDate,
      notes: `Set from cap-table onboarding — ${owner.name}`,
    };
    const up = await supabase
      .from('entity_ownership')
      .upsert(edge, { onConflict: 'org_id,parent_entity_id,child_entity_id,effective_start' });
    if (up.error) {
      if (isMissingRelation(up.error)) {
        consolidationTableAvailable = false;
        break;
      }
      warnings.push(`Could not wire consolidation ownership for ${owner.name}: ${up.error.message}`);
    } else {
      consolidationEdgesWired += 1;
    }
  }

  return {
    persisted,
    tableMissing,
    holdersWritten,
    consolidationEdgesWired,
    consolidationTableAvailable,
    warnings,
  };
}

/**
 * Best-effort read of the opening trial balance's OWNERS'-CAPITAL balance for an
 * entity, in CENTS (natural credit balance, positive). Used to reconcile per-owner
 * capital contributions to the posted opening equity. DEGRADE-SAFE: returns null
 * when the role can't be resolved, no opening entry exists, or anything fails — the
 * caller then simply skips the reconcile (never forces).
 */
export async function loadOpeningCapitalCents(
  supabase: SupabaseClient,
  orgId: string,
  entityId: string,
): Promise<number | null> {
  let capitalAccountId: string;
  try {
    const ref = await resolveRole(supabase, orgId, 'OWNERS_CAPITAL', entityId);
    capitalAccountId = ref.id;
  } catch (e) {
    if (e instanceof PostingError) return null;
    return null;
  }

  // Opening-balance GL lines for this account + entity. Sum credit − debit.
  const { data: entries, error: entErr } = await supabase
    .from('gl_entries')
    .select('id')
    .eq('org_id', orgId)
    .eq('source_module', 'OPENING_BALANCE')
    .limit(5000);
  if (entErr || !entries || entries.length === 0) return null;
  const entryIds = (entries as Array<{ id: string }>).map((e) => e.id);

  let creditMinusDebit = 0;
  let sawAny = false;
  for (let i = 0; i < entryIds.length; i += 500) {
    const slice = entryIds.slice(i, i + 500);
    const { data: lines, error } = await supabase
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents')
      .eq('account_id', capitalAccountId)
      .eq('location_id', entityId)
      .in('gl_entry_id', slice);
    if (error) return null;
    for (const l of (lines ?? []) as Array<{ debit_cents: number | string; credit_cents: number | string }>) {
      sawAny = true;
      creditMinusDebit += (Number(l.credit_cents) || 0) - (Number(l.debit_cents) || 0);
    }
  }

  return sawAny ? creditMinusDebit : null;
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
