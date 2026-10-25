/**
 * Field contract v2 — the phone commands added for Wave C (apps/workforce/mobile/src/core/contract.ts
 * mirrors these shapes). Same envelope and the same rules as contract.ts: a client command id
 * (the idempotency key), the ORIGINAL device time, one CommandResult per command, applied at most
 * once. They travel in the same POST /api/field/sync batch as the v1 commands.
 *
 *   approval.decide    approve / send back an approval-engine request (pm.approval_act, channel 'phone')
 *   notification.mark  read / done on my own inbox rows (core.notifications)
 *   kiosk.event        a shop-floor station tap (pm.mfg_kiosk_events; deduped there on client_event_id)
 *   ro.clock           dealer tech clock on / off / indirect on a repair-order line (pm.dlr_clock_*)
 *   ro.story           complaint / cause / correction for a repair order line (saved as a field log)
 *   esign.sign         a customer signs on the tech's phone (esign.sign with the one-time token)
 *   fs.sell            kitchen-table close: options, add-ons, financing, membership, signature, deposit
 *   fs.decline         the customer said no (with the reason)
 *
 * Money: fs.sell carries the DEPOSIT the customer agreed to pay (a customer-facing amount, never a
 * cost or a rate). No other v2 command carries money. Pure: Zod only.
 */
import { z } from 'zod';
import { EnvelopeShape, Uuid } from './contract';

const Text = (max: number) => z.string().trim().max(max);

export const KIOSK_ACTIONS = ['START', 'STOP', 'PAUSE', 'COMPLETE', 'INDIRECT_START', 'INDIRECT_STOP', 'REMAKE'] as const;
export const RO_INDIRECT = ['SHOP', 'WAITING_PARTS', 'TRAINING', 'CLEANUP', 'IDLE'] as const;
export const DEPOSIT_METHODS = ['none', 'link', 'check', 'cash'] as const;

export const ApprovalDecideZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('approval.decide'),
  requestId: Uuid,
  decision: z.enum(['approve', 'reject']),
  reason: Text(2000).nullish(),
  /** A solo / two-person company approving its own item types why (exception report). */
  selfReason: Text(2000).nullish(),
  /** The round and step the phone saw: a re-send after the step moved on is recognised, not re-applied. */
  round: z.number().int().min(1).max(1000),
  step: z.number().int().min(1).max(50),
}).superRefine((c, ctx) => {
  if (c.decision === 'reject' && !c.reason) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Say why you are sending it back.' });
});

export const NotificationMarkZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('notification.mark'),
  ids: z.array(Uuid).min(1).max(200),
  state: z.enum(['read', 'done']),
});

export const KioskEventZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('kiosk.event'),
  companyId: Uuid,
  /** From the badge + PIN sign-in at the station (online); the event replays with it offline. */
  sessionToken: z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/),
  action: z.enum(KIOSK_ACTIONS),
  operationId: Uuid.nullish(),
  goodQty: z.number().min(0).max(1e7).nullish(),
  scrapQty: z.number().min(0).max(1e7).nullish(),
  qty: z.number().min(0).max(1e7).nullish(),
  reason: Text(300).nullish(),
  indirectCode: Text(30).nullish(),
  partLabel: Text(60).nullish(),
  remakeReason: Text(30).nullish(),
});

export const RoClockZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('ro.clock'),
  op: z.enum(['clock_on', 'clock_off', 'indirect']),
  companyId: Uuid,
  lineId: Uuid.nullish(),
  indirectKind: z.enum(RO_INDIRECT).nullish(),
}).superRefine((c, ctx) => {
  if (c.op === 'clock_on' && !c.lineId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lineId'], message: 'Pick the repair-order line to clock on to.' });
  if (c.op === 'indirect' && !c.indirectKind) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['indirectKind'], message: 'Pick what the time is for.' });
});

export const RoStoryZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('ro.story'),
  workOrderId: Uuid,
  lineId: Uuid.nullish(),
  complaint: Text(2000).nullish(),
  cause: Text(2000).nullish(),
  correction: Text(2000).nullish(),
}).superRefine((c, ctx) => {
  if (!c.complaint && !c.cause && !c.correction) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['complaint'], message: 'Say the complaint, the cause or the correction.' });
});

export const EsignSignZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('esign.sign'),
  /** The one-time signing token issued for this in-person signer (POST /api/field/sign). */
  token: z.string().min(20).max(200).regex(/^[A-Za-z0-9_-]+$/),
  typedName: z.string().trim().min(2, 'Type your full name.').max(120),
  signaturePng: z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Draw the signature in the box.'),
  consent: z.literal(true),
});

export const FsSellZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('fs.sell'),
  estimateId: Uuid,
  optionIds: z.array(Uuid).min(1).max(5),
  /** Add-ons ticked or unticked at the table (applied before the sale). */
  toggles: z.array(z.object({ itemId: Uuid, selected: z.boolean() })).max(80).default([]),
  signedName: z.string().trim().min(1, 'The customer signs with their name').max(120),
  /** The photo command that carried the drawn signature (PNG); resolved to its document on the server. */
  signaturePhotoId: Uuid.nullish(),
  financingPlanId: Uuid.nullish(),
  joinTemplateId: Uuid.nullish(),
  depositCents: z.number().int().min(0).max(1e11).default(0),
  depositMethod: z.enum(DEPOSIT_METHODS).default('none'),
  depositRef: Text(120).nullish(),
  dismissReason: Text(200).nullish(),
});

export const FsDeclineZ = z.object({
  ...EnvelopeShape,
  kind: z.literal('fs.decline'),
  estimateId: Uuid,
  reason: z.string().trim().min(1, 'Say why the customer declined').max(300),
});

export const PHONE_SCHEMAS = {
  'approval.decide': ApprovalDecideZ,
  'notification.mark': NotificationMarkZ,
  'kiosk.event': KioskEventZ,
  'ro.clock': RoClockZ,
  'ro.story': RoStoryZ,
  'esign.sign': EsignSignZ,
  'fs.sell': FsSellZ,
  'fs.decline': FsDeclineZ,
} as const;
export type PhoneKind = keyof typeof PHONE_SCHEMAS;

export function isPhoneKind(k: unknown): k is PhoneKind {
  return typeof k === 'string' && Object.prototype.hasOwnProperty.call(PHONE_SCHEMAS, k);
}

export type ApprovalDecideCommand = z.infer<typeof ApprovalDecideZ>;
export type NotificationMarkCommand = z.infer<typeof NotificationMarkZ>;
export type KioskEventCommand = z.infer<typeof KioskEventZ>;
export type RoClockCommand = z.infer<typeof RoClockZ>;
export type RoStoryCommand = z.infer<typeof RoStoryZ>;
export type EsignSignCommand = z.infer<typeof EsignSignZ>;
export type FsSellCommand = z.infer<typeof FsSellZ>;
export type FsDeclineCommand = z.infer<typeof FsDeclineZ>;
export type PhoneCommand =
  | ApprovalDecideCommand | NotificationMarkCommand | KioskEventCommand | RoClockCommand | RoStoryCommand | EsignSignCommand | FsSellCommand | FsDeclineCommand;
