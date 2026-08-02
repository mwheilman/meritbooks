export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuthedContext } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import { resolveRole, PostingError, type AccountRoleKey } from '@/lib/posting/account-roles';
import {
  parsePayrollRegister,
  PAYROLL_REGISTER_EXTRACT_FEATURE,
  type ProposedPayrollLine,
} from '@/lib/payroll/register-parse';

/**
 * POST /api/payroll/import-register — DROP-AND-PARSE payroll register → payroll JE.
 *
 * The MANUAL-IMPORT path for tenants NOT on the embedded payroll provider. Accepts
 * an uploaded payroll register (multipart `file`), runs it through the Core AI
 * gateway (feature PAYROLL_REGISTER_EXTRACT, metered + budget-capped per tenant),
 * and returns the PROPOSED, BALANCED payroll journal entry — each line addressed by
 * ROLE with a SUGGESTED account resolved from this tenant's chart, plus a balance
 * verification (built entry foots) and the register's own footing check.
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING to the ledger.
 * Its only write is a single `ai_decisions` PROPOSED audit row. The human reviews /
 * adjusts the account mapping and confirms via `POST .../import-register/confirm`,
 * which posts the balanced entry through `postJournalEntry`.
 *
 * Account resolution is BY ROLE (`resolveRole`) — the engine never guesses. A role
 * with no mapping/fallback in this tenant is REPORTED (`unresolvedRoles`) and its
 * line is returned with a null suggestion so the human maps it in the UI; the parse
 * DEGRADES gracefully rather than failing.
 *
 * Access: gated on `payroll:create` (RBAC) — the same permission the run wizard's
 * draft path uses — plus RLS tenant isolation on the gateway metering + audit write.
 *
 * Storage: the register is TRANSIENT — decoded to base64 and extracted in-request,
 * never persisted (no storage bucket for payroll registers today; reported follow-up).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface SuggestedLine {
  roleKey: AccountRoleKey;
  side: 'DR' | 'CR';
  cents: number;
  label: string;
  degraded: boolean;
  /** Suggested account resolved by role (null when the role could not be resolved). */
  suggestedAccountId: string | null;
  suggestedAccountNumber: string | null;
  /** True when no account could be resolved for this role — the human must pick one. */
  unresolved: boolean;
}

export async function POST(request: Request): Promise<NextResponse> {
  const ctx = await requireAuthedContext();
  if (ctx instanceof NextResponse) return ctx;
  const { supabase, orgId, userId } = ctx;
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // RBAC — gate on the existing payroll create permission (draft/import path).
  const guard = await requirePermission(userId, 'payroll', 'create');
  if (!guard.ok) return guard.response;

  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: 'AI is not configured (Anthropic key missing).', code: 'NO_API_KEY' },
      { status: 503 },
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

    fileName = file.name || 'payroll-register';
    mediaType = file.type || 'application/octet-stream';
    if (!ALLOWED.includes(mediaType)) {
      return NextResponse.json(
        { error: `Unsupported file type: ${mediaType}. Upload a PDF, JPEG, PNG, or WebP.`, code: 'BAD_FILE_TYPE' },
        { status: 400 },
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

  // ── Extract + build the proposed JE through the metered gateway ──────────────
  const result = await parsePayrollRegister(
    { supabase, anthropicApiKey: apiKey },
    { orgId, userId, base64Data, mediaType },
  );

  if (!result.ok) {
    const status = result.budgetBlocked ? 429 : 422;
    return NextResponse.json(
      { error: result.error, code: result.budgetBlocked ? 'BUDGET_BLOCKED' : 'PARSE_FAILED' },
      { status },
    );
  }

  // ── Resolve each proposed role -> a suggested account (degrade + REPORT) ─────
  // Location-agnostic best-effort suggestion; the confirm step re-resolves with the
  // chosen company. A role with no mapping/fallback is reported, not fatal.
  const uniqueRoles = Array.from(new Set(result.proposed.lines.map((l) => l.roleKey)));
  const roleToAccount = new Map<AccountRoleKey, { id: string; number: string }>();
  const unresolvedRoles: AccountRoleKey[] = [];
  await Promise.all(
    uniqueRoles.map(async (role) => {
      try {
        const ref = await resolveRole(supabase, orgId, role);
        roleToAccount.set(role, { id: ref.id, number: ref.account_number });
      } catch (e) {
        if (e instanceof PostingError) unresolvedRoles.push(role);
        else throw e;
      }
    }),
  );

  const lines: SuggestedLine[] = result.proposed.lines.map((l: ProposedPayrollLine) => {
    const acct = roleToAccount.get(l.roleKey) ?? null;
    return {
      roleKey: l.roleKey,
      side: l.side,
      cents: l.cents,
      label: l.label,
      degraded: l.degraded,
      suggestedAccountId: acct?.id ?? null,
      suggestedAccountNumber: acct?.number ?? null,
      unresolved: acct === null,
    };
  });

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ─────
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: PAYROLL_REGISTER_EXTRACT_FEATURE,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Payroll register import — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'payroll_register',
          file_name: fileName,
          document_note: result.documentNote,
          register: result.register,
          proposed: result.proposed,
          unresolvedRoles,
        },
        reasoning:
          'Payroll register parsed into a proposed balanced payroll journal entry; proposed for human review. The confirmed entry posts via the gated confirm path — the model never writes a debit/credit.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[payroll/import-register] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    register: {
      payDate: result.register.payDate,
      periodStart: result.register.periodStart,
      periodEnd: result.register.periodEnd,
      employeeCount: result.register.employeeCount,
      grossCents: result.register.grossCents,
      netCents: result.register.netCents,
      lowConfidenceFields: result.register.lowConfidenceFields,
    },
    lines,
    balance: {
      totalDebitCents: result.proposed.totalDebitCents,
      totalCreditCents: result.proposed.totalCreditCents,
      balanced: result.proposed.balanced,
      imbalanceCents: result.proposed.imbalanceCents,
      registerFoots: result.proposed.registerFoots,
      footingDeltaCents: result.proposed.footingDeltaCents,
    },
    unresolvedRoles,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
