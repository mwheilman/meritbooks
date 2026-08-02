export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { createAdminSupabase } from '@/lib/supabase/server';
import { runAiGateway } from '@meritbooks/core-ai';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { loadInvoiceDocById } from '@/lib/invoices/invoice-doc';
import {
  cadenceStageForDays,
  getDunningStage,
  DUNNING_LADDER,
  type DunningStageKey,
} from '@/lib/collections/cadence';
import {
  deterministicDunningDraft,
  dunningSystemPrompt,
  dunningUserPrompt,
  parseDunningReply,
  DUNNING_DRAFT_FEATURE,
  DUNNING_DRAFT_MODEL,
  type DunningFacts,
} from '@/lib/collections/dunning-copy';

/**
 * POST /api/collections/draft — DRAFT a dunning reminder for one invoice.
 *
 * Canon §3: the cadence ladder (deterministic) picks the stage; the AI only
 * phrases the letter from already-computed facts; and this endpoint DRAFTS ONLY —
 * it never sends. The human reviews/edits the returned subject+body and then
 * POSTs /api/collections/send to actually mail it. If the gateway is unavailable
 * or budget-blocked, we return the deterministic letter so a draft always exists
 * (graceful degrade). No writes.
 */

const STAGE_KEYS = new Set<string>(DUNNING_LADDER.map((s) => s.key));

function extractText(result: unknown): string | null {
  if (!Array.isArray(result)) return null;
  const b = (result as Array<{ type?: string; text?: string }>).find((c) => c?.type === 'text');
  return b?.text ?? null;
}

function daysOverdue(dueDate: string, asOf: string): number {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const at = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(due) || Number.isNaN(at)) return 0;
  return Math.max(0, Math.floor((at - due) / 86_400_000));
}

export async function POST(req: Request) {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization' }, { status: 400 });

  let body: { invoiceId?: string; stage?: string; asOf?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'PARSE_ERROR' }, { status: 400 });
  }
  const invoiceId = body.invoiceId;
  if (!invoiceId) return NextResponse.json({ error: 'invoiceId is required' }, { status: 422 });

  const doc = await loadInvoiceDocById(supabase, orgId, invoiceId);
  if (!doc) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (doc.status === 'PAID' || doc.status === 'VOIDED' || doc.status === 'WRITTEN_OFF' || doc.balance_cents <= 0) {
    return NextResponse.json({ error: 'This invoice has no open balance to remind on.', code: 'NOTHING_DUE' }, { status: 422 });
  }

  const asOf = body.asOf || new Date().toISOString().slice(0, 10);
  const overdue = daysOverdue(doc.due_date, asOf);

  // Stage: explicit request wins (validated); else the cadence stage; else the
  // earliest notice (a human can always draft a first courtesy pre-grace).
  const requested = body.stage && STAGE_KEYS.has(body.stage) ? (body.stage as DunningStageKey) : null;
  const stageKey: DunningStageKey = requested ?? cadenceStageForDays(overdue)?.key ?? 'FIRST_NOTICE';
  const stage = getDunningStage(stageKey);

  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://meritbooks-web.vercel.app';
  const facts: DunningFacts = {
    customerName: doc.customer?.name ?? 'Valued customer',
    supplierName: doc.entity?.name ?? 'Your supplier',
    invoiceNumber: doc.invoice_number,
    invoiceDate: doc.invoice_date,
    dueDate: doc.due_date,
    balanceCents: doc.balance_cents,
    daysOverdue: overdue,
    payUrl: doc.public_token ? `${base}/pay/${doc.public_token}` : null,
  };

  const deterministic = deterministicDunningDraft(stageKey, facts);

  // AI phrasing (feature DUNNING_DRAFT). Degrade to deterministic on any failure.
  let aiUsed = false;
  let draft = deterministic;
  const apiKey = getAnthropicApiKey();
  if (apiKey) {
    try {
      const admin = createAdminSupabase();
      const gw = await runAiGateway(
        { supabase: admin, anthropicApiKey: apiKey },
        {
          tenant_id: orgId,
          user_id: userId,
          module: 'BOOKS',
          feature: DUNNING_DRAFT_FEATURE,
          model: DUNNING_DRAFT_MODEL,
          system: dunningSystemPrompt(),
          messages: [{ role: 'user', content: [{ type: 'text', text: dunningUserPrompt(stageKey, facts) }] }],
          max_tokens: 500,
        },
      );
      if (gw.status !== 'blocked' && gw.result != null) {
        const text = extractText(gw.result);
        const parsed = text ? parseDunningReply(text, stageKey, stage.tone) : null;
        if (parsed) { draft = parsed; aiUsed = true; }
      }
    } catch (e) {
      console.error('[collections draft] gateway failed, using deterministic', e);
    }
  }

  return NextResponse.json({
    invoiceId,
    stage: stageKey,
    stageLabel: stage.label,
    tone: stage.tone,
    daysOverdue: overdue,
    balanceCents: doc.balance_cents,
    customerName: facts.customerName,
    customerEmail: doc.customer?.email ?? null,
    subject: draft.subject,
    body: draft.body,
    aiUsed,
    /** The deterministic fallback, so the UI can offer "reset to template". */
    fallback: { subject: deterministic.subject, body: deterministic.body },
  });
}
