export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { checkActionSchema } from '@/lib/validations/checks';
import { loadCheck, loadCheckPayments } from '@/lib/ap/checks/db';
import { checkActionSodBlock, markCheckSent, printChecks, spoilCheck, spoilProblem } from '@/lib/ap/checks/print-service';
import { printSecurityHold } from '@/lib/ap/checks/stock-security';
import { paymentBlockKey, paymentBlockReasons } from '@/lib/services/vendor-compliance';
import { voidCheck } from '@/lib/ap/checks/void-service';
import { loadPrintSetup } from '@/lib/ap/checks/stock-service';
import { supabaseCheckSecrets } from '@/lib/ap/checks/secrets';
import { renderCheck, signaturesPrinted } from '@/lib/ap/check-print/check-doc';
import { checkErrorResponse, loadPrintSod, pdfResponse, renderCheckRun, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/[id] — act on one check in the register.
 *   void    reverse its payments (open period: void in place; closed: reversing entry on the
 *           void date), reopen the bills, return the approvals, number VOIDED
 *   spoil   printed but never handed out: number consumed, payments back to "ready".
 *           Only the original printer, within 24 h of printing (else void) — M1.
 *   reprint spoil + print the same payments on the next number (PDF response); same rule.
 *   issue / mail  record that it was handed out / mailed (manual — no provider wired)
 * Release authority for every action; void / spoil / reprint also need the session policy,
 * and spoil / reprint the print SoD (spoiling re-releases the payments). Logged.
 */
export async function POST(request: Request, { params }: { params: { id: string } }) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  if (!/^[0-9a-f-]{36}$/i.test(params.id)) return NextResponse.json({ error: 'Invalid check id' }, { status: 400 });

  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = checkActionSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request', code: 'VALIDATION_ERROR' }, { status: 422 });
  }
  const body = parsed.data;

  if (body.action === 'void' || body.action === 'reprint' || body.action === 'spoil') {
    const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'money_release' });
    if (!policy.ok) return policy.response;
  }

  try {
    const check = await loadCheck(supabase, orgId, params.id);
    const log = (action: string, summary: string, metadata: Record<string, unknown> = {}) =>
      logHumanAction(supabase, userId, orgId, { action, subjectTable: 'ap_checks', subjectId: params.id, summary, metadata: { checkNumber: check.check_number, ...metadata } }).catch(() => {});

    if (body.action === 'void') {
      const res = await voidCheck(supabase, orgId, userId, params.id, { reason: body.reason, voidDate: body.voidDate });
      await log('ap.checks.void', `Voided check ${res.checkNumber}: ${body.reason}`, { mode: res.mode, reversedEntryIds: res.reversedEntryIds, voidDate: body.voidDate ?? null });
      // GL attribution per canon §2: gl_entries.created_by is a uuid and stays null (Clerk ids
      // are text); the actor is recorded on the subject rows (ap_checks / bill_payments
      // voided_by) and here, one action-log row per reversed / voided journal entry.
      for (const entryId of res.reversedEntryIds) {
        await logHumanAction(supabase, userId, orgId, {
          action: res.mode === 'VOID_IN_PLACE' ? 'gl.entry.void' : 'gl.entry.reverse',
          subjectTable: 'gl_entries',
          subjectId: entryId,
          summary: `Check ${res.checkNumber} void: ${body.reason}`.slice(0, 300),
          metadata: { checkId: params.id, checkNumber: res.checkNumber, mode: res.mode, voidDate: body.voidDate ?? null },
        }).catch(() => {});
      }
      return NextResponse.json({ ok: true, ...res });
    }

    // spoil / reprint: the window + original printer (M1), then the print SoD, BEFORE any write.
    const sod = body.action === 'spoil' || body.action === 'reprint' ? await loadPrintSod(orgId) : null;
    const links = body.action === 'spoil' || body.action === 'reprint'
      ? (await loadCheckPayments(supabase, orgId, [params.id])).filter((l) => l.is_current)
      : [];
    if (sod && check.status !== 'SPOILED') {
      const problem = spoilProblem(check, userId, new Date());
      if (problem) return NextResponse.json({ error: problem }, { status: check.status === 'PRINTED' && check.printed_by !== userId ? 403 : 409 });
      const sodMsg = await checkActionSodBlock(supabase, orgId, userId, links.map((l) => l.approval_id).filter((x): x is string => !!x), sod);
      if (sodMsg) return NextResponse.json({ error: sodMsg }, { status: 403 });
    }

    if (body.action === 'spoil') {
      const res = await spoilCheck(supabase, orgId, userId, params.id, body.reason);
      await log('ap.checks.spoil', `Spoiled check ${res.checkNumber}: ${body.reason}`);
      return NextResponse.json({ ok: true, ...res });
    }
    if (body.action === 'issue' || body.action === 'mail') {
      await markCheckSent(supabase, orgId, userId, params.id, body.action === 'issue' ? 'ISSUED' : 'MAILED', { tracking: body.action === 'mail' ? body.tracking ?? null : null });
      await log(`ap.checks.${body.action}`, `Check ${check.check_number} marked ${body.action === 'issue' ? 'handed out' : 'mailed'}`);
      return NextResponse.json({ ok: true });
    }

    // reprint: validate EVERYTHING that could stop the replacement first, so a reprint never
    // spoils without one — the stock setup, the printer's security-change hold (M9) and a
    // vendor hold re-checked since release (M3).
    if (!sod) throw new Error('unreachable');
    const admin = createAdminSupabase();
    const setup = await loadPrintSetup(supabase, admin, orgId, check.bank_account_id, supabaseCheckSecrets(admin), { storage: admin });
    if (check.status !== 'PRINTED' || links.length === 0) {
      return NextResponse.json({ error: `Check ${check.check_number} can't be reprinted — only a printed check that was never handed out. Void it instead.` }, { status: 409 });
    }
    const securityHold = await printSecurityHold(supabase, orgId, check.bank_account_id, userId);
    if (securityHold) return NextResponse.json({ error: securityHold.reason }, { status: 409 });
    if (check.payee_vendor_id) {
      const { data: billRows, error: billErr } = await supabase.from('bills').select('id, location_id').eq('org_id', orgId).in('id', links.map((l) => l.bill_id));
      if (billErr) return NextResponse.json({ error: 'Could not re-check the vendor before reprinting. Try again.' }, { status: 500 });
      const loc = new Map(((billRows ?? []) as Array<{ id: string; location_id: string }>).map((b) => [b.id, b.location_id]));
      const vendorId = check.payee_vendor_id;
      const holds = await paymentBlockReasons(supabase, orgId, links.map((l) => ({ vendorId, billId: l.bill_id, locationId: loc.get(l.bill_id) ?? null })));
      const hold = links.map((l) => holds.get(paymentBlockKey(vendorId, l.bill_id))).find((x): x is string => !!x);
      if (hold) return NextResponse.json({ error: `${hold} The check was not reprinted; void it if it must not be paid.` }, { status: 409 });
    }
    await spoilCheck(supabase, orgId, userId, params.id, `Reprint: ${body.reason}`);
    const run = await printChecks(supabase, orgId, userId, {
      bankAccountId: check.bank_account_id,
      billPaymentIds: links.map((l) => l.bill_payment_id),
      checkDate: body.checkDate ?? check.check_date,
      memo: check.memo,
      replacesCheckId: params.id,
      layout: setup.layout,
      signaturesFor: (amt) => signaturesPrinted(amt, setup),
    }, sod);
    let pdf: Uint8Array;
    try {
      pdf = await renderCheckRun(run.checks.map((c) => renderCheck(c, setup)), setup);
    } catch (e) {
      // Same as the print route: never leave a live, un-printed number behind.
      console.error('[checks.reprint] render failed; spoiling the replacement', e);
      for (const c of run.checks) {
        await spoilCheck(supabase, orgId, userId, c.checkId, 'The PDF could not be generated — spoiled automatically, nothing was printed').catch(() => {});
      }
      await log('ap.checks.reprint_failed', `Reprint of check ${check.check_number} failed to render; replacement ${run.firstNumber} spoiled`, { newCheckNumber: run.firstNumber });
      return NextResponse.json({ error: `The reprint could not be rendered, so check ${check.check_number} and its replacement ${run.firstNumber} were spoiled. Nothing was printed; the bills are back under Print checks.` }, { status: 500 });
    }
    await log('ap.checks.reprint', `Reprinted check ${check.check_number} as ${run.firstNumber}: ${body.reason}`, { newCheckNumber: run.firstNumber });
    return pdfResponse(pdf, `check-${run.firstNumber}-reprint.pdf`, { 'X-Check-First': String(run.firstNumber), 'X-Check-Last': String(run.lastNumber), 'X-Check-Run': run.runId });
  } catch (e) {
    return checkErrorResponse(e, 'Could not update the check.');
  }
}
