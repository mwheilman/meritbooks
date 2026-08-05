/**
 * "Explain this ___" — deterministic fact assembler (M7 breadth).
 *
 * Given an object KIND + id and an RLS-scoped Supabase client, this gathers the
 * record's facts and produces a structured `Explanation`. It is deterministic:
 * every number and classification comes from the ledger. The Core AI gateway (in
 * the route) only phrases the resulting fact set; it never sees or invents a
 * number. Mirrors the grounding discipline of the report flux/variance narrative.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { formatMoney } from '@meritbooks/shared';
import { fetchCoreMap } from '@/lib/stitch-core';
import type {
  ExplainKind,
  Explanation,
  ExplainLineFact,
  ExplainFact,
  ExplainLink,
  ExplainActor,
} from './types';

/** Raised when the target record can't be found under the caller's RLS scope. */
export class ExplainNotFoundError extends Error {
  constructor(kind: ExplainKind, id: string) {
    super(`${kind} ${id} not found`);
    this.name = 'ExplainNotFoundError';
  }
}

// ── Nested-join shapes (mirror the income-statement / narrative routes) ───────
interface JoinedAccount {
  account_number: string;
  name: string;
  account_type: string;
  account_groups: {
    account_sub_types: {
      account_types: { normal_balance: string };
    };
  };
}

/** Normalize the Supabase nested-join value (object or single-element array). */
function one<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Derive the effect a posting has on the account's balance. */
function effectOf(side: 'debit' | 'credit', normal: 'DEBIT' | 'CREDIT'): 'increase' | 'decrease' {
  const sideIsDebit = side === 'debit';
  const normalIsDebit = normal === 'DEBIT';
  return sideIsDebit === normalIsDebit ? 'increase' : 'decrease';
}

function normalizeBalance(v: string | null | undefined): 'DEBIT' | 'CREDIT' {
  return v === 'CREDIT' ? 'CREDIT' : 'DEBIT';
}

function money(cents: number): string {
  return formatMoney(cents);
}

// ── JOURNAL_ENTRY ─────────────────────────────────────────────────────────────

interface JeHeaderRow {
  id: string;
  entry_number: string;
  entry_date: string;
  entry_type: string;
  memo: string | null;
  source_module: string | null;
  source_id: string | null;
  status: string;
  posted_at: string | null;
  posted_by: string | null;
  created_by: string | null;
  is_reversing: boolean;
  reversal_of_id: string | null;
  reversed_by_id: string | null;
  locations: { name: string | null; code: string | null } | { name: string | null; code: string | null }[] | null;
}

interface JeLineRow {
  line_number: number;
  debit_cents: number | null;
  credit_cents: number | null;
  memo: string | null;
  accounts: JoinedAccount | JoinedAccount[] | null;
}

function lineFactFrom(
  acct: JoinedAccount,
  debitCents: number,
  creditCents: number,
  memo: string | null,
): ExplainLineFact {
  const normal = normalizeBalance(acct.account_groups?.account_sub_types?.account_types?.normal_balance);
  const side: 'debit' | 'credit' = debitCents > 0 ? 'debit' : 'credit';
  const amountCents = debitCents > 0 ? debitCents : creditCents;
  return {
    accountNumber: acct.account_number,
    accountName: acct.name,
    accountType: acct.account_type,
    normalBalance: normal,
    side,
    amountCents,
    effect: effectOf(side, normal),
    memo,
  };
}

/** Human phrasing of the source module that originated an entry. */
function sourceModuleLabel(mod: string | null): string {
  switch (mod) {
    case 'BANK_FEED': return 'bank-feed categorization';
    case 'BILL': return 'a vendor bill';
    case 'RECEIPT': return 'a receipt';
    case 'PAYROLL': return 'payroll';
    case 'REV_REC': return 'revenue recognition';
    case 'DEPRECIATION': return 'depreciation';
    case 'INTERCOMPANY': return 'an intercompany transaction';
    case 'MANUAL': return 'a manual entry';
    default: return mod ? mod.toLowerCase().replace(/_/g, ' ') : 'a manual entry';
  }
}

async function gatherAiDecisions(
  supabase: SupabaseClient,
  glEntryId: string | null,
): Promise<Explanation['aiDecisions']> {
  if (!glEntryId) return [];
  const { data } = await supabase
    .from('ai_decisions')
    .select('id, feature, model_used, confidence, status, reasoning, created_at')
    .eq('posted_gl_entry_id', glEntryId)
    .order('created_at', { ascending: false })
    .limit(5);
  return (data ?? []).map((d) => ({
    id: d.id as string,
    feature: (d.feature as string) ?? '',
    modelUsed: (d.model_used as string | null) ?? null,
    confidence: d.confidence == null ? null : Number(d.confidence),
    status: (d.status as string) ?? '',
    reasoning: (d.reasoning as string | null) ?? null,
    createdAt: (d.created_at as string) ?? '',
  }));
}

/**
 * Gather the posting lines for a GL entry, with each line's debit/credit
 * DIRECTION derived from the touched account's normal balance. Shared by the
 * JOURNAL_ENTRY, BANK_TRANSACTION, and PAYMENT gatherers so the "why it posted
 * this way" breakdown is identical everywhere. `accounts` is a `public` table,
 * so the nested embed resolves without a cross-schema stitch.
 */
async function gatherGlLines(supabase: SupabaseClient, glEntryId: string): Promise<ExplainLineFact[]> {
  const { data: lineRows, error } = await supabase
    .from('gl_entry_lines')
    .select(
      `line_number, debit_cents, credit_cents, memo,
       accounts!inner(
         account_number, name, account_type,
         account_groups!inner(account_sub_types!inner(account_types!inner(normal_balance)))
       )`,
    )
    .eq('gl_entry_id', glEntryId)
    .order('line_number', { ascending: true });
  if (error) throw new Error(error.message);
  const lines: ExplainLineFact[] = [];
  for (const row of (lineRows ?? []) as unknown as JeLineRow[]) {
    const acct = one(row.accounts);
    if (!acct) continue;
    lines.push(lineFactFrom(acct, Number(row.debit_cents ?? 0), Number(row.credit_cents ?? 0), row.memo));
  }
  return lines;
}

/** Minimal GL entry header used to describe a downstream record's posting. */
interface GlHeaderLite {
  entry_number: string;
  status: string;
  posted_at: string | null;
  posted_by: string | null;
}

async function gatherGlHeader(supabase: SupabaseClient, glEntryId: string): Promise<GlHeaderLite | null> {
  const { data } = await supabase
    .from('gl_entries')
    .select('entry_number, status, posted_at, posted_by')
    .eq('id', glEntryId)
    .maybeSingle();
  return (data as GlHeaderLite | null) ?? null;
}

async function gatherJournalEntry(
  supabase: SupabaseClient,
  id: string,
): Promise<Explanation> {
  const { data: header, error: headerErr } = await supabase
    .from('gl_entries')
    .select(
      `id, entry_number, entry_date, entry_type, memo, source_module, source_id,
       status, posted_at, posted_by, created_by, is_reversing, reversal_of_id, reversed_by_id,
       locations!inner(name, code)`,
    )
    .eq('id', id)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);
  if (!header) throw new ExplainNotFoundError('JOURNAL_ENTRY', id);
  const h = header as unknown as JeHeaderRow;

  const lines = await gatherGlLines(supabase, id);

  const totalDebits = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountCents, 0);
  const totalCredits = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amountCents, 0);
  const loc = one(h.locations);

  // "Why posted this way" — deterministic, derived from the lines' directions.
  const debitLines = lines.filter((l) => l.side === 'debit');
  const creditLines = lines.filter((l) => l.side === 'credit');
  const whyParts: string[] = [];
  if (debitLines.length && creditLines.length) {
    const dr = debitLines.map((l) => `${l.accountName} (${l.effect === 'increase' ? 'increased' : 'decreased'} ${money(l.amountCents)})`).join(', ');
    const cr = creditLines.map((l) => `${l.accountName} (${l.effect === 'increase' ? 'increased' : 'decreased'} ${money(l.amountCents)})`).join(', ');
    whyParts.push(`Debits: ${dr}. Credits: ${cr}.`);
  }
  const whyPosted = whyParts.join(' ') || 'This entry has no posting lines.';

  const proposedBy: ExplainActor = {
    label: h.source_module && h.source_module !== 'MANUAL'
      ? `Originated from ${sourceModuleLabel(h.source_module)}`
      : 'Manual journal entry',
    detail: h.created_by ? `Created by ${h.created_by}` : null,
  };
  const approvedBy: ExplainActor | null = h.posted_at
    ? { label: 'Posted to the general ledger', detail: `${new Date(h.posted_at).toISOString().slice(0, 10)}${h.posted_by ? ` · by ${h.posted_by}` : ''}` }
    : { label: `Not yet posted (status ${h.status})`, detail: null };

  const aiDecisions = await gatherAiDecisions(supabase, id);

  const facts: ExplainFact[] = [
    { label: 'Entry number', value: h.entry_number, mono: true },
    { label: 'Entry date', value: h.entry_date, mono: true },
    { label: 'Type', value: h.entry_type },
    { label: 'Status', value: h.status },
    { label: 'Company', value: loc?.name ?? loc?.code ?? '--' },
    { label: 'Source', value: h.source_module ? sourceModuleLabel(h.source_module) : 'Manual entry' },
    { label: 'Memo', value: h.memo ?? '--' },
    { label: 'Total debits', value: money(totalDebits), mono: true },
    { label: 'Total credits', value: money(totalCredits), mono: true },
    { label: 'Posted', value: h.posted_at ? new Date(h.posted_at).toISOString().slice(0, 10) : 'Not posted', mono: true },
  ];
  if (h.is_reversing) facts.push({ label: 'Reversing entry', value: 'Yes' });

  const links: ExplainLink[] = [{ label: `Journal entry ${h.entry_number}`, href: `/journal-entries?id=${id}`, kind: 'gl_entry' }];
  if (h.source_module === 'BILL' && h.source_id) links.push({ label: 'Source bill', href: `/bills?id=${h.source_id}`, kind: 'bill' });
  if (h.source_module === 'AR' && h.source_id) links.push({ label: 'Source invoice', href: `/invoices?invoice=${h.source_id}`, kind: 'invoice' });
  if (aiDecisions.length) links.push({ label: 'AI decision log', href: '/exceptions', kind: 'source' });

  return {
    kind: 'JOURNAL_ENTRY',
    id,
    title: `Journal Entry ${h.entry_number}`,
    whatItIs: `A ${h.entry_type.toLowerCase()} journal entry${h.source_module && h.source_module !== 'MANUAL' ? ` generated from ${sourceModuleLabel(h.source_module)}` : ''}, dated ${h.entry_date}${loc?.name ? ` for ${loc.name}` : ''}.`,
    whyPosted,
    status: h.status,
    totalCents: totalDebits,
    balanced: totalDebits === totalCredits,
    lines,
    proposedBy,
    approvedBy,
    aiDecisions,
    facts,
    links,
  };
}

// ── BILL ──────────────────────────────────────────────────────────────────────

interface BillHeaderRow {
  id: string;
  bill_number: string | null;
  bill_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  ai_extracted: boolean;
  ai_confidence: number | null;
  source_file_url: string | null;
  gl_entry_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  vendors: { name: string | null; display_name: string | null } | { name: string | null; display_name: string | null }[] | null;
}

interface BillLineRow {
  line_number: number;
  description: string | null;
  amount_cents: number;
  accounts: JoinedAccount | JoinedAccount[] | null;
}

async function gatherBill(supabase: SupabaseClient, id: string): Promise<Explanation> {
  const { data: header, error: headerErr } = await supabase
    .from('bills')
    .select(
      `id, bill_number, bill_date, due_date, subtotal_cents, tax_cents, total_cents,
       amount_paid_cents, balance_cents, status, ai_extracted, ai_confidence,
       source_file_url, gl_entry_id, approved_by, approved_at,
       vendors!inner(name, display_name)`,
    )
    .eq('id', id)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);
  if (!header) throw new ExplainNotFoundError('BILL', id);
  const h = header as unknown as BillHeaderRow;
  const vendor = one(h.vendors);
  const vendorName = vendor?.display_name || vendor?.name || 'Unknown vendor';

  const { data: lineRows, error: lineErr } = await supabase
    .from('bill_lines')
    .select(
      `line_number, description, amount_cents,
       accounts!inner(
         account_number, name, account_type,
         account_groups!inner(account_sub_types!inner(account_types!inner(normal_balance)))
       )`,
    )
    .eq('bill_id', id)
    .order('line_number', { ascending: true });
  if (lineErr) throw new Error(lineErr.message);

  // A bill debits its expense/asset distribution lines and credits AP for the
  // total — so each distribution line is a debit; direction derived from the
  // account's normal balance, same as the GL.
  const lines: ExplainLineFact[] = [];
  for (const row of (lineRows ?? []) as unknown as BillLineRow[]) {
    const acct = one(row.accounts);
    if (!acct) continue;
    lines.push(lineFactFrom(acct, Number(row.amount_cents ?? 0), 0, row.description));
  }

  const whyLines = lines.map((l) => `${l.accountName} (${l.effect === 'increase' ? 'increased' : 'decreased'} ${money(l.amountCents)})`).join(', ');
  const whyPosted = lines.length
    ? `The bill distributes ${money(h.subtotal_cents)} across ${whyLines}${h.tax_cents ? `, plus ${money(h.tax_cents)} tax` : ''}, and credits Accounts Payable for the ${money(h.total_cents)} total owed to ${vendorName}.`
    : `The bill records ${money(h.total_cents)} owed to ${vendorName} but has no distribution lines yet.`;

  const proposedBy: ExplainActor = h.ai_extracted
    ? { label: 'AI-extracted from the source document', detail: h.ai_confidence != null ? `Confidence ${Math.round(Number(h.ai_confidence) * 100)}%` : null }
    : { label: 'Manually entered', detail: null };
  const approvedBy: ExplainActor | null = h.approved_at
    ? { label: 'Approved', detail: `${new Date(h.approved_at).toISOString().slice(0, 10)}${h.approved_by ? ` · by ${h.approved_by}` : ''}` }
    : { label: `Not yet approved (status ${h.status})`, detail: null };

  const aiDecisions = await gatherAiDecisions(supabase, h.gl_entry_id);

  const facts: ExplainFact[] = [
    { label: 'Bill number', value: h.bill_number ?? '--', mono: true },
    { label: 'Vendor', value: vendorName },
    { label: 'Bill date', value: h.bill_date, mono: true },
    { label: 'Due date', value: h.due_date, mono: true },
    { label: 'Subtotal', value: money(h.subtotal_cents), mono: true },
    { label: 'Tax', value: money(h.tax_cents), mono: true },
    { label: 'Total', value: money(h.total_cents), mono: true },
    { label: 'Paid', value: money(h.amount_paid_cents), mono: true },
    { label: 'Balance', value: money(h.balance_cents), mono: true },
    { label: 'Status', value: h.status },
    { label: 'AI-extracted', value: h.ai_extracted ? 'Yes' : 'No' },
  ];

  const links: ExplainLink[] = [{ label: `Bill ${h.bill_number ?? ''}`.trim(), href: `/bills?id=${id}`, kind: 'bill' }];
  if (h.gl_entry_id) links.push({ label: 'Posted journal entry', href: `/journal-entries?id=${h.gl_entry_id}`, kind: 'gl_entry' });
  if (h.source_file_url) links.push({ label: 'Source document', href: h.source_file_url, kind: 'document' });

  return {
    kind: 'BILL',
    id,
    title: `Bill ${h.bill_number ?? ''} — ${vendorName}`.replace('  ', ' '),
    whatItIs: `An accounts-payable bill from ${vendorName} for ${money(h.total_cents)}, dated ${h.bill_date} and due ${h.due_date}.`,
    whyPosted,
    status: h.status,
    totalCents: h.total_cents,
    balanced: null,
    lines,
    proposedBy,
    approvedBy,
    aiDecisions,
    facts,
    links,
  };
}

// ── BANK_TRANSACTION ────────────────────────────────────────────────────────

interface BankTxnRow {
  id: string;
  description: string;
  amount_cents: number;
  transaction_date: string;
  posted_date: string | null;
  status: string;
  category: string | null;
  ai_account_id: string | null;
  final_account_id: string | null;
  ai_vendor_id: string | null;
  final_vendor_id: string | null;
  ai_confidence: number | null;
  ai_reasoning: string | null;
  ai_model_version: string | null;
  match_type: string | null;
  match_confidence: number | null;
  matched_bill_id: string | null;
  matched_receipt_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  gl_entry_id: string | null;
  location_id: string | null;
  bank_account_id: string | null;
}

interface AccountLite {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
}

function pct(v: number | null | undefined): string {
  return v == null ? '--' : `${Math.round(Number(v) * 100)}%`;
}

/** Human phrasing of a bank-feed match type. */
function matchLabel(type: string): string {
  switch (type) {
    case 'VENDOR_PATTERN': return 'a known vendor pattern';
    case 'BILL_PAYMENT': return 'a vendor bill';
    case 'RECEIPT': return 'a receipt';
    default: return type.toLowerCase().replace(/_/g, ' ');
  }
}

async function gatherBankTransaction(supabase: SupabaseClient, id: string): Promise<Explanation> {
  const { data: header, error: headerErr } = await supabase
    .from('bank_transactions')
    .select(
      `id, description, amount_cents, transaction_date, posted_date, status, category,
       ai_account_id, final_account_id, ai_vendor_id, final_vendor_id,
       ai_confidence, ai_reasoning, ai_model_version,
       match_type, match_confidence, matched_bill_id, matched_receipt_id,
       approved_by, approved_at, gl_entry_id, location_id, bank_account_id`,
    )
    .eq('id', id)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);
  if (!header) throw new ExplainNotFoundError('BANK_TRANSACTION', id);
  const h = header as unknown as BankTxnRow;

  // The account the txn is coded to: a human override wins over the AI suggestion.
  const codedAccountId = h.final_account_id ?? h.ai_account_id;
  const wasOverridden = h.final_account_id != null && h.final_account_id !== h.ai_account_id;
  let codedAccount: AccountLite | null = null;
  if (codedAccountId) {
    const { data: acct } = await supabase
      .from('accounts')
      .select('id, account_number, name, account_type')
      .eq('id', codedAccountId)
      .maybeSingle();
    codedAccount = (acct as AccountLite | null) ?? null;
  }

  // Vendor + company live in `core` — stitch, never embed across the schema line.
  const vendorId = h.final_vendor_id ?? h.ai_vendor_id;
  const vendorMap = await fetchCoreMap<{ id: string; name: string; display_name: string | null }>(
    supabase, 'vendors', 'id, name, display_name', [vendorId],
  );
  const vendor = vendorId ? vendorMap.get(vendorId) ?? null : null;
  const vendorName = vendor?.display_name || vendor?.name || null;
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [h.location_id],
  );
  const loc = h.location_id ? locMap.get(h.location_id) ?? null : null;

  // Source bank account (public).
  let bankAccountName: string | null = null;
  if (h.bank_account_id) {
    const { data: ba } = await supabase
      .from('bank_accounts')
      .select('institution_name, account_name, account_mask')
      .eq('id', h.bank_account_id)
      .maybeSingle();
    const b = ba as { institution_name: string; account_name: string; account_mask: string | null } | null;
    if (b) bankAccountName = `${b.institution_name} · ${b.account_name}${b.account_mask ? ` ••${b.account_mask}` : ''}`;
  }

  // Matched bill / receipt (both public).
  let matchedBill: { bill_number: string | null; total_cents: number } | null = null;
  if (h.matched_bill_id) {
    const { data: b } = await supabase
      .from('bills')
      .select('bill_number, total_cents')
      .eq('id', h.matched_bill_id)
      .maybeSingle();
    matchedBill = (b as { bill_number: string | null; total_cents: number } | null) ?? null;
  }
  let matchedReceipt: { vendor_name: string | null; amount_cents: number | null } | null = null;
  if (h.matched_receipt_id) {
    const { data: r } = await supabase
      .from('receipts')
      .select('vendor_name, amount_cents')
      .eq('id', h.matched_receipt_id)
      .maybeSingle();
    matchedReceipt = (r as { vendor_name: string | null; amount_cents: number | null } | null) ?? null;
  }

  // The posted GL entry (only exists after approval).
  const lines = h.gl_entry_id ? await gatherGlLines(supabase, h.gl_entry_id) : [];
  const glHeader = h.gl_entry_id ? await gatherGlHeader(supabase, h.gl_entry_id) : null;
  const aiDecisions = await gatherAiDecisions(supabase, h.gl_entry_id);

  const moneyIn = h.amount_cents >= 0; // positive = credit (money in)
  const absCents = Math.abs(h.amount_cents);
  const totalDebits = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountCents, 0);
  const totalCredits = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amountCents, 0);

  const matchClause = h.match_type && h.match_type !== 'NONE'
    ? ` It was matched to ${matchLabel(h.match_type)}${h.match_confidence != null ? ` at ${pct(h.match_confidence)} match confidence` : ''}.`
    : '';
  const whyParts: string[] = [];
  if (codedAccount) {
    whyParts.push(
      `The AI categorized this ${moneyIn ? 'deposit' : 'withdrawal'} to ${codedAccount.account_number} ${codedAccount.name}${h.ai_confidence != null ? ` at ${pct(h.ai_confidence)} confidence` : ''}${wasOverridden ? ' (a human overrode the original AI suggestion)' : ''}.${matchClause}`,
    );
  } else {
    whyParts.push(`This ${moneyIn ? 'deposit' : 'withdrawal'} has not been categorized to a GL account yet.${matchClause}`);
  }
  if (lines.length) {
    const dr = lines.filter((l) => l.side === 'debit').map((l) => `${l.accountName} (${money(l.amountCents)})`).join(', ');
    const cr = lines.filter((l) => l.side === 'credit').map((l) => `${l.accountName} (${money(l.amountCents)})`).join(', ');
    whyParts.push(`On approval it posted — Debits: ${dr}. Credits: ${cr}.`);
  }
  const whyPosted = whyParts.join(' ');

  const proposedBy: ExplainActor = {
    label: codedAccount ? 'AI bank-feed categorizer' : 'Awaiting categorization',
    detail: h.ai_model_version
      ? `${h.ai_model_version}${h.ai_confidence != null ? ` · ${pct(h.ai_confidence)} confidence` : ''}`
      : (h.ai_confidence != null ? `${pct(h.ai_confidence)} confidence` : null),
  };
  const approvedBy: ExplainActor | null = h.approved_at
    ? {
        label: 'Approved & posted to the general ledger',
        detail: `${new Date(h.approved_at).toISOString().slice(0, 10)}${h.approved_by ? ` · by ${h.approved_by}` : ''}${glHeader ? ` · ${glHeader.entry_number}` : ''}`,
      }
    : { label: `Not yet approved (status ${h.status})`, detail: null };

  const facts: ExplainFact[] = [
    { label: 'Date', value: h.transaction_date, mono: true },
    { label: 'Description', value: h.description },
    { label: moneyIn ? 'Amount received' : 'Amount paid', value: money(absCents), mono: true },
    { label: 'Direction', value: moneyIn ? 'Money in (credit)' : 'Money out (debit)' },
    { label: 'Bank account', value: bankAccountName ?? '--' },
    { label: 'Company', value: loc?.name ?? '--' },
    { label: 'Vendor', value: vendorName ?? '--' },
    { label: 'Coded to', value: codedAccount ? `${codedAccount.account_number} · ${codedAccount.name}` : 'Uncategorized' },
    { label: 'AI confidence', value: pct(h.ai_confidence) },
    { label: 'Bank category', value: h.category ?? '--' },
    { label: 'Match', value: h.match_type && h.match_type !== 'NONE' ? `${matchLabel(h.match_type)}${h.match_confidence != null ? ` (${pct(h.match_confidence)})` : ''}` : 'Unmatched' },
    { label: 'Status', value: h.status },
  ];
  if (matchedBill) facts.push({ label: 'Matched bill', value: `${matchedBill.bill_number ?? '--'} · ${money(Number(matchedBill.total_cents))}` });
  if (matchedReceipt) facts.push({ label: 'Matched receipt', value: `${matchedReceipt.vendor_name ?? 'Receipt'}${matchedReceipt.amount_cents != null ? ` · ${money(Number(matchedReceipt.amount_cents))}` : ''}` });

  const links: ExplainLink[] = [{ label: 'Bank feed', href: `/bank-feed?id=${id}`, kind: 'bank_transaction' }];
  if (h.gl_entry_id) links.push({ label: glHeader ? `Journal entry ${glHeader.entry_number}` : 'Posted journal entry', href: `/journal-entries?id=${h.gl_entry_id}`, kind: 'gl_entry' });
  if (h.matched_bill_id) links.push({ label: 'Matched bill', href: `/bills?id=${h.matched_bill_id}`, kind: 'bill' });
  if (aiDecisions.length) links.push({ label: 'AI decision log', href: '/exceptions', kind: 'source' });

  return {
    kind: 'BANK_TRANSACTION',
    id,
    title: `Bank transaction — ${money(absCents)} ${moneyIn ? 'in' : 'out'}`,
    whatItIs: `A bank-feed ${moneyIn ? 'deposit' : 'withdrawal'} of ${money(absCents)} dated ${h.transaction_date}${vendorName ? ` involving ${vendorName}` : ''}${loc?.name ? ` for ${loc.name}` : ''} — "${h.description}".`,
    whyPosted,
    status: h.status,
    totalCents: absCents,
    balanced: lines.length ? totalDebits === totalCredits : null,
    lines,
    proposedBy,
    approvedBy,
    aiDecisions,
    facts,
    links,
  };
}

// ── PAYMENT (customer cash receipt) ─────────────────────────────────────────

interface CustomerPaymentRow {
  id: string;
  customer_id: string | null;
  payment_date: string;
  amount_cents: number;
  payment_method: string | null;
  reference_number: string | null;
  bank_account_id: string | null;
  gl_entry_id: string | null;
  created_at: string;
}

/** Human phrasing of a payment rail. */
function methodLabel(m: string | null): string {
  switch (m) {
    case 'CHECK': return 'check';
    case 'ACH': return 'ACH';
    case 'WIRE': return 'wire';
    case 'CREDIT_CARD': return 'credit-card';
    case 'CASH': return 'cash';
    default: return m ? m.toLowerCase() : 'customer';
  }
}

async function gatherPayment(supabase: SupabaseClient, id: string): Promise<Explanation> {
  const { data: header, error: headerErr } = await supabase
    .from('customer_payments')
    .select('id, customer_id, payment_date, amount_cents, payment_method, reference_number, bank_account_id, gl_entry_id, created_at')
    .eq('id', id)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);
  if (!header) throw new ExplainNotFoundError('PAYMENT', id);
  const h = header as unknown as CustomerPaymentRow;

  const custMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase, 'customers', 'id, name', [h.customer_id],
  );
  const customerName = (h.customer_id ? custMap.get(h.customer_id)?.name : null) ?? 'Customer';

  // Applications: which invoices this receipt cleared (public tables).
  const { data: appRows } = await supabase
    .from('payment_applications')
    .select('invoice_id, amount_cents')
    .eq('payment_id', id);
  const apps = (appRows ?? []) as Array<{ invoice_id: string; amount_cents: number }>;
  const invoiceIds = apps.map((a) => a.invoice_id);
  const invMap = new Map<string, { invoice_number: string; total_cents: number; balance_cents: number }>();
  if (invoiceIds.length) {
    const { data: invRows } = await supabase
      .from('invoices')
      .select('id, invoice_number, total_cents, balance_cents')
      .in('id', invoiceIds);
    for (const r of (invRows ?? []) as Array<{ id: string; invoice_number: string; total_cents: number; balance_cents: number }>) {
      invMap.set(r.id, { invoice_number: r.invoice_number, total_cents: Number(r.total_cents), balance_cents: Number(r.balance_cents) });
    }
  }

  // DR cash / CR AR posting lines (direction derived from account normal balance).
  const lines = h.gl_entry_id ? await gatherGlLines(supabase, h.gl_entry_id) : [];
  const glHeader = h.gl_entry_id ? await gatherGlHeader(supabase, h.gl_entry_id) : null;
  const aiDecisions = await gatherAiDecisions(supabase, h.gl_entry_id);

  const debitLine = lines.find((l) => l.side === 'debit') ?? null; // cash side
  const creditLine = lines.find((l) => l.side === 'credit') ?? null; // AR side
  const totalDebits = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountCents, 0);
  const totalCredits = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amountCents, 0);

  const appList = apps
    .map((a) => {
      const inv = invMap.get(a.invoice_id);
      return inv ? `${inv.invoice_number} (${money(Number(a.amount_cents))})` : money(Number(a.amount_cents));
    })
    .join(', ');

  const whyParts: string[] = [];
  if (debitLine && creditLine) {
    whyParts.push(
      `The ${methodLabel(h.payment_method)} receipt debits ${debitLine.accountName} (increasing cash by ${money(debitLine.amountCents)}) and credits ${creditLine.accountName} (reducing accounts receivable by ${money(creditLine.amountCents)}).`,
    );
  }
  if (appList) whyParts.push(`It was applied to ${apps.length === 1 ? 'invoice' : 'invoices'} ${appList}.`);
  const whyPosted = whyParts.join(' ') || `A ${money(Number(h.amount_cents))} customer receipt from ${customerName}.`;

  const proposedBy: ExplainActor = {
    label: `Customer payment recorded (${methodLabel(h.payment_method)})`,
    detail: h.reference_number ? `Ref ${h.reference_number}` : null,
  };
  const approvedBy: ExplainActor | null = glHeader?.posted_at
    ? { label: 'Posted to the general ledger', detail: `${new Date(glHeader.posted_at).toISOString().slice(0, 10)}${glHeader.entry_number ? ` · ${glHeader.entry_number}` : ''}` }
    : { label: 'Recorded (not linked to a posted GL entry)', detail: null };

  const facts: ExplainFact[] = [
    { label: 'Customer', value: customerName },
    { label: 'Payment date', value: h.payment_date, mono: true },
    { label: 'Amount', value: money(Number(h.amount_cents)), mono: true },
    { label: 'Method', value: methodLabel(h.payment_method) },
    { label: 'Reference', value: h.reference_number ?? '--' },
    { label: 'Cash account', value: debitLine ? `${debitLine.accountNumber} · ${debitLine.accountName}` : '--' },
    { label: 'Applied to', value: apps.length ? `${apps.length} invoice(s)` : 'On account' },
  ];

  const links: ExplainLink[] = [];
  if (h.gl_entry_id) links.push({ label: glHeader ? `Journal entry ${glHeader.entry_number}` : 'Posted journal entry', href: `/journal-entries?id=${h.gl_entry_id}`, kind: 'gl_entry' });
  // Deep-link each invoice this receipt cleared, so the "based on" trail lands on
  // the exact record rather than the AR list.
  for (const a of apps) {
    const inv = invMap.get(a.invoice_id);
    links.push({ label: inv ? `Invoice ${inv.invoice_number}` : 'Applied invoice', href: `/invoices?invoice=${a.invoice_id}`, kind: 'invoice' });
  }
  links.push({ label: 'Cash application', href: '/cash-application', kind: 'invoice' });

  return {
    kind: 'PAYMENT',
    id,
    title: `Payment — ${customerName} · ${money(Number(h.amount_cents))}`,
    whatItIs: `A ${methodLabel(h.payment_method)} customer receipt of ${money(Number(h.amount_cents))} from ${customerName}, dated ${h.payment_date}, applied to ${apps.length || 'no'} open invoice(s).`,
    whyPosted,
    status: glHeader?.status ?? 'RECORDED',
    totalCents: Number(h.amount_cents),
    balanced: lines.length ? totalDebits === totalCredits : null,
    lines,
    proposedBy,
    approvedBy,
    aiDecisions,
    facts,
    links,
  };
}

// ── INVOICE (customer AR invoice) ───────────────────────────────────────────

interface InvoiceHeaderRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  amount_paid_cents: number;
  balance_cents: number;
  status: string;
  is_progress_bill: boolean;
  customer_id: string | null;
  location_id: string | null;
  gl_entry_id: string | null;
  sent_at: string | null;
  memo: string | null;
}

interface InvoiceLineRow {
  line_number: number;
  description: string | null;
  amount_cents: number;
  accounts: JoinedAccount | JoinedAccount[] | null;
}

async function gatherInvoice(supabase: SupabaseClient, id: string): Promise<Explanation> {
  const { data: header, error: headerErr } = await supabase
    .from('invoices')
    .select(
      `id, invoice_number, invoice_date, due_date, subtotal_cents, tax_cents, total_cents,
       amount_paid_cents, balance_cents, status, is_progress_bill,
       customer_id, location_id, gl_entry_id, sent_at, memo`,
    )
    .eq('id', id)
    .maybeSingle();
  if (headerErr) throw new Error(headerErr.message);
  if (!header) throw new ExplainNotFoundError('INVOICE', id);
  const h = header as unknown as InvoiceHeaderRow;

  // Customer + company live in `core` — stitch, never embed across the schema line.
  const custMap = await fetchCoreMap<{ id: string; name: string }>(
    supabase, 'customers', 'id, name', [h.customer_id],
  );
  const customerName = (h.customer_id ? custMap.get(h.customer_id)?.name : null) ?? 'Customer';
  const locMap = await fetchCoreMap<{ id: string; name: string; short_code: string }>(
    supabase, 'locations', 'id, name, short_code', [h.location_id],
  );
  const loc = h.location_id ? locMap.get(h.location_id) ?? null : null;

  // Posting lines: prefer the authoritative posted GL entry (DR AR / CR revenue,
  // plus any tax liability). For a DRAFT not yet posted there is no GL entry, so
  // synthesize the revenue-credit distribution from the invoice lines — every
  // distribution line credits its revenue account; direction is derived from the
  // account's normal balance, same as everywhere else.
  let lines: ExplainLineFact[];
  if (h.gl_entry_id) {
    lines = await gatherGlLines(supabase, h.gl_entry_id);
  } else {
    const { data: lineRows, error: lineErr } = await supabase
      .from('invoice_lines')
      .select(
        `line_number, description, amount_cents,
         accounts!inner(
           account_number, name, account_type,
           account_groups!inner(account_sub_types!inner(account_types!inner(normal_balance)))
         )`,
      )
      .eq('invoice_id', id)
      .order('line_number', { ascending: true });
    if (lineErr) throw new Error(lineErr.message);
    lines = [];
    for (const row of (lineRows ?? []) as unknown as InvoiceLineRow[]) {
      const acct = one(row.accounts);
      if (!acct) continue;
      lines.push(lineFactFrom(acct, 0, Number(row.amount_cents ?? 0), row.description));
    }
  }

  const glHeader = h.gl_entry_id ? await gatherGlHeader(supabase, h.gl_entry_id) : null;
  const aiDecisions = await gatherAiDecisions(supabase, h.gl_entry_id);

  const totalDebits = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amountCents, 0);
  const totalCredits = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amountCents, 0);

  const revenueLines = lines.filter((l) => l.side === 'credit');
  const whyRevenue = revenueLines.map((l) => `${l.accountName} (${money(l.amountCents)})`).join(', ');
  const whyPosted = lines.length
    ? `The invoice debits Accounts Receivable for the ${money(h.total_cents)} owed by ${customerName} and credits ${whyRevenue || 'revenue'}${h.tax_cents ? `, including ${money(h.tax_cents)} sales tax` : ''}.`
    : `The invoice bills ${money(h.total_cents)} to ${customerName} but has no distribution lines yet.`;

  const proposedBy: ExplainActor = {
    label: h.is_progress_bill ? 'Progress (AIA) invoice issued' : 'Customer invoice issued',
    detail: h.sent_at ? `Sent ${new Date(h.sent_at).toISOString().slice(0, 10)}` : null,
  };
  const approvedBy: ExplainActor | null = glHeader?.posted_at
    ? { label: 'Issued & posted to the general ledger', detail: `${new Date(glHeader.posted_at).toISOString().slice(0, 10)}${glHeader.entry_number ? ` · ${glHeader.entry_number}` : ''}` }
    : { label: `Not yet posted (status ${h.status})`, detail: null };

  const facts: ExplainFact[] = [
    { label: 'Invoice number', value: h.invoice_number, mono: true },
    { label: 'Customer', value: customerName },
    { label: 'Company', value: loc?.name ?? '--' },
    { label: 'Invoice date', value: h.invoice_date, mono: true },
    { label: 'Due date', value: h.due_date, mono: true },
    { label: 'Subtotal', value: money(h.subtotal_cents), mono: true },
    { label: 'Tax', value: money(h.tax_cents), mono: true },
    { label: 'Total', value: money(h.total_cents), mono: true },
    { label: 'Paid', value: money(h.amount_paid_cents), mono: true },
    { label: 'Balance', value: money(h.balance_cents), mono: true },
    { label: 'Status', value: h.status },
  ];
  if (h.is_progress_bill) facts.push({ label: 'Progress bill', value: 'AIA G702/G703' });

  const links: ExplainLink[] = [{ label: `Invoice ${h.invoice_number}`, href: `/invoices?invoice=${id}`, kind: 'invoice' }];
  if (h.gl_entry_id) links.push({ label: glHeader ? `Journal entry ${glHeader.entry_number}` : 'Posted journal entry', href: `/journal-entries?id=${h.gl_entry_id}`, kind: 'gl_entry' });
  if (aiDecisions.length) links.push({ label: 'AI decision log', href: '/exceptions', kind: 'source' });

  return {
    kind: 'INVOICE',
    id,
    title: `Invoice ${h.invoice_number} — ${customerName}`,
    whatItIs: `A customer invoice for ${money(h.total_cents)} billed to ${customerName}, dated ${h.invoice_date} and due ${h.due_date}${loc?.name ? ` from ${loc.name}` : ''}.`,
    whyPosted,
    status: h.status,
    totalCents: h.total_cents,
    // A DRAFT has only synthesized revenue credits (no AR debit yet) so balance is
    // not meaningful; only assert balance once a real GL entry exists.
    balanced: h.gl_entry_id && lines.length ? totalDebits === totalCredits : null,
    lines,
    proposedBy,
    approvedBy,
    aiDecisions,
    facts,
    links,
  };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function gatherExplanation(
  supabase: SupabaseClient,
  kind: ExplainKind,
  id: string,
): Promise<Explanation> {
  switch (kind) {
    case 'JOURNAL_ENTRY': return gatherJournalEntry(supabase, id);
    case 'BILL': return gatherBill(supabase, id);
    case 'BANK_TRANSACTION': return gatherBankTransaction(supabase, id);
    case 'PAYMENT': return gatherPayment(supabase, id);
    case 'INVOICE': return gatherInvoice(supabase, id);
    default: {
      // Exhaustiveness guard.
      const never: never = kind;
      throw new Error(`Unsupported explain kind: ${String(never)}`);
    }
  }
}

// ── Narrative (deterministic fallback + AI prompt) ────────────────────────────

/** No-speculation fallback narrative, used when the gateway is unavailable. */
export function deterministicExplainNarrative(exp: Explanation): string {
  const parts: string[] = [exp.whatItIs];
  if (exp.lines.length) parts.push(exp.whyPosted);
  if (exp.balanced === false) parts.push('Note: this entry is currently out of balance.');
  if (exp.proposedBy) parts.push(`${exp.proposedBy.label}${exp.proposedBy.detail ? ` (${exp.proposedBy.detail})` : ''}.`);
  if (exp.approvedBy) parts.push(`${exp.approvedBy.label}${exp.approvedBy.detail ? ` (${exp.approvedBy.detail})` : ''}.`);
  if (exp.aiDecisions.length) {
    const d = exp.aiDecisions[0];
    parts.push(`AI (${d.feature}${d.confidence != null ? `, ${Math.round(d.confidence * 100)}% confidence` : ''}) proposed the coding.`);
  }
  return parts.join(' ');
}

/** The fact block handed to the gateway — the model phrases ONLY these facts. */
export function buildExplainFacts(exp: Explanation): string {
  const lineFacts = exp.lines
    .map((l, i) => `${i + 1}. ${l.side.toUpperCase()} ${money(l.amountCents)} to ${l.accountNumber} ${l.accountName} (${l.accountType}, normal ${l.normalBalance}) — ${l.effect}s the account${l.memo ? ` [${l.memo}]` : ''}`)
    .join('\n');
  const aiFacts = exp.aiDecisions
    .map((d) => `- ${d.feature} via ${d.modelUsed ?? 'model'}${d.confidence != null ? ` @ ${Math.round(d.confidence * 100)}%` : ''} (${d.status})${d.reasoning ? `: ${d.reasoning}` : ''}`)
    .join('\n');
  return [
    `Object: ${exp.title}`,
    `What it is: ${exp.whatItIs}`,
    `Status: ${exp.status}`,
    exp.balanced == null ? '' : `Balanced: ${exp.balanced ? 'yes' : 'NO — out of balance'}`,
    '',
    'Posting lines (already computed — use these figures verbatim; direction derived from the account normal balance):',
    lineFacts || '(no posting lines)',
    '',
    exp.proposedBy ? `Proposed by: ${exp.proposedBy.label}${exp.proposedBy.detail ? ` (${exp.proposedBy.detail})` : ''}` : '',
    exp.approvedBy ? `Approval: ${exp.approvedBy.label}${exp.approvedBy.detail ? ` (${exp.approvedBy.detail})` : ''}` : '',
    aiFacts ? `Related AI decisions:\n${aiFacts}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export const EXPLAIN_SYSTEM =
  'You are a controller explaining a single accounting record to a colleague in plain English. ' +
  'You are given the record\'s facts, which have ALREADY been gathered from the book of record. ' +
  'STRICT RULES: (1) Use ONLY the dollar figures, accounts, dates, and statuses provided — never invent, recompute, round differently, or introduce any number, account, or fact not in the input. ' +
  '(2) Explain what the record is, why it debits/credits the way it does (the direction is given per line), and who or what proposed and approved it. ' +
  '(3) Do not speculate about business causes the data does not contain; if the cause is not in the facts, say it is not determinable from the record. ' +
  '(4) Write 2-4 tight sentences of clear prose. No markdown, no headings, no bullet lists — just the paragraph.';
