/**
 * Income Tax Provision service (ASC 740) — the RLS-scoped I/O around the pure engine.
 *
 * Compute: assemble the Schedule M-1/M-3 reconciliation from real GL activity (the same
 * `buildM1Report` the book-to-tax report uses), then hand its permanent/temporary split to the
 * pure `computeProvision`. The engine never sees the database; this file never does the tax
 * arithmetic — a clean seam. RLS enforces org isolation (org_id is never hand-filtered).
 *
 * Propose: snapshot the computed provision into `public.tax_provision` (status PROPOSED) plus
 * the per-line temporary-difference detail into `public.deferred_tax_items`.
 *
 * Post: on human approval, resolve the four accounts BY ROLE, build the balanced provision JE,
 * and post it through the deterministic `postJournalEntry` — guarded by a stable `source_ref`
 * so the same period cannot post twice (canon §3: the ledger is the double-post guarantor).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry } from '@/lib/services/gl-posting';
import { buildM1Report, type M1Report } from './m1-report';
import {
  computeProvision,
  buildProvisionJournalLines,
  type ProvisionResult,
} from './provision';
import { resolveProvisionAccounts } from './provision-accounts';

type DB = SupabaseClient;

const SOURCE_MODULE = 'TAX_PROVISION';

export interface ProvisionPeriodInput {
  startDate: string;
  endDate: string;
  statutoryRatePct: number;
  /** Entity/company the provision is booked to. Required to POST (a JE needs a location). */
  locationId?: string | null;
}

/** One temporary-difference line rolled into the deferred column. */
export interface DeferredTaxItem {
  code: string;
  label: string;
  /** Signed temporary difference (ADD +, SUBTRACT −). */
  temporaryDiffCents: number;
  /** Deferred tax magnitude = |temp diff| × rate. */
  deferredTaxCents: number;
  category: 'DTA' | 'DTL';
}

/**
 * The beginning → change → ending DTA/DTL rollforward for a period. Beginning balances are the
 * cumulative deferred-tax items persisted on PRIOR provisions for the same entity; the change is
 * this period's live Δ DTA / Δ DTL. Every figure is integer cents.
 */
export interface DtaDtlRollforward {
  beginningDtaCents: number;
  beginningDtlCents: number;
  dtaChangeCents: number;
  dtlChangeCents: number;
  endingDtaCents: number;
  endingDtlCents: number;
  /** Net deferred tax asset position at period end (ending DTA − ending DTL). */
  endingNetDtaCents: number;
  /** Whether beginning balances were found in prior persisted provisions. */
  hasPriorHistory: boolean;
}

export interface ProvisionComputation {
  startDate: string;
  endDate: string;
  locationId: string | null;
  result: ProvisionResult;
  m1: M1Report;
  deferredItems: DeferredTaxItem[];
  /** Beginning → change → ending DTA/DTL rollforward (beginning read from prior provisions). */
  rollforward: DtaDtlRollforward;
  /** Role names that could not be resolved (posting is blocked until these are seeded). */
  missingAccounts: string[];
}

/**
 * Cumulative deferred-tax balances entering `startDate` for one entity: the sum of persisted
 * `deferred_tax_items` on every PRIOR provision (end_date < startDate). RLS-scoped; the single
 * source of truth for a DTA/DTL rollforward's beginning balances (shared by the provision screen
 * and the 1120 return package so the two can never disagree). Read-only.
 */
export async function readBeginningDeferredBalances(
  db: DB,
  orgId: string,
  locationId: string | null,
  startDate: string,
): Promise<{ dtaCents: number; dtlCents: number; hasPriorHistory: boolean }> {
  let provQuery = db
    .from('tax_provision')
    .select('id')
    .eq('org_id', orgId)
    .lt('end_date', startDate);
  provQuery = locationId ? provQuery.eq('location_id', locationId) : provQuery.is('location_id', null);
  const { data: priorProvs, error: provErr } = await provQuery;
  if (provErr) throw new Error(provErr.message);

  const ids = ((priorProvs ?? []) as Array<{ id: string }>).map((p) => p.id);
  if (ids.length === 0) return { dtaCents: 0, dtlCents: 0, hasPriorHistory: false };

  const { data: items, error: itemErr } = await db
    .from('deferred_tax_items')
    .select('category, deferred_tax_cents')
    .in('provision_id', ids);
  if (itemErr) throw new Error(itemErr.message);

  let dtaCents = 0;
  let dtlCents = 0;
  for (const it of (items ?? []) as Array<{ category: 'DTA' | 'DTL'; deferred_tax_cents: number }>) {
    const amt = Number(it.deferred_tax_cents ?? 0);
    if (it.category === 'DTA') dtaCents += amt;
    else dtlCents += amt;
  }
  return { dtaCents, dtlCents, hasPriorHistory: true };
}

/**
 * Assemble the DTA/DTL rollforward: prior-provision beginning balances + this period's change.
 * Read-only; never throws for a missing history (degrades to zero beginnings).
 */
export async function computeDtaDtlRollforward(
  db: DB,
  orgId: string,
  locationId: string | null,
  startDate: string,
  dtaChangeCents: number,
  dtlChangeCents: number,
): Promise<DtaDtlRollforward> {
  let begin = { dtaCents: 0, dtlCents: 0, hasPriorHistory: false };
  try {
    begin = await readBeginningDeferredBalances(db, orgId, locationId, startDate);
  } catch {
    /* prior-balance read is additive — a failure degrades to zero beginnings. */
  }
  const endingDtaCents = begin.dtaCents + dtaChangeCents;
  const endingDtlCents = begin.dtlCents + dtlChangeCents;
  return {
    beginningDtaCents: begin.dtaCents,
    beginningDtlCents: begin.dtlCents,
    dtaChangeCents,
    dtlChangeCents,
    endingDtaCents,
    endingDtlCents,
    endingNetDtaCents: endingDtaCents - endingDtlCents,
    hasPriorHistory: begin.hasPriorHistory,
  };
}

/** Derive the per-line deferred detail from the M-1 temporary differences. */
function deriveDeferredItems(m1: M1Report, ratePct: number): DeferredTaxItem[] {
  const items: DeferredTaxItem[] = [];
  for (const l of m1.additions) {
    if (l.differenceType !== 'TEMPORARY') continue;
    items.push({
      code: l.code,
      label: l.label,
      temporaryDiffCents: l.amountCents, // ADD → deductible temp diff
      deferredTaxCents: Math.round((l.amountCents * ratePct) / 100),
      category: 'DTA',
    });
  }
  for (const l of m1.subtractions) {
    if (l.differenceType !== 'TEMPORARY') continue;
    items.push({
      code: l.code,
      label: l.label,
      temporaryDiffCents: -l.amountCents, // SUBTRACT → taxable temp diff
      deferredTaxCents: Math.round((l.amountCents * ratePct) / 100),
      category: 'DTL',
    });
  }
  return items;
}

/** Compute the ASC 740 provision for a period from live GL activity. Read-only. */
export async function computeProvisionForPeriod(
  db: DB,
  orgId: string,
  input: ProvisionPeriodInput,
): Promise<ProvisionComputation> {
  const locationIds = input.locationId ? [input.locationId] : [];
  const m1 = await buildM1Report(db, {
    startDate: input.startDate,
    endDate: input.endDate,
    locationIds,
  });

  const result = computeProvision({
    pretaxBookIncomeCents: m1.bookNetIncomeCents,
    statutoryRatePct: input.statutoryRatePct,
    permanentAdditionsCents: m1.permanentAdditionsCents,
    permanentSubtractionsCents: m1.permanentSubtractionsCents,
    temporaryAdditionsCents: m1.temporaryAdditionsCents,
    temporarySubtractionsCents: m1.temporarySubtractionsCents,
  });

  const deferredItems = deriveDeferredItems(m1, input.statutoryRatePct);
  const accounts = await resolveProvisionAccounts(db, orgId, {});
  const rollforward = await computeDtaDtlRollforward(
    db,
    orgId,
    input.locationId ?? null,
    input.startDate,
    result.dtaChangeCents,
    result.dtlChangeCents,
  );

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    locationId: input.locationId ?? null,
    result,
    m1,
    deferredItems,
    rollforward,
    missingAccounts: accounts.missing,
  };
}

function periodLabel(startDate: string, endDate: string): string {
  const sy = startDate.slice(0, 4);
  const ey = endDate.slice(0, 4);
  if (startDate.endsWith('-01-01') && endDate.endsWith('-12-31') && sy === ey) return `FY${sy}`;
  return `${startDate}..${endDate}`;
}

export interface SavedProvision {
  id: string;
  status: string;
  gl_entry_id: string | null;
  source_ref: string | null;
}

/**
 * Compute + upsert the provision as PROPOSED, replacing its deferred-item detail. One row per
 * (org, location, period); re-proposing refreshes the snapshot. Does not post.
 */
export async function proposeProvision(
  db: DB,
  orgId: string,
  input: ProvisionPeriodInput,
  userId: string | null,
): Promise<{ provision: SavedProvision; computation: ProvisionComputation }> {
  const computation = await computeProvisionForPeriod(db, orgId, input);
  const r = computation.result;
  const period = periodLabel(input.startDate, input.endDate);

  const { data: row, error } = await db
    .from('tax_provision')
    .upsert(
      {
        org_id: orgId,
        location_id: input.locationId ?? null,
        period,
        start_date: input.startDate,
        end_date: input.endDate,
        statutory_rate: input.statutoryRatePct,
        pretax_book_income_cents: r.pretaxBookIncomeCents,
        permanent_diff_cents: r.permanentNetCents,
        temporary_diff_cents: r.temporaryNetCents,
        taxable_income_cents: r.taxableIncomeCents,
        current_tax_cents: r.currentTaxCents,
        deferred_tax_cents: r.deferredTaxCents,
        total_provision_cents: r.totalProvisionCents,
        dta_change_cents: r.dtaChangeCents,
        dtl_change_cents: r.dtlChangeCents,
        dta_dtl_balance_cents: r.netDeferredTaxAssetCents,
        effective_rate_pct: r.effectiveRatePct,
        status: 'PROPOSED',
        created_by: userId,
      },
      { onConflict: 'org_id,location_id,start_date,end_date' },
    )
    .select('id, status, gl_entry_id, source_ref')
    .single();

  if (error || !row) {
    throw new Error(`Failed to save provision: ${error?.message ?? 'unknown'}`);
  }

  // Replace the deferred-item detail for this provision.
  await db.from('deferred_tax_items').delete().eq('provision_id', row.id);
  if (computation.deferredItems.length > 0) {
    const rows = computation.deferredItems.map((it) => ({
      org_id: orgId,
      provision_id: row.id,
      m_line_code: it.code,
      label: it.label,
      difference_type: 'TEMPORARY',
      temporary_diff_cents: it.temporaryDiffCents,
      deferred_tax_cents: it.deferredTaxCents,
      category: it.category,
    }));
    const { error: itemErr } = await db.from('deferred_tax_items').insert(rows);
    if (itemErr) throw new Error(`Failed to save deferred detail: ${itemErr.message}`);
  }

  return { provision: row as SavedProvision, computation };
}

/** Existing non-voided provision JE with this source_ref (idempotency guard). */
async function findExistingEntry(
  db: DB,
  orgId: string,
  sourceRef: string,
): Promise<{ id: string; entry_number: string | null } | null> {
  const { data } = await db
    .from('gl_entries')
    .select('id, entry_number, status')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .neq('status', 'VOIDED')
    .limit(1)
    .maybeSingle<{ id: string; entry_number: string | null; status: string }>();
  return data ? { id: data.id, entry_number: data.entry_number } : null;
}

export interface PostProvisionResult {
  provisionId: string;
  glEntryId: string;
  entryNumber: string | null;
  sourceRef: string;
  alreadyPosted: boolean;
}

/**
 * The `tax_provision` columns this poster reads. Declared locally because the
 * generated Supabase `Database` type is stale and omits this table, so the query
 * result would otherwise be typed `GenericStringError`. The `.select()` below is
 * cast to this shape (through `unknown`) after the error check.
 */
interface ProvisionPostRow {
  id: string;
  location_id: string | null;
  period: string;
  start_date: string;
  end_date: string;
  status: string;
  total_provision_cents: number;
  current_tax_cents: number;
  dta_change_cents: number;
  dtl_change_cents: number;
  gl_entry_id: string | null;
}

/**
 * Post the balanced provision JE for a proposed provision. Resolves the four accounts BY ROLE
 * (refusing to guess), guards against a double post via source_ref, and stamps the row POSTED.
 */
export async function postProvision(
  db: DB,
  orgId: string,
  provisionId: string,
  userId: string | null,
): Promise<PostProvisionResult> {
  const { data: provData, error } = await db
    .from('tax_provision')
    .select(
      'id, location_id, period, start_date, end_date, status, ' +
        'total_provision_cents, current_tax_cents, dta_change_cents, dtl_change_cents, gl_entry_id',
    )
    .eq('org_id', orgId)
    .eq('id', provisionId)
    .maybeSingle();
  if (error) throw new Error(`Provision lookup failed: ${error.message}`);
  if (!provData) throw new Error('Provision not found');
  // The generated Database type omits tax_provision, so the row comes back typed
  // GenericStringError; restore type-safety against the local declared shape.
  const prov = provData as unknown as ProvisionPostRow;
  if (prov.status === 'POSTED') {
    return {
      provisionId,
      glEntryId: prov.gl_entry_id as string,
      entryNumber: null,
      sourceRef: `TAXPROV:${provisionId}`,
      alreadyPosted: true,
    };
  }
  if (!prov.location_id) {
    throw new Error('Select a company/entity for this provision before posting (a journal entry needs a location).');
  }
  if (prov.total_provision_cents === 0 && prov.current_tax_cents === 0 &&
      prov.dta_change_cents === 0 && prov.dtl_change_cents === 0) {
    throw new Error('This provision is zero — there is nothing to post.');
  }

  const sourceRef = `TAXPROV:${provisionId}`;
  const existing = await findExistingEntry(db, orgId, sourceRef);
  if (existing) {
    await db.from('tax_provision').update({ status: 'POSTED', gl_entry_id: existing.id, source_ref: sourceRef, posted_at: new Date().toISOString() }).eq('id', provisionId);
    return { provisionId, glEntryId: existing.id, entryNumber: existing.entry_number, sourceRef, alreadyPosted: true };
  }

  // Resolve accounts; block the post (never guess) if a needed one is missing.
  const accounts = await resolveProvisionAccounts(db, orgId, {});
  const needed: string[] = [];
  if (prov.total_provision_cents !== 0 && !accounts.incomeTaxExpense) needed.push('Income Tax Expense');
  if (prov.current_tax_cents !== 0 && !accounts.incomeTaxesPayable) needed.push('Income Taxes Payable');
  if (prov.dta_change_cents !== 0 && !accounts.deferredTaxAsset) needed.push('Deferred Tax Asset');
  if (prov.dtl_change_cents !== 0 && !accounts.deferredTaxLiability) needed.push('Deferred Tax Liability');
  if (needed.length > 0) {
    throw new Error(
      `Cannot post — these accounts are not set up in the chart of accounts: ${needed.join(', ')}. ` +
        `Seed them (or map the roles) and try again.`,
    );
  }

  // Reconstruct the result shape the JE builder needs from the stored snapshot.
  const result = {
    totalProvisionCents: Number(prov.total_provision_cents),
    currentTaxCents: Number(prov.current_tax_cents),
    dtaChangeCents: Number(prov.dta_change_cents),
    dtlChangeCents: Number(prov.dtl_change_cents),
  } as ProvisionResult;

  const memo = `Income tax provision (ASC 740) — ${prov.period}`;
  const lines = buildProvisionJournalLines(
    result,
    {
      incomeTaxExpenseAccountId: accounts.incomeTaxExpense!.id,
      incomeTaxesPayableAccountId: accounts.incomeTaxesPayable?.id ?? null,
      deferredTaxAssetAccountId: accounts.deferredTaxAsset?.id ?? null,
      deferredTaxLiabilityAccountId: accounts.deferredTaxLiability?.id ?? null,
    },
    prov.location_id as string,
    memo,
  );
  if (lines.length < 2) throw new Error('Provision produced fewer than two journal lines — nothing to post.');

  const je = await postJournalEntry(db, {
    org_id: orgId,
    location_id: prov.location_id as string,
    entry_date: prov.end_date as string,
    entry_type: 'STANDARD',
    memo,
    source_module: SOURCE_MODULE,
    source_ref: sourceRef,
    created_by: userId,
    lines,
  });
  if (!je.success || !je.entry_id) throw new Error(je.error ?? 'Failed to post provision journal entry');

  await db
    .from('tax_provision')
    .update({ status: 'POSTED', gl_entry_id: je.entry_id, source_ref: sourceRef, posted_at: new Date().toISOString() })
    .eq('id', provisionId);

  return { provisionId, glEntryId: je.entry_id, entryNumber: je.entry_number ?? null, sourceRef, alreadyPosted: false };
}
