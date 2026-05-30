/**
 * Internal-invoice GL booking service (Session 13, Phase 1 — II.4).
 *
 * Replaces the retired chargeback engine. When a receiving department head
 * approves an internal invoice, it books a real, balanced GL entry tagged with
 * both departments, using eliminating accounts that net to zero at the company
 * (location) roll-up.
 *
 *   Revenue method (default):
 *     DR  Interdepartmental Services Cost      (receiver dept)   total
 *     CR  Interdepartmental Services Revenue   (provider dept)   total
 *
 *   Cost-transfer method:
 *     DR  Interdepartmental Cost Transfer       (receiver dept)   total
 *     CR  Interdepartmental Cost Transfer       (provider dept)   total
 *     (single eliminating account; moves cost between departments, no revenue)
 *
 * All three accounts are flagged is_eliminating = true so the consolidation
 * toggle (Phase 1 reporting) can exclude them for the company/consolidated view.
 *
 * Mirrors the proven /api/journal-entries posting path: resolve the open fiscal
 * period for the location + date, insert gl_entries (entry_number auto-generates),
 * then gl_entry_lines. Honors the balanced-entry, approved-account, control-account,
 * and dimension-requirement triggers.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type DB = SupabaseClient;

export type ChargeMethod = 'revenue' | 'cost_transfer';

export interface EliminatingAccounts {
  revenueAccountId: string;
  costAccountId: string;
  transferAccountId: string;
}

interface AccountSpec {
  number: string;
  name: string;
  accountType: 'REVENUE' | 'COGS';
  subTypeCode: 'REVENUE' | 'COST_OF_GOODS_SOLD';
  groupName: string;
}

const ELIM_REVENUE: AccountSpec = {
  number: '4990',
  name: 'Interdepartmental Services Revenue',
  accountType: 'REVENUE',
  subTypeCode: 'REVENUE',
  groupName: 'Interdepartmental Eliminations',
};

const ELIM_COST: AccountSpec = {
  number: '5990',
  name: 'Interdepartmental Services Cost',
  accountType: 'COGS',
  subTypeCode: 'COST_OF_GOODS_SOLD',
  groupName: 'Interdepartmental Eliminations',
};

const ELIM_TRANSFER: AccountSpec = {
  number: '5991',
  name: 'Interdepartmental Cost Transfer',
  accountType: 'COGS',
  subTypeCode: 'COST_OF_GOODS_SOLD',
  groupName: 'Interdepartmental Eliminations',
};

/** Find a free account_number at/after the desired base within the same thousand-range. */
async function freeAccountNumber(db: DB, orgId: string, desired: string): Promise<string> {
  const { data } = await db.from('accounts').select('account_number').eq('org_id', orgId);
  const taken = new Set((data ?? []).map((a: { account_number: string }) => a.account_number));
  if (!taken.has(desired)) return desired;
  let n = parseInt(desired, 10);
  for (let i = 0; i < 50; i++) {
    n += 1;
    if (!taken.has(String(n))) return String(n);
  }
  return desired; // fall back; unique constraint will surface a clear error
}

/** Ensure (lazily create) the eliminating account for a spec; returns its id. */
async function ensureAccount(db: DB, orgId: string, spec: AccountSpec): Promise<string> {
  // Already created (match by name + eliminating flag, org-scoped)
  const { data: existing } = await db
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', spec.name)
    .eq('is_eliminating', true)
    .maybeSingle();
  if (existing?.id) return existing.id;

  // Resolve sub-type for the org
  const { data: subType } = await db
    .from('account_sub_types')
    .select('id')
    .eq('org_id', orgId)
    .eq('code', spec.subTypeCode)
    .maybeSingle();
  if (!subType?.id) {
    throw new Error(`Account sub-type ${spec.subTypeCode} not found — COA not seeded for this org`);
  }

  // Resolve (or create) a dedicated eliminations group under that sub-type
  let groupId: string | null = null;
  const { data: group } = await db
    .from('account_groups')
    .select('id')
    .eq('org_id', orgId)
    .eq('name', spec.groupName)
    .maybeSingle();
  if (group?.id) {
    groupId = group.id;
  } else {
    const { data: maxOrder } = await db
      .from('account_groups')
      .select('display_order')
      .eq('org_id', orgId)
      .order('display_order', { ascending: false })
      .limit(1)
      .maybeSingle();
    const { data: created, error: groupErr } = await db
      .from('account_groups')
      .insert({
        org_id: orgId,
        account_sub_type_id: subType.id,
        name: `${spec.groupName} (${spec.accountType})`,
        display_order: ((maxOrder?.display_order as number) ?? 900) + 1,
      })
      .select('id')
      .single();
    if (groupErr || !created) throw new Error(`Failed to create eliminations group: ${groupErr?.message}`);
    groupId = created.id;
  }

  const number = await freeAccountNumber(db, orgId, spec.number);

  const { data: account, error } = await db
    .from('accounts')
    .insert({
      org_id: orgId,
      account_group_id: groupId,
      account_number: number,
      name: spec.name,
      account_type: spec.accountType,
      account_sub_type: spec.subTypeCode,
      is_eliminating: true,
      is_control_account: false,
      require_department: false, // line still carries the department; no hard gate needed
      require_location: true,
      approval_status: 'APPROVED', // system account, immediately postable
      display_order: 990,
    })
    .select('id')
    .single();
  if (error || !account) throw new Error(`Failed to create eliminating account ${spec.name}: ${error?.message}`);
  return account.id;
}

/** Ensure all eliminating accounts exist for the org; returns their ids. */
export async function ensureEliminatingAccounts(db: DB, orgId: string): Promise<EliminatingAccounts> {
  const [revenueAccountId, costAccountId, transferAccountId] = await Promise.all([
    ensureAccount(db, orgId, ELIM_REVENUE),
    ensureAccount(db, orgId, ELIM_COST),
    ensureAccount(db, orgId, ELIM_TRANSFER),
  ]);
  return { revenueAccountId, costAccountId, transferAccountId };
}

export interface BookInput {
  orgId: string;
  locationId: string;
  invoiceDate: string; // YYYY-MM-DD
  totalCents: number;
  providerDepartmentId: string;
  receiverDepartmentId: string;
  chargeMethod: ChargeMethod;
  memo: string | null;
  postedBy: string | null;
}

export interface BookResult {
  glEntryId: string;
}

/**
 * Post the balanced GL entry for an approved internal invoice.
 * Throws an Error with a user-facing message on any failure (no partial state:
 * the header is rolled back if line insertion fails).
 */
export async function bookInternalInvoice(db: DB, input: BookInput): Promise<BookResult> {
  if (input.totalCents <= 0) throw new Error('Invoice total must be greater than zero');
  if (input.providerDepartmentId === input.receiverDepartmentId) {
    throw new Error('Provider and receiver departments must differ');
  }

  const elim = await ensureEliminatingAccounts(db, input.orgId);

  // Resolve the open fiscal period for this location + date (same rule as JE posting)
  const { data: period } = await db
    .from('fiscal_periods')
    .select('id, status')
    .eq('org_id', input.orgId)
    .eq('location_id', input.locationId)
    .lte('start_date', input.invoiceDate)
    .gte('end_date', input.invoiceDate)
    .maybeSingle();
  if (!period?.id) {
    throw new Error(`No fiscal period exists for ${input.invoiceDate}. Open a period for this company first.`);
  }
  if ((period.status as string) === 'HARD_CLOSE') {
    throw new Error('Cannot book into a hard-closed period');
  }

  // Insert the GL entry header (entry_number auto-generates)
  const { data: entry, error: entryError } = await db
    .from('gl_entries')
    .insert({
      org_id: input.orgId,
      location_id: input.locationId,
      entry_date: input.invoiceDate,
      entry_type: 'STANDARD',
      fiscal_period_id: period.id,
      memo: input.memo ?? 'Inter-department internal invoice',
      source_module: 'INTERNAL_INVOICE',
      status: 'POSTED',
      posted_at: new Date().toISOString(),
      posted_by: input.postedBy,
      created_by: input.postedBy,
    })
    .select('id')
    .single();
  if (entryError || !entry) throw new Error(`Failed to create GL entry: ${entryError?.message}`);

  // Build the two balanced, department-tagged lines per charge method
  const lines =
    input.chargeMethod === 'cost_transfer'
      ? [
          {
            account_id: elim.transferAccountId,
            debit_cents: input.totalCents,
            credit_cents: 0,
            department_id: input.receiverDepartmentId,
            counterparty_department_id: input.providerDepartmentId,
            memo: 'Cost transfer in',
          },
          {
            account_id: elim.transferAccountId,
            debit_cents: 0,
            credit_cents: input.totalCents,
            department_id: input.providerDepartmentId,
            counterparty_department_id: input.receiverDepartmentId,
            memo: 'Cost transfer out',
          },
        ]
      : [
          {
            account_id: elim.costAccountId,
            debit_cents: input.totalCents,
            credit_cents: 0,
            department_id: input.receiverDepartmentId,
            counterparty_department_id: input.providerDepartmentId,
            memo: 'Internal services cost',
          },
          {
            account_id: elim.revenueAccountId,
            debit_cents: 0,
            credit_cents: input.totalCents,
            department_id: input.providerDepartmentId,
            counterparty_department_id: input.receiverDepartmentId,
            memo: 'Internal services revenue',
          },
        ];

  const lineInserts = lines.map((l, i) => ({
    org_id: input.orgId,
    gl_entry_id: entry.id,
    line_number: i + 1,
    account_id: l.account_id,
    debit_cents: l.debit_cents,
    credit_cents: l.credit_cents,
    location_id: input.locationId,
    department_id: l.department_id,
    counterparty_department_id: l.counterparty_department_id,
    class_id: null,
    item_id: null,
    memo: l.memo,
  }));

  const { error: linesError } = await db.from('gl_entry_lines').insert(lineInserts);
  if (linesError) {
    await db.from('gl_entries').delete().eq('id', entry.id); // roll back header
    throw new Error(`Failed to post GL lines: ${linesError.message}`);
  }

  return { glEntryId: entry.id };
}
