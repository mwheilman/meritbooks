/**
 * Bank / card feed split service (FPB-bank-feed-splits, migration 177).
 *
 *   validateSplitLines  — every id in-org, account usable by the line's company, job /
 *                         department belong to it, required dimensions present, Σ = total.
 *   postSplit           — one balanced JE per company through postJournalEntry (period lock,
 *                         balance, posted immutability all apply), stamped with an
 *                         idempotent source_ref; rolls back (voids) on a partial failure;
 *                         persists the POSTED split rows, job cost, and the feed line.
 *   saveDraftSplit / clearDraftSplit — edit before posting.
 *   reverseFeedPosting  — reversal-on-edit after posting (void, never silent mutation).
 *   saveSplitRule / suggestSplit — "remember this split" and the suggestion banner.
 *
 * Writes to locked tables (gl_*, bank_transactions, bank_transaction_splits, split_rules,
 * job_cost_entries) go through scopedWriter / writerFor: the route has already run its
 * permission check; here every company the write lands on is org-pinned and
 * client-scope-asserted, and every referenced id is verified in-org (FKs never check the
 * tenant). `opts.writer` lets tests drive the real schema through one client.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { postJournalEntry, voidJournalEntry } from '@/lib/services/gl-posting';
import { resolveRole, PostingError } from '@/lib/posting/account-roles';
import { assertOrgRefs, isWriteScopeError, scopedWriter, writerFor } from '@/lib/db/scoped-writer';
import { voidAttribution } from '@/lib/services/cost-approval';
import type { SplitLineInput } from '@/lib/validations/bank-splits';
import { checkSplitAmounts, percentagesFromAmounts, FULL_BP } from './allocate';
import { planSplitEntries, splitSourceRef, SplitPlanError, type PlannedEntry, type SplitLineForPosting } from './postings';
import type { SplitRow, SplitSuggestion, SplitSummary } from './types';
import {
  applySplitAllocations,
  matchSplitRule,
  normalizePattern,
  splitAllocationsSchema,
  type SplitAllocation,
  type SplitRuleRow,
} from './rules';

type DB = SupabaseClient;

export type { SplitRow, SplitSuggestion, SplitSummary } from './types';

export interface SplitServiceOptions {
  /** Writer override (tests). Default: the service role for a member caller. */
  writer?: SupabaseClient;
}

/** A refusal the route maps to an HTTP status. */
export class SplitError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.name = 'SplitError';
  }
}

export interface FeedTxn {
  id: string;
  org_id: string;
  /** The bank / card account's company. */
  location_id: string;
  /** The bank's cash account, or the card's liability account. */
  cash_account_id: string;
  bank_account_id: string;
  amount_cents: number;
  transaction_date: string;
  description: string;
  status: string;
  match_type: string | null;
  matched_bill_id: string | null;
  gl_entry_id: string | null;
  final_vendor_id: string | null;
  ai_vendor_id: string | null;
}

/** Load a feed line + its bank account through the caller's client (RLS proves org + scope). */
export async function loadFeedTxn(db: DB, orgId: string, txnId: string): Promise<FeedTxn | null> {
  const { data: t, error } = await db
    .from('bank_transactions')
    .select('id, org_id, bank_account_id, amount_cents, transaction_date, description, status, match_type, matched_bill_id, gl_entry_id, final_vendor_id, ai_vendor_id')
    .eq('id', txnId)
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the transaction: ${error.message}`);
  if (!t) return null;
  const row = t as Record<string, unknown>;
  const { data: ba } = await db
    .from('bank_accounts')
    .select('id, location_id, account_id')
    .eq('id', row.bank_account_id as string)
    .eq('org_id', orgId)
    .maybeSingle();
  const bank = ba as { id: string; location_id: string; account_id: string } | null;
  if (!bank) return null;
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    location_id: bank.location_id,
    cash_account_id: bank.account_id,
    bank_account_id: bank.id,
    amount_cents: Number(row.amount_cents),
    transaction_date: String(row.transaction_date),
    description: String(row.description ?? ''),
    status: String(row.status),
    match_type: (row.match_type as string | null) ?? null,
    matched_bill_id: (row.matched_bill_id as string | null) ?? null,
    gl_entry_id: (row.gl_entry_id as string | null) ?? null,
    final_vendor_id: (row.final_vendor_id as string | null) ?? null,
    ai_vendor_id: (row.ai_vendor_id as string | null) ?? null,
  };
}

function isBillSettlement(txn: FeedTxn): boolean {
  return txn.amount_cents < 0 && txn.match_type === 'BILL_PAYMENT' && !!txn.matched_bill_id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ResolvedSplitLine extends SplitLineForPosting {
  percentBp: number | null;
  costCodeId: string | null;
}

interface AccountInfo {
  id: string;
  account_number: string;
  name: string;
  account_type: string;
  company_location_id: string | null;
  is_active: boolean;
  approval_status: string | null;
  require_department: boolean | null;
  require_class: boolean | null;
}

const uniq = (xs: ReadonlyArray<string | null | undefined>): string[] =>
  Array.from(new Set(xs.filter((x): x is string => typeof x === 'string' && x.length > 0)));

/**
 * Resolve + validate split lines against the tenant's data. Throws SplitError with a
 * plain-English reason on the first problem; nothing has been written yet.
 */
export async function validateSplitLines(
  db: DB,
  orgId: string,
  txn: FeedTxn,
  lines: ReadonlyArray<SplitLineInput>,
  opts: SplitServiceOptions = {},
): Promise<ResolvedSplitLine[]> {
  const total = Math.abs(txn.amount_cents);
  const check = checkSplitAmounts(total, lines.map((l) => l.amount_cents));
  if (!check.ok) throw new SplitError(check.error ?? 'Invalid split.');

  const resolved: ResolvedSplitLine[] = lines.map((l, i) => ({
    lineNo: i + 1,
    amountCents: l.amount_cents,
    accountId: l.account_id,
    locationId: l.allocation_location_id ?? txn.location_id,
    departmentId: l.department_id ?? null,
    classId: l.class_id ?? null,
    jobId: l.job_id ?? null,
    memo: l.memo?.trim() || null,
    percentBp: l.percent_bp ?? null,
    costCodeId: l.cost_code_id ?? null,
  }));

  const locIds = uniq(resolved.map((l) => l.locationId));
  const accountIds = uniq(resolved.map((l) => l.accountId));
  const deptIds = uniq(resolved.map((l) => l.departmentId));
  const classIds = uniq(resolved.map((l) => l.classId));
  const jobIds = uniq(resolved.map((l) => l.jobId));
  const costCodeIds = uniq(resolved.map((l) => l.costCodeId));
  for (const l of resolved) {
    if (l.costCodeId && !l.jobId) throw new SplitError(`Line ${l.lineNo}: a cost code needs a job.`);
  }

  try {
    await assertOrgRefs(
      orgId,
      [
        { schema: 'core', table: 'locations', ids: locIds, label: 'company' },
        { table: 'accounts', ids: accountIds, label: 'GL account' },
        { schema: 'core', table: 'departments', ids: deptIds, label: 'department' },
        { table: 'classes', ids: classIds, label: 'class' },
        { schema: 'core', table: 'jobs', ids: jobIds, label: 'job' },
        { table: 'job_cost_codes', ids: costCodeIds, label: 'cost code' },
      ],
      { caller: db, writer: opts.writer },
    );
  } catch (e) {
    if (isWriteScopeError(e)) throw new SplitError(e.message, 400);
    throw e;
  }

  const reader = writerFor(db, opts.writer);
  const [acctRes, locRes, jobRes, deptRes, jobCountRes] = await Promise.all([
    reader.from('accounts')
      .select('id, account_number, name, account_type, company_location_id, is_active, approval_status, require_department, require_class')
      .eq('org_id', orgId).in('id', accountIds),
    reader.schema('core').from('locations')
      .select('id, name, require_department, require_class')
      .eq('org_id', orgId).in('id', locIds),
    jobIds.length
      ? reader.schema('core').from('jobs').select('id, location_id, job_number').eq('org_id', orgId).in('id', jobIds)
      : Promise.resolve({ data: [] as Array<{ id: string; location_id: string; job_number: string }>, error: null }),
    deptIds.length
      ? reader.schema('core').from('departments').select('id, location_id, name').eq('org_id', orgId).in('id', deptIds)
      : Promise.resolve({ data: [] as Array<{ id: string; location_id: string | null; name: string }>, error: null }),
    reader.schema('core').from('jobs').select('id, location_id').eq('org_id', orgId).in('location_id', locIds).limit(1000),
  ]);

  const accounts = new Map(((acctRes.data ?? []) as AccountInfo[]).map((a) => [a.id, a]));
  const locs = new Map(
    ((locRes.data ?? []) as Array<{ id: string; name: string; require_department: boolean | null; require_class: boolean | null }>).map((l) => [l.id, l]),
  );
  const jobs = new Map(((jobRes.data ?? []) as Array<{ id: string; location_id: string; job_number: string }>).map((j) => [j.id, j]));
  const depts = new Map(((deptRes.data ?? []) as Array<{ id: string; location_id: string | null; name: string }>).map((d) => [d.id, d]));
  const companiesWithJobs = new Set(((jobCountRes.data ?? []) as Array<{ location_id: string }>).map((j) => j.location_id));

  for (const l of resolved) {
    const a = accounts.get(l.accountId);
    const loc = locs.get(l.locationId);
    const where = `Line ${l.lineNo}`;
    if (!a) throw new SplitError(`${where}: GL account not found.`);
    if (!loc) throw new SplitError(`${where}: company not found.`);
    if (!a.is_active) throw new SplitError(`${where}: account ${a.account_number} is inactive.`);
    if (a.approval_status && a.approval_status !== 'APPROVED') throw new SplitError(`${where}: account ${a.account_number} is not approved yet.`);
    if (a.company_location_id && a.company_location_id !== l.locationId) {
      throw new SplitError(`${where}: account ${a.account_number} belongs to another company; pick one ${loc.name} can use.`);
    }
    if (l.accountId === txn.cash_account_id) throw new SplitError(`${where}: a split line can't book back to the bank / card account itself.`);
    if (l.jobId) {
      const j = jobs.get(l.jobId);
      if (!j || j.location_id !== l.locationId) throw new SplitError(`${where}: that job belongs to another company.`);
    }
    if (l.departmentId) {
      const d = depts.get(l.departmentId);
      if (!d || (d.location_id && d.location_id !== l.locationId)) throw new SplitError(`${where}: that department belongs to another company.`);
    }
    if (loc.require_department && !l.departmentId) throw new SplitError(`${where}: ${loc.name} requires a department on every entry.`);
    if (loc.require_class && !l.classId) throw new SplitError(`${where}: ${loc.name} requires a class on every entry.`);
    if (a.require_department && !l.departmentId) throw new SplitError(`${where}: account ${a.account_number} requires a department.`);
    if (a.require_class && !l.classId) throw new SplitError(`${where}: account ${a.account_number} requires a class.`);
    if (a.account_type === 'COGS' && !l.jobId && companiesWithJobs.has(l.locationId)) {
      throw new SplitError(`${where}: COGS lines need a job for cost tracking.`);
    }
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// Posting
// ─────────────────────────────────────────────────────────────────────────────

/** 1 + the number of earlier postings of this line that were reversed (voided). */
export async function nextPostingVersion(db: DB, orgId: string, txn: FeedTxn): Promise<number> {
  const { count } = await db
    .from('gl_entries')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('source_module', 'BANK_FEED')
    .eq('source_id', txn.id)
    .eq('location_id', txn.location_id)
    .eq('status', 'VOIDED');
  return (count ?? 0) + 1;
}

const DUP_RE = /uq_gl_entries_org_source_type|duplicate key/i;

export interface PostedSplitEntry {
  location_id: string;
  entry_id: string;
  entry_number: string;
}

export interface PostSplitInput {
  orgId: string;
  txn: FeedTxn;
  lines: ReadonlyArray<ResolvedSplitLine>;
  memo: string;
  vendorId: string | null;
  splitRuleId?: string | null;
}

export interface PostSplitResult {
  entries: PostedSplitEntry[];
  version: number;
  /** The line whose account / dims stand in for the whole split (largest amount). */
  dominant: ResolvedSplitLine;
  jobLines: Array<{ line: ResolvedSplitLine; glEntryId: string; glLineId: string | null }>;
}

/**
 * Post a split: one balanced JE per company, bank company first. Throws SplitError
 * (409 when another approve of the same posting already won).
 */
export async function postSplit(db: DB, input: PostSplitInput, opts: SplitServiceOptions = {}): Promise<PostSplitResult> {
  const { orgId, txn, lines } = input;
  if (txn.status === 'POSTED') throw new SplitError('Transaction already posted', 409);
  if (isBillSettlement(txn)) {
    throw new SplitError('This line pays a bill, so it settles Accounts Payable and cannot be split. Unmatch the bill to split it.');
  }

  const crossCompany = lines.some((l) => l.locationId !== txn.location_id);
  let icAr: string | null = null;
  let icAp: string | null = null;
  if (crossCompany) {
    try {
      icAr = (await resolveRole(db, orgId, 'INTERCOMPANY_AR')).id;
      icAp = (await resolveRole(db, orgId, 'INTERCOMPANY_AP')).id;
    } catch (e) {
      if (e instanceof PostingError) throw new SplitError(e.message);
      throw e;
    }
  }

  let plan: PlannedEntry[];
  try {
    plan = planSplitEntries({
      bankLocationId: txn.location_id,
      cashAccountId: txn.cash_account_id,
      signedAmountCents: txn.amount_cents,
      lines,
      icReceivableAccountId: icAr,
      icPayableAccountId: icAp,
      memo: input.memo,
    });
  } catch (e) {
    if (e instanceof SplitPlanError) throw new SplitError(e.message);
    throw e;
  }

  const version = await nextPostingVersion(db, orgId, txn);
  const posted: PostedSplitEntry[] = [];
  // Undo the entries already posted for this split. A void that fails leaves a half-posted
  // split in the GL, so it is surfaced as an error naming the entries to reverse by hand —
  // never only logged.
  const rollback = async (why: string): Promise<void> => {
    const stuck: string[] = [];
    for (const p of posted) {
      try {
        const res = await voidJournalEntry(db, orgId, p.entry_id, null, `Split rollback: ${why}`.slice(0, 500), { writer: opts.writer });
        if (!res.success) stuck.push(p.entry_number || p.entry_id);
      } catch {
        stuck.push(p.entry_number || p.entry_id);
      }
    }
    if (stuck.length) {
      console.error('[bank-splits] split rollback could not void', stuck.join(', '), why);
      throw new SplitError(
        `The split could not be posted (${why}), and ${stuck.length === 1 ? 'entry' : 'entries'} ${stuck.join(', ')} could not be undone automatically. Void ${stuck.length === 1 ? 'it' : 'them'} in Journal Entries before trying again.`,
        409,
      );
    }
  };

  for (const e of plan) {
    const res = await postJournalEntry(
      db,
      {
        org_id: orgId,
        location_id: e.locationId,
        entry_date: txn.transaction_date,
        entry_type: 'STANDARD',
        memo: e.locationId === txn.location_id ? input.memo : `${input.memo} (split from affiliate)`,
        source_module: 'BANK_FEED',
        source_id: txn.id,
        source_ref: splitSourceRef(txn.id, version, e.locationId, txn.location_id),
        created_by: null,
        lines: e.lines,
      },
      { writer: opts.writer },
    );
    if (!res.success || !res.entry_id) {
      const msg = res.error ?? 'Posting failed';
      await rollback(msg);
      if (DUP_RE.test(msg)) throw new SplitError('This transaction is already being posted.', 409);
      const company = e.locationId === txn.location_id ? '' : ' (affiliate company)';
      throw new SplitError(`${msg}${company}`);
    }
    posted.push({ location_id: e.locationId, entry_id: res.entry_id, entry_number: res.entry_number ?? '' });
  }

  // Map split line → GL line (line_number = planned index + 1).
  const glLineIds = new Map<number, { entryId: string; lineId: string | null }>();
  for (const [i, e] of plan.entries()) {
    const entryId = posted[i].entry_id;
    const { data: glLines } = await db
      .from('gl_entry_lines')
      .select('id, line_number')
      .eq('gl_entry_id', entryId)
      .eq('org_id', orgId);
    const byNumber = new Map(((glLines ?? []) as Array<{ id: string; line_number: number }>).map((g) => [Number(g.line_number), g.id]));
    for (const s of e.splitLineIndex) glLineIds.set(s.lineNo, { entryId, lineId: byNumber.get(s.index + 1) ?? null });
  }

  const allLocs = uniq([txn.location_id, ...lines.map((l) => l.locationId)]);
  const writer = await scopedWriter(db, orgId, allLocs, { writer: opts.writer });
  const now = new Date().toISOString();

  // Persist the POSTED split rows (replacing any draft).
  const { error: delErr } = await writer
    .from('bank_transaction_splits')
    .delete()
    .eq('org_id', orgId)
    .eq('bank_transaction_id', txn.id)
    .eq('status', 'DRAFT');
  if (delErr) throw new Error(`Could not replace the draft split: ${delErr.message}`);
  const { error: insErr } = await writer.from('bank_transaction_splits').insert(
    lines.map((l) => ({
      org_id: orgId,
      bank_transaction_id: txn.id,
      location_id: txn.location_id,
      line_no: l.lineNo,
      status: 'POSTED',
      amount_cents: l.amountCents,
      percent_bp: l.percentBp,
      account_id: l.accountId,
      allocation_location_id: l.locationId,
      department_id: l.departmentId ?? null,
      class_id: l.classId ?? null,
      job_id: l.jobId ?? null,
      cost_code_id: l.costCodeId,
      memo: l.memo ?? null,
      posting_version: version,
      gl_entry_id: glLineIds.get(l.lineNo)?.entryId ?? null,
      gl_entry_line_id: glLineIds.get(l.lineNo)?.lineId ?? null,
      split_rule_id: input.splitRuleId ?? null,
      posted_at: now,
    })),
  );
  if (insErr) {
    // The GL is the book of record: the entries stand; surface the bookkeeping gap loudly.
    console.error('[bank-splits] posted but split rows failed to persist', insErr.message);
  }

  // Job cost sub-ledger, one row per job line, in that line's company.
  const jobLines: PostSplitResult['jobLines'] = [];
  for (const l of lines) {
    if (!l.jobId) continue;
    const gl = glLineIds.get(l.lineNo);
    if (!gl) continue;
    jobLines.push({ line: l, glEntryId: gl.entryId, glLineId: gl.lineId });
    if (!gl.lineId) continue;
    const { error: jcErr } = await writer.from('job_cost_entries').insert({
      org_id: orgId,
      job_id: l.jobId,
      cost_code_id: l.costCodeId,
      gl_entry_line_id: gl.lineId,
      amount_cents: txn.amount_cents < 0 ? l.amountCents : -l.amountCents,
      description: `Bank feed (split ${l.lineNo}/${lines.length}): ${txn.description}`.slice(0, 500),
      entry_date: txn.transaction_date,
    });
    if (jcErr) console.error('[bank-splits] job cost entry failed', jcErr.message);
  }

  const dominant = [...lines].sort((a, b) => b.amountCents - a.amountCents || a.lineNo - b.lineNo)[0];
  const { error: txnErr } = await writer
    .from('bank_transactions')
    .update({
      status: 'POSTED',
      final_account_id: dominant.accountId,
      final_vendor_id: input.vendorId,
      final_department_id: dominant.locationId === txn.location_id ? dominant.departmentId ?? null : null,
      final_class_id: dominant.classId ?? null,
      final_job_id: dominant.locationId === txn.location_id ? dominant.jobId ?? null : null,
      approved_by: null,
      approved_at: now,
      gl_entry_id: posted[0].entry_id,
      updated_at: now,
    })
    .eq('id', txn.id)
    .eq('org_id', orgId);
  if (txnErr) console.error('[bank-splits] feed line status update failed', txnErr.message);

  return { entries: posted, version, dominant, jobLines };
}

// ─────────────────────────────────────────────────────────────────────────────
// Drafts
// ─────────────────────────────────────────────────────────────────────────────


export async function loadSplitRows(db: DB, orgId: string, txnId: string): Promise<SplitRow[]> {
  const { data, error } = await db
    .from('bank_transaction_splits')
    .select('id, line_no, status, amount_cents, percent_bp, account_id, allocation_location_id, department_id, class_id, job_id, cost_code_id, memo, posting_version, gl_entry_id, split_rule_id')
    .eq('org_id', orgId)
    .eq('bank_transaction_id', txnId)
    .order('line_no', { ascending: true });
  if (error) throw new Error(`Could not load the split: ${error.message}`);
  return ((data ?? []) as SplitRow[]).map((r) => ({ ...r, amount_cents: Number(r.amount_cents), line_no: Number(r.line_no) }));
}

/** Split rows back into approve-route input lines. */
export function rowsToLineInputs(rows: ReadonlyArray<SplitRow>): SplitLineInput[] {
  return rows.map((r) => ({
    amount_cents: r.amount_cents,
    percent_bp: r.percent_bp,
    account_id: r.account_id,
    allocation_location_id: r.allocation_location_id,
    department_id: r.department_id,
    class_id: r.class_id,
    job_id: r.job_id,
    cost_code_id: r.cost_code_id,
    memo: r.memo,
  }));
}

/** Save (replace) the draft split. `lines: []` unsplits. Refused once posted. */
export async function saveDraftSplit(
  db: DB,
  input: { orgId: string; txn: FeedTxn; lines: ReadonlyArray<SplitLineInput>; splitRuleId?: string | null },
  opts: SplitServiceOptions = {},
): Promise<{ lines: number }> {
  const { orgId, txn } = input;
  if (txn.status === 'POSTED') throw new SplitError('This transaction is posted. Reverse it to change the split.', 409);
  if (input.lines.length > 0 && isBillSettlement(txn)) {
    throw new SplitError('This line pays a bill, so it settles Accounts Payable and cannot be split.');
  }
  const resolved = input.lines.length > 0 ? await validateSplitLines(db, orgId, txn, input.lines, opts) : [];
  if (input.splitRuleId) await assertOrgRefs(orgId, [{ table: 'split_rules', ids: [input.splitRuleId], label: 'split rule' }], { caller: db, writer: opts.writer });

  const writer = await scopedWriter(db, orgId, uniq([txn.location_id, ...resolved.map((l) => l.locationId)]), { writer: opts.writer });
  const existing = await loadSplitRows(db, orgId, txn.id);
  if (existing.some((r) => r.status === 'POSTED')) throw new SplitError('This split is posted. Reverse it to edit.', 409);
  const version = existing[0]?.posting_version ?? (await nextPostingVersion(db, orgId, txn));

  const { error: delErr } = await writer
    .from('bank_transaction_splits')
    .delete()
    .eq('org_id', orgId)
    .eq('bank_transaction_id', txn.id)
    .eq('status', 'DRAFT');
  if (delErr) throw new Error(`Could not save the split: ${delErr.message}`);
  if (resolved.length === 0) return { lines: 0 };

  const { error } = await writer.from('bank_transaction_splits').insert(
    resolved.map((l) => ({
      org_id: orgId,
      bank_transaction_id: txn.id,
      location_id: txn.location_id,
      line_no: l.lineNo,
      status: 'DRAFT',
      amount_cents: l.amountCents,
      percent_bp: l.percentBp,
      account_id: l.accountId,
      allocation_location_id: l.locationId,
      department_id: l.departmentId ?? null,
      class_id: l.classId ?? null,
      job_id: l.jobId ?? null,
      cost_code_id: l.costCodeId,
      memo: l.memo ?? null,
      posting_version: version,
      split_rule_id: input.splitRuleId ?? null,
    })),
  );
  if (error) throw new Error(`Could not save the split: ${error.message}`);
  return { lines: resolved.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reversal-on-edit
// ─────────────────────────────────────────────────────────────────────────────

/** Links on a feed line that make it unsafe to reverse from the bank feed. */
async function loadReversalGuards(
  db: DB,
  orgId: string,
  txnId: string,
): Promise<{ reconciledAt: string | null; matchedReceiptId: string | null }> {
  const { data, error } = await db
    .from('bank_transactions')
    .select('reconciled_at, matched_receipt_id')
    .eq('org_id', orgId)
    .eq('id', txnId)
    .maybeSingle();
  if (error) throw new Error(`Could not load the transaction: ${error.message}`);
  const row = (data ?? {}) as { reconciled_at?: string | null; matched_receipt_id?: string | null };
  let matchedReceiptId = row.matched_receipt_id ?? null;
  if (!matchedReceiptId) {
    // receipts.bank_transaction_id is the other direction of the same match (migration 005).
    const { data: rc } = await db.from('receipts').select('id').eq('org_id', orgId).eq('bank_transaction_id', txnId).limit(1);
    matchedReceiptId = ((rc ?? []) as Array<{ id: string }>)[0]?.id ?? null;
  }
  return { reconciledAt: row.reconciled_at ?? null, matchedReceiptId };
}

/** Plain-English owner of a GL entry the bank feed did not post for this line. */
async function describeEntryOwner(db: DB, orgId: string, entryId: string): Promise<string> {
  const { data: pay } = await db.from('customer_payments').select('id').eq('org_id', orgId).eq('gl_entry_id', entryId).limit(1);
  if (((pay ?? []) as unknown[]).length > 0) return 'customer_payment';
  const { data: e } = await db.from('gl_entries').select('source_module, entry_number').eq('org_id', orgId).eq('id', entryId).maybeSingle();
  const row = e as { source_module: string | null; entry_number: string | null } | null;
  const module = (row?.source_module ?? '').toUpperCase();
  const label: Record<string, string> = {
    BANK_FEED: 'the bank feed for a different line',
    RECONCILIATION: 'a bank reconciliation adjustment',
    BANK_REC: 'a bank reconciliation adjustment',
    AR: 'Accounts Receivable',
    CUSTOMER_PAYMENT: 'a customer payment',
    BILL: 'a bill payment',
    MANUAL: 'a manual journal entry',
  };
  const who = label[module] ?? (module ? `another module (${module.toLowerCase()})` : 'another workflow');
  return row?.entry_number ? `${who} (${row.entry_number})` : who;
}

export interface ReverseResult {
  voided: string[];
  version: number;
}

/**
 * Reverse a posted feed line (split or not): void every POSTED BANK_FEED entry it
 * produced (refused as a whole when any sits in a hard-closed period), void the job
 * cost it cleared, and return the line to review with its split as an editable draft.
 */
export async function reverseFeedPosting(
  db: DB,
  input: { orgId: string; txn: FeedTxn; reason: string },
  opts: SplitServiceOptions = {},
): Promise<ReverseResult> {
  const { orgId, txn, reason } = input;
  if (txn.status !== 'POSTED') throw new SplitError('Only a posted transaction can be reversed.', 409);
  if (isBillSettlement(txn)) {
    throw new SplitError('This line paid a bill. Reverse the payment from the bill so Accounts Payable stays right.');
  }

  // Lines other workflows depend on are not ours to undo here.
  const guard = await loadReversalGuards(db, orgId, txn.id);
  if (guard.reconciledAt) {
    throw new SplitError('This line is part of a finished bank reconciliation. Reopen the reconciliation before reversing it.', 409);
  }
  if (guard.matchedReceiptId) {
    throw new SplitError('A receipt is matched to this line. Unmatch the receipt before reversing it.', 409);
  }

  // Only entries the bank feed itself posted FOR THIS LINE are voided. txn.gl_entry_id can
  // point at an entry another module owns (cash application's customer payment, a
  // reconciliation adjustment) — voiding that here would silently undo the other workflow.
  const { data: entryRows, error } = await db
    .from('gl_entries')
    .select('id, entry_number, status, fiscal_period_id, location_id')
    .eq('org_id', orgId)
    .eq('source_module', 'BANK_FEED')
    .eq('source_id', txn.id)
    .eq('status', 'POSTED');
  if (error) throw new Error(`Could not load the posted entries: ${error.message}`);
  const entries = (entryRows ?? []) as Array<{ id: string; entry_number: string; fiscal_period_id: string; location_id: string }>;
  if (txn.gl_entry_id && !entries.some((e) => e.id === txn.gl_entry_id)) {
    const owner = await describeEntryOwner(db, orgId, txn.gl_entry_id);
    throw new SplitError(
      owner === 'customer_payment'
        ? 'This deposit was applied to customer invoices. Undo the customer payment in Cash Application instead.'
        : `This line was posted by ${owner} and not by the bank feed. Reverse it from there instead.`,
      409,
    );
  }
  if (entries.length === 0) throw new SplitError('No posted journal entry was found for this transaction.', 404);

  // All-or-nothing: refuse before voiding anything if any entry's period is hard-closed.
  const periodIds = uniq(entries.map((e) => e.fiscal_period_id));
  const { data: periods } = await db.from('fiscal_periods').select('id, status').in('id', periodIds);
  if (((periods ?? []) as Array<{ status: string }>).some((p) => p.status === 'HARD_CLOSE')) {
    throw new SplitError('The posting sits in a hard-closed period. Post a correcting journal entry in an open period instead.');
  }

  const writer = await scopedWriter(db, orgId, uniq([txn.location_id, ...entries.map((e) => e.location_id)]), { writer: opts.writer });

  // GL lines (for the job-cost clean-up) before voiding.
  const entryIds = entries.map((e) => e.id);
  const { data: lineRows } = await db.from('gl_entry_lines').select('id').eq('org_id', orgId).in('gl_entry_id', entryIds);
  const lineIds = ((lineRows ?? []) as Array<{ id: string }>).map((l) => l.id);

  const voided: string[] = [];
  for (const e of entries) {
    const res = await voidJournalEntry(db, orgId, e.id, null, `Bank feed reversal: ${reason}`.slice(0, 500), { writer: opts.writer });
    if (!res.success) {
      throw new SplitError(`Could not reverse ${e.entry_number}: ${res.error ?? 'unknown error'}${voided.length ? ` (already reversed: ${voided.join(', ')})` : ''}`);
    }
    voided.push(e.entry_number);
  }

  if (lineIds.length) {
    const { error: jcErr } = await writer.from('job_cost_entries').delete().eq('org_id', orgId).in('gl_entry_line_id', lineIds);
    if (jcErr) console.error('[bank-splits] job cost clean-up failed', jcErr.message);
  }
  // The CLEARED JOB_COST attributions (the Projects seam) are voided, which emits VOIDED.
  try {
    const { data: atts } = await db
      .from('job_cost_attributions')
      .select('id, lifecycle')
      .eq('org_id', orgId)
      .in('gl_entry_id', entryIds);
    for (const a of (atts ?? []) as Array<{ id: string; lifecycle: string }>) {
      if (a.lifecycle !== 'VOIDED') await voidAttribution(db, orgId, a.id, `Bank feed reversal: ${reason}`);
    }
  } catch (e) {
    console.error('[bank-splits] job cost attribution void failed (non-fatal)', e);
  }

  const version = (await nextPostingVersion(db, orgId, txn));
  const { error: splitErr } = await writer
    .from('bank_transaction_splits')
    .update({ status: 'DRAFT', posting_version: version, gl_entry_id: null, gl_entry_line_id: null, posted_at: null, updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('bank_transaction_id', txn.id)
    .eq('status', 'POSTED');
  if (splitErr) {
    throw new Error(`Reversed ${voided.join(', ')}, but the split could not be reopened as a draft: ${splitErr.message}`);
  }

  const { error: txnErr } = await writer
    .from('bank_transactions')
    .update({ status: 'CATEGORIZED', gl_entry_id: null, approved_at: null, updated_at: new Date().toISOString() })
    .eq('id', txn.id)
    .eq('org_id', orgId);
  if (txnErr) throw new Error(`Reversed, but the feed line could not be reopened: ${txnErr.message}`);

  return { voided, version };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rules + suggestions
// ─────────────────────────────────────────────────────────────────────────────

/** A description pattern for a vendor-less rule: words only, digits (ref numbers) dropped. */
export function patternFromDescription(description: string): string | null {
  const p = normalizePattern(description.replace(/\d+/g, ' ')).slice(0, 60).trim();
  return p.length >= 3 ? p : null;
}

/** Lines (amounts) → rule allocations (basis points summing to 100%). */
export function allocationsFromLines(lines: ReadonlyArray<ResolvedSplitLine>): SplitAllocation[] {
  const allBp = lines.every((l) => l.percentBp != null) && lines.reduce((s, l) => s + (l.percentBp ?? 0), 0) === FULL_BP;
  const bps = allBp ? lines.map((l) => l.percentBp as number) : percentagesFromAmounts(lines.map((l) => l.amountCents));
  return lines.map((l, i) => ({
    percent_bp: bps[i],
    account_id: l.accountId,
    allocation_location_id: l.locationId,
    department_id: l.departmentId ?? null,
    class_id: l.classId ?? null,
    job_id: l.jobId ?? null,
    cost_code_id: l.costCodeId,
    memo: l.memo ?? null,
  }));
}

/** "Remember this split": one active rule per vendor per company (replaces the old one). */
export async function saveSplitRule(
  db: DB,
  input: { orgId: string; txn: FeedTxn; vendorId: string | null; vendorName: string | null; lines: ReadonlyArray<ResolvedSplitLine>; userId: string | null },
  opts: SplitServiceOptions = {},
): Promise<{ id: string; name: string } | null> {
  const { orgId, txn } = input;
  const allocations = allocationsFromLines(input.lines);
  if (!splitAllocationsSchema.safeParse(allocations).success || allocations.some((a) => a.percent_bp <= 0)) return null;
  const pattern = input.vendorId ? null : patternFromDescription(txn.description);
  if (!input.vendorId && !pattern) return null;
  const shares = allocations.map((a) => `${Math.round(a.percent_bp / 100)}`).join('/');
  const name = `${input.vendorName ?? pattern ?? 'Split'} ${shares}`.slice(0, 120);

  const writer = await scopedWriter(db, orgId, uniq([txn.location_id, ...input.lines.map((l) => l.locationId)]), { writer: opts.writer });
  if (input.vendorId) {
    await writer
      .from('split_rules')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .eq('vendor_id', input.vendorId)
      .eq('location_id', txn.location_id)
      .eq('is_active', true);
  }
  const { data, error } = await writer
    .from('split_rules')
    .insert({
      org_id: orgId,
      location_id: txn.location_id,
      vendor_id: input.vendorId,
      description_pattern: pattern,
      name,
      allocations,
      is_active: true,
      created_by: input.userId,
    })
    .select('id')
    .single();
  if (error || !data) {
    console.error('[bank-splits] split rule save failed', error?.message);
    return null;
  }
  return { id: (data as { id: string }).id, name };
}

/** Bump a rule's usage after it was applied to a posted split. */
export async function markRuleApplied(db: DB, orgId: string, ruleId: string, opts: SplitServiceOptions = {}): Promise<void> {
  const { data } = await db.from('split_rules').select('id, times_applied, location_id').eq('org_id', orgId).eq('id', ruleId).maybeSingle();
  const r = data as { id: string; times_applied: number; location_id: string | null } | null;
  if (!r) return;
  const writer = await scopedWriter(db, orgId, [r.location_id], { writer: opts.writer });
  await writer
    .from('split_rules')
    .update({ times_applied: Number(r.times_applied ?? 0) + 1, last_applied_at: new Date().toISOString() })
    .eq('id', ruleId)
    .eq('org_id', orgId);
}


/** The suggestion banner: a saved rule first, else the vendor's most recent posted split. */
export async function suggestSplit(db: DB, orgId: string, txn: FeedTxn, vendorId: string | null): Promise<SplitSuggestion | null> {
  const total = Math.abs(txn.amount_cents);
  if (total === 0) return null;

  const { data: ruleRows } = await db
    .from('split_rules')
    .select('id, name, location_id, vendor_id, description_pattern, allocations, is_active, times_applied')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .limit(500);
  const rule = matchSplitRule((ruleRows ?? []) as SplitRuleRow[], { vendorId, description: txn.description, locationId: txn.location_id });
  if (rule) {
    const allocations = splitAllocationsSchema.parse(rule.allocations);
    return { source: 'RULE', rule_id: rule.id, name: rule.name, lines: applySplitAllocations(total, allocations) };
  }

  if (!vendorId) return null;
  const { data: vendorTxns } = await db
    .from('bank_transactions')
    .select('id, approved_at')
    .eq('org_id', orgId)
    .eq('final_vendor_id', vendorId)
    .eq('status', 'POSTED')
    .neq('id', txn.id)
    .order('approved_at', { ascending: false })
    .limit(50);
  const ids = ((vendorTxns ?? []) as Array<{ id: string }>).map((t) => t.id);
  if (ids.length === 0) return null;
  const { data: splitRows } = await db
    .from('bank_transaction_splits')
    .select('bank_transaction_id, line_no, amount_cents, account_id, allocation_location_id, department_id, class_id, job_id, cost_code_id, memo')
    .eq('org_id', orgId)
    .eq('status', 'POSTED')
    .in('bank_transaction_id', ids);
  const byTxn = new Map<string, Array<Record<string, unknown>>>();
  for (const r of (splitRows ?? []) as Array<Record<string, unknown>>) {
    const k = r.bank_transaction_id as string;
    byTxn.set(k, [...(byTxn.get(k) ?? []), r]);
  }
  const latest = ids.find((id) => (byTxn.get(id)?.length ?? 0) >= 2);
  if (!latest) return null;
  const rows = (byTxn.get(latest) ?? []).sort((a, b) => Number(a.line_no) - Number(b.line_no));
  const bps = percentagesFromAmounts(rows.map((r) => Number(r.amount_cents)));
  const allocations: SplitAllocation[] = rows.map((r, i) => ({
    percent_bp: bps[i],
    account_id: r.account_id as string,
    allocation_location_id: r.allocation_location_id as string,
    department_id: (r.department_id as string | null) ?? null,
    class_id: (r.class_id as string | null) ?? null,
    job_id: (r.job_id as string | null) ?? null,
    cost_code_id: (r.cost_code_id as string | null) ?? null,
    memo: (r.memo as string | null) ?? null,
  }));
  if (allocations.some((a) => a.percent_bp <= 0)) return null;
  return { source: 'HISTORY', rule_id: null, name: 'Your last split of this vendor', lines: applySplitAllocations(total, allocations) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed-table summary
// ─────────────────────────────────────────────────────────────────────────────


/** "Split · 3 lines" for the feed tables. */
export async function fetchSplitSummaries(db: DB, txnIds: ReadonlyArray<string>): Promise<Map<string, SplitSummary>> {
  const out = new Map<string, SplitSummary>();
  if (txnIds.length === 0) return out;
  const { data } = await db
    .from('bank_transaction_splits')
    .select('bank_transaction_id, allocation_location_id, status')
    .in('bank_transaction_id', [...txnIds]);
  const acc = new Map<string, { lines: number; companies: Set<string>; posted: boolean }>();
  for (const r of (data ?? []) as Array<{ bank_transaction_id: string; allocation_location_id: string; status: string }>) {
    const a = acc.get(r.bank_transaction_id) ?? { lines: 0, companies: new Set<string>(), posted: false };
    a.lines += 1;
    a.companies.add(r.allocation_location_id);
    if (r.status === 'POSTED') a.posted = true;
    acc.set(r.bank_transaction_id, a);
  }
  for (const [k, a] of acc) out.set(k, { lines: a.lines, companies: a.companies.size, status: a.posted ? 'POSTED' : 'DRAFT' });
  return out;
}
