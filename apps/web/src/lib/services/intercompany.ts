/**
 * Intercompany service (Session 22) — entity-level due-to / due-from.
 *
 * An intercompany transaction moves value between two entities (core.locations)
 * inside one tenant. Because postJournalEntry gates the fiscal period per
 * location, each side is its own balanced entry on that entity's books; a parent
 * `intercompany_transactions` row links the pair so they reconcile and void
 * together. The "from" (creditor) entity books Intercompany Receivable (role
 * INTERCOMPANY_AR / 1160); the "to" (debtor) entity books Intercompany Payable
 * (role INTERCOMPANY_AP / 2020). The two always net to zero on consolidation.
 *
 *   FUNDING            from advances cash to to
 *     from:  DR Intercompany AR  / CR Operating bank        (cp = to)
 *     to:    DR Operating bank   / CR Intercompany AP        (cp = from)
 *   EXPENSE_ON_BEHALF  from pays a third-party cost owed by to
 *     from:  DR Intercompany AR  / CR Operating bank        (cp = to)
 *     to:    DR <expense acct>   / CR Intercompany AP        (cp = from)
 *   REPAYMENT          to repays from (relieves the position)
 *     to:    DR Intercompany AP  / CR Operating bank        (cp = from)
 *     from:  DR Operating bank   / CR Intercompany AR        (cp = to)
 *
 * Advisory note: this is real cross-entity intercompany (each entity a separate
 * book), distinct from the inter-DEPARTMENT internal-invoice elimination (II.4),
 * which moves value between departments inside ONE entity.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, voidJournalEntry, type JournalEntryLineInput } from './gl-posting';
import { resolveRole, getAccountRef, PostingError } from '@/lib/posting/account-roles';

type DB = SupabaseClient;

export type IcNature = 'FUNDING' | 'EXPENSE_ON_BEHALF' | 'REPAYMENT';

export interface PostIntercompanyInput {
  orgId: string;
  nature: IcNature;
  transactionDate: string; // YYYY-MM-DD
  fromLocationId: string;
  toLocationId: string;
  amountCents: number;
  memo?: string;
  expenseAccountId?: string; // required for EXPENSE_ON_BEHALF
}

export interface PostIntercompanyResult {
  success: boolean;
  icId?: string;
  icNumber?: string;
  fromEntryNumber?: string;
  toEntryNumber?: string;
  error?: string;
}

const EXPENSE_TYPES = new Set(['COGS', 'OPEX', 'OTHER']);

/**
 * Ensure the Intercompany Receivable (1160) and Intercompany Payable (2020)
 * accounts exist. They are part of the standard chart template, so a normally
 * seeded tenant already has them and this is a no-op. For an older-vintage chart
 * that predates them, we create each from its sibling control account (1100 AR /
 * 2000 AP), inheriting that account's group + sub-type so it lands in the right
 * place. Idempotent; resolveRole then finds them by number even without a role map.
 */
async function ensureIntercompanyAccounts(db: DB, orgId: string): Promise<void> {
  const specs = [
    { number: '1160', name: 'Intercompany Receivable', sibling: '1100', type: 'ASSET', subType: 'CURRENT_ASSET' },
    { number: '2020', name: 'Intercompany Payable', sibling: '2000', type: 'LIABILITY', subType: 'CURRENT_LIABILITY' },
  ];
  for (const s of specs) {
    const { data: existing } = await db
      .from('accounts')
      .select('id')
      .eq('org_id', orgId)
      .eq('account_number', s.number)
      .eq('is_company_specific', false)
      .maybeSingle();
    if (existing?.id) continue;

    const { data: sib } = await db
      .from('accounts')
      .select('account_group_id, account_sub_type, account_type')
      .eq('org_id', orgId)
      .eq('account_number', s.sibling)
      .eq('is_company_specific', false)
      .maybeSingle<{ account_group_id: string | null; account_sub_type: string; account_type: string }>();

    // account_group_id is NOT NULL on accounts. If we can't borrow the sibling
    // control account's group, don't attempt a doomed insert — let resolveRole
    // surface its clear "map this role / seed this account" PostingError instead
    // of a raw DB constraint violation.
    if (!sib?.account_group_id) continue;

    await db.from('accounts').upsert(
      {
        org_id: orgId,
        account_group_id: sib?.account_group_id ?? null,
        account_number: s.number,
        name: s.name,
        account_type: sib?.account_type ?? s.type,
        account_sub_type: sib?.account_sub_type ?? s.subType,
        is_company_specific: false,
        company_location_id: null,
        approval_status: 'APPROVED',
        is_active: true,
        display_order: 50,
      },
      { onConflict: 'org_id,account_number', ignoreDuplicates: true },
    );
  }
}

/** Next IC-NNNNNN for the org (zero-padded, gap-tolerant by count). */
async function nextIcNumber(db: DB, orgId: string): Promise<string> {
  const { count } = await db
    .from('intercompany_transactions')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);
  return `IC-${String((count ?? 0) + 1).padStart(6, '0')}`;
}

/**
 * Post an intercompany transaction as two linked, balanced entries.
 * Atomic-ish: if the second entry or the link fails, already-posted entries are
 * voided and the parent row is removed, so the books never carry a half-posting.
 */
export async function postIntercompany(
  db: DB,
  input: PostIntercompanyInput,
): Promise<PostIntercompanyResult> {
  const { orgId, nature, transactionDate, fromLocationId, toLocationId, amountCents, memo } = input;

  // ---- Validate ----
  if (fromLocationId === toLocationId) {
    return { success: false, error: 'The two entities must be different.' };
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return { success: false, error: 'Amount must be a positive whole number of cents.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
    return { success: false, error: 'transaction_date must be YYYY-MM-DD.' };
  }

  // Both entities must belong to the org.
  const { data: locs } = await db
    .schema('core').from('locations')
    .select('id')
    .eq('org_id', orgId)
    .in('id', [fromLocationId, toLocationId]);
  if (!locs || locs.length !== 2) {
    return { success: false, error: 'One or both entities were not found in this organization.' };
  }

  try {
    // Make sure the intercompany accounts exist (no-op on a standard chart).
    await ensureIntercompanyAccounts(db, orgId);

    // ---- Resolve accounts (refuses to guess; throws PostingError) ----
    const icAr = await resolveRole(db, orgId, 'INTERCOMPANY_AR');
    const icAp = await resolveRole(db, orgId, 'INTERCOMPANY_AP');
    const fromBank = await resolveRole(db, orgId, 'OPERATING_BANK', fromLocationId);
    const toBank = await resolveRole(db, orgId, 'OPERATING_BANK', toLocationId);

    let expenseAcctId: string | null = null;
    if (nature === 'EXPENSE_ON_BEHALF') {
      if (!input.expenseAccountId) {
        return { success: false, error: 'An expense account is required for "expense paid on behalf".' };
      }
      const exp = await getAccountRef(db, orgId, input.expenseAccountId);
      if (!EXPENSE_TYPES.has(exp.account_type)) {
        return {
          success: false,
          error: `Account ${exp.account_number} is a ${exp.account_type} account; choose a COGS or operating-expense account.`,
        };
      }
      expenseAcctId = exp.id;
    }

    // ---- Build the two entries' lines per nature ----
    let fromLines: JournalEntryLineInput[];
    let toLines: JournalEntryLineInput[];

    if (nature === 'FUNDING' || nature === 'EXPENSE_ON_BEHALF') {
      fromLines = [
        { account_id: icAr.id, debit_cents: amountCents, credit_cents: 0, location_id: fromLocationId, counterparty_location_id: toLocationId, memo: 'Intercompany receivable' },
        { account_id: fromBank.id, debit_cents: 0, credit_cents: amountCents, location_id: fromLocationId, memo: 'Cash out' },
      ];
      toLines = [
        {
          account_id: nature === 'FUNDING' ? toBank.id : (expenseAcctId as string),
          debit_cents: amountCents,
          credit_cents: 0,
          location_id: toLocationId,
          memo: nature === 'FUNDING' ? 'Cash in' : 'Expense funded by affiliate',
        },
        { account_id: icAp.id, debit_cents: 0, credit_cents: amountCents, location_id: toLocationId, counterparty_location_id: fromLocationId, memo: 'Intercompany payable' },
      ];
    } else {
      // REPAYMENT: to pays from back
      toLines = [
        { account_id: icAp.id, debit_cents: amountCents, credit_cents: 0, location_id: toLocationId, counterparty_location_id: fromLocationId, memo: 'Relieve intercompany payable' },
        { account_id: toBank.id, debit_cents: 0, credit_cents: amountCents, location_id: toLocationId, memo: 'Cash out (repayment)' },
      ];
      fromLines = [
        { account_id: fromBank.id, debit_cents: amountCents, credit_cents: 0, location_id: fromLocationId, memo: 'Cash in (repayment)' },
        { account_id: icAr.id, debit_cents: 0, credit_cents: amountCents, location_id: fromLocationId, counterparty_location_id: toLocationId, memo: 'Relieve intercompany receivable' },
      ];
    }

    // ---- Create parent row (no entries yet) ----
    const icNumber = await nextIcNumber(db, orgId);
    const { data: ic, error: icErr } = await db
      .from('intercompany_transactions')
      .insert({
        org_id: orgId,
        ic_number: icNumber,
        nature,
        transaction_date: transactionDate,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        amount_cents: amountCents,
        expense_account_id: expenseAcctId,
        memo: memo ?? null,
        status: 'POSTED',
        created_by: null,
      })
      .select('id')
      .single();
    if (icErr || !ic) {
      return { success: false, error: `Failed to create intercompany record: ${icErr?.message ?? 'unknown'}` };
    }

    const baseMemo = `Intercompany ${icNumber}${memo ? ` — ${memo}` : ''}`;

    // ---- Post the FROM entry ----
    const fromRes = await postJournalEntry(db, {
      org_id: orgId,
      location_id: fromLocationId,
      entry_date: transactionDate,
      entry_type: 'STANDARD',
      memo: baseMemo,
      source_module: 'INTERCOMPANY',
      source_id: ic.id,
      created_by: null,
      lines: fromLines,
    });
    if (!fromRes.success) {
      await db.from('intercompany_transactions').delete().eq('id', ic.id);
      return { success: false, error: `From-entity entry failed: ${fromRes.error}` };
    }

    // ---- Post the TO entry ----
    const toRes = await postJournalEntry(db, {
      org_id: orgId,
      location_id: toLocationId,
      entry_date: transactionDate,
      entry_type: 'STANDARD',
      memo: baseMemo,
      source_module: 'INTERCOMPANY',
      source_id: ic.id,
      created_by: null,
      lines: toLines,
    });
    if (!toRes.success) {
      // Compensate: void the from entry, drop the parent.
      await voidJournalEntry(db, orgId, fromRes.entry_id as string, null, `Auto-reversed: paired intercompany entry failed (${toRes.error})`);
      await db.from('intercompany_transactions').delete().eq('id', ic.id);
      return { success: false, error: `To-entity entry failed: ${toRes.error}` };
    }

    // ---- Link both entries onto the parent ----
    await db
      .from('intercompany_transactions')
      .update({ from_entry_id: fromRes.entry_id, to_entry_id: toRes.entry_id })
      .eq('id', ic.id);

    return {
      success: true,
      icId: ic.id,
      icNumber,
      fromEntryNumber: fromRes.entry_number,
      toEntryNumber: toRes.entry_number,
    };
  } catch (err) {
    if (err instanceof PostingError) return { success: false, error: err.message };
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

/** Void an intercompany transaction: void BOTH entries, mark the parent VOIDED. */
export async function voidIntercompany(
  db: DB,
  orgId: string,
  icId: string,
  reason: string,
): Promise<{ success: boolean; error?: string }> {
  const { data: ic, error } = await db
    .from('intercompany_transactions')
    .select('id, status, from_entry_id, to_entry_id')
    .eq('org_id', orgId)
    .eq('id', icId)
    .single();
  if (error || !ic) return { success: false, error: 'Intercompany transaction not found.' };
  if (ic.status === 'VOIDED') return { success: false, error: 'Already voided.' };

  // Void both sides. voidJournalEntry refuses on a hard-closed period, so if one
  // side is in a closed period we stop before mutating the other.
  for (const entryId of [ic.from_entry_id, ic.to_entry_id]) {
    if (!entryId) continue;
    const res = await voidJournalEntry(db, orgId, entryId as string, null, `Intercompany void: ${reason}`);
    if (!res.success) {
      return { success: false, error: `Could not void a paired entry: ${res.error}` };
    }
  }

  const { error: updErr } = await db
    .from('intercompany_transactions')
    .update({ status: 'VOIDED', voided_at: new Date().toISOString(), voided_by: null, void_reason: reason })
    .eq('id', icId)
    .eq('org_id', orgId);
  if (updErr) return { success: false, error: updErr.message };
  return { success: true };
}

// ---- Overview / reconciliation ----------------------------------------------

export interface IcEntity { id: string; name: string; shortCode: string | null }

export interface IcTransactionRow {
  id: string;
  icNumber: string;
  nature: IcNature;
  transactionDate: string;
  fromEntity: IcEntity | null;
  toEntity: IcEntity | null;
  amountCents: number;
  memo: string | null;
  status: 'POSTED' | 'VOIDED';
  fromEntryNumber: string | null;
  toEntryNumber: string | null;
}

export interface IcPairBalance {
  creditorEntity: IcEntity; // owed the money
  debtorEntity: IcEntity;   // owes the money
  netCents: number;         // > 0 means debtor owes creditor this much
}

export interface IcGroupTie {
  totalReceivableCents: number; // sum of Intercompany AR across the group
  totalPayableCents: number;    // sum of Intercompany AP across the group
  differenceCents: number;      // should be 0
  balanced: boolean;
}

export interface IcOverview {
  entities: IcEntity[];
  transactions: IcTransactionRow[];
  pairBalances: IcPairBalance[];
  groupTie: IcGroupTie;
}

export async function getIntercompanyOverview(db: DB, orgId: string): Promise<IcOverview> {
  // Entities
  const { data: locRows } = await db
    .schema('core').from('locations')
    .select('id, name, short_code')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('name');
  const entities: IcEntity[] = (locRows ?? []).map((l: Record<string, unknown>) => ({
    id: l.id as string,
    name: l.name as string,
    shortCode: (l.short_code as string) ?? null,
  }));
  const entityById = new Map(entities.map((e) => [e.id, e]));

  // Transactions
  const { data: txnRows } = await db
    .from('intercompany_transactions')
    .select('id, ic_number, nature, transaction_date, from_location_id, to_location_id, amount_cents, memo, status, from_entry_id, to_entry_id')
    .eq('org_id', orgId)
    .order('transaction_date', { ascending: false })
    .order('created_at', { ascending: false });

  const txns = txnRows ?? [];

  // Resolve linked GL entry numbers for display.
  const entryIds = [
    ...new Set(
      txns.flatMap((t: Record<string, unknown>) => [t.from_entry_id, t.to_entry_id]).filter(Boolean) as string[],
    ),
  ];
  const entryNumberById = new Map<string, string>();
  if (entryIds.length > 0) {
    const { data: entryRows } = await db
      .from('gl_entries')
      .select('id, entry_number')
      .in('id', entryIds);
    for (const e of entryRows ?? []) entryNumberById.set(e.id as string, e.entry_number as string);
  }

  const transactions: IcTransactionRow[] = txns.map((t: Record<string, unknown>) => ({
    id: t.id as string,
    icNumber: t.ic_number as string,
    nature: t.nature as IcNature,
    transactionDate: t.transaction_date as string,
    fromEntity: entityById.get(t.from_location_id as string) ?? null,
    toEntity: entityById.get(t.to_location_id as string) ?? null,
    amountCents: Number(t.amount_cents ?? 0),
    memo: (t.memo as string) ?? null,
    status: t.status as 'POSTED' | 'VOIDED',
    fromEntryNumber: t.from_entry_id ? entryNumberById.get(t.from_entry_id as string) ?? null : null,
    toEntryNumber: t.to_entry_id ? entryNumberById.get(t.to_entry_id as string) ?? null : null,
  }));

  // Pair balances from POSTED transactions.
  // directed[creditor][debtor] accumulates "debtor owes creditor".
  const directed = new Map<string, number>();
  const key = (a: string, b: string) => `${a}|${b}`;
  for (const t of transactions) {
    if (t.status !== 'POSTED' || !t.fromEntity || !t.toEntity) continue;
    const from = t.fromEntity.id;
    const to = t.toEntity.id;
    // FUNDING / EXPENSE_ON_BEHALF: `to` owes `from`. REPAYMENT relieves it.
    const delta = t.nature === 'REPAYMENT' ? -t.amountCents : t.amountCents;
    directed.set(key(from, to), (directed.get(key(from, to)) ?? 0) + delta);
  }
  const pairBalances: IcPairBalance[] = [];
  const seen = new Set<string>();
  for (const e1 of entities) {
    for (const e2 of entities) {
      if (e1.id >= e2.id) continue;
      const pairId = key(e1.id, e2.id);
      if (seen.has(pairId)) continue;
      seen.add(pairId);
      const aOwesB = directed.get(key(e2.id, e1.id)) ?? 0; // e1 owes e2
      const bOwesA = directed.get(key(e1.id, e2.id)) ?? 0; // e2 owes e1
      const net = bOwesA - aOwesB;
      if (net === 0) continue;
      if (net > 0) pairBalances.push({ creditorEntity: e1, debtorEntity: e2, netCents: net });
      else pairBalances.push({ creditorEntity: e2, debtorEntity: e1, netCents: -net });
    }
  }
  pairBalances.sort((a, b) => b.netCents - a.netCents);

  // Group tie: total Intercompany AR vs AP across the whole group (should match).
  let totalReceivableCents = 0;
  let totalPayableCents = 0;
  try {
    const icAr = await resolveRole(db, orgId, 'INTERCOMPANY_AR');
    const icAp = await resolveRole(db, orgId, 'INTERCOMPANY_AP');

    // Only count lines on POSTED entries.
    const { data: postedEntries } = await db
      .from('gl_entries')
      .select('id')
      .eq('org_id', orgId)
      .eq('status', 'POSTED');
    const postedIds = (postedEntries ?? []).map((e: Record<string, unknown>) => e.id as string);

    if (postedIds.length > 0) {
      const { data: arLines } = await db
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .eq('account_id', icAr.id)
        .in('gl_entry_id', postedIds);
      totalReceivableCents = (arLines ?? []).reduce(
        (s: number, l: Record<string, unknown>) => s + Number(l.debit_cents ?? 0) - Number(l.credit_cents ?? 0),
        0,
      );
      const { data: apLines } = await db
        .from('gl_entry_lines')
        .select('debit_cents, credit_cents')
        .eq('account_id', icAp.id)
        .in('gl_entry_id', postedIds);
      totalPayableCents = (apLines ?? []).reduce(
        (s: number, l: Record<string, unknown>) => s + Number(l.credit_cents ?? 0) - Number(l.debit_cents ?? 0),
        0,
      );
    }
  } catch {
    // Roles not seeded yet → leave totals at zero; UI shows nothing to reconcile.
  }

  const differenceCents = totalReceivableCents - totalPayableCents;
  const groupTie: IcGroupTie = {
    totalReceivableCents,
    totalPayableCents,
    differenceCents,
    balanced: differenceCents === 0,
  };

  return { entities, transactions, pairBalances, groupTie };
}
