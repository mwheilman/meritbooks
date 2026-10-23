/**
 * Generate a positive-pay issue file for one bank account (FPB §4.3, AC-11).
 *
 * The file carries the FULL account number, so: the caller has already authorized the
 * download, the reveal is written to core.field_reveals BEFORE the file is returned (no
 * unlogged reveal), and the file is never stored — only its SHA-256 and counts.
 */

import { createHash } from 'node:crypto';
import {
  CheckError,
  checkWriter,
  loadBankAccount,
  loadProfile,
  loadProfileSecrets,
  type CheckRow,
  type CheckServiceOptions,
  type DB,
} from './db';
import {
  buildPositivePayFile,
  selectForPositivePay,
  toRecords,
  type CsvMapping,
  type FixedMapping,
  type PositivePayFormat,
  type RegisterCheckForPp,
} from './positive-pay';
import type { CheckSecretsStore } from './secrets';

export interface PositivePayRequest {
  bankAccountId: string;
  mode: 'SINCE_LAST' | 'RANGE';
  from?: string | null;
  through?: string | null;
  /** Preview only: counts, no file, no reveal, no stamping. */
  preview?: boolean;
}

export interface PositivePayPreview {
  format: PositivePayFormat;
  issueCount: number;
  voidCount: number;
  issueTotalCents: number;
  voidTotalCents: number;
}

export interface PositivePayOutput extends PositivePayPreview {
  exportId: string;
  fileName: string;
  content: string;
  mime: string;
}

export type RevealLogger = (e: { orgId: string; clerkUserId: string; subjectIds: string[]; reason: string }) => Promise<boolean>;

function toPp(c: CheckRow): RegisterCheckForPp {
  return {
    id: c.id,
    checkNumber: Number(c.check_number),
    checkDate: c.check_date,
    amountCents: Number(c.amount_cents),
    payeeName: c.payee_name,
    status: c.status,
    voidedAt: c.voided_at,
    issueExportId: c.positive_pay_issue_export_id,
    voidExportId: c.positive_pay_void_export_id,
  };
}

function mappingFor(format: PositivePayFormat, raw: Record<string, unknown> | null): { csv?: CsvMapping; fixed?: FixedMapping } | null {
  if (!raw) return null;
  if (format === 'CUSTOM_CSV') return { csv: raw as unknown as CsvMapping };
  if (format === 'CUSTOM_FIXED') return { fixed: raw as unknown as FixedMapping };
  return null;
}

export async function generatePositivePay(
  db: DB,
  orgId: string,
  actor: string,
  req: PositivePayRequest,
  secrets: CheckSecretsStore,
  logReveal: RevealLogger,
  opts: CheckServiceOptions = {},
): Promise<PositivePayOutput | PositivePayPreview> {
  if (req.mode === 'RANGE' && (!req.from || !req.through || req.from > req.through)) {
    throw new CheckError('Choose a from and through date.');
  }
  const ba = await loadBankAccount(db, orgId, req.bankAccountId);
  const profile = await loadProfile(db, orgId, req.bankAccountId);
  const format: PositivePayFormat = profile?.positive_pay_format ?? 'GENERIC_CSV';

  const { data, error } = await db.from('ap_checks').select('*').eq('org_id', orgId).eq('bank_account_id', req.bankAccountId);
  if (error) throw new CheckError(`Could not load the register: ${error.message}`, 500);
  const sel = selectForPositivePay(((data ?? []) as CheckRow[]).map(toPp), req.mode,
    req.mode === 'RANGE' ? { from: req.from as string, through: req.through as string } : undefined);
  const preview: PositivePayPreview = {
    format,
    issueCount: sel.issues.length,
    voidCount: sel.voids.length,
    issueTotalCents: sel.issues.reduce((s, c) => s + c.amountCents, 0),
    voidTotalCents: sel.voids.reduce((s, c) => s + c.amountCents, 0),
  };
  if (req.preview) return preview;
  if (sel.issues.length + sel.voids.length === 0) throw new CheckError('There are no new checks or voids to send to the bank.', 409);

  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const ptr = await loadProfileSecrets(writer, orgId, req.bankAccountId);
  if (!ptr?.micr_secret_ref) throw new CheckError('Add this account’s routing and account numbers on the Check stock tab first.', 409);
  const micr = await secrets.readMicr(ptr.micr_secret_ref);
  if (!micr) throw new CheckError('The bank numbers for this account could not be read. Re-enter them on the Check stock tab.', 409);

  // Build first (a bad custom mapping fails before anything is logged or stamped).
  const file = buildPositivePayFile(toRecords(sel, micr.account, micr.routing), format, mappingFor(format, profile?.positive_pay_mapping ?? null));

  const ok = await logReveal({ orgId, clerkUserId: actor, subjectIds: [req.bankAccountId], reason: `Positive-pay file (${sel.issues.length} issue, ${sel.voids.length} void)` });
  if (!ok) throw new CheckError('Could not record access to the account number; no file was generated.', 500);

  const stamp = (opts.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `positive-pay-${(ba.account_mask ?? '').replace(/\D/g, '').slice(-4) || 'acct'}-${stamp}.${file.extension}`;
  const { data: exp, error: expErr } = await writer
    .from('positive_pay_exports')
    .insert({
      org_id: orgId,
      location_id: ba.location_id,
      bank_account_id: req.bankAccountId,
      format,
      mode: req.mode,
      from_date: req.mode === 'RANGE' ? req.from : null,
      through_date: req.mode === 'RANGE' ? req.through : null,
      issue_count: preview.issueCount,
      void_count: preview.voidCount,
      issue_total_cents: preview.issueTotalCents,
      void_total_cents: preview.voidTotalCents,
      file_name: fileName,
      file_sha256: createHash('sha256').update(file.content).digest('hex'),
      generated_by: actor,
    })
    .select('id')
    .single();
  if (expErr || !exp) throw new CheckError(`Could not record the file: ${expErr?.message ?? 'unknown error'}`, 500);
  const exportId = (exp as { id: string }).id;

  const issueIds = sel.issues.filter((c) => !c.issueExportId).map((c) => c.id);
  const voidIds = sel.voids.filter((c) => !c.voidExportId).map((c) => c.id);
  if (issueIds.length) {
    await writer.from('ap_checks').update({ positive_pay_issue_export_id: exportId }).eq('org_id', orgId).in('id', issueIds).is('positive_pay_issue_export_id', null);
  }
  if (voidIds.length) {
    await writer.from('ap_checks').update({ positive_pay_void_export_id: exportId }).eq('org_id', orgId).in('id', voidIds).is('positive_pay_void_export_id', null);
  }
  return { ...preview, exportId, fileName, content: file.content, mime: file.mime };
}

export async function listPositivePayExports(db: DB, orgId: string, bankAccountId: string) {
  const { data, error } = await db
    .from('positive_pay_exports')
    .select('id, format, mode, from_date, through_date, issue_count, void_count, issue_total_cents, void_total_cents, file_name, generated_by, created_at')
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new CheckError(`Could not load positive-pay history: ${error.message}`, 500);
  return (data ?? []) as Array<{
    id: string; format: string; mode: string; from_date: string | null; through_date: string | null;
    issue_count: number; void_count: number; issue_total_cents: number; void_total_cents: number;
    file_name: string; generated_by: string; created_at: string;
  }>;
}
