export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-handler';
import { requirePermission } from '@/lib/rbac/require-permission';
import { createAdminSupabase } from '@/lib/supabase/server';
import { getAnthropicApiKey } from '@/lib/ai/gateway';
import {
  parseContractDocument,
  normalizeCustomerName,
  CONTRACT_EXTRACT_FEATURE,
} from '@/lib/invoices/contract-parse';

/**
 * POST /api/invoices/parse-contract — DROP-AND-PARSE contract / SOW extraction.
 *
 * Accepts an uploaded signed customer contract or SOW (multipart `file`), runs it
 * through the Core AI gateway (feature CONTRACT_EXTRACT, metered + budget-capped per
 * tenant), and returns a PROPOSED billing structure: the customer (MATCHED to an
 * existing customer by normalized name, or PROPOSED as new), the total contract
 * value, the billing schedule (one-time invoice / milestone invoices / recurring
 * schedule), the term dates, and a SUGGESTED rev-rec method (one of the nine).
 *
 * Canon §3 boundary: this is AI PROPOSING facts — it WRITES NOTHING billable. Its
 * only write is a single `ai_decisions` PROPOSED audit row (feature CONTRACT_EXTRACT)
 * for explainability. The human reviews/edits/confirms in the UI, and only confirmed
 * rows persist via the EXISTING gated create paths: `POST /api/invoices`
 * (post_to_gl:false, rev-rec-aware, one invoice per milestone) and
 * `POST /api/recurring-invoices` (the existing template path). Neither is forked.
 *
 * Access: gated on `invoices:create` — the same permission the invoice/recurring
 * create paths require (defense-in-depth on top of RLS), since this proposes an
 * invoice draft. The org filter + admin-client convention matches invoice-create.
 *
 * Storage: the document is TRANSIENT — decoded to base64 and extracted in-request,
 * never persisted (no contract-document bucket exists; standing one up is a follow-up).
 */

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'];

interface CustomerCandidate {
  id: string;
  name: string;
  email: string | null;
  payment_terms_days: number | null;
}

export async function POST(request: Request): Promise<NextResponse> {
  const authResult = await requireAuth();
  if (authResult instanceof NextResponse) return authResult;
  const { userId } = authResult;
  const orgId = authResult.orgId ?? '';
  if (!orgId) return NextResponse.json({ error: 'No organization', code: 'NO_ORG' }, { status: 400 });

  // Proposing an invoice draft requires invoices:create (mirrors the create paths).
  const guard = await requirePermission(userId, 'invoices', 'create');
  if (!guard.ok) return guard.response;

  // Anthropic key — obtained solely to inject into the Core AI gateway (canon §2).
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

    fileName = file.name || 'contract';
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

  const supabase = createAdminSupabase();

  // ── Extract through the metered gateway ──────────────────────────────────────
  const result = await parseContractDocument(
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

  const contract = result.contract;

  // ── Match the proposed customer to an existing one (by normalized name) ───────
  // Read is org-scoped explicitly on the admin client (matches invoice-create).
  let customerMatch:
    | { type: 'MATCHED'; customer: CustomerCandidate }
    | { type: 'PROPOSED'; name: string | null; email: string | null; candidates: CustomerCandidate[] };

  const candidates: CustomerCandidate[] = [];
  if (contract.customer.matchKey) {
    const { data } = await supabase
      .schema('core')
      .from('customers')
      .select('id, name, email, payment_terms_days')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .limit(500);
    const rows = (data ?? []) as CustomerCandidate[];
    const exact = rows.filter((c) => normalizeCustomerName(c.name) === contract.customer.matchKey);
    if (exact.length === 1) {
      customerMatch = { type: 'MATCHED', customer: exact[0] };
    } else {
      // No unique exact match — surface near matches (shared-token overlap) as candidates.
      const keyTokens = new Set(contract.customer.matchKey.split(' ').filter(Boolean));
      const near = rows
        .map((c) => {
          const t = new Set(normalizeCustomerName(c.name).split(' ').filter(Boolean));
          let overlap = 0;
          for (const tok of keyTokens) if (t.has(tok)) overlap += 1;
          return { c, overlap };
        })
        .filter((x) => x.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
        .slice(0, 5)
        .map((x) => x.c);
      candidates.push(...(exact.length > 1 ? exact.slice(0, 5) : near));
      customerMatch = {
        type: 'PROPOSED',
        name: contract.customer.name,
        email: contract.customer.email,
        candidates,
      };
    }
  } else {
    customerMatch = { type: 'PROPOSED', name: contract.customer.name, email: contract.customer.email, candidates: [] };
  }

  // ── Log the proposal to the AI decision rail (PROPOSED) for traceability ──────
  // Read-only w.r.t. AR: nothing is written to invoices/recurring templates here.
  let decisionId: string | null = null;
  try {
    const { data: dec } = await supabase
      .from('ai_decisions')
      .insert({
        org_id: orgId,
        feature: CONTRACT_EXTRACT_FEATURE,
        model_requested: null,
        model_used: result.model,
        correlation_id: result.correlationId,
        input_summary: `Contract/SOW extraction — ${fileName}`.slice(0, 2000),
        proposed_output: {
          kind: 'contract_extraction',
          file_name: fileName,
          document_note: result.documentNote,
          customer_match: customerMatch.type,
          billing_kind: contract.billing_kind,
          rev_rec_method: contract.rev_rec.method,
          total_contract_value_cents: contract.total_contract_value_cents,
          contract,
        },
        reasoning:
          'Billing terms extracted from an uploaded customer contract/SOW; proposed for human review. The invoice(s) or recurring schedule are confirmed via the gated invoice / recurring-invoice create paths — the model never writes AR.',
        status: 'PROPOSED',
        created_by_user: userId,
      })
      .select('id')
      .single();
    decisionId = (dec as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.error('[invoices/parse-contract] decision log failed (non-fatal):', e instanceof Error ? e.message : e);
  }

  return NextResponse.json({
    contract,
    customerMatch,
    meta: {
      fileName,
      model: result.model,
      decisionId,
      documentNote: result.documentNote,
      extractionMs: result.extractionMs,
    },
  });
}
