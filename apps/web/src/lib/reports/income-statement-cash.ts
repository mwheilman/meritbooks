/**
 * TRUE cash-basis Income Statement (P&L).
 *
 * The accrual engine (app/api/reports/board-package/queries.ts → fetchIncomeStatement,
 * and app/api/reports/income-statement/route.ts) recognizes revenue when INVOICED
 * (DR AR / CR revenue) and expense when BILLED (DR expense / CR AP). Its `basis:'cash'`
 * option is only a weak proxy — it keeps accrual-dated GL lines that happen to be tied
 * to a cleared bank transaction, which is NOT a real cash-basis presentation.
 *
 * This module produces a deterministic, genuine cash-basis P&L that recognizes:
 *
 *   • REVENUE when cash is RECEIVED — customer cash receipts (customer_payments)
 *     traced through payment_applications back to each invoice's revenue lines,
 *     PLUS direct cash sales (a GL entry that credits revenue against cash with no
 *     invoice).
 *   • EXPENSE when cash is PAID — bill payments (bill_payments) traced back to each
 *     bill's expense lines, PLUS direct cash disbursements (a GL entry that debits an
 *     expense against cash with no bill).
 *
 * The three legs are mutually exclusive by construction (settlement entries touch
 * AR/AP not P&L; accrual recognition entries never touch cash; only genuine
 * direct-cash P&L entries touch cash AND a P&L account on the same entry), so there
 * is no double counting.
 *
 * Output is the SAME `IncomeStatementPayload` shape the accrual engine returns —
 * identical sections / groups / summary — so the report compiler and the export
 * StatementModel builders render it identically (tagged basis:'cash'). Money is
 * bigint cents throughout; no floats.
 *
 * `computeCashIncomeStatement` is a PURE function (no I/O) and is unit-tested.
 * `fetchCashIncomeStatement` fetches the sub-ledger + GL data (RLS-scoped) and calls it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import type { IncomeStatementPayload } from '@/lib/reports/board-package';

const PL_TYPES = ['REVENUE', 'COGS', 'OPEX', 'OTHER'] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Pure computation
// ─────────────────────────────────────────────────────────────────────────────

export interface CashAccountMeta {
  accountId: string;
  accountNumber: string;
  accountName: string;
  /** REVENUE | COGS | OPEX | OTHER — other types are ignored (dropped from the P&L). */
  accountType: string;
  groupName: string;
  groupOrder: number;
  normalBalance: 'DEBIT' | 'CREDIT';
}

/**
 * One settled document (an invoice for a receipt leg, a bill for a disbursement
 * leg): the cash actually moved in the period, the document's total (the
 * allocation denominator, INCLUSIVE of tax/retainage so those portions of the
 * cash are correctly excluded from the P&L), and the document's P&L lines.
 */
export interface CashSettlementLeg {
  cashCents: number;
  documentTotalCents: number;
  lines: Array<{ accountId: string; amountCents: number }>;
}

/** A P&L line on a GL entry that directly touched cash (a cash sale / direct pay). */
export interface CashDirectLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
}

export interface CashISInput {
  /** Metadata for every P&L account referenced by any leg, keyed by accountId. */
  accounts: Map<string, CashAccountMeta>;
  receipts: CashSettlementLeg[];      // leg A — customer cash receipts → invoice revenue
  disbursements: CashSettlementLeg[]; // leg B — bill payments → bill expense
  directLines: CashDirectLine[];      // leg C — direct cash sales / disbursements
  filters: { startDate: string; endDate: string };
}

/**
 * Allocate the cash that moved on a document across its P&L lines, pro-rata to
 * each line's share of the document total. Using the tax/retainage-inclusive
 * total as the denominator means the non-P&L portion of the cash (sales tax
 * collected, retainage withheld) is implicitly excluded from the statement.
 */
function allocate(leg: CashSettlementLeg): Array<{ accountId: string; amountCents: number }> {
  if (leg.cashCents === 0 || leg.lines.length === 0) return [];
  const lineSum = leg.lines.reduce((s, l) => s + l.amountCents, 0);
  const denom = leg.documentTotalCents > 0 ? leg.documentTotalCents : lineSum;
  if (denom === 0) return [];
  return leg.lines.map((l) => ({
    accountId: l.accountId,
    amountCents: Math.round((leg.cashCents * l.amountCents) / denom),
  }));
}

interface DebCred { debits: number; credits: number }

/** Fold all three legs into per-account debit/credit totals (natural GL sign). */
function accumulate(input: CashISInput): Map<string, DebCred> {
  const per = new Map<string, DebCred>();
  const bump = (accountId: string, debit: number, credit: number) => {
    const e = per.get(accountId) ?? { debits: 0, credits: 0 };
    e.debits += debit;
    e.credits += credit;
    per.set(accountId, e);
  };

  // Legs A + B: the allocated cash lands on each account's natural P&L side
  // (revenue = credit, expense = debit), so a fully-paid line reproduces its
  // recognized amount exactly.
  for (const leg of input.receipts) {
    for (const a of allocate(leg)) {
      const meta = input.accounts.get(a.accountId);
      if (!meta) continue;
      if (meta.normalBalance === 'CREDIT') bump(a.accountId, 0, a.amountCents);
      else bump(a.accountId, a.amountCents, 0);
    }
  }
  for (const leg of input.disbursements) {
    for (const a of allocate(leg)) {
      const meta = input.accounts.get(a.accountId);
      if (!meta) continue;
      if (meta.normalBalance === 'CREDIT') bump(a.accountId, 0, a.amountCents);
      else bump(a.accountId, a.amountCents, 0);
    }
  }

  // Leg C: direct cash P&L movements carry real debits/credits from the GL.
  for (const l of input.directLines) {
    if (!input.accounts.has(l.accountId)) continue;
    bump(l.accountId, l.debitCents, l.creditCents);
  }

  return per;
}

const SECTION_CONFIG = [
  { type: 'REVENUE', label: 'Revenue' },
  { type: 'COGS', label: 'Cost of Goods Sold' },
  { type: 'OPEX', label: 'Operating Expenses' },
  { type: 'OTHER', label: 'Other Income / Expense' },
] as const;

/**
 * Build the IncomeStatementPayload from per-account debit/credit totals — the SAME
 * grouping, sign, sorting and summary math as the accrual engine
 * (board-package/queries.ts fetchIncomeStatement), so the shapes are identical.
 */
export function computeCashIncomeStatement(input: CashISInput): IncomeStatementPayload {
  const per = accumulate(input);

  const sections: IncomeStatementPayload['sections'] = [];
  for (const cfg of SECTION_CONFIG) {
    const accounts = [...per.entries()]
      .map(([id, v]) => ({ meta: input.accounts.get(id), v }))
      .filter((x): x is { meta: CashAccountMeta; v: DebCred } => !!x.meta && x.meta.accountType === cfg.type)
      .map((x) => ({
        accountId: x.meta.accountId,
        accountNumber: x.meta.accountNumber,
        accountName: x.meta.accountName,
        groupName: x.meta.groupName,
        groupOrder: x.meta.groupOrder,
        amountCents: x.meta.normalBalance === 'CREDIT' ? x.v.credits - x.v.debits : x.v.debits - x.v.credits,
      }))
      .sort((a, b) => a.groupOrder - b.groupOrder || a.accountNumber.localeCompare(b.accountNumber));

    const groupMap = new Map<string, { accounts: typeof accounts; totalCents: number }>();
    for (const acct of accounts) {
      const existing = groupMap.get(acct.groupName);
      if (existing) {
        existing.accounts.push(acct);
        existing.totalCents += acct.amountCents;
      } else {
        groupMap.set(acct.groupName, { accounts: [acct], totalCents: acct.amountCents });
      }
    }
    const groups = [...groupMap.entries()].map(([name, g]) => ({
      name,
      accounts: g.accounts.map((a) => ({
        accountNumber: a.accountNumber,
        accountName: a.accountName,
        amountCents: a.amountCents,
        accountId: a.accountId,
        groupName: a.groupName,
      })),
      totalCents: g.totalCents,
    }));
    sections.push({ type: cfg.type, label: cfg.label, groups, totalCents: groups.reduce((s, g) => s + g.totalCents, 0) });
  }

  const revenue = sections.find((s) => s.type === 'REVENUE')?.totalCents ?? 0;
  const cogs = sections.find((s) => s.type === 'COGS')?.totalCents ?? 0;
  const opex = sections.find((s) => s.type === 'OPEX')?.totalCents ?? 0;
  const other = sections.find((s) => s.type === 'OTHER')?.totalCents ?? 0;
  const grossProfit = revenue - cogs;
  const ebitda = grossProfit - opex;
  const netIncome = ebitda - other;

  return {
    sections,
    summary: {
      revenueCents: revenue,
      cogsCents: cogs,
      grossProfitCents: grossProfit,
      opexCents: opex,
      ebitdaCents: ebitda,
      otherCents: other,
      netIncomeCents: netIncome,
      grossMarginPct: revenue > 0 ? Math.round((grossProfit / revenue) * 10000) / 100 : 0,
      netMarginPct: revenue > 0 ? Math.round((netIncome / revenue) * 10000) / 100 : 0,
    },
    filters: { startDate: input.filters.startDate, endDate: input.filters.endDate, basis: 'cash' },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Data fetch (RLS-scoped) → pure compute
// ─────────────────────────────────────────────────────────────────────────────

export interface CashISScope {
  startDate: string;
  endDate: string;
  locationIds: string[];
}

const ACCOUNT_META_SELECT = `
  id, account_number, name, account_type, display_order,
  account_groups!inner(
    name, display_order,
    account_sub_types!inner(
      name, display_order,
      account_types!inner( name, display_order, normal_balance )
    )
  )
`;

function applyLoc<T>(q: T, locationIds: string[], col = 'location_id'): T {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = q as any;
  if (locationIds.length === 1) return query.eq(col, locationIds[0]);
  if (locationIds.length > 1) return query.in(col, locationIds);
  return query;
}

/** Cash / bank account ids (is_bank_account flag + the standard cash roles). */
async function resolveCashAccountIds(supabase: SupabaseClient, orgId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  const { data: bankAccts } = await supabase.from('accounts').select('id').eq('is_bank_account', true);
  for (const a of (bankAccts ?? []) as Array<{ id: string }>) ids.add(a.id);
  const roles: AccountRoleKey[] = ['CASH_ON_HAND', 'UNDEPOSITED_FUNDS', 'OPERATING_BANK'];
  for (const role of roles) {
    try {
      const ref = await resolveRole(supabase, orgId, role);
      ids.add(ref.id);
    } catch (e) {
      if (!(e instanceof PostingError)) throw e;
    }
  }
  return ids;
}

/** Fetch metadata for a set of account ids; keep only P&L accounts. */
async function fetchAccountMeta(
  supabase: SupabaseClient,
  accountIds: string[],
): Promise<Map<string, CashAccountMeta>> {
  const out = new Map<string, CashAccountMeta>();
  if (accountIds.length === 0) return out;
  const { data, error } = await supabase.from('accounts').select(ACCOUNT_META_SELECT).in('id', accountIds);
  if (error) throw new Error(error.message);
  for (const raw of (data ?? []) as unknown as Record<string, unknown>[]) {
    const type = String(raw.account_type ?? '');
    if (!PL_TYPES.includes(type as (typeof PL_TYPES)[number])) continue;
    const group = raw.account_groups as Record<string, unknown> | undefined;
    const subType = group?.account_sub_types as Record<string, unknown> | undefined;
    const acctType = subType?.account_types as Record<string, unknown> | undefined;
    out.set(raw.id as string, {
      accountId: raw.id as string,
      accountNumber: String(raw.account_number ?? ''),
      accountName: String(raw.name ?? ''),
      accountType: type,
      groupName: String(group?.name ?? 'Ungrouped'),
      groupOrder: Number(group?.display_order ?? 0),
      normalBalance: (acctType?.normal_balance as 'DEBIT' | 'CREDIT') ?? (type === 'REVENUE' || type === 'OTHER' ? 'CREDIT' : 'DEBIT'),
    });
  }
  return out;
}

export async function fetchCashIncomeStatement(
  supabase: SupabaseClient,
  orgId: string,
  scope: CashISScope,
): Promise<IncomeStatementPayload> {
  const { startDate, endDate, locationIds } = scope;

  // ── Leg A: customer cash receipts → invoice revenue lines ───────────────────
  const { data: paymentsRaw, error: payErr } = await supabase
    .from('customer_payments')
    .select('id, gl_entry_id')
    .gte('payment_date', startDate)
    .lte('payment_date', endDate);
  if (payErr) throw new Error(payErr.message);
  const payments = (paymentsRaw ?? []) as Array<{ id: string; gl_entry_id: string | null }>;
  const paymentIds = payments.map((p) => p.id);
  const settlementEntryIds = new Set<string>();
  for (const p of payments) if (p.gl_entry_id) settlementEntryIds.add(p.gl_entry_id);

  const receipts: CashSettlementLeg[] = [];
  const referencedAccountIds = new Set<string>();
  if (paymentIds.length > 0) {
    const { data: appsRaw, error: appErr } = await supabase
      .from('payment_applications')
      .select('payment_id, invoice_id, amount_cents')
      .in('payment_id', paymentIds);
    if (appErr) throw new Error(appErr.message);
    const apps = (appsRaw ?? []) as Array<{ payment_id: string; invoice_id: string; amount_cents: number }>;
    const invoiceIds = [...new Set(apps.map((a) => a.invoice_id))];

    if (invoiceIds.length > 0) {
      // Invoices carry the revenue location — location-scope the receipts here.
      let invQ = supabase.from('invoices').select('id, total_cents, location_id').in('id', invoiceIds);
      invQ = applyLoc(invQ, locationIds);
      const { data: invRaw, error: invErr } = await invQ;
      if (invErr) throw new Error(invErr.message);
      const invMeta = new Map<string, { totalCents: number }>();
      for (const iv of (invRaw ?? []) as Array<{ id: string; total_cents: number }>) {
        invMeta.set(iv.id, { totalCents: Number(iv.total_cents ?? 0) });
      }
      const inScopeInvoiceIds = [...invMeta.keys()];

      const linesByInvoice = new Map<string, Array<{ accountId: string; amountCents: number }>>();
      if (inScopeInvoiceIds.length > 0) {
        const { data: linesRaw, error: lineErr } = await supabase
          .from('invoice_lines')
          .select('invoice_id, account_id, amount_cents')
          .in('invoice_id', inScopeInvoiceIds);
        if (lineErr) throw new Error(lineErr.message);
        for (const l of (linesRaw ?? []) as Array<{ invoice_id: string; account_id: string; amount_cents: number }>) {
          const arr = linesByInvoice.get(l.invoice_id) ?? [];
          arr.push({ accountId: l.account_id, amountCents: Number(l.amount_cents ?? 0) });
          linesByInvoice.set(l.invoice_id, arr);
          referencedAccountIds.add(l.account_id);
        }
      }

      for (const app of apps) {
        const meta = invMeta.get(app.invoice_id);
        const lines = linesByInvoice.get(app.invoice_id);
        if (!meta || !lines || lines.length === 0) continue;
        receipts.push({ cashCents: Number(app.amount_cents ?? 0), documentTotalCents: meta.totalCents, lines });
      }
    }
  }

  // ── Leg B: bill payments → bill expense lines ───────────────────────────────
  let bpQ = supabase
    .from('bill_payments')
    .select('id, bill_id, amount_cents, gl_entry_id, location_id')
    .eq('status', 'POSTED')
    .gte('payment_date', startDate)
    .lte('payment_date', endDate);
  bpQ = applyLoc(bpQ, locationIds);
  const { data: bpRaw, error: bpErr } = await bpQ;
  if (bpErr) throw new Error(bpErr.message);
  const billPayments = (bpRaw ?? []) as Array<{ id: string; bill_id: string; amount_cents: number; gl_entry_id: string | null }>;
  for (const bp of billPayments) if (bp.gl_entry_id) settlementEntryIds.add(bp.gl_entry_id);

  const disbursements: CashSettlementLeg[] = [];
  const billIds = [...new Set(billPayments.map((b) => b.bill_id))];
  if (billIds.length > 0) {
    const { data: billsRaw, error: billErr } = await supabase.from('bills').select('id, total_cents').in('id', billIds);
    if (billErr) throw new Error(billErr.message);
    const billTotal = new Map<string, number>();
    for (const b of (billsRaw ?? []) as Array<{ id: string; total_cents: number }>) billTotal.set(b.id, Number(b.total_cents ?? 0));

    const { data: blRaw, error: blErr } = await supabase
      .from('bill_lines')
      .select('bill_id, account_id, amount_cents')
      .in('bill_id', billIds);
    if (blErr) throw new Error(blErr.message);
    const linesByBill = new Map<string, Array<{ accountId: string; amountCents: number }>>();
    for (const l of (blRaw ?? []) as Array<{ bill_id: string; account_id: string; amount_cents: number }>) {
      const arr = linesByBill.get(l.bill_id) ?? [];
      arr.push({ accountId: l.account_id, amountCents: Number(l.amount_cents ?? 0) });
      linesByBill.set(l.bill_id, arr);
      referencedAccountIds.add(l.account_id);
    }

    for (const bp of billPayments) {
      const lines = linesByBill.get(bp.bill_id);
      if (!lines || lines.length === 0) continue;
      disbursements.push({ cashCents: Number(bp.amount_cents ?? 0), documentTotalCents: billTotal.get(bp.bill_id) ?? 0, lines });
    }
  }

  // ── Leg C: direct cash sales / disbursements (GL entries touching cash) ──────
  const directLines: CashDirectLine[] = [];
  const cashIds = await resolveCashAccountIds(supabase, orgId);
  if (cashIds.size > 0) {
    // (a) entries in the period that touch a cash account
    let cashQ = supabase
      .from('gl_entry_lines')
      .select('gl_entry_id, gl_entries!inner(entry_date, status)')
      .eq('gl_entries.status', 'POSTED')
      .gte('gl_entries.entry_date', startDate)
      .lte('gl_entries.entry_date', endDate)
      .in('account_id', [...cashIds]);
    cashQ = applyLoc(cashQ, locationIds);
    const { data: cashLinesRaw, error: cashErr } = await cashQ;
    if (cashErr) throw new Error(cashErr.message);
    const cashEntryIds = new Set<string>();
    for (const l of (cashLinesRaw ?? []) as Array<{ gl_entry_id: string }>) cashEntryIds.add(l.gl_entry_id);
    // A settlement entry (a customer/bill payment) touches cash but its non-cash
    // side is AR/AP, never P&L — excluding them is defensive belt-and-suspenders.
    const targetEntryIds = [...cashEntryIds].filter((id) => !settlementEntryIds.has(id));

    if (targetEntryIds.length > 0) {
      // (b) the P&L lines on those entries = the direct cash revenue / expense
      let plQ = supabase
        .from('gl_entry_lines')
        .select('account_id, debit_cents, credit_cents, accounts!inner(account_type)')
        .in('gl_entry_id', targetEntryIds)
        .in('accounts.account_type', PL_TYPES as unknown as string[]);
      plQ = applyLoc(plQ, locationIds);
      const { data: plRaw, error: plErr } = await plQ;
      if (plErr) throw new Error(plErr.message);
      for (const l of (plRaw ?? []) as unknown as Array<Record<string, unknown>>) {
        const accountId = l.account_id as string;
        directLines.push({
          accountId,
          debitCents: Number(l.debit_cents ?? 0),
          creditCents: Number(l.credit_cents ?? 0),
        });
        referencedAccountIds.add(accountId);
      }
    }
  }

  // ── Metadata for every referenced P&L account, then compute ─────────────────
  const accounts = await fetchAccountMeta(supabase, [...referencedAccountIds]);

  return computeCashIncomeStatement({
    accounts,
    receipts,
    disbursements,
    directLines,
    filters: { startDate, endDate },
  });
}
