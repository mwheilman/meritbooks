/**
 * Budget collaboration (Wave 4B, FP-21 / AC-B11): threaded comments on a line, "please justify"
 * requests, and variance explanations — the owner explains (EXPLAINED), someone else reviews
 * (REVIEWED; the DB refuses author = reviewer).
 */
import { BudgetError } from '../lifecycle';
import { canSeeDepartment } from '../scope';
import type { BudgetComment, BvaWindow } from '../types';
import { must, type BudgetCtx } from './data';
import { assertBudgetRefs } from './refs';

type Row = Record<string, unknown>;

function toComment(r: Row): BudgetComment {
  return {
    id: String(r.id),
    versionId: (r.version_id as string | null) ?? null,
    departmentId: (r.department_id as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    periodNumber: r.period_number == null ? null : Number(r.period_number),
    parentId: (r.parent_id as string | null) ?? null,
    kind: String(r.kind) as BudgetComment['kind'],
    status: String(r.status) as BudgetComment['status'],
    body: String(r.body),
    authorUserId: String(r.author_user_id),
    authorName: (r.author_name as string | null) ?? null,
    periodKey: (r.period_key as string | null) ?? null,
    varianceWindow: (r.variance_window as BvaWindow | null) ?? null,
    varianceCents: r.variance_cents == null ? null : Number(r.variance_cents),
    resolvedBy: (r.resolved_by as string | null) ?? null,
    reviewedBy: (r.reviewed_by as string | null) ?? null,
    reviewNote: (r.review_note as string | null) ?? null,
    createdAt: String(r.created_at),
  };
}

export interface CommentQuery {
  locationId: string;
  versionId?: string | null;
  departmentId?: string | null;
  accountId?: string | null;
  kind?: BudgetComment['kind'];
  periodKey?: string | null;
}

export async function listComments(ctx: BudgetCtx, q: CommentQuery): Promise<BudgetComment[]> {
  if (q.departmentId !== undefined && !canSeeDepartment(ctx.access, q.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  let cq = ctx.reader.from('budget_comments').select('*').eq('location_id', q.locationId);
  if (q.versionId) cq = cq.eq('version_id', q.versionId);
  if (q.departmentId === null) cq = cq.is('department_id', null);
  else if (q.departmentId) cq = cq.eq('department_id', q.departmentId);
  if (q.accountId) cq = cq.eq('account_id', q.accountId);
  if (q.kind) cq = cq.eq('kind', q.kind);
  if (q.periodKey) cq = cq.eq('period_key', q.periodKey);
  const rows = must(await cq, 'comments') as Row[];
  return rows.map(toComment).filter((c) => canSeeDepartment(ctx.access, c.departmentId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface AddCommentInput {
  locationId: string;
  versionId?: string | null;
  departmentId: string | null;
  accountId?: string | null;
  periodNumber?: number | null;
  parentId?: string | null;
  kind: BudgetComment['kind'];
  body: string;
  periodKey?: string | null;
  varianceWindow?: BvaWindow | null;
  varianceCents?: number | null;
}

export async function addComment(ctx: BudgetCtx, i: AddCommentInput): Promise<BudgetComment> {
  if (!canSeeDepartment(ctx.access, i.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const body = i.body.trim();
  if (body.length < 1 || body.length > 4000) throw new BudgetError('VALIDATION', 'Write a comment (up to 4,000 characters).');
  if (i.kind === 'VARIANCE_EXPLANATION' && body.length < 10) throw new BudgetError('VALIDATION', 'Explain the variance in a sentence (at least 10 characters).');
  if (i.kind === 'JUSTIFY_REQUEST' && ctx.access.scope !== 'ALL') throw new BudgetError('SCOPE', 'Only finance can ask for a justification.');
  // Every id the comment references must be this org's, and this company's (service/refs.ts).
  await assertBudgetRefs(ctx, {
    locationId: i.locationId,
    versionIds: [i.versionId],
    accountIds: [i.accountId],
    departmentIds: [i.departmentId],
    commentIds: [i.parentId],
  });
  if (i.parentId) {
    // A reply stays in its parent's thread: same version and department (so it can't hop scope).
    const parents = must(await ctx.writer.from('budget_comments').select('id, version_id, department_id').eq('org_id', ctx.orgId).eq('id', i.parentId), 'parent comment') as Row[];
    const p = parents[0];
    if (!p) throw new BudgetError('NOT_FOUND', 'The comment you are replying to was not found.');
    if ((p.version_id ?? null) !== (i.versionId ?? null) || (p.department_id ?? null) !== (i.departmentId ?? null)) {
      throw new BudgetError('VALIDATION', 'A reply must be on the same budget version and department as its comment.');
    }
  }
  const ins = must(
    await ctx.writer.from('budget_comments').insert({
      org_id: ctx.orgId,
      location_id: i.locationId,
      version_id: i.versionId ?? null,
      department_id: i.departmentId,
      account_id: i.accountId ?? null,
      period_number: i.periodNumber ?? null,
      parent_id: i.parentId ?? null,
      kind: i.kind,
      status: i.kind === 'VARIANCE_EXPLANATION' ? 'EXPLAINED' : 'OPEN',
      body,
      author_user_id: ctx.userId,
      author_name: ctx.userName ?? null,
      period_key: i.periodKey ?? null,
      variance_window: i.varianceWindow ?? null,
      variance_cents: i.varianceCents ?? null,
    }).select('*'),
    'add comment',
  ) as Row[];
  return toComment(ins[0]);
}

export async function actOnComment(
  ctx: BudgetCtx,
  id: string,
  action: 'resolve' | 'reopen' | 'review',
  note?: string | null,
): Promise<BudgetComment> {
  const rows = must(await ctx.reader.from('budget_comments').select('*').eq('id', id), 'comment') as Row[];
  if (!rows[0]) throw new BudgetError('NOT_FOUND', 'That comment was not found.');
  const c = toComment(rows[0]);
  if (!canSeeDepartment(ctx.access, c.departmentId)) throw new BudgetError('SCOPE', 'That department’s budget isn’t yours to see.');
  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  if (action === 'review') {
    if (c.kind !== 'VARIANCE_EXPLANATION') throw new BudgetError('VALIDATION', 'Only a variance explanation is reviewed.');
    if (!(ctx.access.scope === 'ALL' && (ctx.access.canApprove || ctx.access.canEdit))) throw new BudgetError('SCOPE', 'Only finance reviews variance explanations.');
    if (c.authorUserId === ctx.userId) throw new BudgetError('SOD', 'You wrote this explanation — someone else has to review it.');
    patch = { status: 'REVIEWED', reviewed_by: ctx.userId, reviewed_at: now, review_note: note ? note.slice(0, 1000) : null };
  } else if (action === 'resolve') {
    patch = { status: 'RESOLVED', resolved_by: ctx.userId, resolved_at: now };
  } else {
    patch = { status: c.kind === 'VARIANCE_EXPLANATION' ? 'EXPLAINED' : 'OPEN', resolved_by: null, resolved_at: null, reviewed_by: null, reviewed_at: null };
  }
  const out = must(await ctx.writer.from('budget_comments').update(patch).eq('id', id).eq('org_id', ctx.orgId).select('*'), 'update comment') as Row[];
  if (!out[0]) throw new BudgetError('NOT_FOUND', 'That comment was not found.');
  return toComment(out[0]);
}
