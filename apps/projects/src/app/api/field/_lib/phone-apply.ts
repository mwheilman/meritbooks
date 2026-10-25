/**
 * Apply one v2 phone command (phone-contract.ts), at most once, with the same shape as apply.ts:
 * check age → load what the command names through the caller's RLS → check the grant at that
 * company → dedupe → write → one CommandResult. Never throws: refusals are `rejected` with words
 * the phone shows; passing failures are `retry` so the phone keeps the command.
 *
 * Dedupe, per kind (no new table — each record already has a natural key):
 *   approval.decide    the request's history: my decision at the (round, step) the phone saw
 *   notification.mark  read / done are idempotent
 *   kiosk.event        pm.mfg_kiosk_events ledger on client_event_id = the command id
 *   ro.clock           my open punch: already on that line / already off
 *   ro.story           pm.field_logs.ext._client_command_id (like a daily log)
 *   esign.sign         the one-time token: "signed" / "used" after our own first send
 *   fs.sell / decline  the estimate's status (SOLD with the same options / DECLINED)
 */
import { can } from '@/lib/access/can';
import { forbiddenBody } from '@/lib/access/guard';
import type { CommandResult } from './contract';
import { captured, failure, type FieldCtx } from './apply';
import { checkAge, type Rejection } from './rules';
import {
  PHONE_SCHEMAS, type ApprovalDecideCommand, type EsignSignCommand, type FsDeclineCommand, type FsSellCommand, type KioskEventCommand,
  type NotificationMarkCommand, type PhoneKind, type RoClockCommand, type RoStoryCommand,
} from './phone-contract';
import type { PhoneStore } from './phone-store-types';

function rejected(id: string, kind: string, r: Rejection): CommandResult {
  return { id, kind, outcome: 'rejected', code: r.code, reason: r.reason };
}

const NOT_SET_UP: Rejection = { code: 'NOT_AVAILABLE', reason: 'This server does not take that from the phone yet. Update Merit Workforce or ask the office.' };

function phoneOf(ctx: FieldCtx): PhoneStore | null {
  return ctx.phone ?? null;
}

function refusal(ctx: FieldCtx, cap: Parameters<typeof can>[1], action: Parameters<typeof can>[2], companyId: string): Rejection | null {
  if (can(ctx.access, cap, action, companyId)) return null;
  return { code: 'FORBIDDEN', reason: forbiddenBody(cap, action, ctx.companyName(companyId)).error };
}


// ----------------------------------------------------------------------------------- approvals

export async function applyApprovalDecide(ctx: FieldCtx, p: PhoneStore, c: ApprovalDecideCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const r = await p.approval(c.requestId);
  if (!r) return rejected(c.id, c.kind, { code: 'NOT_FOUND', reason: 'That approval was not found, or it is not yours to see any more.' });
  const want = c.decision === 'approve' ? 'APPROVE' : 'REJECT';
  const atStep = r.history.filter((h) => h.round === c.round && h.step === c.step && (h.decision === 'APPROVE' || h.decision === 'REJECT'));
  const same = atStep.find((h) => h.decision === want);
  // The step I saw is already decided: my own earlier send (or someone making the same call) → nothing to do.
  if (same) {
    return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: r.id, note: same.channel === 'phone' ? undefined : `Already ${want === 'APPROVE' ? 'approved' : 'sent back'} by ${same.actor}.` };
  }
  const other = atStep[0];
  if (other) {
    return rejected(c.id, c.kind, { code: 'APPROVAL_DECIDED', reason: `${other.actor} already ${other.decision === 'APPROVE' ? 'approved' : 'sent back'} “${r.title}”, so your answer was not used.` });
  }
  if (r.status !== 'PENDING') {
    return rejected(c.id, c.kind, { code: 'APPROVAL_CLOSED', reason: `“${r.title}” is ${r.status.toLowerCase()} now, so your answer was not used.` });
  }
  if (r.round !== c.round || r.step !== c.step) {
    return rejected(c.id, c.kind, { code: 'APPROVAL_MOVED', reason: `“${r.title}” changed since your phone loaded it. Open Approve again and look at it once more.` });
  }
  if (!r.canAct) return rejected(c.id, c.kind, { code: 'NOT_YOUR_STEP', reason: `“${r.title}” is waiting on someone else now.` });
  const out = await p.actApproval(r.id, c.decision, { reason: c.reason ?? null, selfReason: c.selfReason ?? null });
  const note = out.status === 'pending' && out.waitingOn ? `Your step is done. It now waits on ${out.waitingOn}.` : out.message ?? undefined;
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: r.id, note };
}

// ------------------------------------------------------------------------------- notifications

export async function applyNotificationMark(_ctx: FieldCtx, p: PhoneStore, c: NotificationMarkCommand): Promise<CommandResult> {
  const n = await p.markNotifications([...new Set(c.ids)], c.state);
  return { id: c.id, kind: c.kind, outcome: n > 0 ? 'applied' : 'duplicate' };
}

// ---------------------------------------------------------------------------------------- kiosk

function kioskWords(error: string | undefined): string {
  const e = error ?? '';
  if (e.startsWith('PM_KIOSK_SESSION')) return 'The badge sign-in ended before this was sent. Scan your badge and do it again.';
  if (e.startsWith('PM_UNKNOWN_OPERATION')) return 'That operation is no longer on the shop schedule.';
  const plain = e.replace(/^PM_[A-Z_]+:\s*/, '');
  return plain || 'The station could not record this.';
}

export async function applyKioskEvent(ctx: FieldCtx, p: PhoneStore, c: KioskEventCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const g = refusal(ctx, 'projects.production', 'edit', c.companyId);
  if (g) return rejected(c.id, c.kind, g);
  const [r] = await p.kioskEvents(c.companyId, [{
    client_event_id: c.id, session_token: c.sessionToken, action: c.action, operation_id: c.operationId ?? null,
    good_qty: c.goodQty ?? null, scrap_qty: c.scrapQty ?? null, qty: c.qty ?? null, reason: c.reason ?? null,
    indirect_code: c.indirectCode ?? null, part_label: c.partLabel ?? null, remake_reason: c.remakeReason ?? null, at: c.at,
  }]);
  if (!r) return { id: c.id, kind: c.kind, outcome: 'retry', code: 'NO_ANSWER', reason: 'The station did not answer. It will be sent again.' };
  if (!r.ok) return rejected(c.id, c.kind, { code: 'KIOSK_REFUSED', reason: kioskWords(r.error) });
  return { id: c.id, kind: c.kind, outcome: r.replay ? 'duplicate' : 'applied' };
}

// ------------------------------------------------------------------------------ dealer RO clock

export async function applyRoClock(ctx: FieldCtx, p: PhoneStore, c: RoClockCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  let companyId = c.companyId;
  if (c.op === 'clock_on') {
    const line = await p.roLine(c.lineId!);
    if (!line) return rejected(c.id, c.kind, { code: 'NOT_FOUND', reason: 'That repair-order line is not on your list any more.' });
    companyId = line.companyId;
  }
  const g = refusal(ctx, 'projects.time', 'create', companyId);
  if (g) return rejected(c.id, c.kind, g);
  const open = await p.roOpenPunch(companyId);
  if (c.op === 'clock_on') {
    if (open && open.lineId === c.lineId) return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'You are already on that line.' };
    await p.roClockOn(c.lineId!, c.at);
    return { id: c.id, kind: c.kind, outcome: 'applied', serverId: c.lineId ?? null };
  }
  if (c.op === 'clock_off') {
    if (!open) return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'You were already clocked off.' };
    await p.roClockOff(companyId, c.at);
    return { id: c.id, kind: c.kind, outcome: 'applied' };
  }
  if (open && open.kind !== 'LINE' && open.indirectKind === c.indirectKind) return { id: c.id, kind: c.kind, outcome: 'duplicate' };
  await p.roIndirect(companyId, c.indirectKind!, c.at);
  return { id: c.id, kind: c.kind, outcome: 'applied' };
}

/** "Complaint: … / Cause: … / Correction: …" — what the service writer reads on the job's log. */
export function storyBody(number: string | null, c: Pick<RoStoryCommand, 'complaint' | 'cause' | 'correction'>): string {
  const parts = [
    c.complaint ? `Complaint: ${c.complaint}` : null,
    c.cause ? `Cause: ${c.cause}` : null,
    c.correction ? `Correction: ${c.correction}` : null,
  ].filter(Boolean);
  return [`Tech story${number ? ` for ${number}` : ''}`, ...parts].join('\n');
}

export async function applyRoStory(ctx: FieldCtx, p: PhoneStore, c: RoStoryCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const wo = await p.workOrder(c.workOrderId);
  if (!wo) return rejected(c.id, c.kind, { code: 'NOT_FOUND', reason: 'That repair order is not on your list any more.' });
  const job = await ctx.store.job(wo.jobId);
  if (!job) return rejected(c.id, c.kind, { code: 'JOB_NOT_FOUND', reason: 'That repair order is not on your list any more.' });
  const g = refusal(ctx, 'projects.documents', 'create', job.companyId);
  if (g) return rejected(c.id, c.kind, g);
  const dup = await ctx.store.logByCommand(c.id);
  if (dup) return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: dup.id };
  const tz = c.tz && /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(c.tz) ? c.tz : ctx.defaultTz;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(c.at));
  const id = await ctx.store.insertLog({
    job_id: job.jobId, log_date: day, kind: 'VISIT', body: storyBody(wo.number, c), weather: null, crew_count: null, hours: null,
    ext: {
      ...captured(c),
      _ro_story: { work_order_id: wo.id, line_id: c.lineId ?? null, complaint: c.complaint ?? null, cause: c.cause ?? null, correction: c.correction ?? null },
    },
  });
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: id };
}

// --------------------------------------------------------------------------------------- e-sign

const SIGN_WORDS: Readonly<Record<string, string>> = {
  invalid: 'This signing request is no longer valid. Start the signature again.',
  expired: 'This signing request expired. Start the signature again.',
  revoked: 'This signing request was replaced. Start the signature again.',
  voided: 'The office cancelled this signing request.',
  declined: 'This request was declined, so it can no longer be signed.',
  waiting: 'Someone earlier in the signing order has not signed yet.',
  consent_required: 'The customer must agree to sign electronically.',
  name_required: 'The customer must type their full name.',
  signature_required: 'The customer must draw their signature.',
};

export async function applyEsignSign(ctx: FieldCtx, p: PhoneStore, c: EsignSignCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const s = await p.esignSign(c.token, { typedName: c.typedName, signaturePng: c.signaturePng }, ctx.meta ?? { ip: null, userAgent: null });
  if (s.ok) return { id: c.id, kind: c.kind, outcome: 'applied' };
  const why = s.reason ?? 'invalid';
  if (why === 'signed' || why === 'completed') return { id: c.id, kind: c.kind, outcome: 'duplicate' };
  // A one-time link answers "used" to a re-send of the signature that already went through.
  if (why === 'used') return { id: c.id, kind: c.kind, outcome: 'duplicate', note: 'This signature was already received.' };
  if (why === 'unavailable') return { id: c.id, kind: c.kind, outcome: 'retry', code: 'UNAVAILABLE', reason: 'Signing is not available right now. It will be sent again.' };
  return rejected(c.id, c.kind, { code: `ESIGN_${why.toUpperCase()}`.slice(0, 40), reason: SIGN_WORDS[why] ?? 'The signature could not be recorded. Start it again.' });
}

// --------------------------------------------------------------------------- field-service sell

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => a.length === b.length && a.every((x) => b.includes(x));

export async function applyFsSell(ctx: FieldCtx, p: PhoneStore, c: FsSellCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const e = await p.fsEstimate(c.estimateId);
  if (!e) return rejected(c.id, c.kind, { code: 'NOT_FOUND', reason: 'Those options were not found. Open the visit again.' });
  const g = refusal(ctx, 'projects.jobs', 'view', e.companyId);
  if (g) return rejected(c.id, c.kind, g);
  if (e.status === 'SOLD') {
    if (sameSet(e.soldOptionIds, [...new Set(c.optionIds)])) return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: e.id };
    return rejected(c.id, c.kind, { code: 'ESTIMATE_SOLD', reason: `${e.number ?? 'These options'} were already sold with a different choice. Ask the office.` });
  }
  if (e.status !== 'DRAFT' && e.status !== 'PRESENTED') {
    return rejected(c.id, c.kind, { code: 'ESTIMATE_LOCKED', reason: `${e.number ?? 'These options'} are ${e.status.toLowerCase()} and can’t be sold.` });
  }
  for (const t of c.toggles) await p.fsToggle(t.itemId, t.selected);
  const notes: string[] = [];
  let signatureDocumentId: string | null = null;
  if (c.signaturePhotoId) {
    for (const ext of ['png', 'jpg']) {
      signatureDocumentId = await ctx.store.documentByPath(`${ctx.orgId}/projects/field/${e.jobId}/${c.signaturePhotoId}.${ext}`);
      if (signatureDocumentId) break;
    }
    if (!signatureDocumentId) notes.push('The drawn signature did not reach the office; the typed name is recorded.');
  }
  const ref = c.depositMethod === 'check' || c.depositMethod === 'cash'
    ? [c.depositMethod === 'check' ? 'Check' : 'Cash', c.depositRef].filter(Boolean).join(' ').slice(0, 120)
    : c.depositRef ?? null;
  const r = await p.fsSell({
    estimateId: e.id, optionIds: [...new Set(c.optionIds)], signedName: c.signedName, dismissReason: c.dismissReason ?? null,
    joinTemplateId: c.joinTemplateId ?? null, depositCents: c.depositMethod === 'none' ? 0 : c.depositCents,
    requestDeposit: c.depositMethod === 'link' && c.depositCents > 0, depositRef: ref || null,
    financingPlanId: c.financingPlanId ?? null, signatureDocumentId,
  });
  if (r.depositRequestId) notes.push('The deposit request went to the office; the customer gets a pay link.');
  if (r.agreementId) notes.push('Membership started.');
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: e.id, note: notes.join(' ') || undefined };
}

export async function applyFsDecline(ctx: FieldCtx, p: PhoneStore, c: FsDeclineCommand): Promise<CommandResult> {
  const age = checkAge(c.at, ctx.now);
  if (age) return rejected(c.id, c.kind, age);
  const e = await p.fsEstimate(c.estimateId);
  if (!e) return rejected(c.id, c.kind, { code: 'NOT_FOUND', reason: 'Those options were not found. Open the visit again.' });
  const g = refusal(ctx, 'projects.jobs', 'view', e.companyId);
  if (g) return rejected(c.id, c.kind, g);
  if (e.status === 'DECLINED') return { id: c.id, kind: c.kind, outcome: 'duplicate', serverId: e.id };
  if (e.status === 'SOLD') return rejected(c.id, c.kind, { code: 'ESTIMATE_SOLD', reason: `${e.number ?? 'These options'} were already sold.` });
  await p.fsDecline(e.id, c.reason);
  return { id: c.id, kind: c.kind, outcome: 'applied', serverId: e.id };
}

// ------------------------------------------------------------------------------------ dispatch

function idOf(raw: unknown): string {
  const id = typeof raw === 'object' && raw !== null ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id.slice(0, 64) : '';
}

/** Validate and apply one v2 phone command. Never throws. */
export async function applyPhoneRaw(ctx: FieldCtx, kind: PhoneKind, raw: unknown): Promise<CommandResult> {
  const id = idOf(raw);
  const parsed = PHONE_SCHEMAS[kind].safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { id, kind, outcome: 'rejected', code: 'VALIDATION', reason: first ? `${first.message}${first.path.length ? ` (${first.path.join('.')})` : ''}` : 'Check the values and try again.' };
  }
  const p = phoneOf(ctx);
  if (!p) return rejected(id, kind, NOT_SET_UP);
  try {
    const c = parsed.data;
    switch (c.kind) {
      case 'approval.decide': return await applyApprovalDecide(ctx, p, c);
      case 'notification.mark': return await applyNotificationMark(ctx, p, c);
      case 'kiosk.event': return await applyKioskEvent(ctx, p, c);
      case 'ro.clock': return await applyRoClock(ctx, p, c);
      case 'ro.story': return await applyRoStory(ctx, p, c);
      case 'esign.sign': return await applyEsignSign(ctx, p, c);
      case 'fs.sell': return await applyFsSell(ctx, p, c);
      case 'fs.decline': return await applyFsDecline(ctx, p, c);
    }
  } catch (e) {
    return failure(id, kind, e);
  }
}
