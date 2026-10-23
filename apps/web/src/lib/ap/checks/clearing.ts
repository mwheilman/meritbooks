/**
 * Auto-clear printed checks from the bank feed (FPB §5, AC-12).
 *
 * A bank-feed OUTFLOW on the check's bank account whose check number (parsed from the
 * description — "CHECK 1043", "CHK #1043") and amount match an outstanding check exactly
 * marks the check CLEARED. The bank line is linked to the payment that already posted on
 * release (match_type BILL_PAYMENT, gl_entry_id = that payment's JE, status POSTED) so the
 * feed never posts it a second time; the bank feed's reversal guard refuses to undo a
 * bill-settlement line. A bank line someone already posted elsewhere is linked to the check
 * but flagged for review (possible double entry). Approvals move RELEASED → SETTLED.
 *
 * Idempotent; safe to run on every register load and from the nightly bank sync
 * (`runCheckClearingJob` — the scheduler registry is owned by slice 2E).
 */

import { scopedWriter } from '@/lib/db/scoped-writer';
import { CheckError, moveApproval, type CheckServiceOptions, type DB } from './db';
import { parseCheckNumber } from './register';

interface OutstandingCheck { id: string; location_id: string; bank_account_id: string; check_number: number; amount_cents: number; check_date: string }
interface BankLine { id: string; bank_account_id: string; amount_cents: number; description: string; status: string; gl_entry_id: string | null; transaction_date: string; posted_date: string | null }

export interface ClearingResult {
  cleared: number;
  flagged: number;
  checked: number;
}

export async function matchClearedChecks(
  db: DB,
  orgId: string,
  filter: { bankAccountId?: string | null } = {},
  opts: CheckServiceOptions = {},
): Promise<ClearingResult> {
  let q = db
    .from('ap_checks')
    .select('id, location_id, bank_account_id, check_number, amount_cents, check_date')
    .eq('org_id', orgId)
    .in('status', ['PRINTED', 'ISSUED', 'MAILED']);
  if (filter.bankAccountId) q = q.eq('bank_account_id', filter.bankAccountId);
  const { data: cData, error: cErr } = await q;
  if (cErr) throw new CheckError(`Could not load outstanding checks: ${cErr.message}`, 500);
  const checks = (cData ?? []) as OutstandingCheck[];
  const result: ClearingResult = { cleared: 0, flagged: 0, checked: checks.length };
  if (checks.length === 0) return result;

  const byKey = new Map<string, OutstandingCheck>();
  for (const c of checks) byKey.set(`${c.bank_account_id}:${Number(c.check_number)}`, c);
  const accounts = Array.from(new Set(checks.map((c) => c.bank_account_id)));
  const earliest = checks.reduce((m, c) => (c.check_date < m ? c.check_date : m), checks[0].check_date);

  const { data: lData, error: lErr } = await db
    .from('bank_transactions')
    .select('id, bank_account_id, amount_cents, description, status, gl_entry_id, transaction_date, posted_date')
    .eq('org_id', orgId)
    .in('bank_account_id', accounts)
    .lt('amount_cents', 0)
    .gte('transaction_date', earliest);
  if (lErr) throw new CheckError(`Could not read the bank feed: ${lErr.message}`, 500);
  const lines = (lData ?? []) as BankLine[];
  if (lines.length === 0) return result;

  // Bank lines already used to clear a check are never reused.
  const { data: used } = await db
    .from('ap_checks')
    .select('cleared_bank_transaction_id')
    .eq('org_id', orgId)
    .in('cleared_bank_transaction_id', lines.map((l) => l.id));
  const usedIds = new Set(((used ?? []) as Array<{ cleared_bank_transaction_id: string | null }>).map((u) => u.cleared_bank_transaction_id));

  for (const line of lines) {
    if (usedIds.has(line.id)) continue;
    const num = parseCheckNumber(line.description);
    if (num === null) continue;
    const check = byKey.get(`${line.bank_account_id}:${num}`);
    if (!check || -Number(line.amount_cents) !== Number(check.amount_cents)) continue;

    const writer = await scopedWriter(db, orgId, [check.location_id], { writer: opts.writer });
    const { data: links } = await db
      .from('ap_check_payments')
      .select('bill_payment_id, bill_id, approval_id')
      .eq('org_id', orgId)
      .eq('check_id', check.id)
      .eq('is_current', true);
    const linkRows = (links ?? []) as Array<{ bill_payment_id: string; bill_id: string; approval_id: string | null }>;
    const { data: pays } = linkRows.length
      ? await db.from('bill_payments').select('id, gl_entry_id, bank_transaction_id').eq('org_id', orgId).in('id', linkRows.map((l) => l.bill_payment_id))
      : { data: [] };
    const payRows = (pays ?? []) as Array<{ id: string; gl_entry_id: string | null; bank_transaction_id: string | null }>;
    const ourEntries = new Set(payRows.map((p) => p.gl_entry_id).filter(Boolean));
    const alreadyPostedElsewhere = line.status === 'POSTED' && !!line.gl_entry_id && !ourEntries.has(line.gl_entry_id);
    const note = alreadyPostedElsewhere
      ? 'The bank line was already posted separately in the bank feed — check for a double entry.'
      : null;

    const { data: upd, error: updErr } = await writer
      .from('ap_checks')
      .update({
        status: 'CLEARED',
        cleared_at: new Date(`${line.posted_date ?? line.transaction_date}T12:00:00Z`).toISOString(),
        cleared_bank_transaction_id: line.id,
        cleared_by: 'bank_feed',
        clear_note: note,
      })
      .eq('org_id', orgId)
      .eq('id', check.id)
      .in('status', ['PRINTED', 'ISSUED', 'MAILED'])
      .select('id');
    if (updErr) throw new CheckError(`Could not clear check ${check.check_number}: ${updErr.message}`, 500);
    if (((upd ?? []) as unknown[]).length === 0) continue;
    usedIds.add(line.id);
    byKey.delete(`${line.bank_account_id}:${num}`);
    result.cleared += 1;
    if (note) result.flagged += 1;

    if (!alreadyPostedElsewhere && line.status !== 'POSTED') {
      const first = payRows[0];
      await writer
        .from('bank_transactions')
        .update({
          status: 'POSTED',
          match_type: 'BILL_PAYMENT',
          matched_bill_id: linkRows[0]?.bill_id ?? null,
          match_confidence: 1,
          gl_entry_id: first?.gl_entry_id ?? null,
          approved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('org_id', orgId)
        .eq('id', line.id)
        .neq('status', 'POSTED');
      if (first && !first.bank_transaction_id) {
        await writer.from('bill_payments').update({ bank_transaction_id: line.id }).eq('org_id', orgId).eq('id', first.id).is('bank_transaction_id', null);
      }
    }
    for (const l of linkRows) {
      if (l.approval_id) await moveApproval(writer, orgId, l.approval_id, 'RELEASED', 'SETTLED', 'bank_feed', `Check ${check.check_number} cleared the bank`);
    }
  }
  return result;
}

/** Scheduler entry point (wire into the nightly bank job — registry owned by slice 2E). */
export async function runCheckClearingJob(adminDb: DB, orgId: string): Promise<ClearingResult> {
  return matchClearedChecks(adminDb, orgId);
}
