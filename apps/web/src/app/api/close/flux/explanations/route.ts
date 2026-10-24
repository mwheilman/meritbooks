export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { apiHandler } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { resolveActor } from '@/lib/trust/actor';
import { logHumanAction } from '@/lib/trust/action-log';
import { loadExplanation, reviewExplanation, saveExplanation } from '@/lib/close/flux/service';
import { EXPLANATION_CATEGORIES } from '@/lib/close/flux/types';
import { fluxErrorResponse, noOrg } from '@/lib/close/flux/route-support';

/**
 * POST  /api/close/flux/explanations — save a draft or submit an explanation for one flux
 *       line (preparer; close_mgmt:view). The server re-computes and snapshots the figures.
 * PATCH /api/close/flux/explanations — approve or send back (reviewer; close_mgmt:manage).
 *       The reviewer must not be the preparer (route + DB CHECK). The explanation is loaded
 *       server-side first and the permission is checked against ITS company; approving
 *       requires `explanation_hash` = the hash of the text the reviewer saw (409 STALE when
 *       the preparer changed it since), which the server pins on the row.
 *
 * AI provenance is server-side only: `ai_decision_id` is a claim the service verifies
 * against ai_decisions (this org / company / month / line, text derived from the draft);
 * any client `drafted_by_ai` / `ai_citations` is stripped by the schema and ignored.
 */

const saveSchema = z.object({
  location_id: z.string().uuid(),
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
  line_key: z.string().min(1).max(200),
  explanation: z.string().max(4000).nullable().optional(),
  category: z.enum(EXPLANATION_CATEGORIES as unknown as [string, ...string[]]).nullable().optional(),
  submit: z.boolean(),
  attachment_document_id: z.string().uuid().nullable().optional(),
  ai_decision_id: z.string().uuid().nullable().optional(),
  carried_from_id: z.string().uuid().nullable().optional(),
});

export const POST = apiHandler(saveSchema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  const guard = await requirePermission(ctx.userId, 'close_mgmt', 'view', { locationId: b.location_id });
  if (!guard.ok) return guard.response;
  try {
    const { coreUserId } = await resolveActor(ctx.supabase, ctx.userId);
    const saved = await saveExplanation(ctx.supabase, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      coreUserId,
      locationId: b.location_id,
      year: b.year,
      month: b.month,
      lineKey: b.line_key,
      explanation: b.explanation ?? null,
      category: (b.category ?? null) as (typeof EXPLANATION_CATEGORIES)[number] | null,
      submit: b.submit,
      attachmentDocumentId: b.attachment_document_id,
      aiDecisionId: b.ai_decision_id ?? null,
      carriedFromId: b.carried_from_id ?? null,
    });
    if (b.submit) {
      await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
        action: 'close.flux.explain',
        subjectTable: 'flux_explanations',
        subjectId: saved.id,
        summary: `Explained a flux line for ${saved.periodKey} (${saved.category ?? 'uncategorized'})`,
        locationId: b.location_id,
        metadata: { line_key: saved.lineKey, change_cents: saved.changeCents, drafted_by_ai: saved.draftedByAi, carried_from_id: saved.carriedFromId },
      });
    }
    return NextResponse.json({ explanation: saved });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/explanations POST');
  }
});

const reviewSchema = z.object({
  explanation_id: z.string().uuid(),
  action: z.enum(['approve', 'send_back']),
  note: z.string().max(1000).nullable().optional(),
  explanation_hash: z.string().regex(/^[0-9a-fA-F]{64}$/).nullable().optional(),
});

export const PATCH = apiHandler(reviewSchema, async (b, ctx) => {
  if (!ctx.orgId) return noOrg();
  try {
    // Load first (RLS: org + client scope) so the permission is checked on the row's company.
    const explanation = await loadExplanation(ctx.supabase, ctx.orgId, b.explanation_id);
    const guard = await requirePermission(ctx.userId, 'close_mgmt', 'manage', { locationId: explanation.locationId });
    if (!guard.ok) return guard.response;
    const saved = await reviewExplanation(ctx.supabase, {
      orgId: ctx.orgId,
      userId: ctx.userId,
      explanationId: b.explanation_id,
      action: b.action,
      note: b.note ?? null,
      explanationHash: b.explanation_hash ?? null,
      explanation,
    });
    await logHumanAction(ctx.supabase, ctx.userId, ctx.orgId, {
      action: b.action === 'approve' ? 'close.flux.review' : 'close.flux.send_back',
      subjectTable: 'flux_explanations',
      subjectId: saved.id,
      summary: `${b.action === 'approve' ? 'Reviewed' : 'Sent back'} a flux explanation for ${saved.periodKey}`,
      locationId: saved.locationId,
      metadata: { line_key: saved.lineKey, prepared_by: saved.preparedBy, note: b.note ?? null },
    });
    return NextResponse.json({ explanation: saved });
  } catch (e) {
    return fluxErrorResponse(e, 'close/flux/explanations PATCH');
  }
});
