/**
 * Check stock settings per bank account (FPB §4.4): layout, printer nudge, payer / bank
 * blocks, MICR numbers (Vault), signatures (private storage), thresholds, positive-pay
 * format, and the check-number sequence. Plus `loadPrintSetup`, the ONLY place the full
 * MICR numbers and signature bytes are assembled — immediately before rendering.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CheckStockSetup, ImageBytes } from '@/lib/ap/check-print/check-doc';
import { clampOffset, type CheckLayout } from '@/lib/ap/check-print/layout';
import { BRANDING_BUCKET, isTenantLogoUrl } from '@/lib/invoices/templates/logo-url';
import { maskLast4, normalizeAccountNumber, validateMicrInputs } from './micr';
import { imageFormat, MAX_SIGNATURE_BYTES, signaturePath, type CheckSecretsStore } from './secrets';
import {
  CheckError,
  checkWriter,
  loadBankAccount,
  loadNextNumber,
  loadProfile,
  loadProfileSecrets,
  type CheckServiceOptions,
  type DB,
  type ProfileRow,
} from './db';
import type { PositivePayFormat } from './positive-pay';
import { loadOpenSecurityChanges, notifySecurityChange, recordSecurityChange, thresholdChanges, type SecurityChangeKind, type SecurityChangeRow } from './stock-security';

type Account = Awaited<ReturnType<typeof loadBankAccount>>;

const accountLabel = (ba: Account) => `${ba.account_name}${ba.account_mask ? ` ${ba.account_mask}` : ''}`;

/** Record security changes BEFORE applying them (M9); returns the rows to notify about after. */
async function recordChanges(
  writer: DB,
  orgId: string,
  ba: Account,
  actor: string,
  changes: ReadonlyArray<{ kind: SecurityChangeKind; summary: string }>,
  opts: CheckServiceOptions,
): Promise<SecurityChangeRow[]> {
  const rows: SecurityChangeRow[] = [];
  for (const c of changes) {
    rows.push(await recordSecurityChange(writer, { orgId, locationId: ba.location_id, bankAccountId: ba.id, kind: c.kind, summary: c.summary, actor }, opts.now ?? new Date()));
  }
  return rows;
}

async function notifyChanges(writer: DB, ba: Account, rows: ReadonlyArray<SecurityChangeRow>): Promise<void> {
  for (const r of rows) await notifySecurityChange(writer, r, accountLabel(ba));
}

export interface StockView {
  bankAccount: { id: string; name: string; institution: string; mask: string | null; locationId: string; type: string };
  profile: ProfileRow | null;
  nextNumber: number;
  hasMicr: boolean;
  hasSignature: boolean;
  hasSignature2: boolean;
  defaults: { payerName: string; logoUrl: string | null };
  /** Signature / bank-number / threshold changes still awaiting a second admin (M9). */
  securityChanges: SecurityChangeRow[];
}

export async function loadStockView(db: DB, orgId: string, bankAccountId: string, writer: DB): Promise<StockView> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const profile = await loadProfile(db, orgId, bankAccountId);
  const secrets = await loadProfileSecrets(writer, orgId, bankAccountId);
  const { data: loc } = await db.schema('core').from('locations').select('name').eq('org_id', orgId).eq('id', ba.location_id).maybeSingle();
  const { data: tpl } = await db
    .from('invoice_templates')
    .select('logo_url, is_default')
    .eq('org_id', orgId)
    .eq('location_id', ba.location_id)
    .eq('is_default', true)
    .limit(1);
  const tplLogo = ((tpl ?? []) as Array<{ logo_url: string | null }>)[0]?.logo_url ?? null;
  return {
    bankAccount: { id: ba.id, name: ba.account_name, institution: ba.institution_name, mask: ba.account_mask, locationId: ba.location_id, type: ba.account_type },
    profile,
    nextNumber: await loadNextNumber(db, orgId, bankAccountId),
    hasMicr: !!secrets?.micr_secret_ref,
    hasSignature: !!secrets?.signature_path,
    hasSignature2: !!secrets?.signature2_path,
    securityChanges: await loadOpenSecurityChanges(db, orgId, bankAccountId),
    defaults: {
      payerName: (loc as { name: string } | null)?.name ?? '',
      logoUrl: isTenantLogoUrl(tplLogo, orgId) ? tplLogo : null,
    },
  };
}

export interface StockSettingsInput {
  layout: CheckLayout;
  offsetXPt: number;
  offsetYPt: number;
  payerName: string | null;
  payerAddress: string | null;
  logoUrl: string | null;
  bankName: string | null;
  bankAddress: string | null;
  bankFraction: string | null;
  secondSignatureOverCents: number | null;
  maxCheckCents: number | null;
  voidAfterDays: number;
  staleAfterDays: number;
  oneCheckPerBill: boolean;
  auxOnUsDigits: number;
  positivePayFormat: PositivePayFormat;
  positivePayMapping: Record<string, unknown> | null;
}

/** Ensure the profile row exists (service writer), returning its id. */
async function ensureProfile(writer: DB, orgId: string, locationId: string, bankAccountId: string, actor: string): Promise<string> {
  const { data } = await writer.from('check_stock_profiles').select('id').eq('org_id', orgId).eq('bank_account_id', bankAccountId).maybeSingle();
  const id = (data as { id: string } | null)?.id;
  if (id) return id;
  const { data: ins, error } = await writer
    .from('check_stock_profiles')
    .insert({ org_id: orgId, location_id: locationId, bank_account_id: bankAccountId, updated_by: actor })
    .select('id')
    .single();
  if (error || !ins) {
    // A concurrent create won the unique index — read it back.
    const { data: again } = await writer.from('check_stock_profiles').select('id').eq('org_id', orgId).eq('bank_account_id', bankAccountId).maybeSingle();
    const againId = (again as { id: string } | null)?.id;
    if (againId) return againId;
    throw new CheckError(`Could not create the check stock settings: ${error?.message ?? 'unknown error'}`, 500);
  }
  return (ins as { id: string }).id;
}

/** bigint columns can come back as strings; compare as numbers. */
const centsOrNull = (v: number | string | null | undefined): number | null => (v == null ? null : Number(v));

const nz = (s: string | null | undefined) => {
  const t = (s ?? '').trim();
  return t.length ? t : null;
};

export async function saveStockSettings(
  db: DB,
  orgId: string,
  actor: string,
  bankAccountId: string,
  input: StockSettingsInput,
  opts: CheckServiceOptions = {},
): Promise<void> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  if (ba.account_type !== 'CHECKING') throw new CheckError('Checks can only be printed on a checking account.');
  if (input.logoUrl && !isTenantLogoUrl(input.logoUrl, orgId)) {
    throw new CheckError('Use a logo uploaded in Invoice design — links to images hosted elsewhere are not accepted.');
  }
  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const prev = await loadProfile(db, orgId, bankAccountId);
  const security = await recordChanges(writer, orgId, ba, actor, thresholdChanges(
    prev ? { secondSignatureOverCents: centsOrNull(prev.second_signature_over_cents), maxCheckCents: centsOrNull(prev.max_check_cents) } : null,
    { secondSignatureOverCents: input.secondSignatureOverCents, maxCheckCents: input.maxCheckCents },
  ), opts);
  await ensureProfile(writer, orgId, ba.location_id, bankAccountId, actor);
  const { error } = await writer
    .from('check_stock_profiles')
    .update({
      layout: input.layout,
      offset_x_pt: clampOffset(input.offsetXPt),
      offset_y_pt: clampOffset(input.offsetYPt),
      payer_name: nz(input.payerName),
      payer_address: nz(input.payerAddress),
      logo_url: nz(input.logoUrl),
      bank_name: nz(input.bankName),
      bank_address: nz(input.bankAddress),
      bank_fraction: nz(input.bankFraction),
      second_signature_over_cents: input.secondSignatureOverCents,
      max_check_cents: input.maxCheckCents,
      void_after_days: input.voidAfterDays,
      stale_after_days: input.staleAfterDays,
      one_check_per_bill: input.oneCheckPerBill,
      aux_on_us_digits: input.auxOnUsDigits,
      positive_pay_format: input.positivePayFormat,
      positive_pay_mapping: input.positivePayMapping,
      updated_by: actor,
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId);
  if (error) throw new CheckError(`Could not save the check stock settings: ${error.message}`, 400);
  await notifyChanges(writer, ba, security);
}

/** Store the full routing + account numbers in Vault; the row keeps last-4 masks only. */
export async function setMicrNumbers(
  db: DB,
  orgId: string,
  actor: string,
  bankAccountId: string,
  numbers: { routing: string; account: string },
  secrets: CheckSecretsStore,
  opts: CheckServiceOptions = {},
): Promise<{ routingMask: string; accountMask: string }> {
  const routing = numbers.routing.trim();
  const account = normalizeAccountNumber(numbers.account.trim());
  const problem = validateMicrInputs(routing, account);
  if (problem) throw new CheckError(problem);
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  if (ba.account_mask) {
    const last4 = ba.account_mask.replace(/\D/g, '').slice(-4);
    if (last4.length === 4 && !account.endsWith(last4)) {
      throw new CheckError(`That account number doesn't end in ${last4}, the last four digits the bank feed has for this account.`);
    }
  }
  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const security = await recordChanges(writer, orgId, ba, actor, [{
    kind: 'BANK_NUMBERS',
    summary: `Bank numbers on the check stock set to routing ${maskLast4(routing)}, account ${maskLast4(account)}`,
  }], opts);
  await ensureProfile(writer, orgId, ba.location_id, bankAccountId, actor);
  const existing = await loadProfileSecrets(writer, orgId, bankAccountId);
  const ref = await secrets.storeMicr({ routing, account }, `check-micr:${orgId}:${bankAccountId}`, existing?.micr_secret_ref ?? null);
  const routingMask = maskLast4(routing);
  const accountMask = maskLast4(account);
  const { error } = await writer
    .from('check_stock_profiles')
    .update({ micr_secret_ref: ref, routing_mask: routingMask, account_mask: accountMask, micr_set_at: new Date().toISOString(), micr_set_by: actor, updated_by: actor })
    .eq('org_id', orgId)
    .eq('bank_account_id', bankAccountId);
  if (error) throw new CheckError(`Could not save the bank numbers: ${error.message}`, 500);
  await notifyChanges(writer, ba, security);
  return { routingMask, accountMask };
}

/** Upload (or replace) signature 1 or 2. PNG / JPEG by bytes, ≤ 512 KB. */
export async function setSignature(
  db: DB,
  orgId: string,
  actor: string,
  bankAccountId: string,
  slot: 1 | 2,
  bytes: Uint8Array,
  secrets: CheckSecretsStore,
  opts: CheckServiceOptions = {},
): Promise<void> {
  if (bytes.length === 0) throw new CheckError('Choose a signature image.');
  if (bytes.length > MAX_SIGNATURE_BYTES) throw new CheckError('The signature image must be 512 KB or smaller.');
  const format = imageFormat(bytes);
  if (!format) throw new CheckError('The signature must be a PNG or JPEG image.');
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const security = await recordChanges(writer, orgId, ba, actor, [{ kind: 'SIGNATURE', summary: `Signature ${slot} image uploaded or replaced` }], opts);
  await ensureProfile(writer, orgId, ba.location_id, bankAccountId, actor);
  const existing = await loadProfileSecrets(writer, orgId, bankAccountId);
  const path = signaturePath(orgId, bankAccountId, slot, format);
  await secrets.putSignature(path, bytes, format === 'png' ? 'image/png' : 'image/jpeg');
  const at = new Date().toISOString();
  const patch = slot === 1
    ? { signature_path: path, signature_set_at: at, signature_set_by: actor, updated_by: actor }
    : { signature2_path: path, signature2_set_at: at, signature2_set_by: actor, updated_by: actor };
  const { error } = await writer.from('check_stock_profiles').update(patch).eq('org_id', orgId).eq('bank_account_id', bankAccountId);
  if (error) {
    await secrets.removeSignature(path).catch(() => {});
    throw new CheckError(`Could not save the signature: ${error.message}`, 500);
  }
  const old = slot === 1 ? existing?.signature_path : existing?.signature2_path;
  if (old && old !== path) await secrets.removeSignature(old).catch(() => {});
  await notifyChanges(writer, ba, security);
}

export async function removeSignature(
  db: DB,
  orgId: string,
  actor: string,
  bankAccountId: string,
  slot: 1 | 2,
  secrets: CheckSecretsStore,
  opts: CheckServiceOptions = {},
): Promise<void> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const existing = await loadProfileSecrets(writer, orgId, bankAccountId);
  const old = slot === 1 ? existing?.signature_path : existing?.signature2_path;
  if (!old) return; // nothing on file — nothing changes
  const security = await recordChanges(writer, orgId, ba, actor, [{ kind: 'SIGNATURE_REMOVED', summary: `Signature ${slot} image removed` }], opts);
  const patch = slot === 1
    ? { signature_path: null, signature_set_at: null, signature_set_by: null, updated_by: actor }
    : { signature2_path: null, signature2_set_at: null, signature2_set_by: null, updated_by: actor };
  const { error } = await writer.from('check_stock_profiles').update(patch).eq('org_id', orgId).eq('bank_account_id', bankAccountId);
  if (error) throw new CheckError(`Could not remove the signature: ${error.message}`, 500);
  await secrets.removeSignature(old).catch(() => {});
  await notifyChanges(writer, ba, security);
}

export async function setNextCheckNumber(
  db: DB,
  orgId: string,
  actor: string,
  bankAccountId: string,
  next: number,
  reason: string,
  opts: CheckServiceOptions = {},
): Promise<{ status: string; next_number: number; previous_next_number?: number }> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const writer = await checkWriter(db, orgId, ba.location_id, opts);
  const { data, error } = await writer.rpc('set_check_sequence', {
    p_org: orgId, p_bank_account: bankAccountId, p_next: next, p_actor: actor, p_reason: reason,
  });
  if (error) throw new CheckError(error.message, 400);
  return data as { status: string; next_number: number; previous_next_number?: number };
}

function brandingKey(url: string): string | null {
  const marker = `/storage/v1/object/public/${BRANDING_BUCKET}/`;
  const i = url.indexOf(marker);
  return i >= 0 ? decodeURIComponent(url.slice(i + marker.length)) : null;
}

async function loadLogo(admin: SupabaseClient, orgId: string, url: string | null): Promise<ImageBytes | null> {
  if (!url || !isTenantLogoUrl(url, orgId)) return null;
  const key = brandingKey(url);
  if (!key || !key.startsWith(`${orgId}/`)) return null;
  try {
    const { data } = await admin.storage.from(BRANDING_BUCKET).download(key);
    if (!data) return null;
    const bytes = new Uint8Array(await data.arrayBuffer());
    const format = imageFormat(bytes);
    return format ? { data: Buffer.from(bytes), format } : null;
  } catch {
    return null;
  }
}

/**
 * Everything the renderer needs, INCLUDING the full MICR numbers and signature images.
 * Call only inside a print / positive-pay request, after authorization. Fails closed when
 * the MICR numbers are missing.
 */
export async function loadPrintSetup(
  db: DB,
  writer: DB,
  orgId: string,
  bankAccountId: string,
  secrets: CheckSecretsStore,
  opts: { includeImages?: boolean; storage?: SupabaseClient | null } = {},
): Promise<CheckStockSetup & { profile: ProfileRow | null }> {
  const ba = await loadBankAccount(db, orgId, bankAccountId);
  const profile = await loadProfile(db, orgId, bankAccountId);
  const ptr = await loadProfileSecrets(writer, orgId, bankAccountId);
  if (!ptr?.micr_secret_ref) {
    throw new CheckError('Add this account’s routing and account numbers on the Check stock tab before printing.', 409);
  }
  const micr = await secrets.readMicr(ptr.micr_secret_ref);
  if (!micr) throw new CheckError('The bank numbers for this account could not be read. Re-enter them on the Check stock tab.', 409);
  const images = opts.includeImages !== false;
  const [signature, signature2, logo] = images
    ? await Promise.all([
        ptr.signature_path ? secrets.getSignature(ptr.signature_path) : Promise.resolve(null),
        ptr.signature2_path ? secrets.getSignature(ptr.signature2_path) : Promise.resolve(null),
        opts.storage ? loadLogo(opts.storage, orgId, profile?.logo_url ?? null) : Promise.resolve(null),
      ])
    : [null, null, null];
  const { data: loc } = await db.schema('core').from('locations').select('name').eq('org_id', orgId).eq('id', ba.location_id).maybeSingle();
  return {
    profile,
    layout: profile?.layout ?? 'VOUCHER_TOP',
    offsetXPt: Number(profile?.offset_x_pt ?? 0),
    offsetYPt: Number(profile?.offset_y_pt ?? 0),
    payerName: profile?.payer_name ?? (loc as { name: string } | null)?.name ?? ba.account_name,
    payerAddress: profile?.payer_address ?? null,
    logo,
    bankName: profile?.bank_name ?? ba.institution_name,
    bankAddress: profile?.bank_address ?? null,
    bankFraction: profile?.bank_fraction ?? null,
    routing: micr.routing,
    account: micr.account,
    auxDigits: profile?.aux_on_us_digits ?? 6,
    voidAfterDays: profile?.void_after_days ?? 90,
    signature,
    signature2,
    secondSignatureOverCents: profile?.second_signature_over_cents ?? null,
  };
}
