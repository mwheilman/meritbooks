export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { assertSessionMeetsPolicy } from '@/lib/auth/assert-session-policy';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { logHumanAction } from '@/lib/trust/action-log';
import { printChecksSchema } from '@/lib/validations/checks';
import { printChecks, spoilCheck } from '@/lib/ap/checks/print-service';
import { loadPrintSetup } from '@/lib/ap/checks/stock-service';
import { supabaseCheckSecrets } from '@/lib/ap/checks/secrets';
import { composeMicrLine } from '@/lib/ap/checks/micr';
import { renderCheck, signaturesPrinted } from '@/lib/ap/check-print/check-doc';
import { checkErrorResponse, loadPrintSod, pdfResponse, renderCheckRun, requireCheckMoney } from '@/lib/ap/checks/route-support';

/**
 * POST /api/ap/checks/print — print released check payments on blank stock (FPB §4.1).
 *
 * Release authority + the tenant's session policy (MFA / step-up) + print SoD per payment
 * (printer ≠ preparer; approver only within the 174 release threshold — re-checked inside
 * issue_check_print_run). The check stock setup (full MICR numbers, signatures) is loaded
 * and validated BEFORE any number is consumed; numbers are allocated atomically in the DB.
 * If the PDF then fails to render, every number in the run is spoiled automatically (no
 * gap, no live un-printed check). The PDF is returned once and never stored.
 */
export const POST = apiHandler(printChecksSchema, async (body, { userId, orgId, supabase }) => {
  const guard = await requireCheckMoney(userId);
  if (!guard.ok) return guard.response;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });
  const policy = await assertSessionMeetsPolicy({ orgId, userId }, { action: 'money_release' });
  if (!policy.ok) return policy.response;

  const admin = createAdminSupabase();
  let run;
  let setup;
  try {
    const sod = await loadPrintSod(orgId);
    setup = await loadPrintSetup(supabase, admin, orgId, body.bankAccountId, supabaseCheckSecrets(admin), { storage: admin });
    composeMicrLine({ checkNumber: 1, routing: setup.routing, account: setup.account, auxDigits: setup.auxDigits });
    const s = setup;
    run = await printChecks(supabase, orgId, userId, {
      bankAccountId: body.bankAccountId,
      billPaymentIds: body.billPaymentIds,
      checkDate: body.checkDate,
      expectedFirstNumber: body.expectedFirstNumber ?? null,
      memo: body.memo ?? null,
      layout: s.layout,
      signaturesFor: (amt) => signaturesPrinted(amt, s),
    }, sod);
  } catch (e) {
    return checkErrorResponse(e, 'Could not print the checks.');
  }

  let pdf: Uint8Array;
  try {
    const s = setup;
    pdf = await renderCheckRun(run.checks.map((c) => renderCheck(c, s)), s);
  } catch (e) {
    console.error('[checks.print] render failed; spoiling the run', e);
    for (const c of run.checks) {
      await spoilCheck(supabase, orgId, userId, c.checkId, 'The PDF could not be generated — spoiled automatically, nothing was printed').catch(() => {});
    }
    return NextResponse.json({ error: `The checks could not be rendered, so numbers ${run.firstNumber}–${run.lastNumber} were spoiled. Nothing was printed; try again.` }, { status: 500 });
  }

  await logHumanAction(supabase, userId, orgId, {
    action: 'ap.checks.print',
    subjectTable: 'check_print_runs',
    subjectId: run.runId,
    summary: `Printed ${run.checks.length} check(s) ${run.firstNumber}–${run.lastNumber} for $${(run.totalCents / 100).toFixed(2)}`,
    metadata: { bankAccountId: body.bankAccountId, first: run.firstNumber, last: run.lastNumber, totalCents: run.totalCents, count: run.checks.length },
  }).catch(() => {});

  return pdfResponse(pdf, `checks-${run.firstNumber}-${run.lastNumber}.pdf`, {
    'X-Check-Run': run.runId,
    'X-Check-First': String(run.firstNumber),
    'X-Check-Last': String(run.lastNumber),
    'X-Check-Count': String(run.checks.length),
  });
});
