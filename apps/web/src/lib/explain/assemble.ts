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

  const { data: lineRows, error: lineErr } = await supabase
    .from('gl_entry_lines')
    .select(
      `line_number, debit_cents, credit_cents, memo,
       accounts!inner(
         account_number, name, account_type,
         account_groups!inner(account_sub_types!inner(account_types!inner(normal_balance)))
       )`,
    )
    .eq('gl_entry_id', id)
    .order('line_number', { ascending: true });
  if (lineErr) throw new Error(lineErr.message);

  const lines: ExplainLineFact[] = [];
  for (const row of (lineRows ?? []) as unknown as JeLineRow[]) {
    const acct = one(row.accounts);
    if (!acct) continue;
    lines.push(lineFactFrom(acct, Number(row.debit_cents ?? 0), Number(row.credit_cents ?? 0), row.memo));
  }

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

  const links: ExplainLink[] = [{ label: `Journal entry ${h.entry_number}`, href: '/journal-entries', kind: 'gl_entry' }];
  if (h.source_module === 'BILL' && h.source_id) links.push({ label: 'Source bill', href: '/bills', kind: 'bill' });
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

  const links: ExplainLink[] = [{ label: `Bill ${h.bill_number ?? ''}`.trim(), href: '/bills', kind: 'bill' }];
  if (h.gl_entry_id) links.push({ label: 'Posted journal entry', href: '/journal-entries', kind: 'gl_entry' });
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

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function gatherExplanation(
  supabase: SupabaseClient,
  kind: ExplainKind,
  id: string,
): Promise<Explanation> {
  switch (kind) {
    case 'JOURNAL_ENTRY': return gatherJournalEntry(supabase, id);
    case 'BILL': return gatherBill(supabase, id);
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
