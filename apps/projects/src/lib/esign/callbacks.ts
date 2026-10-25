import 'server-only';
/**
 * The e-sign outbox consumer (webhook-style, at-least-once), on the RLS client. Run on request
 * (the sender's "Finish" on the envelope, or POST /api/sign/callbacks) — never on page load.
 *
 *   who may run what (security review H2): the RECORD callback runs only as the SENDER, whose
 *   authority the action's own guard re-checks at that moment (pm.esign_outbox_settle refuses
 *   anyone else and the trail records who triggered it). A documents:edit holder may send the next
 *   signer's link and file the signed copy, but never runs the record action under their name.
 *
 *
 *   signer.turn         → issue the next signer's one-time link and deliver it
 *   envelope.completed  → stamp the signed PDF + audit certificate as a new locked version,
 *                         then the record's own action:
 *                           estimate      pm.accept_estimate          (proposal accepted)
 *                           change_order  pm.approval_decide (approvals engine, 1113) — or
 *                                         pm.approve_change_order when no approval rule applies;
 *                                         preparer ≠ approver: it then waits for an internal approver
 *                           lien_waiver   pm.compliance_docs → RECEIVED with the signed file
 *                           dealer_quote  pm.accept_dealer_quote      (buyer's order signed)
 *   envelope.declined   → estimate pm.decline_estimate / dealer_quote pm.decline_dealer_quote
 *
 * Each handler is idempotent (an already-accepted record counts as done). A member without the
 * right for the action leaves the event pending for someone who has it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { splitToken, type PgErrorLike } from '@/lib/api-errors';
import { documentsError, unwrap } from '@/lib/documents/errors';
import { discardObject, downloadObject, storagePathOf, storeObject } from '@/lib/documents/store';
import type { SignatureAnchor } from '@/lib/templates/layout';
import { buildSignedPdf, HashMismatchError } from './certificate';
import { companyNameOf, issueAndDeliver, type EsignCtx } from './api';
import type { CompletionKind, EnvelopeRow, EventRow, OutboxRow, SignerRow } from './types';

const pm = (db: SupabaseClient) => db.schema('pm');

interface Res { data: unknown; error: PgErrorLike | null }

/** The few calls the record handlers make (a fake implements it in tests). */
export interface PmCalls {
  rpc(fn: string, args: Record<string, unknown>): Promise<Res>;
  receiveWaiver(complianceDocId: string, documentId: string | null): Promise<Res>;
}

export function pmCalls(db: SupabaseClient): PmCalls {
  return {
    rpc: async (fn, args) => pm(db).rpc(fn, args),
    receiveWaiver: async (id, documentId) => pm(db).from('compliance_docs')
      .update({ status: 'RECEIVED', ...(documentId ? { document_id: documentId } : {}) }).eq('id', id).in('status', ['MISSING', 'RECEIVED', 'REJECTED']).select('id'),
  };
}

export interface Outcome {
  ok: boolean;
  /** true = leave pending (the caller lacks the right; someone else will run it). */
  deferred?: boolean;
  outcome: Record<string, unknown>;
  error?: string;
}

const tokenOf = (e: PgErrorLike | null): string | null => (e ? splitToken(e.message).token ?? (e.code === '42501' ? 'PM_FORBIDDEN' : null) : null);

function settled(r: Res, done: Record<string, unknown>, already: string[] = [], soft: Record<string, Record<string, unknown>> = {}): Outcome {
  if (!r.error) return { ok: true, outcome: done };
  const t = tokenOf(r.error);
  if (t && already.includes(t)) return { ok: true, outcome: { ...done, already: true } };
  if (t && soft[t]) return { ok: true, outcome: soft[t] };
  if (t === 'PM_FORBIDDEN' || r.error.code === '42501') return { ok: false, deferred: true, outcome: {}, error: r.error.message ?? 'forbidden' };
  return { ok: false, outcome: {}, error: r.error.message ?? 'failed' };
}

type Handler = (c: PmCalls, subjectId: string, signed: { documentId: string | null; reason?: string | null }) => Promise<Outcome>;

export const COMPLETION_HANDLERS: Readonly<Record<CompletionKind, Handler>> = {
  estimate: async (c, id) => settled(await c.rpc('accept_estimate', { p_estimate: id }), { estimate: 'accepted' }, ['PM_ESTIMATE_NOT_OPEN']),
  change_order: async (c, id) => {
    // the approvals engine decides when a rule applies (tiers, SoD, delegation); else the CO's own approval
    const a = await c.rpc('approval_decide', { p_object_type: 'change_order', p_object_id: id, p_decision: 'approve', p_reason: 'Signed by the customer (e-signature)', p_channel: 'api' });
    const missing = a.error && (a.error.code === 'PGRST202' || a.error.code === '42883');
    if (a.error && !missing) return settled(a, {}, [], { PM_SOD_VIOLATION: { change_order: 'signed_awaiting_internal_approval' } });
    const st = (a.data as { status?: string } | null)?.status;
    if (!missing && st && st !== 'not_needed') {
      return st === 'approved' ? { ok: true, outcome: { change_order: 'approved', via: 'approvals' } } : { ok: true, outcome: { change_order: 'signed_awaiting_internal_approval', approval: st } };
    }
    return settled(await c.rpc('approve_change_order', { p_co: id }), { change_order: 'approved' }, ['PM_CO_NOT_APPROVABLE'],
    { PM_SOD_VIOLATION: { change_order: 'signed_awaiting_internal_approval' } });
  },
  lien_waiver: async (c, id, s) => {
    const r = await c.receiveWaiver(id, s.documentId);
    if (r.error) return settled(r, {});
    return Array.isArray(r.data) && r.data.length ? { ok: true, outcome: { lien_waiver: 'received' } } : { ok: true, outcome: { lien_waiver: 'already_verified' } };
  },
  dealer_quote: async (c, id) => settled(await c.rpc('accept_dealer_quote', { p_quote: id }), { quote: 'accepted' }, ['PM_QUOTE_NOT_OPEN']),
};

export const DECLINE_HANDLERS: Readonly<Partial<Record<CompletionKind, Handler>>> = {
  estimate: async (c, id, s) => settled(await c.rpc('decline_estimate', { p_estimate: id, p_reason: s.reason ?? 'Declined at signing' }), { estimate: 'declined' }, ['PM_ESTIMATE_NOT_OPEN']),
  dealer_quote: async (c, id, s) => settled(await c.rpc('decline_dealer_quote', { p_quote: id, p_reason: s.reason ?? 'Declined at signing' }), { quote: 'declined' }, ['PM_QUOTE_NOT_OPEN']),
};

/** Run the record's own action for a finished envelope. */
export async function runSubjectCallback(c: PmCalls, row: Pick<OutboxRow, 'kind' | 'subject_kind' | 'subject_id'>, signed: { documentId: string | null; reason?: string | null }): Promise<Outcome> {
  if (row.subject_kind === 'none' || !row.subject_id) return { ok: true, outcome: { subject: 'none' } };
  const h = row.kind === 'envelope.declined' ? DECLINE_HANDLERS[row.subject_kind] : COMPLETION_HANDLERS[row.subject_kind];
  if (!h) return { ok: true, outcome: { subject: row.subject_kind, action: 'none' } };
  return h(c, row.subject_id, signed);
}

const SIGNER_COLS = 'id, envelope_id, routing_order, position, name, email, phone, role_label, channel, status, sent_at, viewed_at, consented_at, consent_version, signed_at, typed_name, signature_png, sign_ip, sign_user_agent, declined_at, decline_reason';

/** Stamp + certificate → a new locked version (idempotent: a done envelope returns its version). */
export async function finalizeEnvelope(ctx: EsignCtx, envelopeId: string, senderName: string | null): Promise<{ versionId: string; documentId: string | null }> {
  const e = unwrap<EnvelopeRow | null>(await pm(ctx.db).from('esign_envelopes').select('*').eq('id', envelopeId).maybeSingle());
  if (!e) throw new Error('envelope not visible');
  if (e.finalize_state === 'done' && e.signed_version_id) {
    const v = unwrap<{ document_id: string } | null>(await pm(ctx.db).from('doc_versions').select('document_id').eq('id', e.signed_version_id).maybeSingle());
    return { versionId: e.signed_version_id, documentId: v?.document_id ?? null };
  }
  const ver = unwrap<{ document_id: string; file_name: string; meta: { anchors?: SignatureAnchor[] } }>(await pm(ctx.db).from('doc_versions').select('document_id, file_name, meta').eq('id', e.version_id).single());
  const [signers, events, original, company] = await Promise.all([
    pm(ctx.db).from('esign_signers').select(SIGNER_COLS).eq('envelope_id', envelopeId).order('position').then((r) => unwrap<SignerRow[]>(r)),
    pm(ctx.db).from('esign_events').select('id, envelope_id, signer_id, event, at, ip, user_agent, actor_user, detail').eq('envelope_id', envelopeId).order('seq').then((r) => unwrap<EventRow[]>(r)),
    storagePathOf(ctx.db, ver.document_id).then((p) => downloadObject(ctx.db, p)),
    companyNameOf(ctx.db, e.location_id),
  ]);
  const nameOf = new Map(signers.map((s) => [s.id, s.name]));
  let signed;
  try {
    signed = await buildSignedPdf({
      original, expectedSha256: e.original_sha256, envelopeId, title: e.title, companyName: company,
      sentAt: e.sent_at, completedAt: e.completed_at ?? new Date().toISOString(), senderName: senderName ?? `${company} (user ${e.sender_user})`,
      consentText: unwrap<string>(await pm(ctx.db).rpc('esign_consent_text')),
      signers: signers.filter((s) => s.status === 'signed' && s.signature_png && s.typed_name && s.signed_at).map((s) => ({
        position: s.position, name: s.name, email: s.email, phone: s.phone, roleLabel: s.role_label, typedName: s.typed_name as string,
        signaturePng: s.signature_png as string, signedAt: s.signed_at as string, consentedAt: s.consented_at, consentVersion: s.consent_version,
        ip: s.sign_ip, userAgent: s.sign_user_agent,
      })),
      events: events.map((x) => ({ at: x.at, event: x.event, signerName: x.signer_id ? nameOf.get(x.signer_id) ?? null : null, ip: x.ip })),
      anchors: Array.isArray(ver.meta?.anchors) ? ver.meta.anchors : null,
    });
  } catch (err) {
    const msg = err instanceof HashMismatchError ? err.message : `The signed copy could not be built: ${err instanceof Error ? err.message : 'unknown error'}`;
    await pm(ctx.db).rpc('esign_finalize_failed', { p_envelope: envelopeId, p_error: msg });
    throw err;
  }
  const obj = await storeObject(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, {
    area: 'esign', fileName: ver.file_name.replace(/(\.pdf)?$/i, ' (signed).pdf'), mimeType: 'application/pdf', bytes: signed.bytes, kind: 'contract',
    notes: `Signed copy of ${e.title} (envelope ${envelopeId})`,
  });
  const r = await pm(ctx.db).rpc('esign_finalize', { p_envelope: envelopeId, p_document: obj.documentId, p_sha256: signed.sha256 });
  if (r.error) { await discardObject(ctx.db, obj); throw documentsError(r.error); }
  return { versionId: (r.data as { version_id: string }).version_id, documentId: obj.documentId };
}

export interface ProcessResult {
  processed: number;
  done: number;
  deferred: number;
  failed: Array<{ id: string; kind: string; error: string }>;
}

/** Work the caller's pending outbox events (newest envelopes first are not special: oldest first). */
export interface ProcessOptions {
  limit?: number;
  envelopeId?: string;
  /** The caller's display name, printed as the sender on envelopes they sent. */
  senderName?: string | null;
  /** May the caller send links / file the signed copy (documents:edit at its company)? The DB re-checks. */
  canManage?: (env: { sender_user: string; location_id: string }) => boolean;
}

export async function processOutbox(ctx: EsignCtx, opts: ProcessOptions = {}): Promise<ProcessResult> {
  let q = pm(ctx.db).from('esign_outbox').select('id, envelope_id, signer_id, kind, subject_kind, subject_id, status, attempts, last_error, created_at').eq('status', 'pending').order('created_at').limit(Math.min(opts.limit ?? 10, 25));
  if (opts.envelopeId) q = q.eq('envelope_id', opts.envelopeId);
  const rows = (await q).data as OutboxRow[] | null;
  const out: ProcessResult = { processed: 0, done: 0, deferred: 0, failed: [] };
  const calls = pmCalls(ctx.db);
  const envIds = [...new Set((rows ?? []).map((r) => r.envelope_id))];
  const envs = envIds.length
    ? new Map((((await pm(ctx.db).from('esign_envelopes').select('id, sender_user, location_id').in('id', envIds)).data ?? []) as Array<{ id: string; sender_user: string; location_id: string }>).map((e) => [e.id, e]))
    : new Map<string, { id: string; sender_user: string; location_id: string }>();
  for (const row of rows ?? []) {
    const env = envs.get(row.envelope_id);
    if (!env || !(env.sender_user === ctx.userId || (opts.canManage?.(env) ?? false))) { out.deferred += 1; continue; }
    out.processed += 1;
    let result: Outcome;
    try {
      if (row.kind === 'signer.turn') {
        const st = row.signer_id ? (await pm(ctx.db).from('esign_signers').select('status').eq('id', row.signer_id).maybeSingle()).data as { status: string } | null : null;
        if (!row.signer_id || !st) { result = { ok: true, outcome: { skipped: 'no signer' } }; }
        else if (st.status !== 'pending_send') { result = { ok: true, outcome: { skipped: 'link already sent' } }; }
        else {
          const env = unwrap<{ location_id: string }>(await pm(ctx.db).from('esign_envelopes').select('location_id').eq('id', row.envelope_id).single());
          const d = await issueAndDeliver(ctx, row.signer_id, await companyNameOf(ctx.db, env.location_id));
          result = { ok: true, outcome: { email: d.email, sms: d.sms, manual: d.manual } };
        }
      } else if (row.kind === 'envelope.completed') {
        const fin = await finalizeEnvelope(ctx, row.envelope_id, env.sender_user === ctx.userId ? opts.senderName ?? null : null);
        if (env.sender_user !== ctx.userId && row.subject_kind !== 'none') {
          // the signed copy is filed; the record action waits for the sender's own authority
          result = { ok: false, deferred: true, outcome: {}, error: 'sender only' };
        } else {
          const cb = await runSubjectCallback(calls, row, { documentId: fin.documentId });
          result = { ...cb, outcome: { ...cb.outcome, signed_version_id: fin.versionId, triggered_by: ctx.userId } };
        }
      } else if (env.sender_user !== ctx.userId && row.subject_kind !== 'none') {
        result = { ok: false, deferred: true, outcome: {}, error: 'sender only' };
      } else {
        const env = unwrap<{ decline_reason: string | null }>(await pm(ctx.db).from('esign_envelopes').select('decline_reason').eq('id', row.envelope_id).single());
        result = await runSubjectCallback(calls, row, { documentId: null, reason: env.decline_reason });
      }
    } catch (e) {
      const status = (e as { status?: number }).status;
      result = status === 403 ? { ok: false, deferred: true, outcome: {}, error: 'forbidden' } : { ok: false, outcome: {}, error: e instanceof Error ? e.message : String(e) };
    }
    if (result.deferred) { out.deferred += 1; continue; }
    const s = await pm(ctx.db).rpc('esign_outbox_settle', { p_id: row.id, p_ok: result.ok, p_outcome: result.outcome, p_error: result.error ?? null });
    if (s.error) { out.deferred += 1; continue; }
    if (result.ok) out.done += 1; else out.failed.push({ id: row.id, kind: row.kind, error: result.error ?? 'failed' });
  }
  return out;
}
