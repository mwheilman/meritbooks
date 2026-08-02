/**
 * Consolidation data loader (GATE 11a).
 *
 * The I/O boundary between the RLS-scoped Supabase client and the PURE engine
 * (`consolidate.ts`). It reads:
 *   - the entity list (core.locations) and the ownership/consolidation structure
 *     (public.entity_ownership, migration 076) — DEGRADING SAFE to FULL/100% for
 *     any entity with no row, and to an all-FULL/100% group if the table does not
 *     yet exist (pre-migration), so the report never breaks;
 *   - per-entity trial balances from POSTED gl_entry_lines: balance-sheet accounts
 *     cumulatively THROUGH the as-of date, income-statement accounts WITHIN the
 *     period — then feeds the engine natural-balance-signed cents.
 *
 * It also tags the two intercompany roles (INTERCOMPANY_AR / INTERCOMPANY_AP) so
 * the engine eliminates the reciprocal due-to/due-from positions by ROLE, not by a
 * hardcoded account number (canon: reference accounts by role).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import {
  consolidate,
  type AccountType,
  type ConsolidationMethod,
  type EntityAccountBalance,
  type EntityMeta,
  type ConsolidationResult,
} from './consolidate';
import {
  translateEntityTB,
  resolveTranslationRates,
  type FxRateRow,
  type TranslationRates,
} from './fx';

const BALANCE_SHEET_TYPES: ReadonlySet<AccountType> = new Set<AccountType>([
  'ASSET',
  'LIABILITY',
  'EQUITY',
]);
const CREDIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>([
  'LIABILITY',
  'EQUITY',
  'REVENUE',
]);

export interface EntityRow {
  id: string;
  name: string;
  shortCode: string | null;
  parentEntityId: string | null;
}

export interface OwnershipRow {
  parentEntityId: string;
  childEntityId: string;
  ownershipPercent: number;
  consolidationMethod: ConsolidationMethod;
  effectiveStart: string;
  effectiveEnd: string | null;
}

/** Per-entity FX translation detail actually applied, for UI transparency. */
export interface EntityFxInfo {
  entityId: string;
  functionalCurrency: string;
  rates: TranslationRates;
  ctaCents: number;
  translated: boolean; // functional ≠ reporting
  ratesResolved: { average: boolean; closing: boolean; historical: boolean };
}

export interface ConsolidationFxResult {
  reportingCurrency: string;
  /** True when the fx_rates table (migration 089) was readable. */
  fxRatesAvailable: boolean;
  /** True when core.locations.functional_currency exists (else all = reporting). */
  functionalCurrencyColumnAvailable: boolean;
  /** True when at least one entity's functional currency ≠ reporting currency. */
  multiCurrency: boolean;
  /** Sum of every foreign entity's CTA plug (reporting cents), for a summary line. */
  ctaTotalCents: number;
  byEntity: EntityFxInfo[];
}

export interface ConsolidationLoadResult {
  result: ConsolidationResult;
  entities: EntityRow[];
  /** Effective ownership meta actually used, for UI transparency. */
  entityMeta: EntityMeta[];
  ownershipTableAvailable: boolean;
  intercompanyRolesResolved: boolean;
  scanned: { entries: number; lines: number };
  fx: ConsolidationFxResult;
}

const N = (v: unknown): number => Number(v ?? 0) || 0;

/** Natural-balance cents from raw debits/credits given the account type. */
function naturalBalance(type: AccountType, debit: number, credit: number): number {
  return CREDIT_NORMAL.has(type) ? credit - debit : debit - credit;
}

/**
 * Load the tenant's entities + effective ownership structure. Returns FULL/100%
 * defaults for entities without a row, and `ownershipTableAvailable=false` when
 * the migration has not been applied yet (engine still runs, all-FULL).
 */
export async function loadOwnership(
  supabase: SupabaseClient,
  orgId: string,
  asOf: string,
): Promise<{
  entities: EntityRow[];
  entityMeta: EntityMeta[];
  ownershipTableAvailable: boolean;
  ownership: OwnershipRow[];
}> {
  // Entities (companies) — core master data.
  const { data: locs } = await supabase
    .schema('core')
    .from('locations')
    .select('id, name, short_code, parent_entity_id')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');
  const entities: EntityRow[] = (locs ?? []).map((l: Record<string, unknown>) => ({
    id: l.id as string,
    name: l.name as string,
    shortCode: (l.short_code as string) ?? null,
    parentEntityId: (l.parent_entity_id as string) ?? null,
  }));

  // Effective-dated ownership structure (migration 076). Degrade safe.
  let ownershipTableAvailable = true;
  const ownership: OwnershipRow[] = [];
  const { data: rows, error } = await supabase
    .from('entity_ownership')
    .select(
      'parent_entity_id, child_entity_id, ownership_percent, consolidation_method, effective_start, effective_end',
    )
    .eq('org_id', orgId)
    .lte('effective_start', asOf)
    .order('effective_start', { ascending: false });
  if (error) {
    // Relation absent (pre-migration) or any read failure → treat as no structure.
    ownershipTableAvailable = false;
  } else {
    for (const r of rows ?? []) {
      const rec = r as Record<string, unknown>;
      const end = (rec.effective_end as string) ?? null;
      if (end && end < asOf) continue; // expired before the as-of date
      ownership.push({
        parentEntityId: rec.parent_entity_id as string,
        childEntityId: rec.child_entity_id as string,
        ownershipPercent: N(rec.ownership_percent),
        consolidationMethod: (rec.consolidation_method as ConsolidationMethod) ?? 'FULL',
        effectiveStart: rec.effective_start as string,
        effectiveEnd: end,
      });
    }
  }

  // Per-child, the most-recent effective row wins (rows already sorted desc).
  const byChild = new Map<string, OwnershipRow>();
  for (const r of ownership) {
    if (!byChild.has(r.childEntityId)) byChild.set(r.childEntityId, r);
  }

  const entityMeta: EntityMeta[] = entities.map((e) => {
    const row = byChild.get(e.id);
    return {
      entityId: e.id,
      name: e.name,
      method: row?.consolidationMethod ?? 'FULL',
      ownershipPercent: row ? row.ownershipPercent : 100,
    };
  });

  return { entities, entityMeta, ownershipTableAvailable, ownership };
}

/** Collect an entity + all its descendants (walk core.locations parent tree). */
export function subtreeOf(entities: EntityRow[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const e of entities) {
    if (e.parentEntityId) {
      const arr = childrenOf.get(e.parentEntityId) ?? [];
      arr.push(e.id);
      childrenOf.set(e.parentEntityId, arr);
    }
  }
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return out;
}

export interface LoadConsolidatedOptions {
  startDate: string; // P&L period start (inclusive)
  endDate: string; // P&L period end + BS as-of (inclusive)
  rootEntityId?: string | null; // scope to a subtree; default = whole org
  eliminate?: boolean;
  /** Override the reporting currency; default = org home_currency (else USD). */
  reportingCurrency?: string | null;
}

/**
 * Load the tenant's FX rate rows (migration 089) + each entity's functional
 * currency + the group reporting currency. DEGRADES SAFE: a missing table/column
 * simply means every entity is treated as already in the reporting currency.
 */
async function loadFxContext(
  supabase: SupabaseClient,
  orgId: string,
  reportingOverride?: string | null,
): Promise<{
  reportingCurrency: string;
  fxRows: FxRateRow[];
  fxRatesAvailable: boolean;
  functionalByEntity: Map<string, string>;
  functionalCurrencyColumnAvailable: boolean;
}> {
  // Reporting currency = explicit override, else org home_currency, else USD.
  let reportingCurrency = (reportingOverride || '').trim();
  if (!reportingCurrency) {
    const { data: orgRows } = await supabase
      .schema('core')
      .from('organizations')
      .select('home_currency')
      .eq('id', orgId)
      .limit(1);
    reportingCurrency = (orgRows?.[0] as { home_currency?: string } | undefined)?.home_currency || 'USD';
  }

  // Per-entity functional currency (reserved-spine column; may not exist yet).
  const functionalByEntity = new Map<string, string>();
  let functionalCurrencyColumnAvailable = false;
  {
    const { data, error } = await supabase
      .schema('core')
      .from('locations')
      .select('id, functional_currency')
      .eq('org_id', orgId);
    if (!error && data) {
      functionalCurrencyColumnAvailable = true;
      for (const l of data as Array<{ id: string; functional_currency: string | null }>) {
        if (l.functional_currency) functionalByEntity.set(l.id, l.functional_currency);
      }
    }
  }

  // FX rate rows (migration 089). Degrade safe if the relation is absent.
  const fxRows: FxRateRow[] = [];
  let fxRatesAvailable = false;
  {
    const { data, error } = await supabase
      .from('fx_rates')
      .select('from_currency, to_currency, rate_date, rate, rate_type')
      .eq('org_id', orgId);
    if (!error) {
      fxRatesAvailable = true;
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        fxRows.push({
          fromCurrency: String(r.from_currency),
          toCurrency: String(r.to_currency),
          rateDate: String(r.rate_date),
          rate: N(r.rate),
          rateType: (r.rate_type as FxRateRow['rateType']) ?? 'CLOSING',
        });
      }
    }
  }

  return {
    reportingCurrency,
    fxRows,
    fxRatesAvailable,
    functionalByEntity,
    functionalCurrencyColumnAvailable,
  };
}

/**
 * End-to-end: load structure + trial balances and run the consolidation engine.
 * RLS-scoped — the caller passes the user-scoped client.
 */
export async function loadConsolidated(
  supabase: SupabaseClient,
  orgId: string,
  opts: LoadConsolidatedOptions,
): Promise<ConsolidationLoadResult> {
  const { startDate, endDate } = opts;
  const eliminate = opts.eliminate !== false;

  const { entities, entityMeta, ownershipTableAvailable } = await loadOwnership(
    supabase,
    orgId,
    endDate,
  );

  // Optional subtree scope.
  const scope = opts.rootEntityId ? subtreeOf(entities, opts.rootEntityId) : null;
  const scopedEntities = scope ? entities.filter((e) => scope.has(e.id)) : entities;
  const scopedMeta = scope ? entityMeta.filter((m) => scope.has(m.entityId)) : entityMeta;

  // Intercompany roles → account ids (best-effort; skip if unseeded).
  let intercompanyRolesResolved = false;
  const roleByAccountId = new Map<string, string>();
  for (const role of ['INTERCOMPANY_AR', 'INTERCOMPANY_AP'] as const) {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      roleByAccountId.set(ref.id, role);
      intercompanyRolesResolved = true;
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }

  // POSTED entries through the as-of date (BS cumulative; P&L filtered later).
  const { data: entriesRaw } = await supabase
    .from('gl_entries')
    .select('id, entry_date')
    .eq('org_id', orgId)
    .eq('status', 'POSTED')
    .lte('entry_date', endDate)
    .limit(50000);
  const entries = (entriesRaw ?? []) as Array<{ id: string; entry_date: string }>;
  const entryDate = new Map<string, string>();
  for (const e of entries) entryDate.set(e.id, e.entry_date);
  const entryIds = entries.map((e) => e.id);

  // Line load in chunks, joined to the account for type/flag.
  interface LineRow {
    gl_entry_id: string;
    account_id: string;
    location_id: string;
    debit_cents: number | string;
    credit_cents: number | string;
    accounts: {
      account_number: string;
      name: string;
      account_type: AccountType;
      is_eliminating: boolean;
    } | null;
  }
  const balancesByKey = new Map<string, EntityAccountBalance>();
  let lineCount = 0;
  for (let i = 0; i < entryIds.length; i += 500) {
    const slice = entryIds.slice(i, i + 500);
    const { data: lines } = await supabase
      .from('gl_entry_lines')
      .select(
        `gl_entry_id, account_id, location_id, debit_cents, credit_cents,
         accounts!inner(account_number, name, account_type, is_eliminating)`,
      )
      .in('gl_entry_id', slice);
    for (const raw of (lines ?? []) as unknown as LineRow[]) {
      const acct = raw.accounts;
      if (!acct) continue;
      const type = acct.account_type;
      const date = entryDate.get(raw.gl_entry_id);
      if (!date) continue;
      // P&L accounts only count WITHIN the period; BS accrue cumulatively.
      const isPnl = !BALANCE_SHEET_TYPES.has(type);
      if (isPnl && date < startDate) continue;
      const entityId = raw.location_id;
      if (scope && !scope.has(entityId)) continue;
      lineCount += 1;
      const natural = naturalBalance(type, N(raw.debit_cents), N(raw.credit_cents));
      const key = `${entityId}:${acct.account_number}`;
      const existing = balancesByKey.get(key);
      if (existing) {
        existing.naturalBalanceCents += natural;
      } else {
        balancesByKey.set(key, {
          entityId,
          accountNumber: acct.account_number,
          accountName: acct.name,
          accountType: type,
          isEliminating: Boolean(acct.is_eliminating),
          role: roleByAccountId.get(raw.account_id) ?? null,
          naturalBalanceCents: natural,
        });
      }
    }
  }

  // ── FX translation (additive): translate each foreign entity's TB into the ──
  // reporting currency BEFORE consolidating, appending a CTA plug so it ties.
  // Single-currency entities pass through unchanged, so the consolidated output is
  // byte-for-byte identical to the pre-FX behavior when all share the currency.
  const fxCtx = await loadFxContext(supabase, orgId, opts.reportingCurrency);

  const rawBalances = Array.from(balancesByKey.values());
  const byEntity = new Map<string, EntityAccountBalance[]>();
  for (const b of rawBalances) {
    const arr = byEntity.get(b.entityId) ?? [];
    arr.push(b);
    byEntity.set(b.entityId, arr);
  }

  const translatedBalances: EntityAccountBalance[] = [];
  const fxByEntity: EntityFxInfo[] = [];
  let ctaTotalCents = 0;
  let multiCurrency = false;
  for (const [entityId, ebals] of byEntity) {
    const functional = fxCtx.functionalByEntity.get(entityId) ?? fxCtx.reportingCurrency;
    const { rates, resolved } = resolveTranslationRates(
      fxCtx.fxRows,
      functional,
      fxCtx.reportingCurrency,
    );
    const tr = translateEntityTB(ebals, {
      functionalCurrency: functional,
      reportingCurrency: fxCtx.reportingCurrency,
      rates,
    });
    translatedBalances.push(...tr.translated);
    ctaTotalCents += tr.ctaCents;
    if (tr.translated_applied) multiCurrency = true;
    fxByEntity.push({
      entityId,
      functionalCurrency: functional,
      rates: tr.rates,
      ctaCents: tr.ctaCents,
      translated: tr.translated_applied,
      ratesResolved: resolved,
    });
  }

  const result = consolidate({
    entities: scopedMeta,
    balances: translatedBalances,
    eliminate,
  });

  return {
    result,
    entities: scopedEntities,
    entityMeta: scopedMeta,
    ownershipTableAvailable,
    intercompanyRolesResolved,
    scanned: { entries: entries.length, lines: lineCount },
    fx: {
      reportingCurrency: fxCtx.reportingCurrency,
      fxRatesAvailable: fxCtx.fxRatesAvailable,
      functionalCurrencyColumnAvailable: fxCtx.functionalCurrencyColumnAvailable,
      multiCurrency,
      ctaTotalCents,
      byEntity: fxByEntity,
    },
  };
}
