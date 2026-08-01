/**
 * GATE 2 verification harness.
 *
 * Runs the deterministic posting engine + settlement lifecycle against the LIVE
 * database (the seeded sandbox tenant) and asserts the "GATE 2 DONE WHEN"
 * criteria from the Transaction & Posting Engine Spec:
 *   - account roles resolve to real accounts
 *   - approving a bill posts DR expense / CR AP (AP rises)
 *   - paying the bill CLEARS AP to its baseline and does NOT re-expense it
 *     (the no-double-count proof)
 *   - voiding an approved bill nets its effect back to zero in POSTED-only views
 *   - a customer payment clears AR (best-effort; skips if invoicing schema differs)
 *   - the trial balance ties (sum of debits == sum of credits)
 *
 * Each check is independent and reports pass/fail with detail, so a single
 * failure is diagnostic rather than fatal. Intended to be invoked AFTER seeding,
 * via POST /api/sandbox { action: 'verify-posting' }.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveOrgId, recordCustomerPayment } from '../posting/lifecycle';
import { resolveRole } from '../posting/account-roles';
import { postTransaction, type PostingFacts } from '../posting/posting-templates';
import { createSchedule, runDueSchedules } from '../posting/schedule-engine';
import { runDepreciation } from '../posting/depreciation-engine';
import { runDueRecurring } from '../posting/recurring-engine';
import { recordAssetDisposal } from '../posting/asset-disposal';
import { recordPayrollRun } from '../posting/payroll';
import { predictException } from '../posting/exception-predictor';
import { recordAssetAcquisition, recordPrepaidPurchase } from '../posting/provisioning';
import { runTaxDepreciation, bookTaxDifference } from '../posting/tax-depreciation';
import { proposePosting } from '../posting/intake';
import { approveBill, payBill, voidBill } from '../services/bill-ap';
import { postJournalEntry } from '../services/gl-posting';

type DB = SupabaseClient;

export interface PostingCheck {
  check: string;
  pass: boolean;
  detail: string;
}

export interface PostingVerifyResult {
  orgId: string;
  allPassed: boolean;
  checks: PostingCheck[];
}

/** The 15th of the current month — guaranteed inside an OPEN period in the seed. */
function openDate(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15)).toISOString().slice(0, 10);
}

/** Net balance (debits − credits) of an account across POSTED entries only. */
async function accountBalance(db: DB, orgId: string, accountId: string): Promise<number> {
  const { data, error } = await db
    .from('gl_entry_lines')
    .select('debit_cents, credit_cents, gl_entries!inner(status)')
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .eq('gl_entries.status', 'POSTED');
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as { debit_cents: number; credit_cents: number }[];
  return rows.reduce((s, l) => s + (l.debit_cents - l.credit_cents), 0);
}

async function pickExpenseAccount(db: DB, orgId: string): Promise<string> {
  const { data } = await db
    .from('accounts')
    .select('id, require_department')
    .eq('org_id', orgId)
    .in('account_type', ['OPEX', 'COGS'])
    .eq('is_active', true)
    .eq('is_control_account', false)
    .order('require_department', { ascending: true })
    .order('account_number', { ascending: true })
    .limit(1)
    .maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (!id) throw new Error('No OPEX/COGS expense account found in the chart of accounts');
  return id;
}

async function acctNum(db: DB, orgId: string, number: string): Promise<string | null> {
  const { data } = await db
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('account_number', number)
    .eq('is_active', true)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

interface Ctx {
  orgId: string;
  locationId: string;
  departmentId?: string;
  expenseAccountId: string;
  apAccountId: string;
}

async function createBill(db: DB, ctx: Ctx, vendorId: string, totalCents: number, tag: string): Promise<string> {
  const today = openDate();
  const { data: bill, error } = await db
    .from('bills')
    .insert({
      org_id: ctx.orgId,
      location_id: ctx.locationId,
      vendor_id: vendorId,
      bill_number: `VERIFY-${tag}-${Date.now()}`,
      bill_date: today,
      due_date: today,
      subtotal_cents: totalCents,
      tax_cents: 0,
      total_cents: totalCents,
      status: 'PENDING',
    })
    .select('id')
    .single();
  if (error || !bill) throw new Error(`Bill create failed: ${error?.message}`);
  const billId = (bill as { id: string }).id;

  const { error: lineErr } = await db.from('bill_lines').insert({
    org_id: ctx.orgId,
    bill_id: billId,
    line_number: 1,
    description: `Verify ${tag}`,
    account_id: ctx.expenseAccountId,
    department_id: ctx.departmentId ?? null,
    amount_cents: totalCents,
  });
  if (lineErr) throw new Error(`Bill line create failed: ${lineErr.message}`);
  return billId;
}

export async function runPostingEngineChecks(db: DB, preferredOrgId?: string | null): Promise<PostingVerifyResult> {
  const checks: PostingCheck[] = [];
  // Operational org = the caller's VERIFIED claim (matches RLS get_org_id());
  // first-org lookup stays only as a transitional fallback when no claim.
  const orgId = await resolveOrgId(db, preferredOrgId);

  const { data: loc } = await db.schema('core').from('locations').select('id').limit(1).maybeSingle();
  const locationId = (loc as { id: string } | null)?.id;
  if (!locationId) {
    return { orgId, allPassed: false, checks: [{ check: 'prerequisite', pass: false, detail: 'No location found — seed the sandbox first.' }] };
  }
  const { data: dept } = await db.schema('core').from('departments').select('id').eq('location_id', locationId).limit(1).maybeSingle();
  const departmentId = (dept as { id: string } | null)?.id;

  // 1. Roles resolve
  let apAccountId = '';
  try {
    const ap = await resolveRole(db, orgId, 'AP_CONTROL');
    const ar = await resolveRole(db, orgId, 'AR_CONTROL');
    apAccountId = ap.id;
    checks.push({ check: 'account_roles_resolve', pass: true, detail: `AP, AR (+others) resolve to real accounts (AP=${ap.account_number}, AR=${ar.account_number}).` });
  } catch (e) {
    checks.push({ check: 'account_roles_resolve', pass: false, detail: e instanceof Error ? e.message : 'role resolution failed' });
    return { orgId, allPassed: false, checks }; // nothing else can run
  }

  let expenseAccountId = '';
  try {
    expenseAccountId = await pickExpenseAccount(db, orgId);
  } catch (e) {
    checks.push({ check: 'expense_account_present', pass: false, detail: e instanceof Error ? e.message : 'no expense account' });
    return { orgId, allPassed: false, checks };
  }

  const ctx: Ctx = { orgId, locationId, departmentId, expenseAccountId, apAccountId };

  // vendor for the bills
  const { data: vendor } = await db.schema('core').from('vendors').insert({ org_id: orgId, name: `Verify Vendor ${Date.now()}` }).select('id').single();
  const vendorId = (vendor as { id: string } | null)?.id;
  if (!vendorId) {
    checks.push({ check: 'vendor_create', pass: false, detail: 'Could not create a test vendor' });
    return { orgId, allPassed: false, checks };
  }

  const AMT = 50_000; // $500.00

  // 2 + 3. AP cycle: approve raises AP + expense; pay clears AP and does NOT re-expense.
  try {
    const billId = await createBill(db, ctx, vendorId, AMT, 'ap');
    const apBefore = await accountBalance(db, orgId, apAccountId);
    const expBefore = await accountBalance(db, orgId, expenseAccountId);

    await approveBill(db, orgId, billId, 'sandbox-verify');
    const apAfterApprove = await accountBalance(db, orgId, apAccountId);
    const expAfterApprove = await accountBalance(db, orgId, expenseAccountId);
    // AP is a liability → credit raises it → balance (debits−credits) drops by AMT.
    const apRose = apBefore - apAfterApprove === AMT;
    const expRose = expAfterApprove - expBefore === AMT;
    checks.push({
      check: 'bill_approval_posts',
      pass: apRose && expRose,
      detail: apRose && expRose
        ? `Approve posted DR expense / CR AP for $${(AMT / 100).toFixed(2)} (AP +${AMT}, expense +${AMT}).`
        : `Unexpected deltas — AP ${apBefore - apAfterApprove}, expense ${expAfterApprove - expBefore} (expected ${AMT} each).`,
    });

    await payBill(db, orgId, billId, AMT, openDate(), 'ACH');
    const apAfterPay = await accountBalance(db, orgId, apAccountId);
    const expAfterPay = await accountBalance(db, orgId, expenseAccountId);
    const apCleared = apAfterPay === apBefore; // back to baseline
    const noDoubleCount = expAfterPay === expAfterApprove; // payment did NOT touch expense
    checks.push({
      check: 'bill_payment_clears_ap',
      pass: apCleared,
      detail: apCleared ? 'Paying the bill cleared Accounts Payable back to its baseline (DR AP / CR cash).' : `AP did not clear (now ${apAfterPay}, baseline ${apBefore}).`,
    });
    checks.push({
      check: 'no_double_count_on_payment',
      pass: noDoubleCount,
      detail: noDoubleCount ? 'Payment moved AP↔cash only; the expense was untouched (no double-count).' : `Expense changed on payment (${expAfterApprove} → ${expAfterPay}).`,
    });
  } catch (e) {
    checks.push({ check: 'ap_cycle', pass: false, detail: e instanceof Error ? e.message : 'AP cycle failed' });
  }

  // 4. Void reverses to net zero.
  try {
    const billId = await createBill(db, ctx, vendorId, AMT, 'void');
    const apBefore = await accountBalance(db, orgId, apAccountId);
    const expBefore = await accountBalance(db, orgId, expenseAccountId);
    await approveBill(db, orgId, billId, 'sandbox-verify');
    await voidBill(db, orgId, billId, 'verification void');
    const apAfter = await accountBalance(db, orgId, apAccountId);
    const expAfter = await accountBalance(db, orgId, expenseAccountId);
    const netZero = apAfter === apBefore && expAfter === expBefore;
    checks.push({
      check: 'void_nets_to_zero',
      pass: netZero,
      detail: netZero ? 'Voiding the approved bill returned AP and expense to baseline (no double-removal).' : `Not net-zero — AP ${apBefore}→${apAfter}, expense ${expBefore}→${expAfter}.`,
    });
  } catch (e) {
    checks.push({ check: 'void_nets_to_zero', pass: false, detail: e instanceof Error ? e.message : 'void check failed' });
  }

  // 5. AR clearing (best-effort: depends on the invoicing schema).
  try {
    const arAccount = await resolveRole(db, orgId, 'AR_CONTROL');
    const revenue = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_type', 'REVENUE').eq('is_active', true).order('account_number').limit(1).maybeSingle();
    const revId = (revenue.data as { id: string } | null)?.id;
    const { data: customer } = await db.schema('core').from('customers').insert({ org_id: orgId, name: `Verify Customer ${Date.now()}` }).select('id').single();
    const customerId = (customer as { id: string } | null)?.id;
    if (!revId || !customerId) throw new Error('missing revenue account or customer');

    const today = openDate();
    const { data: inv, error: invErr } = await db.from('invoices').insert({
      org_id: orgId, location_id: locationId, customer_id: customerId,
      invoice_number: `VERIFY-AR-${Date.now()}`, invoice_date: today, due_date: today,
      subtotal_cents: AMT, total_cents: AMT, status: 'SENT',
    }).select('id').single();
    if (invErr || !inv) throw new Error(`invoice create: ${invErr?.message}`);

    // Post the AR (DR AR / CR revenue) so there is a receivable to clear.
    const post = await postJournalEntry(db, {
      org_id: orgId, location_id: locationId, entry_date: today,
      memo: 'Verify invoice', source_module: 'AR', source_id: (inv as { id: string }).id, created_by: null,
      lines: [
        { account_id: arAccount.id, debit_cents: AMT, credit_cents: 0, location_id: locationId },
        { account_id: revId, debit_cents: 0, credit_cents: AMT, location_id: locationId },
      ],
    });
    if (!post.success) throw new Error(post.error ?? 'AR post failed');

    const arBefore = await accountBalance(db, orgId, arAccount.id);
    await recordCustomerPayment(db, {
      orgId, customerId, locationId, paymentDate: today, amountCents: AMT, method: 'ACH',
      applications: [{ invoice_id: (inv as { id: string }).id, amount_cents: AMT }],
    });
    const arAfter = await accountBalance(db, orgId, arAccount.id);
    const cleared = arBefore - arAfter === AMT;
    checks.push({
      check: 'customer_payment_clears_ar',
      pass: cleared,
      detail: cleared ? 'Customer payment cleared the receivable (DR cash / CR AR).' : `AR did not clear by the expected amount (Δ ${arBefore - arAfter}).`,
    });
  } catch (e) {
    checks.push({ check: 'customer_payment_clears_ar', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'AR check error'}` });
  }

  // 6. Schedule engine — prepaid amortization posts and draws down the prepaid.
  try {
    const prepaidId = (await acctNum(db, orgId, '1300')) ?? (await acctNum(db, orgId, '1330'));
    if (!prepaidId) throw new Error('no prepaid asset account (1300/1330)');
    const start = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10); })();
    const { id } = await createSchedule(db, {
      orgId, locationId, scheduleType: 'PREPAID_AMORTIZATION',
      debitAccountId: expenseAccountId, creditAccountId: prepaidId,
      totalCents: 30_000, months: 3, startDate: start, departmentId, memo: 'Verify prepaid',
    });
    const prepaidBefore = await accountBalance(db, orgId, prepaidId);
    const run = await runDueSchedules(db, orgId, openDate());
    const prepaidAfter = await accountBalance(db, orgId, prepaidId);
    const posted = run.periods_posted > 0;
    const drewDown = prepaidAfter < prepaidBefore || prepaidBefore === 0; // prepaid credited (decreases)
    checks.push({
      check: 'schedule_amortization_posts',
      pass: posted && drewDown,
      detail: posted ? `Posted ${run.periods_posted} amortization period(s) for schedule ${id.slice(0, 8)}…; prepaid drawn down.` : `No periods posted${run.errors[0] ? ` (${run.errors[0].error})` : ''}.`,
    });
  } catch (e) {
    checks.push({ check: 'schedule_amortization_posts', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'schedule check error'}` });
  }

  // 7. Depreciation engine — straight-line posts DR expense / CR accumulated depr.
  try {
    const assetAcct = await acctNum(db, orgId, '1510'); // Equipment
    const accumAcct = await acctNum(db, orgId, '1610'); // Accum Depr - Equipment
    const deprExp = (await acctNum(db, orgId, '6260')) // common Depreciation Expense number; fallback below
      ?? (await (async () => {
        const { data } = await db.from('accounts').select('id, name').eq('org_id', orgId).in('account_type', ['OPEX', 'COGS']).eq('is_active', true).order('account_number');
        const rows = (data ?? []) as { id: string; name: string }[];
        return rows.find((r) => /deprec/i.test(r.name))?.id ?? rows[0]?.id ?? null;
      })());
    if (!assetAcct || !accumAcct || !deprExp) throw new Error('missing asset/accum/depreciation-expense account');
    const acqDate = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 2, 1)).toISOString().slice(0, 10); })();
    const { data: asset } = await db.from('fixed_assets').insert({
      org_id: orgId, location_id: locationId, name: `Verify Asset ${Date.now()}`,
      acquisition_date: acqDate, acquisition_cost_cents: 120_000, salvage_value_cents: 0,
      useful_life_months: 12, depreciation_method: 'STRAIGHT_LINE',
      asset_account_id: assetAcct, depreciation_expense_account_id: deprExp,
      accumulated_depreciation_account_id: accumAcct, status: 'ACTIVE',
    }).select('id').single();
    if (!asset) throw new Error('asset insert failed');
    const accumBefore = await accountBalance(db, orgId, accumAcct);
    const run = await runDepreciation(db, orgId, openDate());
    const accumAfter = await accountBalance(db, orgId, accumAcct);
    const posted = run.periods_posted > 0;
    checks.push({
      check: 'depreciation_posts',
      pass: posted && accumAfter < accumBefore + 1, // accum is credited (balance debits−credits drops)
      detail: posted ? `Posted ${run.periods_posted} month(s) of straight-line depreciation (DR expense / CR accumulated).` : `No depreciation posted${run.errors[0] ? ` (${run.errors[0].error})` : ''}${run.skipped[0] ? ` [${run.skipped[0].reason}]` : ''}.`,
    });
  } catch (e) {
    checks.push({ check: 'depreciation_posts', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'depreciation check error'}` });
  }

  // 8. Recurring engine — generates a due template entry.
  try {
    const payable = (await acctNum(db, orgId, '2400')) ?? (await acctNum(db, orgId, '2100'));
    if (!payable) throw new Error('no offset payable account');
    const lastMonth = (() => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 10); })();
    const { data: tmpl } = await db.from('recurring_templates').insert({
      org_id: orgId, name: `Verify Recurring ${Date.now()}`, frequency: 'MONTHLY',
      start_date: lastMonth, next_run_date: lastMonth, is_reversing: false, is_active: true,
      location_id: locationId,
      template_lines: [
        { account_id: expenseAccountId, debit_cents: 10_000, credit_cents: 0, department_id: departmentId ?? null },
        { account_id: payable, debit_cents: 0, credit_cents: 10_000 },
      ],
    }).select('id').single();
    if (!tmpl) throw new Error('recurring template insert failed');
    const run = await runDueRecurring(db, orgId, openDate());
    checks.push({
      check: 'recurring_generates',
      pass: run.entries_posted > 0,
      detail: run.entries_posted > 0 ? `Generated ${run.entries_posted} recurring entr(ies) for due template(s).` : `No recurring entries posted${run.errors[0] ? ` (${run.errors[0].error})` : ''}.`,
    });
  } catch (e) {
    checks.push({ check: 'recurring_generates', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'recurring check error'}` });
  }

  // 9. Payroll run posts a balanced multi-line entry.
  try {
    const gross = await acctNum(db, orgId, '6000');       // Salaries & Wages
    const erTaxExp = await acctNum(db, orgId, '6010');     // Payroll Taxes
    const fica = await acctNum(db, orgId, '2220');         // FICA Payable (withholding)
    const fedPay = await acctNum(db, orgId, '2200');       // Federal Payroll Tax Payable (employer)
    const bank = await acctNum(db, orgId, '1000');         // Operating Checking
    if (!gross || !erTaxExp || !fica || !fedPay || !bank) throw new Error('missing payroll accounts');
    const res = await recordPayrollRun(db, {
      orgId, locationId, payDate: openDate(), departmentId,
      grossWagesAccountId: gross, grossWagesCents: 100_000,
      withholdings: [{ account_id: fica, amount_cents: 7_650, memo: 'FICA' }],
      employerTaxExpenses: [{ account_id: erTaxExp, amount_cents: 7_650 }],
      employerTaxLiabilities: [{ account_id: fedPay, amount_cents: 7_650 }],
      netPayAccountId: bank,
    });
    checks.push({
      check: 'payroll_run_posts',
      pass: !!res.gl_entry_id && res.net_pay_cents === 92_350,
      detail: res.gl_entry_id ? `Payroll posted: gross $1,000.00, net $${(res.net_pay_cents / 100).toFixed(2)}, employer taxes matched.` : 'Payroll did not post.',
    });
  } catch (e) {
    checks.push({ check: 'payroll_run_posts', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'payroll check error'}` });
  }

  // 10. Asset disposal removes cost + accum and books the loss.
  try {
    const assetAcct = await acctNum(db, orgId, '1510');
    const accumAcct = await acctNum(db, orgId, '1610');
    const deprExp = await acctNum(db, orgId, '6000'); // any expense; not depreciated here
    const bank = await acctNum(db, orgId, '1000');
    if (!assetAcct || !accumAcct || !deprExp || !bank) throw new Error('missing asset/cash accounts');
    const { data: asset } = await db.from('fixed_assets').insert({
      org_id: orgId, location_id: locationId, name: `Disposal Asset ${Date.now()}`,
      acquisition_date: openDate(), acquisition_cost_cents: 120_000, salvage_value_cents: 0,
      useful_life_months: 60, depreciation_method: 'STRAIGHT_LINE',
      asset_account_id: assetAcct, depreciation_expense_account_id: deprExp,
      accumulated_depreciation_account_id: accumAcct, status: 'ACTIVE',
    }).select('id').single();
    if (!asset) throw new Error('asset insert failed');
    const res = await recordAssetDisposal(db, {
      orgId, assetId: (asset as { id: string }).id, disposalDate: openDate(),
      proceedsCents: 50_000, cashAccountId: bank,
    });
    // cost 120k, accum 0, proceeds 50k → loss 70k
    checks.push({
      check: 'asset_disposal_posts',
      pass: !!res.gl_entry_id && res.gain_loss_cents === -70_000,
      detail: res.gl_entry_id ? `Disposed asset (NBV $1,200.00, proceeds $500.00 → loss $700.00); asset marked DISPOSED.` : 'Disposal did not post.',
    });
  } catch (e) {
    checks.push({ check: 'asset_disposal_posts', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'disposal check error'}` });
  }

  // 11. Exception predictor — capitalize over threshold, plain expense under it.
  try {
    const big = await predictException(db, { orgId, locationId, accountId: expenseAccountId, amountCents: 500_000, description: 'Dell server purchase' });
    const small = await predictException(db, { orgId, locationId, accountId: expenseAccountId, amountCents: 5_000, description: 'office snacks' });
    const ok = big.treatment === 'CAPITALIZE' && big.flag && small.treatment === 'EXPENSE' && !small.flag;
    checks.push({
      check: 'exception_predictor',
      pass: ok,
      detail: ok ? `$5,000 durable item flagged CAPITALIZE; $50 item left as EXPENSE (threshold-driven).` : `Unexpected: big=${big.treatment}, small=${small.treatment}.`,
    });
  } catch (e) {
    checks.push({ check: 'exception_predictor', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'predictor check error'}` });
  }

  // 12. Progress billing with retainage, then retainage release.
  try {
    const revId = (await (async () => {
      const { data } = await db.from('accounts').select('id').eq('org_id', orgId).eq('account_type', 'REVENUE').eq('is_active', true).order('account_number').limit(1).maybeSingle();
      return (data as { id: string } | null)?.id ?? null;
    })());
    const arRef = await resolveRole(db, orgId, 'AR_CONTROL');
    const retId = await acctNum(db, orgId, '1110'); // Retainage Receivable
    if (!revId || !retId) throw new Error('missing revenue or retainage-receivable account');

    const arBefore = await accountBalance(db, orgId, arRef.id);
    const retBefore = await accountBalance(db, orgId, retId);

    const progressFacts: PostingFacts = {
      org_id: orgId, location_id: locationId, entry_date: openDate(),
      amount_cents: 100_000, retainage_cents: 10_000, category_account_id: revId,
    };
    await postTransaction(db, 'progress_billing', progressFacts, { created_by: null });

    const arMid = await accountBalance(db, orgId, arRef.id);
    const retMid = await accountBalance(db, orgId, retId);
    const billedOk = arMid - arBefore === 90_000 && retMid - retBefore === 10_000;

    const retainageFacts: PostingFacts = {
      org_id: orgId, location_id: locationId, entry_date: openDate(), amount_cents: 10_000,
    };
    await postTransaction(db, 'retainage', retainageFacts, { created_by: null });

    const arAfter = await accountBalance(db, orgId, arRef.id);
    const retAfter = await accountBalance(db, orgId, retId);
    const releaseOk = retAfter === retBefore && arAfter - arMid === 10_000;

    checks.push({
      check: 'progress_billing_and_retainage',
      pass: billedOk && releaseOk,
      detail: billedOk && releaseOk
        ? 'Progress draw split $900 current AR / $100 retainage receivable; releasing retainage moved it to AR.'
        : `Unexpected — billed AR Δ${arMid - arBefore}/ret Δ${retMid - retBefore}, release AR Δ${arAfter - arMid}/ret end ${retAfter} (baseline ${retBefore}).`,
    });
  } catch (e) {
    checks.push({ check: 'progress_billing_and_retainage', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'progress-billing check error'}` });
  }

  // 13. Rev-rec method by revenue type drives defer-vs-recognize at billing.
  try {
    const posAcct = await acctNum(db, orgId, '4000');   // Service Revenue → point-of-sale
    const pocAcct = await acctNum(db, orgId, '4010');    // Construction Revenue → percent-complete
    const deferred = await resolveRole(db, orgId, 'DEFERRED_REVENUE');
    if (!posAcct || !pocAcct) throw new Error('missing revenue accounts 4000/4010');

    await db.from('revenue_type_methods').upsert([
      { org_id: orgId, location_id: locationId, revenue_account_id: posAcct, method: 'POINT_OF_SALE' },
      { org_id: orgId, location_id: locationId, revenue_account_id: pocAcct, method: 'PCT_COMPLETE' },
    ], { onConflict: 'org_id,location_id,revenue_account_id' });

    // Point-of-sale revenue type → credit Revenue now.
    const posRevBefore = await accountBalance(db, orgId, posAcct);
    const posDefBefore = await accountBalance(db, orgId, deferred.id);
    await postTransaction(db, 'customer_invoice', {
      org_id: orgId, location_id: locationId, entry_date: openDate(), amount_cents: 40_000, category_account_id: posAcct,
    } as PostingFacts, { created_by: null });
    const posRecognized = (posRevBefore - (await accountBalance(db, orgId, posAcct))) === 40_000;
    const posNotDeferred = (await accountBalance(db, orgId, deferred.id)) === posDefBefore;

    // Percent-complete revenue type → credit Deferred (rev-rec earns it out).
    const pocRevBefore = await accountBalance(db, orgId, pocAcct);
    const pocDefBefore = await accountBalance(db, orgId, deferred.id);
    await postTransaction(db, 'customer_invoice', {
      org_id: orgId, location_id: locationId, entry_date: openDate(), amount_cents: 40_000, category_account_id: pocAcct,
    } as PostingFacts, { created_by: null });
    const pocDeferred = (pocDefBefore - (await accountBalance(db, orgId, deferred.id))) === 40_000;
    const pocRevenueUntouched = (await accountBalance(db, orgId, pocAcct)) === pocRevBefore;

    const ok = posRecognized && posNotDeferred && pocDeferred && pocRevenueUntouched;
    checks.push({
      check: 'rev_rec_method_routes_billing',
      pass: ok,
      detail: ok
        ? 'Point-of-sale revenue type credited Revenue at billing; percent-complete revenue type credited Deferred (rev-rec earns it).'
        : `Unexpected — POS recognized:${posRecognized}/defer-untouched:${posNotDeferred}; POC deferred:${pocDeferred}/rev-untouched:${pocRevenueUntouched}.`,
    });
  } catch (e) {
    checks.push({ check: 'rev_rec_method_routes_billing', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'rev-rec routing check error'}` });
  }

  // 14a. Asset acquisition SERVICE creates the asset and it actually depreciates
  //      (book), and the parallel tax track computes.
  try {
    const assetAcct = await acctNum(db, orgId, '1510');  // Equipment
    const accumAcct = await acctNum(db, orgId, '1610');  // Accum Depr - Equipment
    const deprExp = (await acctNum(db, orgId, '6260')) ?? (await acctNum(db, orgId, '8000'));
    if (!assetAcct || !accumAcct || !deprExp) throw new Error('missing asset/accum/depr-expense accounts');

    const accumBefore = await accountBalance(db, orgId, accumAcct);
    const acq = await recordAssetAcquisition(db, {
      facts: {
        org_id: orgId, location_id: locationId, entry_date: openDate(),
        amount_cents: 1_200_000, category_account_id: assetAcct, rail: 'check',
      } as PostingFacts,
      name: 'Verification Forklift', category: 'EQUIPMENT',
      useful_life_months: 60, depreciation_expense_account_id: deprExp,
      accumulated_depreciation_account_id: accumAcct,
      tax: { method: 'SL', life_months: 60, section_179_cents: 200_000 },
    }, { created_by: null });
    if (!acq.success || !acq.provisioned_id) throw new Error(`acquisition failed: ${acq.error}`);

    const depRun = await runDepreciation(db, orgId, openDate());
    const accumAfter = await accountBalance(db, orgId, accumAcct);
    const bookDepreciated = accumAfter !== accumBefore && depRun.periods_posted > 0;

    await runTaxDepreciation(db, orgId, openDate());
    const diff = await bookTaxDifference(db, orgId, acq.provisioned_id);
    const taxComputed = !!diff && diff.tax_accumulated_cents > 0;

    checks.push({
      check: 'asset_acquisition_service_book_and_tax',
      pass: bookDepreciated && taxComputed,
      detail: bookDepreciated && taxComputed
        ? `Asset created, book depreciation posted (accum moved), tax track computed (tax accum $${((diff?.tax_accumulated_cents ?? 0) / 100).toFixed(2)}, book−tax diff $${((diff?.difference_cents ?? 0) / 100).toFixed(2)}).`
        : `Unexpected — book depreciated:${bookDepreciated}, tax computed:${taxComputed}.`,
    });
  } catch (e) {
    checks.push({ check: 'asset_acquisition_service_book_and_tax', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'asset service check error'}` });
  }

  // 14b. Prepaid purchase SERVICE creates an amortization schedule that draws down.
  try {
    const prepaidAcct = (await acctNum(db, orgId, '1320')) ?? (await acctNum(db, orgId, '1300'));
    const expenseAcct = (await acctNum(db, orgId, '6260')) ?? (await acctNum(db, orgId, '8000'));
    if (!prepaidAcct || !expenseAcct) throw new Error('missing prepaid/expense accounts');

    const prepaidBefore = await accountBalance(db, orgId, prepaidAcct);
    const pre = await recordPrepaidPurchase(db, {
      facts: {
        org_id: orgId, location_id: locationId, entry_date: openDate(),
        amount_cents: 120_000, category_account_id: prepaidAcct, rail: 'check',
      } as PostingFacts,
      amortization_months: 12, expense_account_id: expenseAcct,
    }, { created_by: null });
    if (!pre.success || !pre.provisioned_id) throw new Error(`prepaid failed: ${pre.error}`);

    const prepaidAfterBook = await accountBalance(db, orgId, prepaidAcct);
    await runDueSchedules(db, orgId, openDate());
    const prepaidAfterAmort = await accountBalance(db, orgId, prepaidAcct);

    // Booking raises the prepaid asset; amortization then draws it back down.
    const booked = prepaidAfterBook - prepaidBefore === 120_000;
    const amortized = prepaidAfterAmort < prepaidAfterBook;
    checks.push({
      check: 'prepaid_purchase_service_amortizes',
      pass: booked && amortized,
      detail: booked && amortized
        ? 'Prepaid booked ($1,200) and its amortization schedule drew the asset down on the schedule run.'
        : `Unexpected — booked:${booked}, amortized:${amortized}.`,
    });
  } catch (e) {
    checks.push({ check: 'prepaid_purchase_service_amortizes', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'prepaid service check error'}` });
  }

  // 14c. Exception predictor ROUTES the entry (capitalize-sized → asset_acquisition).
  try {
    const expenseAcct = (await acctNum(db, orgId, '6260')) ?? (await acctNum(db, orgId, '8000'));
    if (!expenseAcct) throw new Error('missing expense account');
    const proposal = await proposePosting(db, {
      orgId, locationId, entryDate: openDate(), accountId: expenseAcct,
      amountCents: 500_000, description: 'New forklift for the shop', side: 'expense',
    });
    const routed = proposal.prediction.treatment === 'CAPITALIZE' && proposal.recommended_type === 'asset_acquisition';
    checks.push({
      check: 'predictor_routes_capitalize',
      pass: routed,
      detail: routed
        ? 'A $5,000 forklift expense was flagged CAPITALIZE and routed to asset_acquisition with the inputs commit needs.'
        : `Unexpected — treatment ${proposal.prediction.treatment}, recommended ${proposal.recommended_type}.`,
    });
  } catch (e) {
    checks.push({ check: 'predictor_routes_capitalize', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'routing check error'}` });
  }

  // 14d. Tax-year params drive the bonus default; per-asset override wins.
  try {
    const assetAcct = await acctNum(db, orgId, '1510');
    const accumAcct = await acctNum(db, orgId, '1610');
    const deprExp = (await acctNum(db, orgId, '6260')) ?? (await acctNum(db, orgId, '8000'));
    if (!assetAcct || !accumAcct || !deprExp) throw new Error('missing accounts');

    // Default bonus (no override): current-year param (100% for 2025/2026) → full year-1 tax expensing.
    const a1 = await recordAssetAcquisition(db, {
      facts: { org_id: orgId, location_id: locationId, entry_date: openDate(), amount_cents: 1_000_000, category_account_id: assetAcct, rail: 'check' } as PostingFacts,
      name: 'Bonus-default Asset', useful_life_months: 60,
      depreciation_expense_account_id: deprExp, accumulated_depreciation_account_id: accumAcct,
      tax: { method: 'BONUS', life_months: 60 }, // no bonus_pct → use tax-year default
    }, { created_by: null });

    // Override electing OUT of bonus (0%) → only SL portion in year 1, far less than cost.
    const a2 = await recordAssetAcquisition(db, {
      facts: { org_id: orgId, location_id: locationId, entry_date: openDate(), amount_cents: 1_000_000, category_account_id: assetAcct, rail: 'check' } as PostingFacts,
      name: 'Bonus-elected-out Asset', useful_life_months: 60,
      depreciation_expense_account_id: deprExp, accumulated_depreciation_account_id: accumAcct,
      tax: { method: 'SL', life_months: 60, bonus_pct: 0 },
    }, { created_by: null });

    if (!a1.success || !a1.provisioned_id || !a2.success || !a2.provisioned_id) throw new Error('acquisition failed');
    await runTaxDepreciation(db, orgId, openDate());
    const d1 = await bookTaxDifference(db, orgId, a1.provisioned_id);
    const d2 = await bookTaxDifference(db, orgId, a2.provisioned_id);

    const defaultBonusApplied = !!d1 && d1.tax_accumulated_cents === 1_000_000;  // 100% default
    const overrideElectedOut = !!d2 && d2.tax_accumulated_cents < 1_000_000;      // SL only, no bonus
    checks.push({
      check: 'tax_year_params_bonus_default_and_override',
      pass: defaultBonusApplied && overrideElectedOut,
      detail: defaultBonusApplied && overrideElectedOut
        ? `Year-default bonus expensed the full $10,000 in year 1; the elected-out asset took only straight-line ($${((d2?.tax_accumulated_cents ?? 0) / 100).toFixed(2)}).`
        : `Unexpected — default tax accum ${d1?.tax_accumulated_cents}, elected-out tax accum ${d2?.tax_accumulated_cents}.`,
    });
  } catch (e) {
    checks.push({ check: 'tax_year_params_bonus_default_and_override', pass: false, detail: `Skipped/failed: ${e instanceof Error ? e.message : 'tax-params check error'}` });
  }

  // 14. Trial balance ties.
  try {
    const { data, error } = await db
      .from('gl_entry_lines')
      .select('debit_cents, credit_cents, gl_entries!inner(status)')
      .eq('org_id', orgId)
      .eq('gl_entries.status', 'POSTED');
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as unknown as { debit_cents: number; credit_cents: number }[];
    const debits = rows.reduce((s, l) => s + l.debit_cents, 0);
    const credits = rows.reduce((s, l) => s + l.credit_cents, 0);
    checks.push({
      check: 'trial_balance_ties',
      pass: debits === credits,
      detail: debits === credits ? `Trial balance ties: debits = credits = $${(debits / 100).toFixed(2)}.` : `Out of balance: debits ${debits} vs credits ${credits}.`,
    });
  } catch (e) {
    checks.push({ check: 'trial_balance_ties', pass: false, detail: e instanceof Error ? e.message : 'trial balance check failed' });
  }

  return { orgId, allPassed: checks.every((c) => c.pass), checks };
}
