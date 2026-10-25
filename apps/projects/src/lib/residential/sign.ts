import 'server-only';
/**
 * Signatures for residential records, through the one e-sign service (lib/esign, migration 1115):
 *
 *   proposal       render the branded proposal (proposal-pdf.ts), file it as the estimate's proposal
 *                  document, send it (on completion lib/esign accepts the estimate; migration 1119's
 *                  deferred trigger then builds the job — schedule, selections, deposit, portal invites)
 *   change order   the change-order template, one-day fast-sign link by text (demo discovery: the crew
 *                  resumes the same day), approved through the approvals engine on completion
 *
 * Trade links (schedule confirmations, bids, PO acceptance) are one-time tokens too: the raw token is
 * only in the link, the database keeps its SHA-256.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { HttpError } from '@/lib/api-errors';
import { createDocument, storeObject } from '@/lib/documents/store';
import { requestSignature, type RequestResult } from '@/lib/esign/api';
import { generateToken, hashToken } from '@/lib/esign/token';
import type { SignerInputT } from '@/lib/esign/types';
import { generateDocument } from '@/lib/templates/generate';
import { templateContext } from '@/lib/templates/context';
import { renderProposal } from './proposal-pdf';
import { loadProposal } from './queries';
import { resRpc } from './rpc';

export interface SignCtx { db: SupabaseClient; orgId: string; userId: string; baseUrl: string }

export async function sendProposalForSignature(ctx: SignCtx, proposalId: string, signers: SignerInputT[], message?: string): Promise<RequestResult & { fileId: string }> {
  const b = await loadProposal(ctx.db, proposalId);
  const p = b.proposal;
  if (p.status !== 'SENT') throw new HttpError(409, 'Send the proposal first (it is checked and versioned), then request signatures.', 'PM_RES_PROPOSAL_NOT_SENT');
  if (!p.estimate_id) throw new HttpError(409, 'The proposal has no estimate.', 'PM_RES_NO_ESTIMATE');
  if (b.envelope && (b.envelope.status === 'sent' || b.envelope.status === 'draft')) {
    throw new HttpError(409, 'A signature request is already out for this version. Void it to send a new one.', 'PM_ESIGN_OPEN');
  }
  const ctxT = await templateContext(ctx.db, ctx.orgId, p.location_id, 'proposal');
  const rendered = await renderProposal({
    proposal: p, options: b.options, lines: b.lines, schedule: b.schedule, customerName: b.job?.customer_name ?? null,
    jobLabel: b.job ? `${b.job.job_number} · ${b.job.name}` : null, signers: signers.map((s, i) => ({ position: i + 1, name: s.name })),
  }, ctxT.brand);
  const obj = await storeObject(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, { area: 'docs', fileName: rendered.fileName, mimeType: 'application/pdf', bytes: rendered.bytes, kind: 'proposal' });
  const doc = await createDocument(ctx.db, obj, { jobId: p.job_id, companyId: p.location_id }, {
    title: `${p.title} — proposal${p.version > 1 ? ` v${p.version}` : ''}`, kind: 'proposal', subjectTable: 'estimates', subjectId: p.estimate_id,
    pageCount: rendered.pageCount, source: 'template', meta: { template: 'res_proposal', anchors: rendered.anchors },
  });
  const res = await requestSignature(ctx, {
    documentId: doc.file_id, signers, title: `${p.title} — please review and sign`, message, expiresDays: 14, routing: 'parallel',
    onCompleted: { kind: 'estimate', id: p.estimate_id },
  });
  await resRpc(ctx.db, 'res_link_proposal_envelope', { p_proposal: p.id, p_envelope: res.envelopeId });
  return { ...res, fileId: doc.file_id };
}

/** Fast-sign a priced change order (demo discovery: a one-day text link). */
export async function sendChangeOrderForSignature(ctx: SignCtx, coId: string, signers: SignerInputT[], fast: boolean): Promise<RequestResult & { fileId: string }> {
  const g = await generateDocument(ctx.db, { orgId: ctx.orgId, userId: ctx.userId }, { template: 'change_order', sourceId: coId });
  const res = await requestSignature(ctx, {
    documentId: g.fileId, signers: fast ? signers.map((s) => ({ ...s, channel: s.phone ? 'sms' : s.channel })) : signers,
    title: fast ? 'Change order — sign so work can continue today' : 'Change order to review and sign',
    expiresDays: fast ? 1 : 7, routing: 'parallel', onCompleted: { kind: 'change_order', id: coId },
  });
  return { ...res, fileId: g.fileId };
}

/** A one-time link token for a trade (raw in the link, SHA-256 in the database). */
export function tradeToken(): { token: string; hash: string } {
  const token = generateToken();
  return { token, hash: hashToken(token) };
}

export function publicLink(baseUrl: string, kind: 'trade' | 'bid' | 'po', token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/sign/public/trade-link/${kind}/${token}`;
}
