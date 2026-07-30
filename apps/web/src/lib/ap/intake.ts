/**
 * Autonomous AP intake pipeline.
 *
 * Turns an uploaded vendor invoice into a PENDING (or ON_HOLD) bill:
 *   parse → resolve-or-create vendor → tier → create bill + lines → audit.
 *
 * SAFETY: This is machine DATA ENTRY, not money movement. A bill created here is
 * a DRAFT awaiting the existing human approval flow. We NEVER post to the GL,
 * NEVER touch approvals / gl_entries, and NEVER mark a bill APPROVED. Low-confidence
 * extractions land ON_HOLD so a human must look before anything moves. Every write
 * goes through the RLS-scoped client and is org-scoped.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { parseInvoiceWithAI, type ParsedBill } from '@/lib/services/bill-parser';
import { scoreToTier, getTierPolicy, type Tier } from '@/lib/trust/score-tier';
import { logAction } from '@/lib/trust/action-log';
import { formatMoney } from '@meritbooks/shared';

// GL account the intake lines fall back to when neither the vendor's learned
// default nor an AI suggestion resolves an account. 6660 "Miscellaneous" (OPEX)
// is a non-company-specific seed account present for every org. The human who
// approves the PENDING bill re-codes the lines to the right account — intake
// only needs a valid, non-NULL account_id to write the draft.
const FALLBACK_EXPENSE_ACCOUNT_NUMBER = '6660';

export interface IntakeInvoiceArgs {
  orgId: string;
  locationId: string;
  apiKey: string;
  base64: string;
  mediaType: string;
  fileName: string;
}

export type IntakeResult =
  | { ok: false; error: string }
  | {
      ok: true;
      billId: string;
      vendorId: string;
      vendorCreated: boolean;
      tier: Tier;
      status: 'PENDING' | 'ON_HOLD';
      confidence: number;
      linesCreated: number;
    };

/** Clamp a confidence-ish number into [0,1]; NaN → 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Today as YYYY-MM-DD (UTC). */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Add `days` to a YYYY-MM-DD date string, returning YYYY-MM-DD (UTC-safe). */
function addDaysISO(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map((p) => parseInt(p, 10));
  const base = Date.UTC(y, (m || 1) - 1, d || 1);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Case-insensitive exact match on a trimmed vendor name, scoped to org + not deleted. */
async function findVendor(
  supabase: SupabaseClient,
  orgId: string,
  vendorName: string,
): Promise<{ id: string; defaultAccountId: string | null } | null> {
  const name = vendorName.trim();
  if (!name) return null;

  // Exact, case-insensitive (ilike without wildcards == case-insensitive equality).
  // Match on either the legal name or the display name.
  for (const col of ['name', 'display_name'] as const) {
    const { data } = await supabase
      .schema('core')
      .from('vendors')
      .select('id, default_account_id')
      .eq('org_id', orgId)
      .is('deleted_at', null)
      .ilike(col, name)
      .limit(1);
    const row = (data as Array<{ id: string; default_account_id: string | null }> | null)?.[0];
    if (row) return { id: row.id, defaultAccountId: row.default_account_id };
  }
  return null;
}

/** Resolve the org's fallback expense account id (6660 Miscellaneous). */
async function resolveFallbackAccountId(
  supabase: SupabaseClient,
  orgId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('accounts')
    .select('id')
    .eq('org_id', orgId)
    .eq('account_number', FALLBACK_EXPENSE_ACCOUNT_NUMBER)
    .eq('is_active', true)
    .limit(1);
  return (data as Array<{ id: string }> | null)?.[0]?.id ?? null;
}

export async function intakeInvoice(
  supabase: SupabaseClient,
  args: IntakeInvoiceArgs,
): Promise<IntakeResult> {
  const { orgId, locationId, apiKey, base64, mediaType, fileName } = args;

  // ── 1. Parse ──────────────────────────────────────────────
  const parseResult = await parseInvoiceWithAI(base64, mediaType, apiKey);
  if (!parseResult.success || !parseResult.data) {
    return { ok: false, error: parseResult.error ?? 'Failed to parse invoice' };
  }
  const parsed: ParsedBill = parseResult.data;

  const vendorName = parsed.vendorName.trim();
  if (!vendorName) {
    return { ok: false, error: 'Could not read a vendor name from the document.' };
  }

  // ── 2. Vendor resolve-or-create ───────────────────────────
  let vendorId: string;
  let vendorCreated = false;
  let vendorDefaultAccountId: string | null = null;

  const existing = await findVendor(supabase, orgId, vendorName);
  if (existing) {
    vendorId = existing.id;
    vendorDefaultAccountId = existing.defaultAccountId;
  } else {
    // NOTE: the parser (ParsedBill) does not currently surface vendor
    // email/phone/address, so we create the vendor with the extracted name only.
    // ai_confidence records how sure the model was of the name; auto_approve stays
    // false — a freshly machine-created vendor is never auto-trusted.
    const { data: created, error: vendorErr } = await supabase
      .schema('core')
      .from('vendors')
      .insert({
        org_id: orgId,
        name: vendorName,
        display_name: vendorName,
        ai_confidence: clamp01(parsed.vendorNameConfidence),
        auto_approve: false,
      })
      .select('id, default_account_id')
      .single();

    if (vendorErr || !created) {
      return { ok: false, error: vendorErr?.message ?? 'Failed to create vendor' };
    }
    const row = created as { id: string; default_account_id: string | null };
    vendorId = row.id;
    vendorDefaultAccountId = row.default_account_id;
    vendorCreated = true;
  }

  // ── 3. Tier ───────────────────────────────────────────────
  // The tier engine decides disposition off the total-amount confidence and the
  // extracted amount. It never auto-posts here — 'escalate' just means the draft
  // lands ON_HOLD instead of PENDING.
  const confidence = clamp01(parsed.totalConfidence);
  const policy = await getTierPolicy(supabase, orgId);
  const { tier, reason } = scoreToTier(
    { confidence, amountCents: parsed.totalCents },
    policy,
  );

  const status: 'PENDING' | 'ON_HOLD' = tier === 'escalate' ? 'ON_HOLD' : 'PENDING';

  // ── 4. Create the bill (PENDING / ON_HOLD only) ───────────
  const billDate = parsed.billDate ?? todayISO();
  const dueDate = parsed.dueDate ?? addDaysISO(billDate, 30);

  const { data: bill, error: billErr } = await supabase
    .from('bills')
    .insert({
      org_id: orgId,
      location_id: locationId,
      vendor_id: vendorId,
      bill_number: parsed.billNumber ?? null,
      bill_date: billDate,
      due_date: dueDate,
      subtotal_cents: parsed.subtotalCents,
      tax_cents: parsed.taxCents,
      total_cents: parsed.totalCents,
      status,
      payment_hold_reason: status === 'ON_HOLD' ? reason : null,
      ai_extracted: true,
      ai_confidence: confidence,
      // TODO: persist the original document once a storage bucket is wired.
      // No bucket exists yet, so the source file is not retained.
      source_file_url: null,
    })
    .select('id')
    .single();

  if (billErr || !bill) {
    return { ok: false, error: billErr?.message ?? 'Failed to create bill' };
  }
  const billId = (bill as { id: string }).id;

  // ── 4b. Bill lines ────────────────────────────────────────
  // account_id is NOT NULL on bill_lines, and the parser does not resolve GL
  // accounts, so every line codes to the vendor default (if any) else the org's
  // fallback expense account. If we can't resolve any account, we still leave the
  // draft bill (a human can add lines) rather than fail the whole intake.
  const fallbackAccountId =
    vendorDefaultAccountId ?? (await resolveFallbackAccountId(supabase, orgId));

  let linesCreated = 0;
  if (fallbackAccountId) {
    const sourceLines =
      parsed.lines.length > 0
        ? parsed.lines
        : // No distinct line items → one line for the total.
          [
            {
              description: parsed.billNumber ? `Invoice ${parsed.billNumber}` : 'Invoice total',
              quantity: 1,
              unitCostCents: parsed.totalCents,
              amountCents: parsed.totalCents,
              suggestedAccountNumber: null,
              confidence,
            },
          ];

    const lineInserts = sourceLines.map((line, i) => ({
      org_id: orgId,
      bill_id: billId,
      line_number: i + 1,
      description: line.description || null,
      account_id: fallbackAccountId,
      quantity: line.quantity > 0 ? line.quantity : 1,
      unit_cost_cents: line.unitCostCents,
      amount_cents: line.amountCents,
    }));

    const { data: inserted, error: linesErr } = await supabase
      .from('bill_lines')
      .insert(lineInserts)
      .select('id');

    if (linesErr) {
      // Non-fatal: the draft bill still exists for a human to complete.
      console.error('[ap/intake] bill_lines insert failed:', linesErr.message);
    } else {
      linesCreated = (inserted as Array<{ id: string }> | null)?.length ?? 0;
    }
  } else {
    console.error(
      `[ap/intake] no fallback expense account (${FALLBACK_EXPENSE_ACCOUNT_NUMBER}) for org ${orgId}; bill ${billId} created without lines`,
    );
  }

  // ── 5. Audit (best-effort; logAction never throws) ────────
  await logAction(supabase, {
    orgId,
    locationId,
    actorType: 'AI',
    action: 'ap.bill.extracted',
    subjectTable: 'bills',
    subjectId: billId,
    summary: `Extracted bill from ${vendorName} for ${formatMoney(parsed.totalCents)}`,
    confidence,
    tier,
    metadata: {
      vendorCreated,
      linesCreated,
      status,
      fileName,
      billNumber: parsed.billNumber,
      tierReason: reason,
    },
  });

  // ── 6. Result ─────────────────────────────────────────────
  return {
    ok: true,
    billId,
    vendorId,
    vendorCreated,
    tier,
    status,
    confidence,
    linesCreated,
  };
}
