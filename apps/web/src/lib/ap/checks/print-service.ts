/**
 * Check printing: what's ready, print a run, spoil, mark issued / mailed (FPB §4.1, AC-5–7).
 *
 * "Ready" = a released CHECK-method bill payment (POSTED, drawn on this bank account's GL
 * cash account, authorised by a RELEASED pay-run approval, not recorded as a handwritten
 * check) that is not on a current check. One check per vendor unless the account prints
 * one check per bill. Numbers, inserts and the SoD re-check happen atomically in
 * public.issue_check_print_run (mig 182) — the app never picks a number itself.
 */

import { checkActionSod, type ActionSodCode } from '@/lib/rbac/sod';
import type { PrintableCheck, StubLine } from '@/lib/ap/check-print/check-doc';
import { paymentBlockKey, paymentBlockReasons } from '@/lib/services/vendor-compliance';
import { MAX_CHECK_CENTS } from './amount-words';
import { printSecurityHold } from './stock-security';
import {
  CheckError,
  checkWriter,
  loadBankAccount,
  loadCheck,
  loadNextNumber,
  loadProfile,
  todayIso,
  type CheckServiceOptions,
  type DB,
} from './db';

export interface PrintSod {
  soleApproverMode: boolean;
  soleApproverMaxCents: number | null;
}

/** SoD wording for printing (the printer releases the paper instrument). */
export const PRINT_SOD_MESSAGE: Partial<Record<ActionSodCode, string>> = {
  PREPARER_CANNOT_RELEASE: 'You prepared this payment, so someone else has to print its check.',
  APPROVER_CANNOT_RELEASE: 'You approved this payment, so someone else has to print its check.',
  APPROVER_OVER_RELEASE_LIMIT: 'You approved this payment and it is over the amount an approver may also release, so someone else has to print it.',
};

export interface ReadyPayment {
  billPaymentId: string;
  billId: string;
  billNumber: string | null;
  billDate: string | null;
  billTotalCents: number;
  amountCents: number;
  paymentDate: string;
  approvalId: string;
  preparedBy: string;
  approvedBy: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
}

export interface ReadyCheck {
  key: string;
  vendorId: string;
  payeeName: string;
  payeeAddress: string | null;
  hasAddress: boolean;
  amountCents: number;
  payments: ReadyPayment[];
  printable: boolean;
  blockedReason: string | null;
  /** Why it's blocked: separation of duties, the account limit, a vendor hold re-checked
   *  after release (compliance / bank change), or the printer's own security-change hold. */
  blockKind: 'sod' | 'limit' | 'vendor_hold' | 'security_hold' | null;
}

export interface ReadyToPrint {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string };
  nextNumber: number;
  checks: ReadyCheck[];
  totals: { count: number; amountCents: number; printableCount: number; printableCents: number };
  excluded: { handwritten: number; outsidePayRun: number; vendorHold: number };
  oneCheckPerBill: boolean;
  /** Set when THIS user changed the account's check security settings < 24 h ago (M9). */
  securityHold: { reason: string; holdUntil: string } | null;
}

interface PaymentRow { id: string; bill_id: string; amount_cents: number; payment_date: string; method: string | null; status: string; cash_account_id: string | null; location_id: string }
interface ApprovalRow { id: string; subject_id: string; prepared_by: string; approved_by: string | null; released_by: string | null; amount_cents: number | null; provider_correlation_id: string | null; updated_at: string | null; status: string }
interface BillRow { id: string; vendor_id: string; bill_number: string | null; bill_date: string | null; total_cents: number; location_id: string }
interface VendorRow { id: string; name: string; display_name: string | null; address_line1: string | null; address_line2: string | null; city: string | null; state: string | null; zip: string | null }

/** 'bill_payment:<id>' or 'bill_payment:<id>|check:1042' → { paymentId, handwritten }. */
export function parseCorrelation(c: string | null): { paymentId: string; handwritten: boolean } | null {
  if (!c) return null;
  const m = /^bill_payment:([0-9a-f-]{36})(\|.*)?$/i.exec(c);
  if (!m) return null;
  return { paymentId: m[1].toLowerCase(), handwritten: /\|check:/i.test(m[2] ?? '') };
}

export function vendorAddress(v: VendorRow | undefined): string | null {
  if (!v) return null;
  const cityLine = [v.city, [v.state, v.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  const lines = [v.address_line1, v.address_line2, cityLine].filter((x): x is string => !!x && x.trim().length > 0);
  return lines.length ? lines.join('\n') : null;
}

function chunk<T>(xs: readonly T[], n = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export async function loadReadyToPrint(
  db: DB,
  orgId: string,
  bankAccountId: string,
  actor: string,
  sod: PrintSod,
  now: Date = new Date(),
): Promise<ReadyToPrint> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const profile = await loadProfile(db, orgId, bankAccountId);
  const nextNumber = await loadNextNumber(db, orgId, bankAccountId);
  const base: ReadyToPrint = {
    bankAccount: { id: ba.id, name: ba.account_name, institution: ba.institution_name, mask: ba.account_mask, locationId: ba.location_id },
    nextNumber,
    checks: [],
    totals: { count: 0, amountCents: 0, printableCount: 0, printableCents: 0 },
    excluded: { handwritten: 0, outsidePayRun: 0, vendorHold: 0 },
    oneCheckPerBill: profile?.one_check_per_bill ?? false,
    securityHold: await printSecurityHold(db, orgId, bankAccountId, actor, now),
  };

  const { data: payData, error: payErr } = await db
    .from('bill_payments')
    .select('id, bill_id, amount_cents, payment_date, method, status, cash_account_id, location_id')
    .eq('org_id', orgId)
    .eq('cash_account_id', ba.account_id)
    .eq('status', 'POSTED');
  if (payErr) throw new CheckError(`Could not load released payments: ${payErr.message}`, 500);
  let payments = ((payData ?? []) as PaymentRow[]).filter((p) => (p.method ?? '').toUpperCase() === 'CHECK');
  if (payments.length === 0) return base;

  // Not already on a current check.
  const onCheck = new Set<string>();
  for (const ids of chunk(payments.map((p) => p.id))) {
    const { data } = await db.from('ap_check_payments').select('bill_payment_id').eq('org_id', orgId).eq('is_current', true).in('bill_payment_id', ids);
    for (const r of (data ?? []) as Array<{ bill_payment_id: string }>) onCheck.add(r.bill_payment_id);
  }
  payments = payments.filter((p) => !onCheck.has(p.id));
  if (payments.length === 0) return base;

  const billIds = Array.from(new Set(payments.map((p) => p.bill_id)));
  const approvalByPayment = new Map<string, ApprovalRow & { handwritten: boolean }>();
  const bills = new Map<string, BillRow>();
  for (const ids of chunk(billIds)) {
    const { data: aData, error: aErr } = await db
      .from('approvals')
      .select('id, subject_id, prepared_by, approved_by, released_by, amount_cents, provider_correlation_id, updated_at, status')
      .eq('org_id', orgId)
      .eq('kind', 'AP_DISBURSEMENT')
      .eq('subject_table', 'bills')
      .in('status', ['RELEASED', 'SETTLED'])
      .in('subject_id', ids);
    if (aErr) throw new CheckError(`Could not load approvals: ${aErr.message}`, 500);
    for (const a of (aData ?? []) as ApprovalRow[]) {
      const c = parseCorrelation(a.provider_correlation_id);
      if (c) approvalByPayment.set(c.paymentId, { ...a, handwritten: c.handwritten });
    }
    const { data: bData, error: bErr } = await db
      .from('bills')
      .select('id, vendor_id, bill_number, bill_date, total_cents, location_id')
      .eq('org_id', orgId)
      .in('id', ids);
    if (bErr) throw new CheckError(`Could not load bills: ${bErr.message}`, 500);
    for (const b of (bData ?? []) as BillRow[]) bills.set(b.id, b);
  }

  const vendorIds = Array.from(new Set(Array.from(bills.values()).map((b) => b.vendor_id)));
  const vendors = new Map<string, VendorRow>();
  for (const ids of chunk(vendorIds)) {
    const { data } = await db
      .schema('core')
      .from('vendors')
      .select('id, name, display_name, address_line1, address_line2, city, state, zip')
      .eq('org_id', orgId)
      .in('id', ids);
    for (const v of (data ?? []) as VendorRow[]) vendors.set(v.id, v);
  }

  // Security review M3: the vendor gate ran when the payment was RELEASED; a bank-detail
  // change or a compliance lapse since then must stop the paper check too. Read-only
  // re-check (no override consumed, fails closed), per vendor + bill + company.
  const holds = await paymentBlockReasons(
    db,
    orgId,
    payments.flatMap((p) => {
      const b = bills.get(p.bill_id);
      return b ? [{ vendorId: b.vendor_id, billId: p.bill_id, locationId: b.location_id }] : [];
    }),
    now,
  );

  const groups = new Map<string, ReadyCheck>();
  for (const p of payments.sort((a, b) => a.payment_date.localeCompare(b.payment_date))) {
    const appr = approvalByPayment.get(p.id.toLowerCase());
    if (!appr) { base.excluded.outsidePayRun += 1; continue; }
    if (appr.handwritten) { base.excluded.handwritten += 1; continue; }
    const bill = bills.get(p.bill_id);
    if (!bill) { base.excluded.outsidePayRun += 1; continue; }
    const v = vendors.get(bill.vendor_id);
    const hold = holds.get(paymentBlockKey(bill.vendor_id, p.bill_id)) ?? null;
    if (hold) base.excluded.vendorHold += 1;
    // A held payment never rides on a printable check: it gets its own (blocked) line.
    const key = `${base.oneCheckPerBill ? `bill:${p.id}` : `vendor:${bill.vendor_id}`}${hold ? ':held' : ''}`;
    let g = groups.get(key);
    if (!g) {
      const address = vendorAddress(v);
      g = {
        key,
        vendorId: bill.vendor_id,
        payeeName: (v?.display_name || v?.name || 'Unknown vendor').trim(),
        payeeAddress: address,
        hasAddress: !!address,
        amountCents: 0,
        payments: [],
        printable: !hold,
        blockedReason: hold,
        blockKind: hold ? 'vendor_hold' : null,
      };
      groups.set(key, g);
    }
    g.payments.push({
      billPaymentId: p.id,
      billId: p.bill_id,
      billNumber: bill.bill_number,
      billDate: bill.bill_date,
      billTotalCents: Number(bill.total_cents),
      amountCents: Number(p.amount_cents),
      paymentDate: p.payment_date,
      approvalId: appr.id,
      preparedBy: appr.prepared_by,
      approvedBy: appr.approved_by,
      releasedBy: appr.released_by,
      releasedAt: appr.updated_at,
    });
    g.amountCents += Number(p.amount_cents);
    const code = checkActionSod({
      actor,
      action: 'release',
      preparedBy: appr.prepared_by,
      approvedBy: appr.approved_by,
      soleApproverMode: sod.soleApproverMode,
      soleApproverMaxCents: sod.soleApproverMaxCents,
      amountCents: appr.amount_cents ?? Number(p.amount_cents),
    });
    if (code && g.printable) {
      g.printable = false;
      g.blockedReason = PRINT_SOD_MESSAGE[code] ?? 'Separation of duties: someone else has to print this check.';
      g.blockKind = 'sod';
    }
  }

  for (const g of groups.values()) {
    const max = profile?.max_check_cents ?? null;
    if (g.printable && (g.amountCents > MAX_CHECK_CENTS || (max != null && g.amountCents > max))) {
      g.printable = false;
      g.blockedReason = `This check is over the account's limit of $${((max ?? MAX_CHECK_CENTS) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}.`;
      g.blockKind = 'limit';
    }
    if (g.printable && base.securityHold) {
      g.printable = false;
      g.blockedReason = base.securityHold.reason;
      g.blockKind = 'security_hold';
    }
  }

  const checks = Array.from(groups.values()).sort((a, b) => a.payeeName.localeCompare(b.payeeName));
  base.checks = checks;
  base.totals = {
    count: checks.length,
    amountCents: checks.reduce((s, c) => s + c.amountCents, 0),
    printableCount: checks.filter((c) => c.printable).length,
    printableCents: checks.filter((c) => c.printable).reduce((s, c) => s + c.amountCents, 0),
  };
  return base;
}

export interface PrintInput {
  bankAccountId: string;
  billPaymentIds: string[];
  checkDate?: string;
  expectedFirstNumber?: number | null;
  memo?: string | null;
  replacesCheckId?: string | null;
  /** Signature images that will print for a check of this amount (from the stock setup). */
  signaturesFor?: (amountCents: number) => number;
  layout?: string | null;
}

export interface PrintResult {
  runId: string;
  firstNumber: number;
  lastNumber: number;
  totalCents: number;
  checks: Array<PrintableCheck & { checkId: string }>;
  locationId: string;
}

function defaultMemo(payments: ReadyPayment[]): string | null {
  const refs = payments.map((p) => p.billNumber).filter((x): x is string => !!x);
  if (refs.length === 0) return null;
  const s = `Inv ${refs.join(', ')}`;
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

export function stubLinesFor(payments: ReadyPayment[]): StubLine[] {
  return payments.map((p) => ({
    date: p.billDate,
    ref: p.billNumber,
    billAmountCents: p.billTotalCents,
    discountCents: 0,
    paidCents: p.amountCents,
  }));
}

/** Print the selected payments. Returns the numbered checks for the renderer. */
export async function printChecks(
  db: DB,
  orgId: string,
  actor: string,
  input: PrintInput,
  sod: PrintSod,
  opts: CheckServiceOptions = {},
): Promise<PrintResult> {
  const wanted = new Set(input.billPaymentIds.map((x) => x.toLowerCase()));
  if (wanted.size === 0) throw new CheckError('Choose at least one check to print.');
  const checkDate = input.checkDate ?? todayIso(opts.now);
  const ready = await loadReadyToPrint(db, orgId, input.bankAccountId, actor, sod, opts.now ?? new Date());

  const selected: ReadyCheck[] = [];
  const found = new Set<string>();
  for (const g of ready.checks) {
    const pays = g.payments.filter((p) => wanted.has(p.billPaymentId.toLowerCase()));
    if (pays.length === 0) continue;
    pays.forEach((p) => found.add(p.billPaymentId.toLowerCase()));
    if (!g.printable) throw new CheckError(g.blockedReason ?? 'Someone else has to print this check.', g.blockKind === 'sod' ? 403 : 409);
    selected.push({ ...g, payments: pays, amountCents: pays.reduce((s, p) => s + p.amountCents, 0) });
  }
  if (found.size !== wanted.size) {
    throw new CheckError('One of the selected payments is no longer ready to print (already printed or voided). Refresh and try again.', 409);
  }
  if (input.replacesCheckId && selected.length !== 1) {
    throw new CheckError('A reprint replaces one check at a time.');
  }

  const writer = await checkWriter(db, orgId, ready.bankAccount.locationId, opts);
  const pChecks = selected.map((g) => ({
    payee_vendor_id: g.vendorId,
    payee_name: g.payeeName,
    payee_address: g.payeeAddress,
    amount_cents: g.amountCents,
    memo: (input.memo ?? '').trim() || defaultMemo(g.payments),
    signatures_printed: input.signaturesFor ? input.signaturesFor(g.amountCents) : 0,
    replaces_check_id: input.replacesCheckId ?? null,
    payments: g.payments.map((p) => ({ bill_payment_id: p.billPaymentId })),
  }));

  const { data, error } = await writer.rpc('issue_check_print_run', {
    p_org: orgId,
    p_bank_account: input.bankAccountId,
    p_actor: actor,
    p_check_date: checkDate,
    p_checks: pChecks,
    p_expected_first: input.expectedFirstNumber ?? null,
    p_layout: input.layout ?? null,
  });
  if (error) {
    const msg = error.message ?? 'Could not print the checks.';
    if (msg.includes('STALE_SEQUENCE:')) throw new CheckError(msg.replace(/^.*STALE_SEQUENCE:\s*/, '').replace(/^./, (c) => c.toUpperCase()), 409);
    if (/duplicate key|uq_ap_check_payments_current/i.test(msg)) {
      throw new CheckError('One of these payments was just printed by someone else. Refresh and try again.', 409);
    }
    throw new CheckError(msg, /separation of duties/i.test(msg) ? 403 : 400);
  }
  const run = data as { run_id: string; first_number: number; last_number: number; total_cents: number; checks: Array<{ check_id: string; check_number: number; amount_cents: number }> };
  return {
    runId: run.run_id,
    firstNumber: Number(run.first_number),
    lastNumber: Number(run.last_number),
    totalCents: Number(run.total_cents),
    locationId: ready.bankAccount.locationId,
    checks: run.checks.map((c, i) => ({
      checkId: c.check_id,
      checkNumber: Number(c.check_number),
      checkDate,
      payeeName: selected[i].payeeName,
      payeeAddress: selected[i].payeeAddress,
      amountCents: Number(c.amount_cents),
      memo: pChecks[i].memo,
      stubLines: stubLinesFor(selected[i].payments),
    })),
  };
}

export const SPOIL_WINDOW_HOURS = 24;

/**
 * Pure spoil rule (security review M1). Spoiling returns the payments to "ready to print",
 * so it is only for a check that never left the printer: still PRINTED (not handed out /
 * mailed / cleared), spoiled by the person who printed it, within 24 h of printing.
 * Anything else must be VOIDED (reverses the payment, tells the bank via positive pay).
 */
export function spoilProblem(
  check: { check_number: number | string; status: string; printed_by: string; printed_at: string },
  actor: string,
  now: Date,
): string | null {
  const n = Number(check.check_number);
  if (check.status !== 'PRINTED') {
    return `Check ${n} is ${check.status.toLowerCase()}; only a printed check that was never handed out can be spoiled. Void it instead.`;
  }
  if (check.printed_by !== actor) {
    return `Only the person who printed check ${n} can spoil or reprint it. Void it instead.`;
  }
  if (now.getTime() - new Date(check.printed_at).getTime() > SPOIL_WINDOW_HOURS * 3600_000) {
    return `Check ${n} was printed more than ${SPOIL_WINDOW_HOURS} hours ago, so it may already be out of the office. Void it instead.`;
  }
  return null;
}

/**
 * Spoil a printed check that was never issued (jam, misprint, wrong stock): the number is
 * consumed, nothing posts, and its payments return to "ready". Idempotent. Only the
 * original printer, within 24 h of printing (spoilProblem; the DB guard re-checks).
 */
export async function spoilCheck(
  db: DB,
  orgId: string,
  actor: string,
  checkId: string,
  reason: string,
  opts: CheckServiceOptions = {},
): Promise<{ checkNumber: number; payments: number }> {
  const why = reason.trim();
  if (why.length < 3) throw new CheckError('Say why the check is spoiled.');
  const check = await loadCheck(db, orgId, checkId);
  const writer = await checkWriter(db, orgId, check.location_id, opts);
  if (check.status !== 'SPOILED') {
    const problem = spoilProblem(check, actor, opts.now ?? new Date());
    if (problem) throw new CheckError(problem, check.status === 'PRINTED' && check.printed_by !== actor ? 403 : 409);
    const { data, error } = await writer
      .from('ap_checks')
      .update({
        status: 'SPOILED',
        void_kind: 'SPOIL',
        voided_at: (opts.now ?? new Date()).toISOString(),
        voided_by: actor,
        void_reason: why.slice(0, 500),
        reversal_mode: 'NONE',
      })
      .eq('org_id', orgId)
      .eq('id', checkId)
      .eq('status', 'PRINTED')
      .select('id');
    if (error) {
      if (/void it instead/i.test(error.message)) throw new CheckError(error.message.replace(/\s*\(migration 182\)\.?$/, '.'), 409);
      throw new CheckError(`Could not spoil the check: ${error.message}`, 500);
    }
    if (((data ?? []) as unknown[]).length === 0) throw new CheckError('The check changed while you were spoiling it. Refresh and try again.', 409);
  }
  const { data: links, error: linkErr } = await writer
    .from('ap_check_payments')
    .update({ is_current: false })
    .eq('org_id', orgId)
    .eq('check_id', checkId)
    .eq('is_current', true)
    .select('id');
  if (linkErr) throw new CheckError(`The check is spoiled, but its payments could not be released for reprinting: ${linkErr.message}`, 500);
  return { checkNumber: Number(check.check_number), payments: ((links ?? []) as unknown[]).length };
}

/** Record that a printed check was handed out or mailed (manual — no provider). */
export async function markCheckSent(
  db: DB,
  orgId: string,
  actor: string,
  checkId: string,
  to: 'ISSUED' | 'MAILED',
  opts: CheckServiceOptions & { tracking?: string | null } = {},
): Promise<void> {
  const check = await loadCheck(db, orgId, checkId);
  const allowed = to === 'ISSUED' ? ['PRINTED'] : ['PRINTED', 'ISSUED'];
  if (!allowed.includes(check.status)) {
    throw new CheckError(`Check ${check.check_number} is ${check.status.toLowerCase()} and can't be marked ${to.toLowerCase()}.`, 409);
  }
  const writer = await checkWriter(db, orgId, check.location_id, opts);
  const at = (opts.now ?? new Date()).toISOString();
  const patch = to === 'ISSUED'
    ? { status: 'ISSUED', issued_at: at, issued_by: actor }
    : { status: 'MAILED', mailed_at: at, mailed_by: actor, mail_provider: 'manual', mail_tracking: opts.tracking?.trim().slice(0, 120) || null };
  const { data, error } = await writer.from('ap_checks').update(patch).eq('org_id', orgId).eq('id', checkId).in('status', allowed).select('id');
  if (error) throw new CheckError(`Could not update the check: ${error.message}`, 500);
  if (((data ?? []) as unknown[]).length === 0) throw new CheckError('The check changed. Refresh and try again.', 409);
}

/**
 * Print SoD for acting on an already-printed check (spoil / reprint): someone who may not
 * print these payments may not spoil or reprint the check either. Returns the message or null.
 */
export async function checkActionSodBlock(
  db: DB,
  orgId: string,
  actor: string,
  approvalIds: ReadonlyArray<string>,
  sod: PrintSod,
): Promise<string | null> {
  if (approvalIds.length === 0) return null;
  const { data, error } = await db.from('approvals').select('id, prepared_by, approved_by, amount_cents').eq('org_id', orgId).in('id', [...approvalIds]);
  if (error) throw new CheckError(`Could not load the payment approvals: ${error.message}`, 500);
  for (const a of (data ?? []) as Array<{ prepared_by: string; approved_by: string | null; amount_cents: number | null }>) {
    const code = checkActionSod({ actor, action: 'release', preparedBy: a.prepared_by, approvedBy: a.approved_by, soleApproverMode: sod.soleApproverMode, soleApproverMaxCents: sod.soleApproverMaxCents, amountCents: a.amount_cents });
    if (code) return PRINT_SOD_MESSAGE[code] ?? 'Someone else has to act on this check.';
  }
  return null;
}
