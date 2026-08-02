export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  compileExpensePolicyDocument,
  EXPENSE_POLICY_EXTRACT_FEATURE,
} from '@/lib/expenses/policy-compile';

/**
 * POST /api/expenses/policy/parse — DROP-AND-COMPILE an expense policy document.
 *
 * Accepts an uploaded policy (multipart `file`), runs it through the Core AI
 * gateway (feature EXPENSE_POLICY_EXTRACT, metered + budget-capped per tenant), and
 * returns the PROPOSED compiled ruleset (schema-validated) with any clauses the
 * schema couldn't express carried in `unmappedClauses` for a human.
 *
 * SAFETY (config, not codegen): the model only emits DATA that conforms to the
 * fixed ruleset schema; it writes NOTHING that enforces. Its only side effect here
 * is a single `ai_decisions` PROPOSED audit row. A human reviews/edits/activates a
 * version via the gated create/activate path — nothing enforces until ACTIVE.
 *
 * RBAC (reported: a dedicated `expense_policy` permission is the right home): read
 * gated on `receipts:approve` (compiling a policy is a control action, not routine
 * data entry). RLS scopes gateway metering + the audit write to the tenant.
 *
 * Storage: the document is TRANSIENT — decoded to base64 and compiled in-request,
 * never persisted (no policy-doc bucket exists; standing one up is a follow-up).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  const guard = await requirePermission(userId, 'receipts', 'approve');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' },
      { status: 503 }
    );
  }

  // ── Read the uploaded file (transient; never stored) ─────────────────────────
  let base64Data: string;
  let mediaType: string;
  let fileName: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided', code: 'NO_FILE' }, { status: 400 });

    fileName = file.name || 'policy';
    mediaType = file.type || 'application/octet-stream';
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: 'File too large. Maximum 10MB.', code: 'FILE_TOO_LARGE' }, { status: 400 });
    }
    const buffer = await file.arrayBuffer();
    base64Data = Buffer.from(buffer).toString('base64');
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file', code: 'UPLOAD_ERROR' }, { status: 400 });
  }

  // ── Compile through the metered gateway ──────────────────────────────────────
  const result = await compileExpensePolicyDocument(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType }
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status }
    );
  }

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ──────
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: EXPENSE_POLICY_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Expense policy compile — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'expense_policy_ruleset',
          file_name: fileName,
          document_note: result.documentNote,
          category_count: result.ruleset.categories.length,
          unmapped_count: result.ruleset.unmappedClauses.length,
          ruleset: result.ruleset,
        },
        reasoning:
          'Expense policy compiled from an uploaded document into a schema-validated ruleset (config, not codegen). Unmapped clauses are flagged for a human. Nothing enforces until a human activates a version via the gated create path.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[expenses/policy/parse] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    ruleset: result.ruleset,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
      categoryCount: result.ruleset.categories.length,
      unmappedCount: result.ruleset.unmappedClauses.length,
    },
  });
}
