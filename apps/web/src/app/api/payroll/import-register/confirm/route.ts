export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { logHumanAction } from '@/lib/trust/action-log';
import { postJournalEntry, type JournalEntryLineInput } from '@/lib/services/gl-posting';

/**
 * POST /api/payroll/import-register/confirm — confirm a PROPOSED payroll register JE.
 *
 * The human has reviewed the AI-proposed, balanced payroll journal entry (from
 * `POST /api/payroll/import-register`) and adjusted the per-line account mapping as
 * needed. This route WRITES: it posts the balanced entry to the GL through
 * `postJournalEntry` / `check_journal_balance()` (entry_type PAYROLL_RUN,
 * source_module PAYROLL). Accounts are the explicit IDs the human confirmed — the
 * engine never guesses here.
 *
 * IDEMPOTENT / double-post guard: the entry carries a deterministic `source_ref`.
 * The DB unique index `uq_gl_entries_org_source_type (org_id, source_ref,
 * entry_type)` (migration 064) is the guarantor; we also pre-check and return the
 * existing entry so a re-confirm never posts payroll twice.
 *
 * Canon §3: AI proposed, the deterministic engine did the accounting, a human
 * confirmed. Balance is re-validated server-side (debits == credits, every line has
 * an account, positive amounts) before posting — a proposal that does not foot is
 * rejected, never forced.
 *
 * Access: gated on `payroll:approve` — posting payroll to the GL is the approve-tier
 * action (the same permission the embedded run's post route requires), keeping it
 * separate from the `payroll:create` import/draft step.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ConfirmLine {
  accountId?: unknown;
  debitCents?: unknown;
  creditCents?: unknown;
  memo?: unknown;
}

interface ConfirmBody {
  locationId?: unknown;
  payDate?: unknown;
  memo?: unknown;
  lines?: unknown;
  decisionId?: unknown;
  /** Optional client idempotency key; a deterministic ref is derived when absent. */
  sourceRef?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function toIntCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — posting payroll to the GL is the approve-tier action.
  const guard = await requirePermission(userId, 'payroll', 'approve');
  if (!guard.ok) return guard.response;

  let body: ConfirmBody;
  try {
    body = (await request.json()) as ConfirmBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'BAD_JSON' }, { status: 400 });
  }

  // ── Validate header ──────────────────────────────────────────────────────────
  if (!isNonEmptyString(body.locationId) || !UUID_RE.test(body.locationId)) {
    return NextResponse.json({ error: 'locationId (a company uuid) is required', code: 'VALIDATION' }, { status: 422 });
  }
  if (!isNonEmptyString(body.payDate) || !ISO_DATE.test(body.payDate)) {
    return NextResponse.json({ error: 'payDate must be an ISO date (YYYY-MM-DD)', code: 'VALIDATION' }, { status: 422 });
  }
  const locationId = body.locationId;
  const payDate = body.payDate;

  // ── Validate lines (every line needs an account + a non-negative one-sided amount) ─
  if (!Array.isArray(body.lines) || body.lines.length < 2) {
    return NextResponse.json({ error: 'At least 2 journal lines are required', code: 'VALIDATION' }, { status: 422 });
  }

  const lines: JournalEntryLineInput[] = [];
  let totalDebits = 0;
  let totalCredits = 0;
  for (let i = 0; i < body.lines.length; i++) {
    const raw = body.lines[i] as ConfirmLine;
    if (!isNonEmptyString(raw.accountId) || !UUID_RE.test(raw.accountId)) {
      return NextResponse.json(
        { error: `Line ${i + 1}: an account must be selected before posting`, code: 'MISSING_ACCOUNT' },
        { status: 422 },
      );
    }
    const debit = toIntCents(raw.debitCents ?? 0);
    const credit = toIntCents(raw.creditCents ?? 0);
    if (debit === null || credit === null) {
      return NextResponse.json({ error: `Line ${i + 1}: amounts must be non-negative integer cents`, code: 'VALIDATION' }, { status: 422 });
    }
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      return NextResponse.json({ error: `Line ${i + 1}: exactly one of debit/credit must be > 0`, code: 'VALIDATION' }, { status: 422 });
    }
    totalDebits += debit;
    totalCredits += credit;
    lines.push({
      account_id: raw.accountId,
      debit_cents: debit,
      credit_cents: credit,
      location_id: locationId,
      memo: isNonEmptyString(raw.memo) ? raw.memo.slice(0, 200) : 'Payroll register import',
    });
  }

  // Re-verify the balance server-side — never force a proposal that does not foot.
  if (totalDebits !== totalCredits) {
    return NextResponse.json(
      { error: `Entry does not balance: debits ${totalDebits} ≠ credits ${totalCredits}. Fix the register before posting.`, code: 'UNBALANCED' },
      { status: 422 },
    );
  }

  const memo = isNonEmptyString(body.memo) ? body.memo.slice(0, 200) : `Payroll register — pay date ${payDate}`;

  // Deterministic double-post guard (DB unique index is the guarantor).
  const sourceRef = isNonEmptyString(body.sourceRef)
    ? body.sourceRef.slice(0, 200)
    : `payroll-register:${locationId}:${payDate}:${totalDebits}`;

  // ── Idempotency pre-check: return the existing entry if already posted ────────
  const { data: existing } = await supabase
    .from('gl_entries')
    .select('id, entry_number')
    .eq('org_id', orgId)
    .eq('source_ref', sourceRef)
    .eq('entry_type', 'PAYROLL_RUN')
    .maybeSingle<{ id: string; entry_number: string }>();
  if (existing) {
    return NextResponse.json({ ok: true, entryId: existing.id, entryNumber: existing.entry_number, alreadyPosted: true });
  }

  // ── Post the balanced entry ───────────────────────────────────────────────────
  const result = await postJournalEntry(supabase, {
    org_id: orgId,
    location_id: locationId,
    entry_date: payDate,
    entry_type: 'PAYROLL_RUN',
    memo,
    source_module: 'PAYROLL',
    source_ref: sourceRef,
    created_by: null, // Clerk ids are text; GL author columns are uuid → null
    lines,
  });

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? 'Failed to post payroll entry', code: 'POST_FAILED' }, { status: 422 });
  }

  // ── Mark the originating AI proposal APPROVED (audit trail; non-fatal) ────────
  if (isNonEmptyString(body.decisionId) && UUID_RE.test(body.decisionId)) {
    try {
      await supabase
        .from('ai_decisions')
        .update({
          status: 'APPROVED',
          disposition_by_user: userId,
          disposition_at: new Date().toISOString(),
          disposition_note: `Confirmed & posted payroll register (entry ${result.entry_number ?? ''})`.trim(),
          posted_gl_entry_id: result.entry_id ?? null,
        })
        .eq('id', body.decisionId)
        .eq('org_id', orgId);
    } catch (e) {
      console.error('[payroll/import-register/confirm] decision update failed (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  // Human attribution lives in the action log (GL author columns are uuid/null).
  try {
    await logHumanAction(supabase, userId, orgId, {
      action: 'payroll.register.import',
      subjectTable: 'gl_entries',
      subjectId: result.entry_id ?? sourceRef,
      summary: `Posted imported payroll register (pay date ${payDate}, ${totalDebits} cents) to GL entry ${result.entry_number ?? ''}`.trim(),
      metadata: { locationId, payDate, totalCents: totalDebits, entryId: result.entry_id, sourceRef },
    });
  } catch (e) {
    console.error('[payroll/import-register/confirm] action log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    ok: true,
    entryId: result.entry_id,
    entryNumber: result.entry_number,
    alreadyPosted: false,
  });
}
