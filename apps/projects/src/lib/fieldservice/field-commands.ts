/**
 * Field-service phone commands (FS-26 parity with ServiceTitan's tech app) that complement the
 * Wave C phone contract (fs.decline in app/api/field/_lib/phone-contract.ts): the sale with its signing time, checklists
 * with readings, voice notes, nameplate equipment, will-call pickup, the customer's pay link and a
 * text from the visit. Same envelope rules: a client command id (the idempotency key — each 1123
 * RPC takes it and applies it at most once in the same transaction), the original device time,
 * one result per command. Served by POST /api/field/fs-commands. No cost or rate in any command
 * (fs.sell carries only the customer-facing deposit the customer agreed to).
 *
 * Pure apart from the injected RPC port (unit-tested with a fake port).
 */
import { z } from 'zod';
import { HttpError, PmQueryError, mapPgError } from '@/lib/api-errors';
import { structureNote, tagPhoto } from './notes';
import { decodeSerialYear } from './rules';

const Uuid = z.string().uuid();
const Envelope = { id: Uuid, at: z.string().datetime({ offset: true }) };
const Answer = z.union([z.string().max(2000), z.number(), z.boolean(), z.array(Uuid).max(20), z.null()]);

export const FsFormSubmitZ = z.object({
  ...Envelope, kind: z.literal('fs.form.submit'), workOrderId: Uuid, templateId: Uuid, answers: z.record(Answer),
  signedName: z.string().trim().max(120).nullish(), signaturePath: z.string().max(20_000).regex(/^[MLQCZmlqcz0-9.,\s-]*$/).nullish(),
  photoIds: z.array(Uuid).max(30).default([]), redTagReason: z.string().trim().max(500).nullish(),
});
export const FsNoteSaveZ = z.object({
  ...Envelope, kind: z.literal('fs.note.save'), workOrderId: Uuid, source: z.enum(['VOICE', 'TYPED']).default('TYPED'),
  transcript: z.string().trim().max(20_000).nullish(),
  /** What the tech edited after the rules sorted the transcript; omitted → the rules run on the server. */
  fields: z.object({ diagnosis: z.string().max(4000).nullish(), work_performed: z.string().max(4000).nullish(), recommendations: z.string().max(4000).nullish(),
                     customer_summary: z.string().max(4000).nullish() }).nullish(),
  photoIds: z.array(Uuid).max(30).default([]),
  photoCaptions: z.record(z.string().max(300)).default({}),
});
export const FsEquipmentZ = z.object({
  ...Envelope, kind: z.literal('fs.equipment.upsert'), workOrderId: Uuid, assetId: Uuid.nullish(),
  make: z.string().trim().max(80).nullish(), model: z.string().trim().max(80).nullish(), serial: z.string().trim().max(80).nullish(),
  equipmentType: z.string().regex(/^[A-Z_]{2,30}$/).nullish(), manufacturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  tonnage: z.number().min(0).max(500).nullish(), refrigerantType: z.string().trim().max(20).nullish(), fuelType: z.enum(['GAS', 'PROPANE', 'ELECTRIC', 'OIL', 'DUAL', 'OTHER']).nullish(),
  nameplatePhotoId: Uuid.nullish(),
});
export const FsWillCallZ = z.object({
  ...Envelope, kind: z.literal('fs.willcall.pickup'), commitmentId: Uuid, pickupCode: z.string().regex(/^\d{6}$/, 'The pickup code is 6 digits'),
  lines: z.array(z.object({ lineId: Uuid, qty: z.number().positive().max(1e6), serials: z.array(z.string().trim().min(1).max(80)).max(50).default([]),
                            make: z.string().trim().max(80).nullish(), model: z.string().trim().max(80).nullish() })).min(1).max(100),
});
export const FsPayLinkZ = z.object({ ...Envelope, kind: z.literal('fs.paylink.send'), reviewId: Uuid, channel: z.enum(['SMS', 'EMAIL']).default('SMS') });
export const FsMessageZ = z.object({
  ...Envelope, kind: z.literal('fs.message.send'), companyId: Uuid, customerId: Uuid, jobId: Uuid, workOrderId: Uuid,
  body: z.string().trim().min(1).max(640),
});

/** Same age rule as every field command (app/api/field/_lib/rules.ts MAX_COMMAND_AGE_DAYS / MAX_FUTURE_SKEW_MS). */
export const FS_MAX_AGE_DAYS = 35;
export const FS_MAX_SKEW_MS = 10 * 60_000;

/**
 * Kitchen-table sale (pm.fs_field_sell). `signedAt` is when the customer signed on the phone; the
 * server records it as signed_at / sold_at (bounded: ≤ 10 min ahead, ≤ 35 days old, not before the
 * estimate) and its own receipt time as received_at. The deposit is the customer-facing amount the
 * customer agreed to (cents); never a cost or a rate.
 */
export const FsSellCmdZ = z.object({
  ...Envelope, kind: z.literal('fs.sell'), estimateId: Uuid, optionIds: z.array(Uuid).min(1).max(5),
  toggles: z.array(z.object({ itemId: Uuid, selected: z.boolean() })).max(80).default([]),
  signedName: z.string().trim().min(1, 'The customer signs with their name').max(120),
  signedAt: z.string().datetime({ offset: true }),
  /** The photo command id that carried the drawn signature; resolved to its document on the server. */
  signaturePhotoId: Uuid.nullish(),
  financingPlanId: Uuid.nullish(), joinTemplateId: Uuid.nullish(),
  depositCents: z.number().int().min(0).max(1e11).default(0),
  depositMethod: z.enum(['none', 'link', 'check', 'cash']).default('none'),
  depositRef: z.string().trim().max(120).nullish(),
  dismissReason: z.string().trim().max(200).nullish(),
});

export const FS_COMMAND_SCHEMAS = {
  'fs.sell': FsSellCmdZ,
  'fs.form.submit': FsFormSubmitZ,
  'fs.note.save': FsNoteSaveZ,
  'fs.equipment.upsert': FsEquipmentZ,
  'fs.willcall.pickup': FsWillCallZ,
  'fs.paylink.send': FsPayLinkZ,
  'fs.message.send': FsMessageZ,
} as const;
export type FsCommandKind = keyof typeof FS_COMMAND_SCHEMAS;

export const FsBatchZ = z.object({ commands: z.array(z.unknown()).min(1).max(50) });

export interface FsCommandResult {
  id: string;
  kind: string;
  outcome: 'applied' | 'duplicate' | 'rejected' | 'retry';
  serverId?: string | null;
  code?: string;
  reason?: string;
  /** What the phone shows after it worked (out-of-range readings, the equipment's age …). */
  note?: string;
  data?: Record<string, unknown>;
}

/** The RPC the commands call (fsCall on the caller's RLS client in the route). */
export type FsRpc = <T>(fn: string, args: Record<string, unknown>) => Promise<T>;

function failure(id: string, kind: string, e: unknown): FsCommandResult {
  if (e instanceof HttpError) {
    return e.status >= 400 && e.status < 500 && e.status !== 429
      ? { id, kind, outcome: 'rejected', code: e.code, reason: e.message }
      : { id, kind, outcome: 'retry', code: e.code, reason: e.message };
  }
  if (e instanceof PmQueryError) {
    const m = mapPgError(e.pg);
    return m.status < 500 ? { id, kind, outcome: 'rejected', code: m.body.code, reason: m.body.error }
      : { id, kind, outcome: 'retry', code: m.body.code, reason: 'The server could not save this yet. It will be sent again.' };
  }
  return { id, kind, outcome: 'retry', code: 'NETWORK', reason: 'The server could not save this yet. It will be sent again.' };
}

type Done = Record<string, unknown> & { duplicate?: boolean };
const outcomeOf = (r: Done): 'applied' | 'duplicate' => (r.duplicate ? 'duplicate' : 'applied');

/** Apply one command at most once. Never throws: refusals are `rejected`, passing failures `retry`. */
export async function applyFsCommand(rpc: FsRpc, raw: unknown, now: Date = new Date()): Promise<FsCommandResult> {
  const head = z.object({ id: Uuid, kind: z.string().max(60) }).safeParse(raw);
  if (!head.success) return { id: (raw as { id?: string } | null)?.id ?? 'unknown', kind: 'unknown', outcome: 'rejected', code: 'INVALID', reason: 'The command is not valid.' };
  const { id, kind } = head.data;
  const schema = (FS_COMMAND_SCHEMAS as Record<string, z.ZodTypeAny>)[kind];
  if (!schema) return { id, kind, outcome: 'rejected', code: 'UNKNOWN_KIND', reason: 'This app version sent a command the server does not know. Update the app.' };
  const p = schema.safeParse(raw);
  if (!p.success) return { id, kind, outcome: 'rejected', code: 'INVALID', reason: p.error.issues[0]?.message ?? 'The command is not valid.' };
  const at = Date.parse((p.data as { at: string }).at);
  if (Number.isFinite(at) && at > now.getTime() + FS_MAX_SKEW_MS) return { id, kind, outcome: 'rejected', code: 'CLOCK', reason: 'The phone clock is ahead. Fix the date and time, then try again.' };
  if (Number.isFinite(at) && now.getTime() - at > FS_MAX_AGE_DAYS * 86_400_000) {
    return { id, kind, outcome: 'rejected', code: 'STALE', reason: `This was saved more than ${FS_MAX_AGE_DAYS} days ago. Ask the office to enter it for you.` };
  }
  try {
    switch (kind as FsCommandKind) {
      case 'fs.sell': {
        const c = p.data as z.infer<typeof FsSellCmdZ>;
        const signed = Date.parse(c.signedAt);
        if (signed > now.getTime() + FS_MAX_SKEW_MS) return { id, kind, outcome: 'rejected', code: 'CLOCK', reason: 'The phone clock is ahead. Fix the date and time, then try again.' };
        if (now.getTime() - signed > FS_MAX_AGE_DAYS * 86_400_000) {
          return { id, kind, outcome: 'rejected', code: 'STALE', reason: `This sale was signed more than ${FS_MAX_AGE_DAYS} days ago. Ask the office to enter it.` };
        }
        const ref = c.depositMethod === 'check' || c.depositMethod === 'cash'
          ? [c.depositMethod === 'check' ? 'Check' : 'Cash', c.depositRef].filter(Boolean).join(' ').slice(0, 120)
          : c.depositRef ?? null;
        const r = await rpc<Done & { estimate_id: string; lines?: number; agreement_id?: string | null; deposit_request_id?: string | null; member_pricing?: boolean;
                                     signed_at: string | null; received_at: string | null; signature?: 'ATTACHED' | 'PENDING' | null; already_sold?: boolean }>('fs_field_sell', {
          p_estimate: c.estimateId, p_command: c.id, p_option_ids: [...new Set(c.optionIds)], p_signed_name: c.signedName, p_signed_at: c.signedAt,
          p_toggles: c.toggles.map((t) => ({ item_id: t.itemId, selected: t.selected })), p_signature_photo: c.signaturePhotoId ?? null,
          p_financing_plan: c.financingPlanId ?? null, p_join_template: c.joinTemplateId ?? null,
          p_deposit_cents: c.depositMethod === 'none' ? 0 : c.depositCents, p_request_deposit: c.depositMethod === 'link' && c.depositCents > 0,
          p_deposit_ref: ref || null, p_dismiss_reason: c.dismissReason ?? null });
        const notes = [
          r.signature === 'PENDING' ? 'The drawn signature did not reach the office; the typed name is recorded.' : null,
          r.deposit_request_id ? 'The deposit request went to the office; the customer gets a pay link.' : null,
          r.agreement_id ? 'Membership started.' : null,
        ].filter(Boolean);
        return { id, kind, outcome: outcomeOf(r), serverId: r.estimate_id, note: notes.join(' ') || undefined,
                 data: { signedAt: r.signed_at, receivedAt: r.received_at, lines: r.lines ?? null, agreementId: r.agreement_id ?? null,
                         depositRequestId: r.deposit_request_id ?? null, memberPricing: r.member_pricing ?? null, signature: r.signature ?? null } };
      }
      case 'fs.form.submit': {
        const c = p.data as z.infer<typeof FsFormSubmitZ>;
        const r = await rpc<Done & { id: string; out_of_range: Array<{ label: string }>; red_tag: boolean }>('fs_submit_form', {
          p_wo: c.workOrderId, p_template: c.templateId, p_answers: c.answers, p_signed_name: c.signedName ?? null, p_signature_path: c.signaturePath ?? null,
          p_photos: c.photoIds, p_command: c.id, p_red_tag_reason: c.redTagReason ?? null });
        const oor = (r.out_of_range ?? []).map((x) => x.label);
        return { id, kind, outcome: outcomeOf(r), serverId: r.id, data: r,
                 note: r.red_tag ? 'Red tag recorded — the office is told.' : oor.length ? `Out of range: ${oor.join(', ')}` : undefined };
      }
      case 'fs.note.save': {
        const c = p.data as z.infer<typeof FsNoteSaveZ>;
        const fields = c.fields ?? (c.transcript ? structureNote(c.transcript) : null);
        const tags = Object.fromEntries(Object.entries(c.photoCaptions).map(([k, v]) => [k, tagPhoto(v)]).filter(([, t]) => (t as string[]).length));
        const r = await rpc<Done & { id: string }>('fs_save_visit_note', {
          p_wo: c.workOrderId, p_source: c.source, p_transcript: c.transcript ?? null,
          p_fields: fields ? { diagnosis: fields.diagnosis ?? null, work_performed: fields.work_performed ?? null, recommendations: fields.recommendations ?? null,
                               customer_summary: fields.customer_summary ?? null } : {},
          p_photos: c.photoIds, p_photo_tags: tags, p_command: c.id, p_structured_by: c.fields ? 'PERSON' : 'RULES' });
        return { id, kind, outcome: outcomeOf(r), serverId: r.id };
      }
      case 'fs.equipment.upsert': {
        const c = p.data as z.infer<typeof FsEquipmentZ>;
        const year = c.manufacturedOn ? null : decodeSerialYear(c.make, c.serial, now);
        const r = await rpc<Done & { asset_id: string; age_years: number | null; parts_covered: boolean | null; labor_covered: boolean | null; nameplate: 'ATTACHED' | 'PENDING' | null }>('fs_upsert_equipment', {
          p_wo: c.workOrderId, p_asset: c.assetId ?? null,
          p_fields: { make: c.make ?? null, model: c.model ?? null, serial: c.serial ?? null, equipment_type: c.equipmentType ?? null,
                      manufactured_on: c.manufacturedOn ?? (year ? `${year}-01-01` : null), tonnage: c.tonnage ?? null, refrigerant_type: c.refrigerantType ?? null,
                      fuel_type: c.fuelType ?? null },
          p_nameplate_document: null, p_command: c.id, p_nameplate_photo: c.nameplatePhotoId ?? null });
        const age = r.age_years != null ? `${r.age_years} years old` : null;
        const cover = r.parts_covered ? 'parts under warranty' : r.parts_covered === false ? 'parts warranty expired' : null;
        const plate = r.nameplate === 'PENDING' ? 'nameplate photo not received yet — send the photo, then save the equipment again' : null;
        return { id, kind, outcome: outcomeOf(r), serverId: r.asset_id, data: r, note: [age, cover, plate].filter(Boolean).join(' · ') || undefined };
      }
      case 'fs.willcall.pickup': {
        const c = p.data as z.infer<typeof FsWillCallZ>;
        const r = await rpc<Done & { serials: number }>('fs_receive_po', {
          p_commitment: c.commitmentId, p_pickup_code: c.pickupCode, p_received_on: null, p_command: c.id,
          p_lines: c.lines.map((l) => ({ line_id: l.lineId, qty: l.qty, serials: l.serials, make: l.make ?? null, model: l.model ?? null })) });
        return { id, kind, outcome: outcomeOf(r), serverId: c.commitmentId, note: r.serials ? `${r.serials} serial number(s) on your truck` : undefined };
      }
      case 'fs.paylink.send': {
        const c = p.data as z.infer<typeof FsPayLinkZ>;
        const r = await rpc<Done & { status: string; reason: string | null; message_id: string }>('fs_text_to_pay', {
          p_review: c.reviewId, p_billing_request: null, p_channel: c.channel, p_contact: null, p_command: c.id });
        return { id, kind, outcome: outcomeOf(r), serverId: r.message_id ?? null, note: r.status === 'QUEUED' ? 'Pay link sent' : r.reason ?? `Pay link ${String(r.status).toLowerCase()}` };
      }
      case 'fs.message.send': {
        const c = p.data as z.infer<typeof FsMessageZ>;
        const r = await rpc<Done & { status: string; reason: string | null; message_id: string }>('fs_send_message', {
          p_location: c.companyId, p_customer: c.customerId, p_job: c.jobId, p_channel: 'SMS', p_body: c.body, p_contact: null, p_template: null,
          p_work_order: c.workOrderId, p_vals: null, p_command: c.id });
        return { id, kind, outcome: outcomeOf(r), serverId: r.message_id ?? null, note: r.status === 'QUEUED' ? undefined : r.reason ?? undefined };
      }
    }
  } catch (e) {
    return failure(id, kind, e);
  }
  return { id, kind, outcome: 'rejected', code: 'UNKNOWN_KIND', reason: 'Unknown command.' };
}
